import { stat } from "node:fs/promises"
import type { OrchestratorOptions } from "../../core/config.js"
import { ORCHESTRATION_TOOL_PERMISSION } from "../../core/permissions.js"
import { ADMISSION_ACTIONS, ADMISSION_INPUT_SCHEMA, ADMISSION_STATES, transitionAdmission } from "../../core/admission.js"
import { D4_PARALLELISM_VALUES, classifyTaskComplexity } from "../../core/d4.js"
import { D2_LIMITS, RELATIVE_REPO_PATH_PATTERN } from "../../core/contracts.js"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"
import { resolveRealpath } from "../worktree/git.js"
import { runHandoffHint, validateHandoff, type HandoffValidationResult, type SessionLocation, type ValidationDeps } from "./validation.js"
import type { GenerationHintRecord } from "../observability/trace.js"

/**
 * Serialized runtime orchestration tools (orchestrator_task_complexity_classify,
 * orchestrator_handoff_validate, orchestrator_admission_transition).
 *
 * Registered unconditionally as core tools (no feature-enable gate) under the
 * `orchestrator` namespace with the shared `orchestrator_validation` permission
 * action, plus the runtime orchestrator-agent check (a worker that somehow
 * reaches an execute handler is rejected regardless of visibility rules).
 *
 * They are callable/advisory primitives — NOT automatic hooks: nothing routes
 * worker output through them, they persist nothing, they mutate nothing, they
 * accept no `confirm` input, and they never enforce a completion gate.
 * `task_complexity_classify` is advisory/user-overridable; `handoff_validate`
 * is a deterministic fail-closed D2 validator that threads the invoking
 * `tool.sessionID` into session resolution explicitly (session content is never
 * exposed or logged); `admission_transition` is a stateless state machine that
 * never treats D2 reviewState as approval.
 *
 * `handoff_validate` additionally honors the opt-in `hints.mode: "advisory"`
 * config: after a deterministic `pass` verdict it runs one bounded sessionless
 * generation post-step and attaches a redacted, metadata-only hint record.
 * The hint record never changes the verdict, the admission state, or any gate,
 * and it is not persisted by the plugin.
 */

type ToolDraftLike = {
  add(tool: ToolInfo<any, undefined>): void
}

type ToolResult = { content: string }

type SessionLike = {
  get(input: { sessionID: string }): Promise<unknown>
}

type VcsStatusInput = { location: { directory: string; workspace?: string } }
type VcsLike = {
  status(input: VcsStatusInput & Record<string, unknown>): Promise<unknown>
}

export type OrchestrationToolsDeps = {
  options: OrchestratorOptions
  location: { directory: string; workspaceID?: string }
  /** Default session source for handoff_validate; plugin wiring passes context.session. */
  session?: SessionLike
  /** Default VCS source for handoff_validate; plugin wiring passes context.vcs. */
  vcs?: VcsLike
  pathExists?: (absolutePath: string) => Promise<boolean>
  realpath?: (directory: string) => Promise<string | undefined>
  redact?: (text: string) => string
  /**
   * Sessionless generation surface for the opt-in hint post-step; plugin
   * wiring passes context.generate. Absent means hints cannot run (the tool
   * records a `generate-unavailable` skip when hints are enabled).
   */
  generate?: (input: {
    prompt: string
    model?: { providerID: string; id: string }
  }) => Promise<{ text: string }>
  /**
   * Deterministic test/ops override for the hint timeout race; defaults to
   * `HANDOFF_HINT_TIMEOUT_MS`. The underlying generation is never cancelled.
   */
  hintTimeoutMs?: number
}

export function addOrchestrationTools(draft: ToolDraftLike, deps: OrchestrationToolsDeps): void {
  const validationDeps = resolveValidationDeps(deps)

  draft.add({
    name: "task_complexity_classify",
    description:
      "Classify task complexity from the eight structured D4 facts (each may be null when unknown). Returns an advisory, user-overridable recommendation; nothing is enforced automatically.",
    input: classifyInput,
    options: { namespace: "orchestrator", permission: ORCHESTRATION_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      try {
        const result = classifyTaskComplexity(input ?? {})
        return resultContent(JSON.stringify(result))
      } catch {
        // Deterministic generic failure: never echo the offending values.
        return resultContent(
          "task_complexity_classify rejected invalid structured input; supply only the eight typed dimension fields (each may be null when the fact is unknown) and retry",
        )
      }
    },
  })

  draft.add({
    name: "handoff_validate",
    description:
      "Validate a version-1 structured D2 handoff against a task contract (level worker or orchestrator). Deterministic fail-closed checks; returns an admission state for orchestrator_admission_transition. Callable/advisory: not an automatic gate and no completion gate is enforced. When hints.mode is advisory, a bounded metadata-only generation hint may be attached after a pass; it never changes the verdict or admission state.",
    input: validateInput,
    options: { namespace: "orchestrator", permission: ORCHESTRATION_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const result = await validateHandoff(input, validationDeps, tool.sessionID)
      const hints = await maybeRunHandoffHint(deps, result)
      return resultContent(JSON.stringify(hints ? { ...result, hints } : result))
    },
  })

  draft.add({
    name: "admission_transition",
    description:
      "Compute the deterministic V2 admission transition for one (from, signal) pair. Stateless: returns the next admission state and never persists; the caller owns state. D2 reviewState is never treated as approval.",
    input: admissionInput,
    options: { namespace: "orchestrator", permission: ORCHESTRATION_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const parsed = ADMISSION_INPUT_SCHEMA.safeParse(input)
      if (!parsed.success) {
        return resultContent(
          "admission_transition rejected invalid input; supply from (one of the admission states) and a strict signal object with a valid action and retry",
        )
      }
      return resultContent(JSON.stringify(transitionAdmission(parsed.data)))
    },
  })
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) {
    throw new Error("orchestration validation tools are available only to the orchestrator")
  }
}

/**
 * Opt-in advisory hint post-step. Runs only when `hints.mode: "advisory"` is
 * configured and the deterministic checks already produced a `pass` verdict.
 * The returned record is metadata only and never changes `result`: the
 * validator's verdict, admission state, checks, and prose are whatever the
 * deterministic path produced, and no error here can surface to the caller.
 */
async function maybeRunHandoffHint(
  deps: OrchestrationToolsDeps,
  result: HandoffValidationResult,
): Promise<GenerationHintRecord | undefined> {
  if (deps.options.hints.mode !== "advisory") return undefined
  return runHandoffHint({
    level: result.level,
    verdict: result.verdict,
    checks: result.checks,
    model: deps.options.hints.model,
    generate: deps.generate,
    redact: deps.redact,
    ...(deps.hintTimeoutMs !== undefined ? { timeoutMs: deps.hintTimeoutMs } : {}),
  })
}

function resultContent(content: string): ToolResult {
  return { content }
}

/* ------------------------------------------------------------------ */
/* Default dependency wiring                                           */
/* ------------------------------------------------------------------ */

function resolveValidationDeps(deps: OrchestrationToolsDeps): ValidationDeps {
  return {
    sessionLocation: async (sessionID) => {
      if (!deps.session) {
        return {
          directory: deps.location.directory,
          ...(deps.location.workspaceID !== undefined ? { workspaceID: deps.location.workspaceID } : {}),
        }
      }
      return resolveSessionLocation(deps.session, sessionID, deps.location)
    },
    vcsStatus: async (directory, workspaceID) => {
      if (!deps.vcs) return undefined
      try {
        const output = await deps.vcs.status({
          location: {
            directory,
            ...(workspaceID !== undefined ? { workspace: workspaceID } : {}),
          },
        })
        return arrayData(output)
          .filter(isRecord)
          .map((value) => ({ file: typeof value.file === "string" ? value.file : "" }))
          .filter((entry) => entry.file.length > 0)
      } catch {
        return undefined
      }
    },
    pathExists: deps.pathExists ?? defaultPathExists,
    realpath: deps.realpath ?? resolveRealpath,
    redactFn: deps.redact,
  }
}

/** Resolve the session's current post-move location, falling back to the plugin load-time location. */
async function resolveSessionLocation(
  sessionLike: SessionLike,
  sessionID: string,
  fallback: { directory: string; workspaceID?: string },
): Promise<SessionLocation> {
  try {
    const value = await sessionLike.get({ sessionID })
    const resolved = unwrapSessionLocation(value)
    if (resolved?.directory) return resolved
  } catch {
    // Fall back to the plugin location; the validator can still check the default scope.
  }
  return {
    directory: fallback.directory,
    ...(fallback.workspaceID !== undefined ? { workspaceID: fallback.workspaceID } : {}),
  }
}

function unwrapSessionLocation(value: unknown): SessionLocation | undefined {
  if (!value || typeof value !== "object") return undefined
  if (Array.isArray((value as { data?: unknown }).data)) return undefined
  const source =
    (value as { data?: unknown }).data && typeof (value as { data: unknown }).data === "object"
      ? (value as { data: unknown }).data
      : value
  if (!source || typeof source !== "object") return undefined
  const location = (source as { location?: unknown }).location
  if (!location || typeof location !== "object") return undefined
  const directoryValue = (location as { directory?: unknown }).directory
  if (typeof directoryValue !== "string" || directoryValue.length === 0) return undefined
  const workspaceValue = (location as { workspaceID?: unknown }).workspaceID
  return {
    directory: directoryValue,
    ...(typeof workspaceValue === "string" ? { workspaceID: workspaceValue } : {}),
  }
}

async function defaultPathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath)
    return true
  } catch {
    return false
  }
}

function arrayData(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: unknown[] }).data
  }
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/* ------------------------------------------------------------------ */
/* JSON input schemas (model-facing; runtime validation stays in core) */
/* ------------------------------------------------------------------ */

const nullableInteger = (minimum = 0) => ({ type: ["integer", "null"], minimum })

const classifyInput = {
  type: "object",
  properties: {
    independent_subtasks: nullableInteger(),
    dependent_stages: nullableInteger(),
    files_modules: nullableInteger(),
    independent_review: { type: ["boolean", "null"] },
    external_side_effects: { type: ["boolean", "null"] },
    shared_mutable_state: { type: ["boolean", "null"] },
    security_compliance_risk: { type: ["boolean", "null"] },
    // JSON Schema 2020-12: `type: ["string", "null"]` combined with a shared
    // `enum` rejects null (null is never one of the enum's string values), so
    // the nullable enum needs an explicit `anyOf` null branch. Runtime
    // behavior is unchanged: the D4 Zod schema stays the single authority.
    expected_parallelism_value: {
      anyOf: [{ type: "string", enum: D4_PARALLELISM_VALUES }, { type: "null" }],
    },
  },
  additionalProperties: false,
} as const

const validateInput = {
  type: "object",
  properties: {
    level: { type: "string", enum: ["worker", "orchestrator"] },
    handoff: { type: "object" },
    contract: {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: D2_LIMITS.taskId.min, maxLength: D2_LIMITS.taskId.max },
        writeScope: {
          type: "array",
          items: {
            type: "string",
            minLength: D2_LIMITS.fileScope.min,
            maxLength: D2_LIMITS.fileScope.max,
            pattern: RELATIVE_REPO_PATH_PATTERN,
          },
        },
        requiredCommands: {
          type: "array",
          items: {
            type: "string",
            minLength: D2_LIMITS.verificationCommand.min,
            maxLength: D2_LIMITS.verificationCommand.max,
          },
        },
        reviewRequired: { type: "boolean" },
      },
      required: ["taskId", "writeScope", "requiredCommands", "reviewRequired"],
      additionalProperties: false,
    },
  },
  required: ["level", "handoff", "contract"],
  additionalProperties: false,
} as const

const admissionInput = {
  type: "object",
  properties: {
    // The model-facing enum mirrors the runtime vocabulary exactly; the
    // runtime Zod schema (ADMISSION_INPUT_SCHEMA) stays the single authority.
    from: { type: "string", enum: ADMISSION_STATES },
    signal: {
      type: "object",
      properties: {
        action: { type: "string", enum: ADMISSION_ACTIONS },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
        reviewRequired: { type: "boolean" },
        humanDecision: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  required: ["from", "signal"],
  additionalProperties: false,
} as const