import { stat } from "node:fs/promises"
import type { OrchestratorOptions } from "../../core/config.js"
import { ORCHESTRATION_TOOL_PERMISSION } from "../../core/permissions.js"
import { ADMISSION_ACTIONS, ADMISSION_INPUT_SCHEMA, ADMISSION_STATES, transitionAdmission } from "../../core/admission.js"
import { D4_PARALLELISM_VALUES, classifyTaskComplexity } from "../../core/d4.js"
import { D2_LIMITS, RELATIVE_REPO_PATH_PATTERN } from "../../core/contracts.js"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"
import { resolveRealpath } from "../worktree/git.js"
import { HANDOFF_CHECK_IDS, HANDOFF_CONTRACT_SCHEMA, runHandoffHint, validateHandoff, type HandoffContract, type HandoffValidationResult, type SessionLocation, type ValidationDeps } from "./validation.js"
import type { GenerationHintRecord } from "../observability/trace.js"
import {
  LEAD_BOARD_LIMITATIONS,
  LEAD_MAX_CHECK_IDS,
  LEAD_ROLES,
  LEAD_SHA_PATTERN,
  assignLeadTaskOwner,
  boardCompletionEligible,
  boardUnfinishedTasks,
  boundedBoardText,
  completeLeadBoard,
  createLeadBoard,
  createLeadTask,
  hydrateLeadBoard,
  leadBoardKeyedLocation,
  leadBoardStorageKey,
  normalizeEvidenceRef,
  normalizeScopePacket,
  parseLeadBoard,
  parseReplayDescriptor,
  projectLeadBoard,
  transitionLeadTask,
  writeLeadBoard,
  type EvidenceRef,
  type LeadBoard,
  type LeadRole,
  type LeadTask,
  type LeadTaskValidation,
  type LeadTransitionAction,
} from "./lead-board.js"
import { goalStorageKey, readGoal, withSessionLock, type LocationLike, type StorageLike } from "../goal/state.js"
import { readReviewRecord } from "../observability/runtime.js"
import { validateApprovedReviewRevision } from "../observability/review.js"
import { listVerificationReceipts } from "../verification/state.js"

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
  location: LocationLike
  /** Durable storage for the lead-board tools; plugin wiring passes context.storage. */
  storage: StorageLike
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

  draft.add({
    name: "lead_board_get",
    description:
      "Read the durable lead board for this session as a bounded projection (task statuses, versions, attempts, scopes, replay summary). Orchestrator-only, lead-only, read-only: never raw step receipts, transcripts, or provider output. A missing board is board-missing (legacy); a malformed board is board-unavailable and is never repaired or dispatched from.",
    input: boardGetInput,
    options: { namespace: "orchestrator", permission: ORCHESTRATION_TOOL_PERMISSION },
    execute: async (_input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      return resultContent(JSON.stringify(await boardProjection(deps, tool.sessionID)))
    },
  })

  draft.add({
    name: "lead_board_init",
    description:
      "Explicitly enroll the current goal generation on its durable lead board. Creates a deterministic board with one planned root lead task when absent; replaces it only when the goal generation changed; leaves a same-generation ledger untouched. Orchestrator-only and lead-only.",
    input: boardInitInput,
    options: { namespace: "orchestrator", permission: ORCHESTRATION_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      return resultContent(JSON.stringify(await initLeadBoardTool(deps, tool.sessionID, input)))
    },
  })

  draft.add({
    name: "lead_board_task_create",
    description:
      "Create one child task on the durable lead board with a strict bounded validator (task id pattern, title, owner role/session, normalized advisory scope, existing dependencies, task cap). Orchestrator-only and lead-only; every task starts planned. Scope packets are advisory, not isolation.",
    input: boardTaskCreateInput,
    options: { namespace: "orchestrator", permission: ORCHESTRATION_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      return resultContent(JSON.stringify(await createLeadBoardTaskTool(deps, tool.sessionID, input)))
    },
  })

  draft.add({
    name: "lead_board_task_assign",
    description:
      "Assign the owner (role/session) of one non-completed task on the durable lead board. Requires the task id plus its expected lifecycle version; bumps both versions once. Orchestrator-only and lead-only.",
    input: boardTaskAssignInput,
    options: { namespace: "orchestrator", permission: ORCHESTRATION_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      return resultContent(JSON.stringify(await assignLeadBoardTaskTool(deps, tool.sessionID, input)))
    },
  })

  draft.add({
    name: "lead_board_transition",
    description:
      "Apply one lead-only lifecycle transition to a board task with the task id and its expected lifecycle version. Actions: ready, reserve, deliver, report, fail, ambiguous, validate, complete, request-changes, block, requeue, adopt, reconcile, record-replay. validate runs the unchanged D2 validator (orchestrator level) on the unchanged envelope and records bounded check identities + revision; complete additionally requires an approved exact-revision review for the same revision. Workers are rejected; worker-reported completion is never accepted as completion.",
    input: boardTransitionInput,
    options: { namespace: "orchestrator", permission: ORCHESTRATION_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      return resultContent(JSON.stringify(await transitionLeadBoardTool(deps, validationDeps, tool.sessionID, input)))
    },
  })

  draft.add({
    name: "lead_board_complete",
    description:
      "Complete the durable lead board and its goal generation only when every task is completed, the aggregate D2 verification passes in the lead context, an approved exact-revision review matches the same revision, and the goal identity is unchanged under the same lock. Pause/replacement/deletion/identity change cancels. Orchestrator-only and lead-only; the board is immutable afterward.",
    input: boardCompleteInput,
    options: { namespace: "orchestrator", permission: ORCHESTRATION_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      return resultContent(JSON.stringify(await completeLeadBoardTool(deps, validationDeps, tool.sessionID, input)))
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
    orchestratorAgentID: deps.options.orchestrator,
    verificationReceipts: async (rootSessionID, receiptIDs) =>
      (await listVerificationReceipts(deps.storage, deps.location, rootSessionID, receiptIDs)).map((receipt) => ({
        receiptID: receipt.receiptID,
        rootSessionID: receipt.rootSessionID,
        sessionID: receipt.sessionID,
        agentID: receipt.agentID,
        commandDigest: receipt.commandDigest,
        status: receipt.status,
        completedAt: receipt.completedAt,
        headSha: receipt.repository.headSha,
      })),
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
/* Lead board tool implementations (durable ledger, lead-only)         */
/* ------------------------------------------------------------------ */

const BOARD_TOOL_ACTIONS: readonly LeadTransitionAction[] = [
  "ready",
  "report",
  "fail",
  "ambiguous",
  "validate",
  "complete",
  "request-changes",
  "block",
  "requeue",
  "adopt",
  "reconcile",
  "record-replay",
]

type BoardRead =
  | { status: "ok"; board: LeadBoard; keyedLocation: LocationLike }
  | { status: "missing"; key: string }
  | { status: "unavailable"; key: string; issues: string[]; warning?: string }

async function readBoard(deps: OrchestrationToolsDeps, sessionID: string): Promise<BoardRead> {
  const hydration = await hydrateLeadBoard(deps.storage, deps.location, sessionID)
  if (hydration.status === "ok" && hydration.board) {
    return {
      status: "ok",
      board: hydration.board,
      keyedLocation: await leadBoardKeyedLocation(deps.storage, deps.location, sessionID),
    }
  }
  if (hydration.status === "missing") return { status: "missing", key: hydration.key }
  return {
    status: "unavailable",
    key: hydration.key,
    issues: hydration.issues.slice(0, 8),
    ...(hydration.warning !== undefined ? { warning: hydration.warning } : {}),
  }
}

function boardRefusal(reason: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "refused",
    reason,
    message: boundedBoardText(message, 300),
    ...extra,
    limitations: LEAD_BOARD_LIMITATIONS,
  }
}

async function boardProjection(deps: OrchestrationToolsDeps, sessionID: string): Promise<Record<string, unknown>> {
  const read = await readBoard(deps, sessionID)
  if (read.status === "missing") {
    return { status: "missing", key: read.key, limitations: LEAD_BOARD_LIMITATIONS }
  }
  if (read.status === "unavailable") {
    return {
      status: "unavailable",
      key: read.key,
      issues: read.issues,
      ...(read.warning !== undefined ? { warning: read.warning } : {}),
      limitations: LEAD_BOARD_LIMITATIONS,
    }
  }
  return {
    status: "ok",
    key: leadBoardStorageKey(read.keyedLocation, sessionID),
    board: projectLeadBoard(read.board),
    limitations: LEAD_BOARD_LIMITATIONS,
  }
}

async function initLeadBoardTool(
  deps: OrchestrationToolsDeps,
  sessionID: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  return withSessionLock(deps.location, sessionID, async () => {
    const keyedLocation = await leadBoardKeyedLocation(deps.storage, deps.location, sessionID)
    const goal = await readGoal(deps.storage, goalStorageKey(keyedLocation, sessionID))
    if (!goal) {
      return boardRefusal("no-goal", "no goal is set for this session; set one with /goal first")
    }
    const expected = numberField(input, "goalGeneration")
    if (expected !== undefined && expected !== goal.createdAt) {
      return boardRefusal("goal-generation-mismatch", "the requested goal generation is not the current goal; re-read the goal first")
    }
    const key = leadBoardStorageKey(keyedLocation, sessionID)
    const existing = parseLeadBoard(await deps.storage.get(key))
    if (existing && existing.goalGeneration === goal.createdAt) {
      return { status: "exists", key, board: projectLeadBoard(existing), limitations: LEAD_BOARD_LIMITATIONS }
    }
    const board = createLeadBoard({
      projectID: keyedLocation.project.id,
      leadSessionID: sessionID,
      goalGeneration: goal.createdAt,
      objective: goal.objective,
    })
    await writeLeadBoard(deps.storage, keyedLocation, board)
    return { status: "created", key, board: projectLeadBoard(board), limitations: LEAD_BOARD_LIMITATIONS }
  })
}

async function createLeadBoardTaskTool(
  deps: OrchestrationToolsDeps,
  sessionID: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  return withSessionLock(deps.location, sessionID, async () => {
    const read = await readBoard(deps, sessionID)
    if (read.status !== "ok") return boardRefusal(read.status, `no usable board: ${read.status}`)
    if (sessionID !== read.board.leadSessionID) {
      return boardRefusal("actor-mismatch", "only the board's lead session may create tasks")
    }
    if (read.board.status !== "active") return boardRefusal("board-not-active", `the board is ${read.board.status}`)
    const expectedRevision = numberField(input, "expectedBoardRevision")
    if (expectedRevision === undefined || expectedRevision !== read.board.boardRevision) {
      return boardRefusal(
        "version-mismatch",
        `board revision is ${read.board.boardRevision}, not the expected ${expectedRevision ?? "missing"}; re-read and retry`,
      )
    }
    const root = stringField(input, "root")
    const scope = normalizeScopePacket({
      ...(root === "project" || root === "managed-worktree" ? { root } : {}),
      readPaths: arrayField(input, "readPaths"),
      writePaths: arrayField(input, "writePaths"),
      broad: recordField(input)?.broad === true,
    })
    if (!scope.ok) return boardRefusal("invalid-scope", `scope rejected: ${scope.reason}`)
    const ownerSessionID = stringField(input, "ownerSessionID")
    const ownerRole = stringField(input, "ownerRole")
    if (!ownerSessionID || !(LEAD_ROLES as readonly string[]).includes(ownerRole)) {
      return boardRefusal("invalid-owner", "ownerSessionID and a valid ownerRole are required")
    }
    const created = createLeadTask(read.board, {
      taskID: stringField(input, "taskID"),
      title: stringField(input, "title"),
      owner: { sessionID: ownerSessionID, role: ownerRole as LeadRole },
      scope,
      dependencies: arrayField(input, "dependencies"),
    })
    if (!created.ok) {
      return boardRefusal("invalid-task", "task rejected by the strict validator", { issues: created.issues.slice(0, 16) })
    }
    const next: LeadBoard = {
      ...read.board,
      tasks: [...read.board.tasks, created.task],
      boardRevision: read.board.boardRevision + 1,
      updatedAt: Date.now(),
    }
    await writeLeadBoard(deps.storage, read.keyedLocation, next)
    return {
      status: "created",
      key: leadBoardStorageKey(read.keyedLocation, sessionID),
      taskID: created.task.taskID,
      board: projectLeadBoard(next),
      limitations: LEAD_BOARD_LIMITATIONS,
    }
  })
}

async function assignLeadBoardTaskTool(
  deps: OrchestrationToolsDeps,
  sessionID: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const taskID = stringField(input, "taskID")
  const expectedVersion = numberField(input, "expectedVersion")
  const ownerSessionID = stringField(input, "ownerSessionID")
  const ownerRole = stringField(input, "ownerRole")
  if (!taskID || expectedVersion === undefined || !ownerSessionID || !(LEAD_ROLES as readonly string[]).includes(ownerRole)) {
    return boardRefusal("invalid-input", "taskID, expectedVersion, ownerSessionID, and a valid ownerRole are required")
  }
  return withSessionLock(deps.location, sessionID, async () => {
    const read = await readBoard(deps, sessionID)
    if (read.status !== "ok") return boardRefusal(read.status, `no usable board: ${read.status}`)
    const assigned = assignLeadTaskOwner({
      board: read.board,
      taskID,
      expectedVersion,
      actorSessionID: sessionID,
      owner: { sessionID: ownerSessionID, role: ownerRole as LeadRole },
    })
    if (!assigned.ok) return boardRefusal(assigned.reason, assigned.message)
    await writeLeadBoard(deps.storage, read.keyedLocation, assigned.board)
    return {
      status: "assigned",
      key: leadBoardStorageKey(read.keyedLocation, sessionID),
      taskID,
      owner: assigned.task.owner,
      board: projectLeadBoard(assigned.board),
      limitations: LEAD_BOARD_LIMITATIONS,
    }
  })
}

async function transitionLeadBoardTool(
  deps: OrchestrationToolsDeps,
  validationDeps: ValidationDeps,
  sessionID: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const action = stringField(input, "action") as LeadTransitionAction
  const taskID = stringField(input, "taskID")
  const expectedVersion = numberField(input, "expectedVersion")
  if (!(BOARD_TOOL_ACTIONS as readonly string[]).includes(action) || !taskID || expectedVersion === undefined) {
    return boardRefusal("invalid-input", "action, taskID, and expectedVersion are required")
  }
  const evidence = parseEvidenceInput(input)
  if (!evidence.ok) return boardRefusal("invalid-evidence", "every evidence entry must be a bounded, safe ref")
  const note = optionalString(input, "note")
  const cursor = optionalString(input, "cursor")
  const replayRaw = recordField(input)?.replay
  const replay = replayRaw !== undefined ? parseReplayDescriptor(replayRaw) : undefined
  if (action === "record-replay" && !replay) {
    return boardRefusal("invalid-input", "record-replay requires a valid replay descriptor")
  }
  if (action === "validate") {
    return runBoardValidateTool(deps, validationDeps, sessionID, input, taskID, expectedVersion, evidence.value)
  }
  return withSessionLock(deps.location, sessionID, async () => {
    const read = await readBoard(deps, sessionID)
    if (read.status !== "ok") return boardRefusal(read.status, `no usable board: ${read.status}`)
    if (action === "complete") {
      const task = read.board.tasks.find((candidate) => candidate.taskID === taskID)
      if (!task) return boardRefusal("task-missing", `no task ${taskID} exists on this board`)
      if (task.lifecycleVersion !== expectedVersion) {
        return boardRefusal("version-mismatch", `task ${taskID} is at lifecycle version ${task.lifecycleVersion}, not ${expectedVersion}`)
      }
      if (!task.validation) {
        return boardRefusal("missing-validation", "completion requires a persisted lead validation on this lifecycle")
      }
      if (task.validation.receiptIDs === undefined) {
        return boardRefusal(
          "missing-verification-receipts",
          "this legacy validation has no plugin-observed receipt IDs; validate the task again before completion",
        )
      }
      const review = await readReviewRecord(deps.storage, deps.location, sessionID)
      const check = validateApprovedReviewRevision({
        record: review,
        headSha: task.validation.revision,
        baseSha: review?.baseSha ?? "",
      })
      if (!check.valid || !LEAD_SHA_PATTERN.test(task.validation.revision)) {
        return boardRefusal(check.valid ? "invalid-revision" : check.verdict, check.message)
      }
      const applied = transitionLeadTask({
        board: read.board,
        taskID,
        expectedVersion,
        actorSessionID: sessionID,
        action: "complete",
        review: {
          reference: `review/${review!.taskId}/${review!.runId}`,
          revision: task.validation.revision,
          approvedAt: review!.updatedAt,
        },
      })
      if (!applied.ok) return boardRefusal(applied.reason, applied.message)
      await writeLeadBoard(deps.storage, read.keyedLocation, applied.board)
      return {
        status: "applied",
        key: leadBoardStorageKey(read.keyedLocation, sessionID),
        message: applied.message,
        board: projectLeadBoard(applied.board),
        limitations: LEAD_BOARD_LIMITATIONS,
      }
    }
    const applied = transitionLeadTask({
      board: read.board,
      taskID,
      expectedVersion,
      actorSessionID: sessionID,
      action,
      ...(evidence.value.length > 0 ? { evidence: evidence.value } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(replay !== undefined ? { replay } : {}),
    })
    if (!applied.ok) return boardRefusal(applied.reason, applied.message)
    await writeLeadBoard(deps.storage, read.keyedLocation, applied.board)
    return {
      status: "applied",
      key: leadBoardStorageKey(read.keyedLocation, sessionID),
      message: applied.message,
      board: projectLeadBoard(applied.board),
      limitations: LEAD_BOARD_LIMITATIONS,
    }
  })
}

async function runBoardValidateTool(
  deps: OrchestrationToolsDeps,
  validationDeps: ValidationDeps,
  sessionID: string,
  input: unknown,
  taskID: string,
  expectedVersion: number,
  evidence: EvidenceRef[],
): Promise<Record<string, unknown>> {
  const contract = parseContractInput(recordField(input)?.contract)
  if (!contract) return boardRefusal("invalid-contract", "a strict D2 contract { taskId, writeScope, requiredCommands, reviewRequired } is required")
  if (contract.taskId !== taskID) return boardRefusal("contract-mismatch", "contract.taskId must equal the board task id")
  const checksInput = recordField(input)?.checks
  const checks = checksInput === undefined ? { ok: true as const, value: [] as Array<{ id: string; verdict: "pass" | "fail" }> } : parseCheckInput(checksInput)
  if (!checks.ok) return boardRefusal("invalid-checks", "checks must be an array of { id, verdict: pass|fail }")
  if (checks.value.some((check) => check.verdict === "fail")) return boardRefusal("check-failed", "a supplied check failed; record request-changes or failed instead of validating")
  const receiptIDs = arrayField(input, "receiptIDs")
  if (contract.requiredCommands.length > 0 && receiptIDs.length === 0) {
    return boardRefusal("missing-verification-receipts", "every required command needs plugin-observed receiptIDs; caller-supplied check verdicts are not proof")
  }
  const revision = stringField(input, "revision")
  if (!LEAD_SHA_PATTERN.test(revision)) {
    return boardRefusal("invalid-revision", "revision must be the exact full lowercase head commit SHA")
  }

  // Pre-read (no lock held while the D2 validator runs): actor, task, and the
  // contract scope must match before any expensive work.
  const pre = await readBoard(deps, sessionID)
  if (pre.status !== "ok") return boardRefusal(pre.status, `no usable board: ${pre.status}`)
  if (sessionID !== pre.board.leadSessionID) return boardRefusal("actor-mismatch", "only the board's lead session may validate a task")
  const preTask = pre.board.tasks.find((candidate) => candidate.taskID === taskID)
  if (!preTask || preTask.lifecycleVersion !== expectedVersion) {
    return boardRefusal("version-mismatch", "the task is missing or no longer at the expected lifecycle version; re-read and retry")
  }
  if (preTask.status !== "awaiting-validation") {
    return boardRefusal("invalid-transition", `task ${taskID} cannot validate from ${preTask.status}`)
  }
  const scopeIssue = validateContractScope(preTask, contract)
  if (scopeIssue) return boardRefusal("contract-scope", scopeIssue)

  // The parent-side D2 validator runs in the lead context. Required commands
  // are accepted only when receipt IDs match plugin-observed shell calls at
  // this task's exact revision; caller-supplied checks remain diagnostic.
  const result = await validateHandoff(
    {
      level: "orchestrator",
      handoff: recordField(input)?.handoff,
      contract,
      ...(receiptIDs.length > 0 ? { receiptIDs } : {}),
      revision,
      minimumCompletedAt: preTask.updatedAt,
    },
    validationDeps,
    sessionID,
  )
  const failures = result.checks.filter((check) => check.verdict === "fail")
  const blockers = result.checks.filter((check) => check.verdict === "blocked-unknown")
  if (failures.length > 0 || blockers.length > 0) {
    return boardRefusal("validation-failed", "the unchanged D2 validator did not pass in the lead context", {
      checks: [...failures, ...blockers].slice(0, 8).map((check) => `${check.id}:${check.verdict}`),
    })
  }
  const checkIDs = [...result.checks.map((check) => `${check.id}:${check.verdict}`), ...checks.value.map((check) => `${check.id}:${check.verdict}`)]
    .slice(0, LEAD_MAX_CHECK_IDS)
    .map((value) => boundedBoardText(value, 128))
  const validation: LeadTaskValidation = {
    leadSessionID: sessionID,
    validatedAt: Date.now(),
    revision,
    checkIDs,
    receiptIDs,
  }

  // Locked re-check + persist: a concurrent writer that moved the task is a
  // stale-writer refusal, never a retry.
  return withSessionLock(deps.location, sessionID, async () => {
    const read = await readBoard(deps, sessionID)
    if (read.status !== "ok") return boardRefusal(read.status, `no usable board: ${read.status}`)
    const applied = transitionLeadTask({
      board: read.board,
      taskID,
      expectedVersion,
      actorSessionID: sessionID,
      action: "validate",
      validation,
      ...(evidence.length > 0 ? { evidence } : {}),
    })
    if (!applied.ok) return boardRefusal(applied.reason, applied.message)
    await writeLeadBoard(deps.storage, read.keyedLocation, applied.board)
    return {
      status: "applied",
      key: leadBoardStorageKey(read.keyedLocation, sessionID),
      message: applied.message,
      board: projectLeadBoard(applied.board),
      limitations: LEAD_BOARD_LIMITATIONS,
    }
  })
}

async function completeLeadBoardTool(
  deps: OrchestrationToolsDeps,
  validationDeps: ValidationDeps,
  sessionID: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const expectedRevision = numberField(input, "expectedBoardRevision")
  const revision = stringField(input, "revision")
  const contract = parseContractInput(recordField(input)?.contract)
  const checksInput = recordField(input)?.checks
  const checks = checksInput === undefined ? { ok: true as const, value: [] as Array<{ id: string; verdict: "pass" | "fail" }> } : parseCheckInput(checksInput)
  if (expectedRevision === undefined || !LEAD_SHA_PATTERN.test(revision) || !contract || !checks.ok) {
    return boardRefusal("invalid-input", "expectedBoardRevision, an exact revision SHA, and a strict contract are required")
  }
  if (checks.value.some((check) => check.verdict === "fail")) {
    return boardRefusal("check-failed", "a supplied check failed; the board cannot complete")
  }
  const receiptIDs = arrayField(input, "receiptIDs")
  if (contract.requiredCommands.length > 0 && receiptIDs.length === 0) {
    return boardRefusal("missing-verification-receipts", "every required command needs plugin-observed receiptIDs; caller-supplied check verdicts are not proof")
  }
  const pre = await readBoard(deps, sessionID)
  if (pre.status !== "ok") return boardRefusal(pre.status, `no usable board: ${pre.status}`)
  if (sessionID !== pre.board.leadSessionID) return boardRefusal("actor-mismatch", "only the board's lead session may complete the board")
  if (!boardCompletionEligible(pre.board)) {
    return boardRefusal("board-incomplete", "every task must be completed with none ambiguous/blocked/failed", {
      unfinished: boardUnfinishedTasks(pre.board).slice(0, 16).map((task) => `${task.taskID}:${task.status}`),
    })
  }
  if (contract.taskId !== pre.board.boardID) {
    return boardRefusal("contract-mismatch", "the aggregate contract taskId must equal the board id")
  }
  const result = await validateHandoff(
    {
      level: "orchestrator",
      handoff: recordField(input)?.handoff,
      contract,
      ...(receiptIDs.length > 0 ? { receiptIDs } : {}),
      revision,
    },
    validationDeps,
    sessionID,
  )
  const failures = result.checks.filter((check) => check.verdict === "fail")
  const blockers = result.checks.filter((check) => check.verdict === "blocked-unknown")
  if (failures.length > 0 || blockers.length > 0) {
    return boardRefusal("validation-failed", "the aggregate D2 verification did not pass in the lead context", {
      checks: [...failures, ...blockers].slice(0, 8).map((check) => `${check.id}:${check.verdict}`),
    })
  }
  const review = await readReviewRecord(deps.storage, deps.location, sessionID)
  const reviewCheck = validateApprovedReviewRevision({ record: review, headSha: revision, baseSha: review?.baseSha ?? "" })
  if (!reviewCheck.valid) {
    return boardRefusal(reviewCheck.verdict, `aggregate completion requires an approved exact-revision review: ${reviewCheck.message}`)
  }
  const reviewReference = `review/${review!.taskId}/${review!.runId}`

  return withSessionLock(deps.location, sessionID, async () => {
    const read = await readBoard(deps, sessionID)
    if (read.status !== "ok") return boardRefusal(read.status, `no usable board: ${read.status}`)
    if (read.board.boardRevision !== expectedRevision) {
      return boardRefusal("version-mismatch", `board revision is ${read.board.boardRevision}, not the expected ${expectedRevision}`)
    }
    if (!boardCompletionEligible(read.board)) {
      return boardRefusal("board-incomplete", "the board changed and is no longer completion-eligible")
    }
    // Goal identity is re-read under the same lock: a pause, replacement,
    // deletion, or generation change between verification and write cancels it.
    const goalKey = goalStorageKey(read.keyedLocation, sessionID)
    const goal = await readGoal(deps.storage, goalKey)
    if (!goal || goal.status !== "active" || goal.createdAt !== read.board.goalGeneration) {
      return boardRefusal("goal-identity-changed", "the goal was paused, replaced, deleted, or its generation changed; completion cancelled")
    }
    const now = Date.now()
    const completed = completeLeadBoard(read.board, {
      revision,
      reviewReference,
      validatedAt: now,
      evidence: [
        {
          kind: "receipt",
          reference: read.board.boardID,
          description: "aggregate D2 verification passed in the lead context",
          observedAt: now,
        },
        {
          kind: "review",
          reference: reviewReference,
          description: "approved exact-revision aggregate review",
          observedAt: now,
        },
      ],
    })
    await writeLeadBoard(deps.storage, read.keyedLocation, completed)
    try {
      await deps.storage.set(goalKey, {
        ...goal,
        status: "complete",
        completedAt: now,
        updatedAt: now,
        completionEvidence: boundedBoardText(
          `lead board ${read.board.boardID} completed at revision ${revision}; review ${reviewReference}; ${read.board.tasks.length} tasks`,
          512,
        ),
      })
    } catch (error) {
      // The goal write is the last step: restore the pre-completion board so a
      // complete board never sits under an active goal generation.
      await writeLeadBoard(deps.storage, read.keyedLocation, read.board).catch(() => undefined)
      return boardRefusal("goal-write-failed", "the goal completion write failed; the board was left active")
    }
    return {
      status: "complete",
      key: leadBoardStorageKey(read.keyedLocation, sessionID),
      boardID: read.board.boardID,
      revision,
      reviewReference,
      board: projectLeadBoard(completed),
      limitations: LEAD_BOARD_LIMITATIONS,
    }
  })
}

function validateContractScope(task: LeadTask, contract: HandoffContract): string | undefined {
  if (task.scope.broad) return undefined
  for (const raw of contract.writeScope) {
    const path = raw.replaceAll("\\", "/").replace(/\/+$/, "")
    const within = task.scope.writePaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))
    if (!within) {
      return `contract write scope ${boundedBoardText(path, 64)} is outside the task's declared write scope`
    }
  }
  return undefined
}

function parseContractInput(value: unknown): HandoffContract | undefined {
  const parsed = HANDOFF_CONTRACT_SCHEMA.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function parseCheckInput(value: unknown): { ok: true; value: Array<{ id: string; verdict: "pass" | "fail" }> } | { ok: false } {
  if (!Array.isArray(value) || value.length > 32) return { ok: false }
  const checks: Array<{ id: string; verdict: "pass" | "fail" }> = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false }
    const id = (item as { id?: unknown }).id
    const verdict = (item as { verdict?: unknown }).verdict
    if (typeof id !== "string" || id.trim().length === 0 || id.length > 500) return { ok: false }
    if (verdict !== "pass" && verdict !== "fail") return { ok: false }
    checks.push({ id: id.trim(), verdict })
  }
  return { ok: true, value: checks }
}

function parseEvidenceInput(input: unknown): { ok: true; value: EvidenceRef[] } | { ok: false } {
  const raw = recordField(input)?.evidence
  if (raw === undefined) return { ok: true, value: [] }
  if (!Array.isArray(raw) || raw.length > 32) return { ok: false }
  const now = Date.now()
  const refs: EvidenceRef[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false }
    const kind = (item as { kind?: unknown }).kind
    const reference = (item as { reference?: unknown }).reference
    const description = (item as { description?: unknown }).description
    const observedAt = (item as { observedAt?: unknown }).observedAt
    if (typeof kind !== "string" || typeof reference !== "string" || typeof description !== "string") return { ok: false }
    const normalized = normalizeEvidenceRef({
      kind: kind as EvidenceRef["kind"],
      reference,
      description,
      observedAt: typeof observedAt === "number" && Number.isFinite(observedAt) ? observedAt : now,
    })
    if (!normalized) return { ok: false }
    refs.push(normalized)
  }
  return { ok: true, value: refs }
}

function optionalString(input: unknown, key: string): string | undefined {
  const value = recordField(input)?.[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function recordField(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function stringField(input: unknown, key: string): string {
  const value = recordField(input)?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function numberField(input: unknown, key: string): number | undefined {
  const value = recordField(input)?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function arrayField(input: unknown, key: string): string[] {
  const value = recordField(input)?.[key]
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
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
    receiptIDs: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 128 } },
    revision: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
    minimumCompletedAt: { type: "number", minimum: 0 },
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

/* Lead board tool schemas: bounded model-facing shapes; the lead-board Zod
   schemas remain the single runtime authority (no schema-bypass casts). */

const boardIdJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9][a-z0-9._/-]{0,127}$",
} as const

const boardHandoffContractJsonSchema = {
  type: "object",
  properties: {
    taskId: { type: "string", minLength: 1, maxLength: 128 },
    writeScope: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 2000, pattern: RELATIVE_REPO_PATH_PATTERN },
    },
    requiredCommands: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    reviewRequired: { type: "boolean" },
  },
  required: ["taskId", "writeScope", "requiredCommands", "reviewRequired"],
  additionalProperties: false,
} as const

const boardEvidenceJsonSchema = {
  type: "array",
  maxItems: 32,
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["file", "url", "command", "receipt", "review"] },
      reference: { type: "string", minLength: 1, maxLength: 512 },
      description: { type: "string", minLength: 1, maxLength: 512 },
      observedAt: { type: "number", minimum: 0 },
    },
    required: ["kind", "reference", "description"],
    additionalProperties: false,
  },
} as const

const boardChecksJsonSchema = {
  type: "array",
  maxItems: 32,
  items: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, maxLength: 500 },
      verdict: { type: "string", enum: ["pass", "fail"] },
    },
    required: ["id", "verdict"],
    additionalProperties: false,
  },
} as const

const boardGetInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const boardInitInput = {
  type: "object",
  properties: {
    goalGeneration: { type: "number", minimum: 0 },
  },
  additionalProperties: false,
} as const

const boardTaskCreateInput = {
  type: "object",
  properties: {
    expectedBoardRevision: { type: "number", minimum: 1 },
    taskID: boardIdJsonSchema,
    title: { type: "string", minLength: 1, maxLength: 1000 },
    ownerSessionID: { type: "string", minLength: 1, maxLength: 512 },
    ownerRole: { type: "string", enum: LEAD_ROLES },
    readPaths: { type: "array", maxItems: 128, items: { type: "string", minLength: 1, maxLength: 512 } },
    writePaths: { type: "array", maxItems: 128, items: { type: "string", minLength: 1, maxLength: 512 } },
    broad: { type: "boolean" },
    root: { type: "string", enum: ["project", "managed-worktree"] },
    dependencies: { type: "array", maxItems: 128, items: boardIdJsonSchema },
  },
  required: ["expectedBoardRevision", "taskID", "title", "ownerSessionID", "ownerRole"],
  additionalProperties: false,
} as const

const boardTaskAssignInput = {
  type: "object",
  properties: {
    taskID: boardIdJsonSchema,
    expectedVersion: { type: "number", minimum: 1 },
    ownerSessionID: { type: "string", minLength: 1, maxLength: 512 },
    ownerRole: { type: "string", enum: LEAD_ROLES },
  },
  required: ["taskID", "expectedVersion", "ownerSessionID", "ownerRole"],
  additionalProperties: false,
} as const

const boardTransitionInput = {
  type: "object",
  properties: {
    taskID: boardIdJsonSchema,
    expectedVersion: { type: "number", minimum: 1 },
    action: {
      type: "string",
      enum: [
        "ready",
        "report",
        "fail",
        "ambiguous",
        "validate",
        "complete",
        "request-changes",
        "block",
        "requeue",
        "adopt",
        "reconcile",
        "record-replay",
      ],
    },
    evidence: boardEvidenceJsonSchema,
    note: { type: "string", maxLength: 512 },
    cursor: { type: "string", maxLength: 512 },
    revision: { type: "string", maxLength: 512 },
    receiptIDs: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 128 } },
    handoff: { type: "object" },
    contract: boardHandoffContractJsonSchema,
    checks: boardChecksJsonSchema,
    replay: { type: "object" },
  },
  required: ["taskID", "expectedVersion", "action"],
  additionalProperties: false,
} as const

const boardCompleteInput = {
  type: "object",
  properties: {
    expectedBoardRevision: { type: "number", minimum: 1 },
    revision: { type: "string", maxLength: 512 },
    receiptIDs: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 128 } },
    handoff: { type: "object" },
    contract: boardHandoffContractJsonSchema,
    checks: boardChecksJsonSchema,
  },
  required: ["expectedBoardRevision", "revision", "handoff", "contract"],
  additionalProperties: false,
} as const
