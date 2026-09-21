/**
 * Pure client/server RPC contract for orchestration progress.
 *
 * This file intentionally has no storage imports.  The CLI plugin can import
 * the definition and parser while the server-only projection lives in
 * `progress/status.ts`.
 */

export const PROGRESS_RPC_ID = "opencode-orchestrator.progress"
export const PROGRESS_OBJECTIVE_HINT_MAX = 120
export const PROGRESS_TASK_TITLE_MAX = 96
export const PROGRESS_BRANCH_MAX = 120
export const PROGRESS_MAX_TASKS = 32
export const PROGRESS_MAX_LIMITATIONS = 16

export const PROGRESS_BOARD_STATUSES = ["active", "paused", "blocked", "complete", "legacy", "missing", "unavailable"] as const
export const PROGRESS_TASK_STATUSES = [
  "planned",
  "ready",
  "reserved",
  "in-progress",
  "awaiting-validation",
  "awaiting-review",
  "changes-requested",
  "ambiguous",
  "failed",
  "blocked",
  "completed",
] as const
export const PROGRESS_ROLES = ["lead", "planner", "explore", "implementer", "reviewer"] as const
export const PROGRESS_GATE_NAMES = ["push", "pr-draft-create", "pr-ready-transition", "approve-after-review", "merge", "github-mutations", "worktree-mutations"] as const
export const PROGRESS_REVIEW_STATES = ["pending", "approved", "changes-requested", "blocked", "tripped", "legacy-unproven"] as const
export const PROGRESS_BUDGET_LIMITS = ["max_steps", "max_tokens", "max_cost_usd", "max_wall_clock_ms", "max_retries"] as const
export const PROGRESS_PUBLICATION_CAPABILITIES = ["push", "pr-draft-create", "pr-ready-transition", "approve-after-review", "merge"] as const

export type ProgressTaskStatus = (typeof PROGRESS_TASK_STATUSES)[number]
export type ProgressRole = (typeof PROGRESS_ROLES)[number]
export type ProgressGateName = (typeof PROGRESS_GATE_NAMES)[number]
export type ProgressReviewState = (typeof PROGRESS_REVIEW_STATES)[number]
export type ProgressBudgetLimit = (typeof PROGRESS_BUDGET_LIMITS)[number]
export type ProgressPublicationCapability = (typeof PROGRESS_PUBLICATION_CAPABILITIES)[number]
export type ProgressBudgetMode = "advisory" | "stop-between-steps"
export type ProgressBudgetVerdict = "within" | "exceeded" | "unknown"
export type ProgressBudgetLimitStatus = "within" | "exceeded" | "unknown"

export type ProgressTaskSummary = {
  title: string
  status: ProgressTaskStatus
  role: ProgressRole
}

export type ProgressBoardSummary = {
  status: (typeof PROGRESS_BOARD_STATUSES)[number]
  counts: Record<ProgressTaskStatus, number>
  total: number
  completed: number
  current?: ProgressTaskSummary
  reserved?: ProgressTaskSummary
  tasks: ProgressTaskSummary[]
}

export type ProgressReviewSummary = {
  state: ProgressReviewState
  round: number
}

export type ProgressBudgetCoverage = "complete" | "partial" | "unknown" | "not-configured"

export type ProgressBudgetDetail = {
  limit: ProgressBudgetLimit
  status: ProgressBudgetLimitStatus
  configured?: number
  observed?: number
}

export type ProgressBudgetSummary = {
  mode: ProgressBudgetMode
  verdict: ProgressBudgetVerdict
  coverage: ProgressBudgetCoverage
  observed: {
    steps?: number
    tokens?: number
    costUsd?: number
    retries?: number
    startedAt?: number
  }
  limits: ProgressBudgetDetail[]
}

export type ProgressWorktreeSummary = {
  status: "pending" | "ready" | "moved" | "dirty" | "orphaned" | "cleanup-failed"
  branch: string
}

export type ProgressPublicationSummary = {
  durableEnabled: boolean
  configEnabled: boolean
  capabilities: ProgressPublicationCapability[]
}

export type ProgressGateSummary = {
  statuses: Array<{
    gate: ProgressGateName
    enabled: boolean
    ceiling: boolean
    sessionDisabled: boolean
  }>
}

export type ProgressView = {
  version: 1
  sessionID: string
  goal: { status: "active" | "paused" | "complete"; objectiveHint: string } | null
  board: ProgressBoardSummary
  currentTask?: ProgressTaskSummary
  reservedTask?: ProgressTaskSummary
  review: ProgressReviewSummary | null
  budget: ProgressBudgetSummary
  worktree: ProgressWorktreeSummary | null
  publication: ProgressPublicationSummary
  gates: ProgressGateSummary
  complete: boolean
  limitations: string[]
}

export const progressRpcDefinition = {
  id: PROGRESS_RPC_ID,
  methods: {
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1, maxLength: 512 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          version: { type: "integer", const: 1 },
          sessionID: { type: "string" },
          goal: { type: ["object", "null"] },
          board: { type: "object" },
          currentTask: { type: "object" },
          reservedTask: { type: "object" },
          review: { type: ["object", "null"] },
          budget: { type: "object" },
          worktree: { type: ["object", "null"] },
          publication: { type: "object" },
          gates: { type: "object" },
          complete: { type: "boolean" },
          limitations: { type: "array" },
        },
        required: ["version", "sessionID", "goal", "board", "review", "budget", "worktree", "publication", "gates", "complete", "limitations"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const

export type ProgressRpcInput = { sessionID: string }

export function parseProgressInput(value: unknown): ProgressRpcInput | undefined {
  if (!isRecord(value)) return undefined
  const sessionID = value.sessionID
  return boundedString(sessionID, 1, 512) ? { sessionID } : undefined
}

export function unavailableProgressView(sessionID = "unknown", message = "progress RPC response is unavailable"): ProgressView {
  return {
    version: 1,
    sessionID: sessionID || "unknown",
    goal: null,
    board: { status: "unavailable", counts: emptyCounts(), total: 0, completed: 0, tasks: [] },
    review: null,
    budget: { mode: "advisory", verdict: "unknown", coverage: "unknown", observed: {}, limits: [] },
    worktree: null,
    publication: { durableEnabled: false, configEnabled: false, capabilities: [] },
    gates: { statuses: [] },
    complete: false,
    limitations: [
      "read-only metadata projection: no transcripts, prompts, command output, credentials, or raw storage records",
      "objective and task text is known-pattern-redacted and length-bounded",
      "budget coverage is observational; unknown coverage is never treated as zero",
      "publication and gate values describe capability policy only, not human identity",
      message,
    ].slice(0, PROGRESS_MAX_LIMITATIONS),
  }
}

/** Strict parser used by the TUI before any response is rendered. */
export function parseProgressView(value: unknown): ProgressView | undefined {
  if (!isRecord(value) || value.version !== 1 || !boundedString(value.sessionID, 1, 512) || typeof value.complete !== "boolean") return undefined
  if (!Array.isArray(value.limitations) || value.limitations.length > PROGRESS_MAX_LIMITATIONS || value.limitations.some((item) => !boundedString(item, 1, 512))) return undefined
  const goal = parseGoal(value.goal)
  const board = parseBoard(value.board)
  const review = parseReview(value.review)
  const budget = parseBudget(value.budget)
  const worktree = parseWorktree(value.worktree)
  const publication = parsePublication(value.publication)
  const gates = parseGates(value.gates)
  const currentTask = parseTask(value.currentTask)
  const reservedTask = parseTask(value.reservedTask)
  if (goal === undefined || !board || review === undefined || !budget || worktree === undefined || !publication || !gates) return undefined
  if (value.currentTask !== undefined && !currentTask) return undefined
  if (value.reservedTask !== undefined && !reservedTask) return undefined
  return {
    version: 1,
    sessionID: value.sessionID,
    goal,
    board,
    ...(currentTask ? { currentTask } : {}),
    ...(reservedTask ? { reservedTask } : {}),
    review,
    budget,
    worktree,
    publication,
    gates,
    complete: value.complete,
    limitations: [...value.limitations],
  }
}

function parseGoal(value: unknown): ProgressView["goal"] | undefined {
  if (value === null) return null
  if (!isRecord(value) || !oneOf(value.status, ["active", "paused", "complete"] as const) || !boundedString(value.objectiveHint, 1, PROGRESS_OBJECTIVE_HINT_MAX)) return undefined
  return { status: value.status, objectiveHint: value.objectiveHint }
}

function parseBoard(value: unknown): ProgressBoardSummary | undefined {
  if (!isRecord(value) || !oneOf(value.status, PROGRESS_BOARD_STATUSES) || !isInt(value.total, 0, 256) || !isInt(value.completed, 0, value.total) || !isRecord(value.counts) || !Array.isArray(value.tasks) || value.tasks.length > PROGRESS_MAX_TASKS) return undefined
  const counts = emptyCounts()
  for (const status of PROGRESS_TASK_STATUSES) if (!isInt(value.counts[status], 0, 256)) return undefined
  for (const status of PROGRESS_TASK_STATUSES) counts[status] = value.counts[status]
  const tasks = value.tasks.map(parseTask)
  const current = parseTask(value.current)
  const reserved = parseTask(value.reserved)
  if (tasks.some((task) => !task) || (value.current !== undefined && !current) || (value.reserved !== undefined && !reserved)) return undefined
  return { status: value.status, counts, total: value.total, completed: value.completed, ...(current ? { current } : {}), ...(reserved ? { reserved } : {}), tasks: tasks as ProgressTaskSummary[] }
}

function parseTask(value: unknown): ProgressTaskSummary | undefined {
  if (!isRecord(value) || !boundedString(value.title, 1, PROGRESS_TASK_TITLE_MAX) || !oneOf(value.status, PROGRESS_TASK_STATUSES) || !oneOf(value.role, PROGRESS_ROLES)) return undefined
  return { title: value.title, status: value.status, role: value.role }
}

function parseReview(value: unknown): ProgressReviewSummary | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !oneOf(value.state, PROGRESS_REVIEW_STATES) || !isInt(value.round, 1, 8)) return undefined
  return { state: value.state, round: value.round }
}

function parseBudget(value: unknown): ProgressBudgetSummary | undefined {
  if (!isRecord(value) || !oneOf(value.mode, ["advisory", "stop-between-steps"] as const) || !oneOf(value.verdict, ["within", "exceeded", "unknown"] as const) || !oneOf(value.coverage, ["complete", "partial", "unknown", "not-configured"] as const) || !isRecord(value.observed) || !Array.isArray(value.limits) || value.limits.length > 5) return undefined
  const observed: ProgressBudgetSummary["observed"] = {}
  for (const key of ["steps", "tokens", "costUsd", "retries", "startedAt"] as const) {
    if (value.observed[key] !== undefined && !isNumber(value.observed[key])) return undefined
    if (value.observed[key] !== undefined) observed[key] = value.observed[key]
  }
  const limits = value.limits.map(parseBudgetDetail)
  return limits.some((limit) => !limit) ? undefined : { mode: value.mode, verdict: value.verdict, coverage: value.coverage, observed, limits: limits as ProgressBudgetDetail[] }
}

function parseBudgetDetail(value: unknown): ProgressBudgetDetail | undefined {
  if (!isRecord(value) || !oneOf(value.limit, PROGRESS_BUDGET_LIMITS) || !oneOf(value.status, ["within", "exceeded", "unknown"] as const)) return undefined
  if (value.configured !== undefined && !isNumber(value.configured)) return undefined
  if (value.observed !== undefined && !isNumber(value.observed)) return undefined
  return { limit: value.limit, status: value.status, ...(value.configured !== undefined ? { configured: value.configured } : {}), ...(value.observed !== undefined ? { observed: value.observed } : {}) }
}

function parseWorktree(value: unknown): ProgressView["worktree"] | undefined {
  if (value === null) return null
  if (!isRecord(value) || !oneOf(value.status, ["pending", "ready", "moved", "dirty", "orphaned", "cleanup-failed"] as const) || !boundedString(value.branch, 1, PROGRESS_BRANCH_MAX)) return undefined
  return { status: value.status, branch: value.branch }
}

function parsePublication(value: unknown): ProgressPublicationSummary | undefined {
  if (!isRecord(value) || typeof value.durableEnabled !== "boolean" || typeof value.configEnabled !== "boolean" || !Array.isArray(value.capabilities) || value.capabilities.length > PROGRESS_PUBLICATION_CAPABILITIES.length || value.capabilities.some((capability) => !oneOf(capability, PROGRESS_PUBLICATION_CAPABILITIES))) return undefined
  return { durableEnabled: value.durableEnabled, configEnabled: value.configEnabled, capabilities: [...value.capabilities] as ProgressPublicationCapability[] }
}

function parseGates(value: unknown): ProgressGateSummary | undefined {
  if (!isRecord(value) || !Array.isArray(value.statuses) || value.statuses.length > PROGRESS_GATE_NAMES.length) return undefined
  const statuses = value.statuses.map((item) => {
    if (!isRecord(item) || !oneOf(item.gate, PROGRESS_GATE_NAMES) || typeof item.enabled !== "boolean" || typeof item.ceiling !== "boolean" || typeof item.sessionDisabled !== "boolean") return undefined
    return { gate: item.gate, enabled: item.enabled, ceiling: item.ceiling, sessionDisabled: item.sessionDisabled }
  })
  return statuses.some((status) => !status) ? undefined : { statuses: statuses as ProgressGateSummary["statuses"] }
}

function emptyCounts(): Record<ProgressTaskStatus, number> {
  return Object.fromEntries(PROGRESS_TASK_STATUSES.map((status) => [status, 0])) as Record<ProgressTaskStatus, number>
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T)
}
