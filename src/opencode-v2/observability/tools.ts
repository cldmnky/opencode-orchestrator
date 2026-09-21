/**
 * Conditional S3 observability and V2 review tools.
 *
 * Review V1 records remain readable through `review_get`, but the old generic
 * transition tool is intentionally gone. A lead starts V2; only the
 * configured reviewer child can submit the decision through its dedicated
 * permission action.
 */
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"
import type { OrchestratorOptions } from "../../core/config.js"
import { OBSERVABILITY_TOOL_PERMISSION, REVIEW_SUBMIT_TOOL_PERMISSION } from "../../core/permissions.js"
import { stableProjectID, withSessionLock, type LocationLike, type StorageLike } from "../goal/state.js"
import { readReviewRecord, readReviewRecordV2, setReviewRecordV2 } from "./runtime.js"
import {
  REVIEW_V2_CHECK_KEYS,
  reviewV2StartInputSchema,
  reviewV2SubmitInputSchema,
  startReviewV2,
  submitReviewV2,
  reviewV2StorageKey,
} from "./review-v2.js"
import {
  hydrateLeadBoardV2,
  transitionLeadTaskV2,
  writeLeadBoardV2,
} from "../orchestration/lead-board-v2.js"

type ToolDraftLike = {
  add(tool: ToolInfo<any, undefined>): void
}

type ToolResult = { content: string }

type SessionLike = {
  get(input: { sessionID: string }): Promise<unknown>
}

export type ObservabilityToolsDeps = {
  options: OrchestratorOptions
  storage: StorageLike
  location: LocationLike
  /** Active when trace or stop-between-steps budget is configured. */
  runtime?: ObservabilityRuntimeLike
  /** Required to prove reviewer-session ancestry for review V2 submit. */
  session?: SessionLike
}

type ObservabilityRuntimeLike = {
  summary(sessionID: string): Promise<unknown>
  evaluation(sessionID: string): Promise<{ verdict: string; version: 1; mode: string; limits: unknown[] }>
}

const LIMITATIONS = [
  "one bounded current record per lead session; no append-only ledger",
  "process-local serialization only: no CAS, transactions, or cross-process guarantee",
  "V1 records are readable status only and are legacy-unproven for publication or completion",
  "V2 approval records store only fixed checks and host-derived reviewer agent/session identity",
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
        return resultContent(JSON.stringify({ version: 1, sessionID, trace: summary ?? null, budget: evaluation, limitations: LIMITATIONS }))
      },
    })
  }

  if (deps.options.review.mode !== "bounded") return

  draft.add({
    name: "review_get",
    description:
      "Read bounded review status for a lead session. V2 records include host-derived reviewer provenance; V1 records are returned as legacy-unproven status only and never authenticate publication or completion. Orchestrator-only.",
    input: reviewGetInput,
    options: { namespace: "orchestrator", permission: OBSERVABILITY_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const sessionID = stringField(input, "sessionID")
      if (!sessionID) return resultContent(JSON.stringify({ version: 1, error: "sessionID is required", limitations: LIMITATIONS }))
      const [v2, v1] = await Promise.all([
        readReviewRecordV2(deps.storage, deps.location, sessionID),
        readReviewRecord(deps.storage, deps.location, sessionID),
      ])
      return resultContent(
        JSON.stringify({
          version: v2 ? 2 : v1 ? 1 : null,
          sessionID,
          state: v2?.state ?? (v1 ? "legacy-unproven" : "none"),
          record: v2 ?? v1 ?? null,
          legacy: v2 && v1 ? { state: "legacy-unproven" } : null,
          maxRounds: deps.options.review.max_rounds,
          reviewerAgentID: deps.options.roles.review,
          limitations: LIMITATIONS,
        }),
      )
    },
  })

  draft.add({
    name: "review_start",
    description:
      "Lead-only: start or reopen one provenance-bound V2 review for the current lead session. Pins task, run, exact head/base SHAs, and the configured reviewer agent. Never accepts reviewer identity from input.",
    input: reviewStartInput,
    options: { namespace: "orchestrator", permission: OBSERVABILITY_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const parsed = reviewV2StartInputSchema.safeParse(input)
      if (!parsed.success) return transitionResult({ accepted: false, reason: "invalid-signal", message: "review_start requires taskId, runId, and a full exact head/base SHA pair", requiresHuman: false, terminal: false })
      const leadSessionID = tool.sessionID
      const transition = await withSessionLock(deps.location, leadSessionID, async () => {
        const boardCheck = await validateReviewStartBoard(deps, leadSessionID, parsed.data)
        if (boardCheck) return { accepted: false, reason: "invalid-signal" as const, message: boardCheck, requiresHuman: false, terminal: false }
        const current = await readReviewRecordV2(deps.storage, deps.location, leadSessionID)
        const result = startReviewV2({
          ...parsed.data,
          record: current,
          leadSessionID,
          expectedReviewerAgentID: deps.options.roles.review,
          maxRounds: deps.options.review.max_rounds,
        })
        if (result.accepted && result.record) await setReviewRecordV2(deps.storage, deps.location, leadSessionID, result.record)
        return result
      })
      return transitionResult(transition)
    },
  })

  draft.add({
    name: "review_submit",
    description:
      "Reviewer-only: submit exactly one approve, request-changes, or block decision for a pending V2 review. The host tool context supplies reviewer agent/session identity; the session must be a child of the named lead. Orchestrator self-approval and caller-supplied reviewer identities are refused.",
    input: reviewSubmitInput,
    options: { namespace: "orchestrator", permission: REVIEW_SUBMIT_TOOL_PERMISSION },
    execute: async (input, tool) => {
      const parsed = reviewV2SubmitInputSchema.safeParse(input)
      if (!parsed.success) return transitionResult({ accepted: false, reason: "invalid-signal", message: "review_submit requires leadSessionID, round, and one strict decision", requiresHuman: false, terminal: false })
      if (tool.agent !== deps.options.roles.review) {
        return transitionResult({ accepted: false, reason: "reviewer-role-mismatch", message: "only the configured reviewer agent may submit a review V2 decision", requiresHuman: false, terminal: false })
      }
      const child = await isChildSession(deps.session, tool.sessionID, parsed.data.leadSessionID)
      if (child !== true) {
        return transitionResult({ accepted: false, reason: "reviewer-session-mismatch", message: "the reviewer session must be a verified child of the lead session", requiresHuman: false, terminal: false })
      }
      const transition = await withSessionLock(deps.location, parsed.data.leadSessionID, async () => {
        const current = await readReviewRecordV2(deps.storage, deps.location, parsed.data.leadSessionID)
        const projectID = await stableProjectID(deps.storage, deps.location, parsed.data.leadSessionID)
        const reviewKey = reviewV2StorageKey({ project: { id: projectID } }, parsed.data.leadSessionID)
        const previousReviewValue = await deps.storage.get(reviewKey)
        const result = submitReviewV2({
          record: current,
          leadSessionID: parsed.data.leadSessionID,
          expectedRound: parsed.data.round,
          maxRounds: deps.options.review.max_rounds,
          expectedReviewerAgentID: deps.options.roles.review,
          actorSessionID: tool.sessionID,
          actorAgentID: tool.agent,
          isChildSession: child,
          decision: parsed.data.decision,
        })
        if (result.accepted && result.record) {
          if (result.record.state === "pending") {
            return { accepted: false, reason: "invalid-signal" as const, message: "review submission did not produce a bounded decision", requiresHuman: false, terminal: false }
          }
          const decisionRecord = result.record as unknown as {
            taskId: string
            runId: string
            state: "approved" | "changes-requested" | "blocked" | "tripped"
            headSha: string
            baseSha: string
            updatedAt: number
          }
          const boardResult = await applyReviewDecisionToBoard(deps, parsed.data.leadSessionID, decisionRecord)
          if (!boardResult.ok) {
            return { accepted: false, reason: "invalid-signal" as const, message: boardResult.message, requiresHuman: false, terminal: false }
          }
          try {
            await setReviewRecordV2(deps.storage, deps.location, parsed.data.leadSessionID, result.record)
          } catch {
            const boardRestored = boardResult.boardKey === undefined
              ? true
              : await restoreStorageValue(deps.storage, boardResult.boardKey, boardResult.previousBoardValue)
            const reviewRestored = await restoreStorageValue(deps.storage, reviewKey, previousReviewValue)
            return {
              accepted: false,
              reason: "invalid-signal" as const,
              message: boardRestored && reviewRestored
                ? "review submission could not be persisted; the board decision was rolled back"
                : "review submission persistence failed and rollback was incomplete; repair the review and lead-board records before retrying",
              requiresHuman: false,
              terminal: false,
            }
          }
          if (boardResult.message) result.message = `${result.message} ${boardResult.message}`
        }
        return result
      })
      return transitionResult(transition)
    },
  })
}

/**
 * When a V2 board is present, review start is also the board's intent-level
 * review admission. The old standalone review surface remains usable for
 * migration/status tests and for sessions that have not enrolled a board.
 */
async function validateReviewStartBoard(
  deps: ObservabilityToolsDeps,
  leadSessionID: string,
  input: { taskId: string; headSha: string },
): Promise<string | undefined> {
  const hydration = await hydrateLeadBoardV2(deps.storage, deps.location, leadSessionID)
  if (hydration.status === "missing") return undefined
  if (hydration.status === "legacy") return "review start requires an explicitly migrated V2 lead board"
  if (hydration.status !== "ok" || !hydration.board) return hydration.warning ?? "review start requires a readable V2 lead board"
  const task = hydration.board.tasks.find((candidate) => candidate.taskID === input.taskId)
  if (!task) return `review start refused: no board task ${input.taskId} exists`
  if (task.status !== "awaiting-review") return `review start refused: task ${input.taskId} is ${task.status}, not awaiting-review`
  if (!task.validation || task.validation.revision !== input.headSha) {
    return "review start refused: the task has no observed validation at the exact requested head revision"
  }
  return undefined
}

type BoardDecisionResult =
  | { ok: true; message?: string; boardKey?: string; previousBoardValue?: unknown }
  | { ok: false; message: string }

/** Apply the reviewer intent to the V2 task ledger without exposing a generic transition edge. */
async function applyReviewDecisionToBoard(
  deps: ObservabilityToolsDeps,
  leadSessionID: string,
  record: {
    taskId: string
    runId: string
    state: "approved" | "changes-requested" | "blocked" | "tripped"
    headSha: string
    baseSha: string
    updatedAt: number
  },
): Promise<BoardDecisionResult> {
  const hydration = await hydrateLeadBoardV2(deps.storage, deps.location, leadSessionID)
  if (hydration.status === "missing") return { ok: true }
  if (hydration.status === "legacy") return { ok: false, message: "review decision refused: migrate the V1 lead board before submitting V2 review" }
  if (hydration.status !== "ok" || !hydration.board) return { ok: false, message: hydration.warning ?? "review decision refused: V2 lead board is unavailable" }
  const task = hydration.board.tasks.find((candidate) => candidate.taskID === record.taskId)
  if (!task) return { ok: false, message: `review decision refused: no board task ${record.taskId} exists` }
  if (task.status !== "awaiting-review") return { ok: false, message: `review decision refused: task ${record.taskId} is ${task.status}, not awaiting-review` }
  if (!task.validation || task.validation.revision !== record.headSha) {
    return { ok: false, message: "review decision refused: task validation and reviewer head revision differ" }
  }
  const action = record.state === "approved" ? "complete" : record.state === "changes-requested" ? "request-changes" : "block"
  const applied = transitionLeadTaskV2({
    board: hydration.board,
    taskID: task.taskID,
    expectedVersion: task.lifecycleVersion,
    actorSessionID: leadSessionID,
    action,
    ...(record.state === "approved"
      ? {
          review: {
            reference: `review/v2/${record.taskId}/${record.runId}`,
            revision: record.headSha,
            baseRevision: record.baseSha,
            approvedAt: record.updatedAt,
            reviewVersion: 2 as const,
          },
        }
      : { note: `reviewer submitted ${record.state}; lead intent transition applied` }),
  })
  if (!applied.ok) return { ok: false, message: `review decision refused: ${applied.message}` }
  const previousBoardValue = await deps.storage.get(hydration.key)
  try {
    await writeLeadBoardV2(deps.storage, { ...deps.location, project: { id: hydration.board.projectID } }, applied.board)
  } catch {
    const restored = await restoreStorageValue(deps.storage, hydration.key, previousBoardValue)
    return {
      ok: false,
      message: restored
        ? "review decision refused: the V2 lead-board update could not be persisted"
        : "review decision refused: the V2 lead-board update failed and rollback was incomplete",
    }
  }
  return {
    ok: true,
    message: `lead board task ${record.taskId} is now ${applied.task.status}`,
    boardKey: hydration.key,
    previousBoardValue,
  }
}

async function restoreStorageValue(storage: StorageLike, key: string, value: unknown): Promise<boolean> {
  try {
    if (value === undefined) await storage.remove(key)
    else await storage.set(key, value)
    return true
  } catch {
    return false
  }
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) throw new Error("observability/review read/start tools are available only to the orchestrator")
}

async function isChildSession(session: SessionLike | undefined, childSessionID: string, leadSessionID: string): Promise<boolean | undefined> {
  if (!session || childSessionID === leadSessionID) return false
  let current = childSessionID
  for (let depth = 0; depth < 32; depth += 1) {
    let value: unknown
    try {
      value = await session.get({ sessionID: current })
    } catch {
      return undefined
    }
    const parentID = parentSessionID(value)
    if (parentID === undefined) return false
    if (parentID === leadSessionID) return true
    current = parentID
  }
  return undefined
}

function parentSessionID(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const data = (value as { data?: unknown }).data
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : value
  const parentID = (source as { parentID?: unknown }).parentID
  return typeof parentID === "string" && parentID.length > 0 ? parentID : undefined
}

function stringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function resultContent(content: string): ToolResult {
  return { content }
}

function transitionResult(transition: { accepted: boolean; reason: string; requiresHuman: boolean; terminal: boolean; message: string; record?: unknown }): ToolResult {
  return {
    content: JSON.stringify({
      version: 2,
      accepted: transition.accepted,
      reason: transition.reason,
      requiresHuman: transition.requiresHuman,
      terminal: transition.terminal,
      message: transition.message,
      ...(transition.record ? { record: transition.record } : {}),
      limitations: LIMITATIONS,
    }),
  }
}

/* ------------------------------------------------------------------ */
/* JSON input schemas (model-facing; runtime validation stays in review-v2) */
/* ------------------------------------------------------------------ */

const observabilityGetInput = {
  type: "object",
  properties: { sessionID: { type: "string", minLength: 1 } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const reviewGetInput = {
  type: "object",
  properties: { sessionID: { type: "string", minLength: 1 } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

export const reviewStartInput = {
  type: "object",
  properties: {
    taskId: { type: "string", minLength: 1, maxLength: 128 },
    runId: { type: "string", minLength: 1, maxLength: 128 },
    headSha: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
    baseSha: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
  },
  required: ["taskId", "runId", "headSha", "baseSha"],
  additionalProperties: false,
} as const

export const reviewSubmitInput = {
  type: "object",
  properties: {
    leadSessionID: { type: "string", minLength: 1, maxLength: 512 },
    round: { type: "integer", minimum: 1, maximum: 8 },
    decision: {
      oneOf: [
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
              required: [...REVIEW_V2_CHECK_KEYS],
              additionalProperties: false,
            },
          },
          required: ["action", "checks"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { action: { type: "string", enum: ["request-changes"] } },
          required: ["action"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { action: { type: "string", enum: ["block"] } },
          required: ["action"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["leadSessionID", "round", "decision"],
  additionalProperties: false,
} as const
