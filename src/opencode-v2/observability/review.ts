/**
 * V1 maker-checker review schema and deterministic transitions.
 *
 * This is a SEPARATE version-1 review schema: it does not change D2
 * `reviewState` (`src/core/contracts.ts`) or the core admission state
 * semantics (`src/core/admission.ts`). A self-declared D2 `reviewState` is
 * never treated as reviewer proof, and this machine never reads the D2
 * envelope. Transitions are deterministic over fixed enums/reason codes only;
 * no free-form reviewer text is accepted or persisted.
 *
 * Record identity is `taskId` + `runId` together: a different task or a new
 * run of the same task is a different record identity. An open record
 * (pending or changes-requested) can never be overwritten by a different
 * identity; a terminal record (approved / blocked / tripped) may be replaced
 * by a fresh start. Reopening changes-requested for the exact same task/run
 * requires the maker and checker to stay unchanged (identity drift is
 * rejected). Approval requires the three fixed checks (`diff`, `scope`,
 * `verification`) all true; arbitrary check names are rejected by the schema.
 *
 * Terminal states (approved / blocked / tripped) are terminal for the current
 * task/run. Storage ownership lives in the runtime/tools layer: exactly ONE
 * bounded current record per session under a versioned stable project/session
 * key, serialized through withSessionLock, with no CAS/cross-process
 * guarantee. Caller identity and child-session ownership cannot be proven by
 * the plugin.
 */
import { z } from "zod"

export const REVIEW_V1_VERSION = 1

export const REVIEW_V1_STATES = ["pending", "approved", "changes-requested", "blocked", "tripped"] as const
export type ReviewV1State = (typeof REVIEW_V1_STATES)[number]

export const REVIEW_V1_ACTIONS = ["start", "approve", "request-changes", "block"] as const
export type ReviewV1Action = (typeof REVIEW_V1_ACTIONS)[number]

export const REVIEW_V1_REASONS = [
  "manual-start",
  "round-reopened",
  "approval-complete",
  "changes-requested",
  "rounds-exhausted",
  "checker-blocked",
  "checker-must-differ",
  "checker-role-mismatch",
  "identity-drift",
  "already-pending",
  "pending-task-locked",
  "terminal-for-task",
  "no-record",
  "checks-failed",
  "invalid-signal",
] as const
export type ReviewV1Reason = (typeof REVIEW_V1_REASONS)[number]

/**
 * Fixed review checks. Approval requires exactly these three boolean keys,
 * all true; any other check name, missing key, or false value fails approval.
 * The model-facing tool schema mirrors this exact set (no arbitrary checks).
 */
export const REVIEW_V1_CHECK_KEYS = ["diff", "scope", "verification"] as const
export type ReviewV1CheckKey = (typeof REVIEW_V1_CHECK_KEYS)[number]

export const reviewV1ChecksSchema = z
  .object({
    diff: z.boolean(),
    scope: z.boolean(),
    verification: z.boolean(),
  })
  .strict()
export type ReviewV1Checks = z.infer<typeof reviewV1ChecksSchema>

export const reviewV1RecordSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    maker: z.string().min(1).max(128),
    checker: z.string().min(1).max(128),
    state: z.enum(REVIEW_V1_STATES),
    round: z.number().int().min(1).max(8),
    maxRounds: z.number().int().min(1).max(8),
    reason: z.enum(REVIEW_V1_REASONS).optional(),
    requiresHuman: z.boolean(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .strict()
export type ReviewV1Record = z.infer<typeof reviewV1RecordSchema>

export const REVIEW_V1_START_SIGNAL_SCHEMA = z
  .object({
    action: z.literal("start"),
    taskId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    maker: z.string().min(1).max(128),
    checker: z.string().min(1).max(128),
    /** The caller-provided admission signal: the task must already be review-pending. */
    admissionState: z.literal("review-pending"),
  })
  .strict()

export const REVIEW_V1_APPROVE_SIGNAL_SCHEMA = z
  .object({
    action: z.literal("approve"),
    checks: reviewV1ChecksSchema,
  })
  .strict()

export const REVIEW_V1_SIGNAL_SCHEMA = z.discriminatedUnion("action", [
  REVIEW_V1_START_SIGNAL_SCHEMA,
  REVIEW_V1_APPROVE_SIGNAL_SCHEMA,
  z.object({ action: z.literal("request-changes") }).strict(),
  z.object({ action: z.literal("block") }).strict(),
])
export type ReviewV1Signal = z.infer<typeof REVIEW_V1_SIGNAL_SCHEMA>

export type ReviewV1TransitionInput = {
  /** The current durable record (bounded one-per-session), if any. */
  record?: ReviewV1Record
  signal: ReviewV1Signal
  maxRounds: number
  /** When provided, a start signal must name this exact checker role. */
  checkerRole?: string
  now?: number
}

export type ReviewV1Transition = {
  accepted: boolean
  /** The current/replaced record when the transition produced one. */
  record?: ReviewV1Record
  reason: ReviewV1Reason
  requiresHuman: boolean
  /** True when the reviewed task/run is terminal and needs no further transitions. */
  terminal: boolean
  /** Deterministic human-readable message (never free-form caller text). */
  message: string
}

export function transitionReviewV1(input: ReviewV1TransitionInput): ReviewV1Transition {
  const now = input.now ?? Date.now()
  if (input.signal.action === "start") return start(input, now)
  return decide(input, now)
}

function start(input: ReviewV1TransitionInput, now: number): ReviewV1Transition {
  const signal = input.signal as z.infer<typeof REVIEW_V1_START_SIGNAL_SCHEMA>
  if (signal.checker === signal.maker) {
    return reject("checker-must-differ", "checker must differ from maker; maker-checker separation requires distinct identities (caller identity itself cannot be proven)")
  }
  if (input.checkerRole !== undefined && signal.checker !== input.checkerRole) {
    return reject("checker-role-mismatch", `checker must be the configured review role (${input.checkerRole})`)
  }

  const current = input.record
  if (!current) {
    return accept(newRecord(signal, input.maxRounds, now), "manual-start", "review started: round 1 pending")
  }

  // Record identity is taskId + runId together. The same taskId with a new
  // runId is a different record identity.
  const sameIdentity = current.taskId === signal.taskId && current.runId === signal.runId

  if (sameIdentity) {
    if (current.state === "pending") {
      return reject("already-pending", `review for task ${current.taskId} run ${current.runId} is already pending in round ${current.round}`)
    }
    if (current.state === "changes-requested") {
      // Reopening the exact record must keep the maker and checker unchanged;
      // identity drift is rejected with a fixed reason code.
      if (signal.maker !== current.maker || signal.checker !== current.checker) {
        return reject(
          "identity-drift",
          `reopening review for task ${current.taskId} run ${current.runId} requires maker ${current.maker} and checker ${current.checker} unchanged`,
        )
      }
      if (current.round < current.maxRounds) {
        return accept(
          { ...current, state: "pending", round: current.round + 1, reason: "round-reopened", requiresHuman: false, updatedAt: now },
          "round-reopened",
          `rework round ${current.round + 1} started (pending)`,
        )
      }
      return reject("rounds-exhausted", "maximum review rounds reached; a human decision is required before any new review", true)
    }
    return reject(
      "terminal-for-task",
      `review for task ${current.taskId} run ${current.runId} is ${current.state} and terminal for this task/run`,
      current.requiresHuman,
    )
  }

  // Different task and/or run: never overwrite an open record; a terminal old
  // record may be replaced by a fresh start.
  if (current.state === "pending" || current.state === "changes-requested") {
    return reject(
      "pending-task-locked",
      `review for task ${current.taskId} run ${current.runId} is still open (${current.state}); a different task/run cannot be overwritten while open`,
    )
  }
  return accept(
    newRecord(signal, input.maxRounds, now),
    "manual-start",
    `previous review for task ${current.taskId} run ${current.runId} was ${current.state} (terminal); starting review round 1 for task ${signal.taskId} run ${signal.runId}`,
  )
}

function decide(input: ReviewV1TransitionInput, now: number): ReviewV1Transition {
  const record = input.record
  if (!record) {
    return reject("no-record", "no review record exists for this session; start one with a start signal first")
  }
  if (record.state !== "pending") {
    return reject(
      "invalid-signal",
      record.state === "changes-requested"
        ? `review for task ${record.taskId} is changes-requested; start the next round before recording another decision`
        : `review for task ${record.taskId} is ${record.state} and terminal for this task`,
      record.requiresHuman,
    )
  }

  if (input.signal.action === "approve") {
    const checks = input.signal.checks
    if (checks.diff !== true || checks.scope !== true || checks.verification !== true) {
      return reject(
        "checks-failed",
        "approval requires every fixed check (diff, scope, verification) to be true; send request-changes when any check is false",
      )
    }
    return accept(
      { ...record, state: "approved", reason: "approval-complete", requiresHuman: false, updatedAt: now },
      "approval-complete",
      "reviewer approved: every fixed check (diff, scope, verification) passed; the run may be admitted through the admission transition",
      false,
      true,
    )
  }

  if (input.signal.action === "request-changes") {
    if (record.round < record.maxRounds) {
      return accept(
        { ...record, state: "changes-requested", reason: "changes-requested", requiresHuman: false, updatedAt: now },
        "changes-requested",
        `reviewer requested changes in round ${record.round}; rework may start the next round`,
      )
    }
    return accept(
      { ...record, state: "tripped", reason: "rounds-exhausted", requiresHuman: true, updatedAt: now },
      "rounds-exhausted",
      "maximum review rounds reached; the circuit is open and a human decision is required",
      true,
      true,
    )
  }

  // action === "block"
  return accept(
    { ...record, state: "blocked", reason: "checker-blocked", requiresHuman: true, updatedAt: now },
    "checker-blocked",
    "reviewer blocked on unknown or unavailable evidence; the circuit is open and a human decision is required",
    true,
    true,
  )
}

/** Storage key for the single bounded current review record per session. */
export function reviewStorageKey(location: { project: { id: string } }, sessionID: string): string {
  return `review/v1/${segment(location.project.id)}/${segment(sessionID)}`
}

/** Strict parse of a stored review record (malformed/unknown data is ignored). */
export function parseReviewRecord(value: unknown): ReviewV1Record | undefined {
  const parsed = reviewV1RecordSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function newRecord(signal: z.infer<typeof REVIEW_V1_START_SIGNAL_SCHEMA>, maxRounds: number, now: number): ReviewV1Record {
  return {
    version: REVIEW_V1_VERSION,
    taskId: signal.taskId,
    runId: signal.runId,
    maker: signal.maker,
    checker: signal.checker,
    state: "pending",
    round: 1,
    maxRounds,
    reason: "manual-start",
    requiresHuman: false,
    createdAt: now,
    updatedAt: now,
  }
}

function reject(reason: ReviewV1Reason, message: string, requiresHuman = false, terminal = false): ReviewV1Transition {
  return { accepted: false, reason, requiresHuman, terminal, message }
}

function accept(
  record: ReviewV1Record,
  reason: ReviewV1Reason,
  message: string,
  requiresHuman = false,
  terminal = false,
): ReviewV1Transition {
  return { accepted: true, record, reason, requiresHuman, terminal, message }
}

function segment(value: string): string {
  return encodeURIComponent(value)
}