/**
 * Provenance-bound review records.
 *
 * V1 review records remain readable for migration/status reporting, but they
 * contain caller-supplied identities and can never authenticate publication or
 * completion. V2 records are created by the lead tool and completed only by a
 * configured reviewer child through the separate submit operation.
 */
import { z } from "zod"
import { stableProjectID, type LocationLike, type StorageLike } from "../goal/state.js"
import type { ReviewV1Record } from "./review.js"

export const REVIEW_V2_VERSION = 2
export const REVIEW_V2_STATES = ["pending", "approved", "changes-requested", "blocked", "tripped"] as const
export type ReviewV2State = (typeof REVIEW_V2_STATES)[number]

export const REVIEW_V2_DECISIONS = ["approve", "request-changes", "block"] as const
export type ReviewV2Decision = (typeof REVIEW_V2_DECISIONS)[number]

export const REVIEW_V2_REASONS = [
  "manual-start",
  "round-reopened",
  "approval-complete",
  "changes-requested",
  "rounds-exhausted",
  "reviewer-blocked",
  "already-pending",
  "pending-task-locked",
  "terminal-for-task",
  "identity-drift",
  "no-record",
  "not-pending",
  "round-mismatch",
  "reviewer-role-mismatch",
  "reviewer-session-mismatch",
  "lead-session-mismatch",
  "checks-failed",
  "invalid-signal",
] as const
export type ReviewV2Reason = (typeof REVIEW_V2_REASONS)[number]

export const REVIEW_V2_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const REVIEW_V2_CHECK_KEYS = ["diff", "scope", "verification"] as const
export type ReviewV2CheckKey = (typeof REVIEW_V2_CHECK_KEYS)[number]

export const reviewV2ChecksSchema = z
  .object({
    diff: z.boolean(),
    scope: z.boolean(),
    verification: z.boolean(),
  })
  .strict()
export type ReviewV2Checks = z.infer<typeof reviewV2ChecksSchema>

const reviewV2Identity = z.string().min(1).max(512)
const reviewV2Agent = z.string().min(1).max(128)
const reviewV2Sha = z.string().regex(REVIEW_V2_SHA_PATTERN)

/**
 * A pending record has the configured reviewer role but no invoking reviewer
 * session identity. The actual session is added only by submitReviewV2 after
 * the host session hierarchy and tool actor have been checked.
 */
export const reviewV2RecordSchema = z
  .object({
    version: z.literal(REVIEW_V2_VERSION),
    taskId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    leadSessionID: reviewV2Identity,
    /** The configured role at start; after submit this is also the observed actor. */
    reviewerAgentID: reviewV2Agent,
    reviewerSessionID: reviewV2Identity.optional(),
    headSha: reviewV2Sha,
    baseSha: reviewV2Sha,
    state: z.enum(REVIEW_V2_STATES),
    round: z.number().int().min(1).max(8),
    checks: reviewV2ChecksSchema.optional(),
    submittedAt: z.number().finite().nonnegative().optional(),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
    reason: z.enum(REVIEW_V2_REASONS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const decisionFields = [value.reviewerSessionID, value.submittedAt]
    const decisionFieldCount = decisionFields.filter((field) => field !== undefined).length
    if (value.state === "pending" && decisionFieldCount !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reviewerSessionID"], message: "pending reviews cannot carry a reviewer decision identity" })
    }
    if (value.state !== "pending" && decisionFieldCount !== decisionFields.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reviewerSessionID"], message: "decided reviews require reviewer session, agent, and submittedAt" })
    }
    if (value.state === "approved" && (value.checks?.diff !== true || value.checks.scope !== true || value.checks.verification !== true)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks"], message: "approved reviews require all fixed checks to be true" })
    }
    if (value.state !== "approved" && value.checks !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks"], message: "checks are stored only for approved reviews" })
    }
  })
export type ReviewV2Record = z.infer<typeof reviewV2RecordSchema>

export const reviewV2StartInputSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    headSha: reviewV2Sha,
    baseSha: reviewV2Sha,
  })
  .strict()
export type ReviewV2StartInput = z.infer<typeof reviewV2StartInputSchema>

export const reviewV2SubmitInputSchema = z
  .object({
    leadSessionID: reviewV2Identity,
    round: z.number().int().min(1).max(8),
    decision: z.discriminatedUnion("action", [
      z.object({ action: z.literal("approve"), checks: reviewV2ChecksSchema }).strict(),
      z.object({ action: z.literal("request-changes") }).strict(),
      z.object({ action: z.literal("block") }).strict(),
    ]),
  })
  .strict()
export type ReviewV2SubmitInput = z.infer<typeof reviewV2SubmitInputSchema>

export type ReviewV2Transition = {
  accepted: boolean
  record?: ReviewV2Record
  reason: ReviewV2Reason
  requiresHuman: boolean
  terminal: boolean
  message: string
}

export function startReviewV2(input: {
  record?: ReviewV2Record
  taskId: string
  runId: string
  leadSessionID: string
  expectedReviewerAgentID: string
  headSha: string
  baseSha: string
  maxRounds: number
  now?: number
}): ReviewV2Transition {
  const now = input.now ?? Date.now()
  if (!validStart(input)) return rejectV2("invalid-signal", "review start requires bounded task/run identity and full exact head/base SHAs")

  const current = input.record
  if (!current) {
    return acceptV2(newPendingRecord(input, 1, now), "manual-start", "review V2 started: round 1 pending")
  }
  if (current.leadSessionID !== input.leadSessionID || current.reviewerAgentID !== input.expectedReviewerAgentID) {
    return rejectV2("identity-drift", "the existing review record belongs to a different lead or configured reviewer")
  }

  const sameIdentity = current.taskId === input.taskId && current.runId === input.runId
  if (sameIdentity) {
    if (current.state === "pending") {
      return rejectV2("already-pending", `review V2 for task ${current.taskId} run ${current.runId} is already pending in round ${current.round}`)
    }
    if (current.state === "changes-requested") {
      if (current.round >= input.maxRounds) {
        return rejectV2("terminal-for-task", "maximum review rounds reached; a human decision is required before another review")
      }
      return acceptV2(
        newPendingRecord(input, current.round + 1, now),
        "round-reopened",
        `review V2 rework round ${current.round + 1} started: pending at the new exact revision`,
      )
    }
    return rejectV2("terminal-for-task", `review V2 for task ${current.taskId} run ${current.runId} is ${current.state} and terminal`)
  }

  if (current.state === "pending" || current.state === "changes-requested") {
    return rejectV2(
      "pending-task-locked",
      `review V2 for task ${current.taskId} run ${current.runId} is still open (${current.state}); a different task/run cannot replace it`,
    )
  }
  return acceptV2(
    newPendingRecord(input, 1, now),
    "manual-start",
    `previous review V2 for task ${current.taskId} run ${current.runId} was terminal; starting task ${input.taskId} run ${input.runId}`,
  )
}

export function submitReviewV2(input: {
  record?: ReviewV2Record
  leadSessionID: string
  expectedRound: number
  maxRounds: number
  expectedReviewerAgentID: string
  actorSessionID: string
  actorAgentID: string
  isChildSession: boolean
  decision: ReviewV2SubmitInput["decision"]
  now?: number
}): ReviewV2Transition {
  const record = input.record
  if (!record) return rejectV2("no-record", "no pending review V2 record exists for this lead session")
  if (record.leadSessionID !== input.leadSessionID) return rejectV2("lead-session-mismatch", "the pending review V2 record names a different lead session")
  if (record.state !== "pending") return rejectV2("not-pending", `review V2 is ${record.state}; exactly one decision is allowed for a pending round`)
  if (record.round !== input.expectedRound) return rejectV2("round-mismatch", `review V2 is at round ${record.round}, not the submitted round`)
  if (input.actorAgentID !== input.expectedReviewerAgentID || record.reviewerAgentID !== input.expectedReviewerAgentID) {
    return rejectV2("reviewer-role-mismatch", "only the configured reviewer agent may submit this review V2 decision")
  }
  if (!input.isChildSession || input.actorSessionID === input.leadSessionID) {
    return rejectV2("reviewer-session-mismatch", "the reviewer session must be a child of the lead session")
  }

  const now = input.now ?? Date.now()
  if (input.decision.action === "approve") {
    if (input.decision.checks.diff !== true || input.decision.checks.scope !== true || input.decision.checks.verification !== true) {
      return rejectV2("checks-failed", "approval requires exactly the fixed diff, scope, and verification checks to be true")
    }
    return acceptV2(
      decidedRecord(record, { state: "approved", reason: "approval-complete", actorSessionID: input.actorSessionID, actorAgentID: input.actorAgentID, checks: input.decision.checks, now }),
      "approval-complete",
      "reviewer child approved: all fixed checks passed at the exact pending revision",
      false,
      true,
    )
  }
  if (input.decision.action === "request-changes") {
    if (record.round >= input.maxRounds) {
      return acceptV2(
        decidedRecord(record, { state: "tripped", reason: "rounds-exhausted", actorSessionID: input.actorSessionID, actorAgentID: input.actorAgentID, now }),
        "rounds-exhausted",
        "maximum review rounds reached; the review circuit is open and requires a human decision",
        true,
        true,
      )
    }
    return acceptV2(
      decidedRecord(record, { state: "changes-requested", reason: "changes-requested", actorSessionID: input.actorSessionID, actorAgentID: input.actorAgentID, now }),
      "changes-requested",
      `reviewer child requested changes in round ${record.round}; the lead must rework and start the next exact-revision round`,
    )
  }
  return acceptV2(
    decidedRecord(record, { state: "blocked", reason: "reviewer-blocked", actorSessionID: input.actorSessionID, actorAgentID: input.actorAgentID, now }),
    "reviewer-blocked",
    "reviewer child blocked on unavailable or unsafe evidence; the review circuit is open",
    true,
    true,
  )
}

export type ReviewV2RevisionVerdict =
  | "valid"
  | "no-record"
  | "legacy-unproven"
  | "not-approved"
  | "missing-revision"
  | "revision-mismatch"
  | "lead-mismatch"
  | "reviewer-mismatch"
  | "invalid-expectation"

export type ReviewV2RevisionCheck = {
  valid: boolean
  verdict: ReviewV2RevisionVerdict
  message: string
}

export function validateApprovedReviewV2Revision(input: {
  record?: ReviewV2Record
  legacyRecord?: ReviewV1Record
  leadSessionID: string
  expectedReviewerAgentID: string
  headSha: string
  baseSha: string
}): ReviewV2RevisionCheck {
  const record = input.record
  if (!record) {
    return revisionCheckV2(
      input.legacyRecord ? "legacy-unproven" : "no-record",
      input.legacyRecord
        ? "legacy-unproven: a V1 review record is readable but cannot authenticate publication; start and submit a V2 review at this exact revision"
        : "no review record exists: no approved V2 review record exists for this lead session",
    )
  }
  if (!REVIEW_V2_SHA_PATTERN.test(input.headSha) || !REVIEW_V2_SHA_PATTERN.test(input.baseSha)) {
    return revisionCheckV2("invalid-expectation", "expected headSha and baseSha must each be a full lowercase 40- or 64-character git SHA")
  }
  if (record.leadSessionID !== input.leadSessionID) {
    return revisionCheckV2("lead-mismatch", "the approved V2 review belongs to a different lead session")
  }
  if (record.state !== "approved") {
    return revisionCheckV2("not-approved", `review V2 for task ${record.taskId} run ${record.runId} is ${record.state}, not approved`)
  }
  if (record.reviewerAgentID !== input.expectedReviewerAgentID || !record.reviewerSessionID) {
    return revisionCheckV2("reviewer-mismatch", "approved V2 review provenance does not name the configured reviewer agent and child session")
  }
  if (record.submittedAt === undefined || !record.checks || record.checks.diff !== true || record.checks.scope !== true || record.checks.verification !== true) {
    return revisionCheckV2("reviewer-mismatch", "approved V2 review has no complete fixed-check decision from a reviewer child")
  }
  if (!REVIEW_V2_SHA_PATTERN.test(record.headSha) || !REVIEW_V2_SHA_PATTERN.test(record.baseSha)) {
    return revisionCheckV2("missing-revision", "approved V2 review carries no valid exact head/base revision")
  }
  if (record.headSha !== input.headSha || record.baseSha !== input.baseSha) {
    return revisionCheckV2("revision-mismatch", "approved V2 review is bound to a different head/base revision")
  }
  return revisionCheckV2("valid", "approved V2 review matches the lead, configured reviewer, and exact head/base revision")
}

export function reviewV2StorageKey(location: { project: { id: string } }, leadSessionID: string): string {
  return `review/v2/${encodeURIComponent(location.project.id)}/${encodeURIComponent(leadSessionID)}`
}

export function parseReviewV2Record(value: unknown): ReviewV2Record | undefined {
  const parsed = reviewV2RecordSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export async function readReviewV2Record(storage: StorageLike, location: LocationLike, leadSessionID: string): Promise<ReviewV2Record | undefined> {
  const projectID = await stableProjectID(storage, location, leadSessionID)
  const keyed = { ...location, project: { id: projectID } }
  const record = parseReviewV2Record(await storage.get(reviewV2StorageKey(keyed, leadSessionID)))
  return record?.leadSessionID === leadSessionID ? record : undefined
}

export async function setReviewV2Record(storage: StorageLike, location: LocationLike, leadSessionID: string, record: ReviewV2Record): Promise<void> {
  if (!reviewV2RecordSchema.safeParse(record).success) throw new Error("invalid review V2 record")
  const projectID = await stableProjectID(storage, location, leadSessionID)
  const keyed = { ...location, project: { id: projectID } }
  await storage.set(reviewV2StorageKey(keyed, leadSessionID), record)
}

function validStart(input: { taskId: string; runId: string; leadSessionID: string; expectedReviewerAgentID: string; headSha: string; baseSha: string; maxRounds: number }): boolean {
  return (
    input.taskId.length > 0 &&
    input.runId.length > 0 &&
    input.leadSessionID.length > 0 &&
    input.expectedReviewerAgentID.length > 0 &&
    REVIEW_V2_SHA_PATTERN.test(input.headSha) &&
    REVIEW_V2_SHA_PATTERN.test(input.baseSha) &&
    Number.isInteger(input.maxRounds) &&
    input.maxRounds >= 1 &&
    input.maxRounds <= 8
  )
}

function newPendingRecord(input: { taskId: string; runId: string; leadSessionID: string; expectedReviewerAgentID: string; headSha: string; baseSha: string }, round: number, now: number): ReviewV2Record {
  return {
    version: REVIEW_V2_VERSION,
    taskId: input.taskId,
    runId: input.runId,
    leadSessionID: input.leadSessionID,
    reviewerAgentID: input.expectedReviewerAgentID,
    headSha: input.headSha,
    baseSha: input.baseSha,
    state: "pending",
    round,
    createdAt: now,
    updatedAt: now,
    reason: round === 1 ? "manual-start" : "round-reopened",
  }
}

function decidedRecord(
  record: ReviewV2Record,
  input: {
    state: Exclude<ReviewV2State, "pending">
    reason: ReviewV2Reason
    actorSessionID: string
    actorAgentID: string
    checks?: ReviewV2Checks
    now: number
  },
): ReviewV2Record {
  return {
    ...record,
    state: input.state,
    reviewerSessionID: input.actorSessionID,
    reviewerAgentID: input.actorAgentID,
    ...(input.checks ? { checks: input.checks } : {}),
    submittedAt: input.now,
    updatedAt: input.now,
    reason: input.reason,
  }
}

function rejectV2(reason: ReviewV2Reason, message: string, requiresHuman = false, terminal = false): ReviewV2Transition {
  return { accepted: false, reason, requiresHuman, terminal, message }
}

function acceptV2(record: ReviewV2Record, reason: ReviewV2Reason, message: string, requiresHuman = false, terminal = false): ReviewV2Transition {
  return { accepted: true, record, reason, requiresHuman, terminal, message }
}

function revisionCheckV2(verdict: ReviewV2RevisionVerdict, message: string): ReviewV2RevisionCheck {
  return { valid: verdict === "valid", verdict, message }
}
