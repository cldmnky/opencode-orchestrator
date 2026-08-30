/**
 * Conditional orchestrator-only S3/V1 runtime tools.
 *
 * Registered ONLY when the corresponding mode is enabled, so the default
 * configuration preserves the existing tool contract/count:
 * - `observability_get` when trace or stop-between-steps budget is active.
 * - `review_get` / `review_transition` when review mode is `bounded`.
 *
 * All tools live under the `orchestrator` namespace with the shared
 * `orchestrator_observability` permission action; workers are denied them by
 * the installer/agent transform and each execute handler rejects non-
 * orchestrator agents regardless of visibility. They are callable/advisory
 * primitives: nothing reads these results automatically and no automatic gate
 * is enforced by a hook. Outputs carry explicit limitations (no CAS/cross-
 * process guarantee, caller identity cannot be proven, one bounded record per
 * session).
 */
import type { OrchestratorOptions } from "../../core/config.js"
import { OBSERVABILITY_TOOL_PERMISSION } from "../../core/permissions.js"
import { REVIEW_V1_CHECK_KEYS, REVIEW_V1_SIGNAL_SCHEMA, transitionReviewV1 } from "./review.js"
import { readReviewRecord, setReviewRecord } from "./runtime.js"
import { withSessionLock, type LocationLike, type StorageLike } from "../goal/state.js"
import type { Info as ToolInfo } from "@opencode-ai/plugin/promise/tool"

type ToolDraftLike = {
  add(tool: ToolInfo<any, undefined>): void
}

type ToolResult = { content: string }

export type ObservabilityToolsDeps = {
  options: OrchestratorOptions
  storage: StorageLike
  location: LocationLike
  /** Active when trace or stop-between-steps budget is configured. */
  runtime?: ObservabilityRuntimeLike
}

type ObservabilityRuntimeLike = {
  summary(sessionID: string): Promise<unknown>
  evaluation(sessionID: string): Promise<{ verdict: string; version: 1; mode: string; limits: unknown[] }>
}

const LIMITATIONS = [
  "one bounded current record per session; no append-only ledger",
  "process-local serialization only: no CAS, transactions, or cross-process guarantee",
  "caller identity and child-session ownership cannot be proven by the plugin",
  "metadata only: no prompts, transcripts, tool input/output, or credentials are ever stored",
]

export function addObservabilityTools(draft: ToolDraftLike, deps: ObservabilityToolsDeps): void {
  const runtime = deps.runtime
  if (runtime && (deps.options.trace.mode !== "off" || deps.options.budget.mode === "stop-between-steps")) {
    draft.add({
      name: "observability_get",
      description:
        "Read the current bounded trace metadata summary and budget evaluation for a session. Metadata only; usage snapshots replace (never accumulate), missing coverage is unknown, never zero. Orchestrator-only.",
      input: observabilityGetInput,
      options: { namespace: "orchestrator", permission: OBSERVABILITY_TOOL_PERMISSION },
      execute: async (input, tool) => {
        requireOrchestrator(tool.agent, deps.options)
        const sessionID = stringField(input, "sessionID")
        if (!sessionID) return resultContent(JSON.stringify({ version: 1, error: "sessionID is required", limitations: LIMITATIONS }))
        const summary = await runtime.summary(sessionID)
        const evaluation = await runtime.evaluation(sessionID)
        return resultContent(
          JSON.stringify({
            version: 1,
            sessionID,
            trace: summary ?? null,
            budget: evaluation,
            limitations: LIMITATIONS,
          }),
        )
      },
    })
  }

  if (deps.options.review.mode === "bounded") {
    draft.add({
      name: "review_get",
      description:
        "Read the single bounded V1 review record for a session (review/v1 storage key). Returns null when no review has been started. Orchestrator-only; callable/advisory, not an automatic gate.",
      input: reviewGetInput,
      options: { namespace: "orchestrator", permission: OBSERVABILITY_TOOL_PERMISSION },
      execute: async (input, tool) => {
        requireOrchestrator(tool.agent, deps.options)
        const sessionID = stringField(input, "sessionID")
        if (!sessionID) return resultContent(JSON.stringify({ version: 1, error: "sessionID is required", limitations: LIMITATIONS }))
        const record = await readReviewRecord(deps.storage, deps.location, sessionID)
        return resultContent(
          JSON.stringify({
            version: 1,
            sessionID,
            record: record ?? null,
            maxRounds: deps.options.review.max_rounds,
            checkerRole: deps.options.roles.review,
            limitations: LIMITATIONS,
          }),
        )
      },
    })

    draft.add({
      name: "review_transition",
      description:
        "Compute and persist the deterministic V1 review transition for one record. start requires exactly taskId, runId, maker, checker, and the review-pending admission signal; approve requires exactly the fixed boolean checks diff, scope, and verification (all must be true); request-changes and block take exactly the action. Orchestrator-only; callable/advisory, not an automatic completion gate.",
      input: reviewTransitionInput,
      options: { namespace: "orchestrator", permission: OBSERVABILITY_TOOL_PERMISSION },
      execute: async (input, tool) => {
        requireOrchestrator(tool.agent, deps.options)
        const sessionID = stringField(input, "sessionID")
        if (!sessionID) {
          return resultContent(
            JSON.stringify({
              version: 1,
              accepted: false,
              reason: "invalid-signal",
              message: "sessionID is required",
              requiresHuman: false,
              terminal: false,
              limitations: LIMITATIONS,
            }),
          )
        }
        const parsed = REVIEW_V1_SIGNAL_SCHEMA.safeParse((input as { signal?: unknown } | null | undefined)?.signal)
        if (!parsed.success) {
          return resultContent(
            JSON.stringify({
              version: 1,
              accepted: false,
              reason: "invalid-signal",
              message:
                "review_transition rejected the signal; start requires exactly taskId, runId, maker, checker, and admissionState review-pending with no extra fields; approve requires exactly the fixed boolean checks diff, scope, and verification; request-changes and block take exactly the action with no extra fields",
              requiresHuman: false,
              terminal: false,
              limitations: LIMITATIONS,
            }),
          )
        }
        const signal = parsed.data

        // Caller-provided identity can never be proven by the plugin; the
        // configured review role and maker/checker difference are still checked.
        if (signal.action === "start" && signal.checker !== deps.options.roles.review) {
          return resultContent(
            JSON.stringify({
              version: 1,
              accepted: false,
              reason: "checker-role-mismatch",
              message: `checker must be the configured review role (${deps.options.roles.review})`,
              requiresHuman: false,
              terminal: false,
              limitations: LIMITATIONS,
            }),
          )
        }

        // Read-modify-write under one withSessionLock so a concurrent
        // transition for the same session cannot interleave. A pending
        // different task can never be overwritten and a terminal old task may
        // be replaced (both enforced by transitionReviewV1).
        const transition = await withSessionLock(deps.location, sessionID, async () => {
          const current = await readReviewRecord(deps.storage, deps.location, sessionID)
          const result = transitionReviewV1({
            record: current,
            signal,
            maxRounds: deps.options.review.max_rounds,
            checkerRole: deps.options.roles.review,
          })
          if (result.accepted && result.record) {
            await setReviewRecord(deps.storage, deps.location, sessionID, result.record)
          }
          return result
        })
        return resultContent(
          JSON.stringify({
            version: 1,
            accepted: transition.accepted,
            reason: transition.reason,
            requiresHuman: transition.requiresHuman,
            terminal: transition.terminal,
            message: transition.message,
            ...(transition.accepted && transition.record ? { record: transition.record } : {}),
            limitations: LIMITATIONS,
          }),
        )
      },
    })
  }
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) {
    throw new Error("observability/review tools are available only to the orchestrator")
  }
}

function stringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function resultContent(content: string): ToolResult {
  return { content }
}

/* ------------------------------------------------------------------ */
/* JSON input schemas (model-facing; runtime validation stays in core) */
/* ------------------------------------------------------------------ */

const observabilityGetInput = {
  type: "object",
  properties: {
    sessionID: { type: "string", minLength: 1 },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const reviewGetInput = {
  type: "object",
  properties: {
    sessionID: { type: "string", minLength: 1 },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const

// Strict per-action input variants: the model-facing JSON schema mirrors the
// runtime REVIEW_V1_SIGNAL_SCHEMA exactly. start requires exactly action,
// taskId, runId, maker, checker, admissionState; approve requires exactly
// action plus the fixed checks (diff, scope, verification); request-changes
// and block allow exactly action. Any extra per-action field matches no
// variant and is rejected. The checks property set and required list are
// derived from REVIEW_V1_CHECK_KEYS so the model-facing and runtime schemas
// can never drift apart.
export const reviewTransitionInput = {
  type: "object",
  properties: {
    sessionID: { type: "string", minLength: 1 },
    signal: {
      oneOf: [
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["start"] },
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            runId: { type: "string", minLength: 1, maxLength: 128 },
            maker: { type: "string", minLength: 1, maxLength: 128 },
            checker: { type: "string", minLength: 1, maxLength: 128 },
            admissionState: { type: "string", enum: ["review-pending"] },
          },
          required: ["action", "taskId", "runId", "maker", "checker", "admissionState"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["approve"] },
            checks: {
              type: "object",
              properties: {
                diff: { type: "boolean" },
                scope: { type: "boolean" },
                verification: { type: "boolean" },
              },
              required: [...REVIEW_V1_CHECK_KEYS],
              additionalProperties: false,
            },
          },
          required: ["action", "checks"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["request-changes"] },
          },
          required: ["action"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["block"] },
          },
          required: ["action"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["sessionID", "signal"],
  additionalProperties: false,
} as const