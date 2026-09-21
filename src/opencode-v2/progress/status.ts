/**
 * Read-only orchestration progress RPC.
 *
 * The server plugin owns the storage joins in this module.  The CLI plugin
 * receives only this bounded projection through the typed RPC; it never gets
 * a storage handle and never imports a durable-state implementation.
 */
import type { OrchestratorOptions } from "../../core/config.js"
import { redactKnownPatterns } from "../process/redact.js"
import { configuredBudgetLimits, evaluateBudget, type BudgetDetail } from "../observability/budget.js"
import { usageTokensTotal, type TraceSummary } from "../observability/trace.js"
import type { ObservabilityRuntime } from "../observability/runtime.js"
import {
  LEAD_TASK_STATUSES,
  type LeadRole,
  type LeadTaskStatus,
} from "../orchestration/lead-board.js"
import { hydrateLeadBoardV2, type LeadBoardV2 } from "../orchestration/lead-board-v2.js"
import { goalStorageKey, parseGoalRecord, stableProjectID, type LocationLike, type StorageLike } from "../goal/state.js"
import { gateStatuses, type GateStatus } from "../gates/state.js"
import { parseReviewRecord, reviewStorageKey } from "../observability/review.js"
import { parseReviewV2Record, reviewV2StorageKey } from "../observability/review-v2.js"
import { publicationStatus } from "../publish/state.js"
import { worktreeSchema, worktreeStorageKey, type WorktreeStatus } from "../worktree/state.js"
import {
  PROGRESS_BRANCH_MAX,
  PROGRESS_MAX_LIMITATIONS,
  PROGRESS_MAX_TASKS,
  PROGRESS_OBJECTIVE_HINT_MAX,
  PROGRESS_TASK_TITLE_MAX,
  type ProgressBoardSummary,
  type ProgressBudgetCoverage,
  type ProgressBudgetDetail,
  type ProgressBudgetSummary,
  type ProgressGateSummary,
  type ProgressPublicationSummary,
  type ProgressTaskSummary,
  type ProgressView,
} from "./rpc.js"

export type ProgressBuildDeps = {
  storage: StorageLike
  location: LocationLike
  options: OrchestratorOptions
  observability?: Pick<ObservabilityRuntime, "summary" | "evaluation">
}

const BASE_LIMITATIONS = [
  "read-only metadata projection: no transcripts, prompts, command output, credentials, or raw storage records",
  "objective and task text is known-pattern-redacted and length-bounded",
  "budget coverage is observational; unknown coverage is never treated as zero",
  "publication and gate values describe capability policy only, not human identity",
] as const

/**
 * Builds the server-side projection.  Every state family is parsed before it
 * crosses the RPC boundary; a malformed or unavailable family is represented
 * as unknown and marks the projection incomplete rather than guessed.
 */
export async function buildProgressView(deps: ProgressBuildDeps, sessionID: string): Promise<ProgressView> {
  const limitations: string[] = [...BASE_LIMITATIONS]
  let complete = true
  const incomplete = (message: string): void => {
    complete = false
    if (limitations.length < PROGRESS_MAX_LIMITATIONS && !limitations.includes(message)) limitations.push(message)
  }

  let projectID = deps.location.project.id
  try {
    projectID = await stableProjectID(deps.storage, deps.location, sessionID)
  } catch {
    incomplete("stable project identity could not be resolved")
  }
  const keyedLocation = { ...deps.location, project: { id: projectID } }

  const goalResult = await readGoal(deps.storage, keyedLocation, sessionID)
  if (goalResult.kind === "error") incomplete("goal state could not be read")
  else if (goalResult.kind === "malformed") incomplete("goal state is malformed and was not interpreted")
  else if (goalResult.value === undefined) incomplete("goal state is not initialized")
  const goal = goalResult.value
    ? { status: goalResult.value.status, objectiveHint: boundedText(goalResult.value.objective, PROGRESS_OBJECTIVE_HINT_MAX) }
    : null

  const boardResult = await readBoard(deps.storage, keyedLocation, sessionID)
  if (boardResult.status === "unavailable") incomplete(boardResult.message ?? "lead board state is unavailable")
  else if (boardResult.status === "missing") incomplete("lead board is not initialized")
  else if (boardResult.status === "legacy") incomplete("legacy V1 lead board is readable but progress is not V2-complete")
  const board = boardResult.board
    ? summarizeBoard(boardResult.board, boardResult.status)
    : emptyBoard(boardResult.status === "unavailable" ? "unavailable" : boardResult.status === "legacy" ? "legacy" : "missing")
  if (boardResult.board && boardResult.board.tasks.length > PROGRESS_MAX_TASKS) {
    incomplete(`lead board task list is truncated at ${PROGRESS_MAX_TASKS} items`)
  }

  const reviewResult = await readReview(deps.storage, keyedLocation, sessionID)
  if (reviewResult.kind === "error") incomplete("review state could not be read")
  else if (reviewResult.kind === "malformed") incomplete("review state is malformed and was not interpreted")
  const review = reviewResult.value
    ? { state: reviewResult.value.kind === "v2" ? reviewResult.value.record.state : ("legacy-unproven" as const), round: reviewResult.value.record.round }
    : null

  const budget = await summarizeBudget(deps, sessionID, incomplete)

  const worktreeResult = await readWorktreeSummary(deps.storage, projectID, sessionID)
  if (worktreeResult.kind === "error") incomplete("worktree state could not be read")
  else if (worktreeResult.kind === "malformed") incomplete("worktree state is malformed and was not interpreted")
  else if (worktreeResult.kind === "missing" && deps.options.worktree.enabled) incomplete("managed worktree is not initialized")
  const worktree = worktreeResult.value
    ? { status: worktreeResult.value.status, branch: boundedText(worktreeResult.value.branch, PROGRESS_BRANCH_MAX) }
    : null

  let publication: ProgressPublicationSummary = { durableEnabled: false, configEnabled: deps.options.publish.enabled, capabilities: [] }
  try {
    const status = await publicationStatus(deps.storage, keyedLocation, sessionID, deps.options)
    publication = {
      durableEnabled: status.durable.enabled,
      configEnabled: status.config.enabled,
      capabilities: [...status.durable.capabilities],
    }
  } catch {
    incomplete("publication capability could not be read")
  }

  let gates: ProgressGateSummary = { statuses: [] }
  try {
    gates = { statuses: (await gateStatuses(deps.storage, keyedLocation, sessionID, deps.options)).map(toProgressGate) }
  } catch {
    incomplete("session gate state could not be read")
  }

  return {
    version: 1,
    sessionID,
    goal,
    board,
    ...(board.current ? { currentTask: board.current } : {}),
    ...(board.reserved ? { reservedTask: board.reserved } : {}),
    review,
    budget,
    worktree,
    publication,
    gates,
    complete,
    limitations: limitations.slice(0, PROGRESS_MAX_LIMITATIONS),
  }
}

async function readGoal(storage: StorageLike, location: LocationLike, sessionID: string): Promise<{ kind: "ok"; value: ReturnType<typeof parseGoalRecord> } | { kind: "malformed"; value?: undefined } | { kind: "error"; value?: undefined }> {
  try {
    const raw = await storage.get(goalStorageKey(location, sessionID))
    if (raw === undefined) return { kind: "ok", value: undefined }
    const value = parseGoalRecord(raw)
    return value ? { kind: "ok", value } : { kind: "malformed" }
  } catch {
    return { kind: "error" }
  }
}

async function readBoard(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
): Promise<{ status: "ok" | "legacy" | "missing" | "unavailable"; board?: LeadBoardV2; message?: string }> {
  const hydration = await hydrateLeadBoardV2(storage, location, sessionID)
  if (hydration.status === "ok" && hydration.board) return { status: "ok", board: hydration.board }
  if (hydration.status === "legacy" && hydration.board) return { status: "legacy", board: hydration.board }
  if (hydration.status === "missing") return { status: "missing" }
  return { status: "unavailable", message: hydration.warning ?? "lead board state is unavailable" }
}

type ReviewRead =
  | { kind: "v2"; record: ReturnType<typeof parseReviewV2Record> & {} }
  | { kind: "v1"; record: ReturnType<typeof parseReviewRecord> & {} }

async function readReview(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
): Promise<{ kind: "ok"; value?: ReviewRead } | { kind: "malformed"; value?: undefined } | { kind: "error"; value?: undefined }> {
  try {
    const v2Raw = await storage.get(reviewV2StorageKey(location, sessionID))
    if (v2Raw !== undefined) {
      const v2 = parseReviewV2Record(v2Raw)
      return v2 ? { kind: "ok", value: { kind: "v2", record: v2 } } : { kind: "malformed" }
    }
    const v1Raw = await storage.get(reviewStorageKey(location, sessionID))
    if (v1Raw === undefined) return { kind: "ok" }
    const v1 = parseReviewRecord(v1Raw)
    return v1 ? { kind: "ok", value: { kind: "v1", record: v1 } } : { kind: "malformed" }
  } catch {
    return { kind: "error" }
  }
}

async function summarizeBudget(
  deps: ProgressBuildDeps,
  sessionID: string,
  incomplete: (message: string) => void,
): Promise<ProgressBudgetSummary> {
  const configured = configuredBudgetLimits(deps.options.budget)
  if (configured.length === 0) {
    return {
      mode: deps.options.budget.mode,
      verdict: "within",
      coverage: "not-configured",
      observed: {},
      limits: [],
    }
  }

  let trace: TraceSummary | undefined
  let evaluation = evaluateBudget({ observed: {}, limits: deps.options.budget, mode: deps.options.budget.mode })
  try {
    if (deps.observability) {
      trace = await deps.observability.summary(sessionID)
      evaluation = await deps.observability.evaluation(sessionID)
    }
  } catch {
    incomplete("budget observation could not be read")
  }
  if (!trace) incomplete("budget coverage is unknown because no observation is available")

  const observed = trace
    ? {
        steps: trace.steps,
        ...(trace.usage ? { tokens: usageTokensTotal(trace.usage), costUsd: trace.usage.costUsd } : {}),
        retries: trace.retries,
        startedAt: trace.firstAt,
      }
    : {}
  const coverage: ProgressBudgetCoverage = !trace ? "unknown" : trace.pending > 0 || trace.droppedUnmatched > 0 ? "partial" : "complete"
  if (coverage === "partial") incomplete("budget observation has incomplete tool-event coverage")
  return {
    mode: deps.options.budget.mode,
    verdict: evaluation.verdict,
    coverage,
    observed,
    limits: evaluation.limits.map(toProgressBudgetDetail),
  }
}

async function readWorktreeSummary(
  storage: StorageLike,
  projectID: string,
  sessionID: string,
): Promise<{ kind: "ok"; value?: { status: WorktreeStatus; branch: string } } | { kind: "missing"; value?: undefined } | { kind: "malformed"; value?: undefined } | { kind: "error"; value?: undefined }> {
  try {
    const raw = await storage.get(worktreeStorageKey(projectID, sessionID))
    if (raw === undefined) return { kind: "missing" }
    const parsed = worktreeSchema.safeParse(raw)
    return parsed.success ? { kind: "ok", value: { status: parsed.data.status, branch: parsed.data.branch } } : { kind: "malformed" }
  } catch {
    return { kind: "error" }
  }
}

function summarizeBoard(board: LeadBoardV2, status: "ok" | "legacy" | "missing" | "unavailable"): ProgressBoardSummary {
  const counts = emptyCounts()
  for (const task of board.tasks) counts[task.status] += 1
  const tasks = board.tasks.slice(0, PROGRESS_MAX_TASKS).map(toTaskSummary)
  const currentTask = board.tasks.find((task) => task.status === "in-progress")
  const reservedTask = board.tasks.find((task) => task.status === "reserved")
  return {
    status: status === "ok" ? board.status : status,
    counts,
    total: board.tasks.length,
    completed: counts.completed,
    ...(currentTask ? { current: toTaskSummary(currentTask) } : {}),
    ...(reservedTask ? { reserved: toTaskSummary(reservedTask) } : {}),
    tasks,
  }
}

function emptyBoard(status: ProgressBoardSummary["status"]): ProgressBoardSummary {
  return { status, counts: emptyCounts(), total: 0, completed: 0, tasks: [] }
}

function emptyCounts(): Record<LeadTaskStatus, number> {
  return Object.fromEntries(LEAD_TASK_STATUSES.map((status) => [status, 0])) as Record<LeadTaskStatus, number>
}

function toTaskSummary(task: { title: string; status: LeadTaskStatus; owner: { role: LeadRole } }): ProgressTaskSummary {
  return { title: boundedText(task.title, PROGRESS_TASK_TITLE_MAX), status: task.status, role: task.owner.role }
}

function toProgressGate(status: GateStatus): ProgressGateSummary["statuses"][number] {
  return { gate: status.gate, enabled: status.enabled, ceiling: status.ceiling, sessionDisabled: status.sessionDisabled }
}

function toProgressBudgetDetail(detail: BudgetDetail): ProgressBudgetDetail {
  return {
    limit: detail.limit,
    status: detail.status,
    ...(detail.configured !== undefined ? { configured: detail.configured } : {}),
    ...(detail.observed !== undefined ? { observed: detail.observed } : {}),
  }
}

function boundedText(value: string, maxLength: number): string {
  const collapsed = redactKnownPatterns(value).replace(/\s+/g, " ").trim()
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, maxLength - 1)}…`
}
