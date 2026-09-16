import { z } from "zod"
import { stableProjectID, type LocationLike, type StorageLike } from "../goal/state.js"
import { redact } from "../process/redact.js"

/**
 * S1 slice 1: durable per-step receipts.
 *
 * One bounded version-1 record per logical step under
 * `step/v1/<project>/<session>/<stepIndex>`, keyed by the session's stable
 * (origin) project exactly like goal/run/halt records, so a session move
 * cannot orphan the receipts.
 *
 * Hard boundaries (slice 1):
 * - These records are OBSERVABILITY ONLY. No admission, gate, review, publish,
 *   or worktree path reads them; a missing, malformed, or unreadable receipt
 *   never changes a decision. A receipt write/update failure is caught by the
 *   caller and never blocks a dispatch.
 * - There is no scheduler, no event log, no projection, no retry hook, and no
 *   backoff here. `status`, `attempt`, `cursor`, `errorClass`, `errorMessage`,
 *   and `completedMessage` are recorded state for later slices to consume;
 *   nothing in this module retries or resumes anything.
 * - There is no exactly-once claim: a receipt records that a step was reserved
 *   (`pending`), delivered (`dispatched`), finished (`completed`), or failed
 *   (`failed`). It can make a replay detectable; it cannot make an external
 *   side effect idempotent. See `docs/s1-replay-safety-inventory.md`.
 * - `completed` and `failed` are sticky terminal records: a finished step is
 *   never reopened and a failure is never silently replaced. Completion is a
 *   recorded observation (the session went idle after delivery), never proof
 *   that the turn or its external effects finished successfully.
 * - Writes are not serialized here: the caller owns locking (goal continuation
 *   performs the pending/dispatched/completed writes under the existing
 *   process-local session lock).
 *
 * This module is free of filesystem/process/git/gh calls: it only reads and
 * writes durable storage through a storage-like interface.
 */

export const STEP_RECORD_VERSION = 1

export const STEP_STATUSES = ["pending", "dispatched", "completed", "failed"] as const
export type StepStatus = (typeof STEP_STATUSES)[number]

/**
 * Bounded failure classes for later retry policy (N5) to consume. This module
 * only records the class; it never decides a retry.
 *
 * - `transient` — the attempt can be repeated with no external side effect.
 * - `permanent` — repeating the attempt cannot succeed.
 * - `ambiguous` — the first attempt may have produced an external side effect;
 *   replay requires a fresh read (or compensation) first, never a blind retry.
 * - `unknown` — unclassified; callers must treat it like `ambiguous`.
 */
export const STEP_ERROR_CLASSES = ["transient", "permanent", "ambiguous", "unknown"] as const
export type StepErrorClass = (typeof STEP_ERROR_CLASSES)[number]

/** Bound for the redacted failure message stored on a record. */
export const STEP_ERROR_MESSAGE_MAX_LENGTH = 500
/** Bound for the redacted completion message stored on a record. */
export const STEP_COMPLETED_MESSAGE_MAX_LENGTH = 500
/** Bound for a deterministic idempotency key. */
export const STEP_IDEMPOTENCY_KEY_MAX_LENGTH = 512
/** Bound for an opaque resume cursor carried by a record. */
export const STEP_CURSOR_MAX_LENGTH = 512
/** List page defaults/limits (bounded scan work, like peer discovery). */
export const STEP_LIST_LIMIT_DEFAULT = 100
export const STEP_LIST_LIMIT_MAX = 500
const STEP_SCAN_PAGE_SIZE = 100
/** Hard cap on scanned entries per lookup so a degenerate store cannot cause unbounded work. */
const STEP_SCAN_ENTRY_CAP = 2_000

export type StepRecord = {
  version: 1
  sessionID: string
  /** Monotonic step position within the session's orchestration sequence. */
  stepIndex: number
  status: StepStatus
  /** Deterministic identity of the logical step; a replay of the same step keeps this key. */
  idempotencyKey: string
  /** 1-based attempt number for this logical step. */
  attempt: number
  createdAt: number
  updatedAt: number
  dispatchedAt?: number
  completedAt?: number
  /** Known-pattern-and-exact-secret redacted, whitespace-collapsed, length-bounded. */
  completedMessage?: string
  failedAt?: number
  errorClass?: StepErrorClass
  /** Known-pattern-and-exact-secret redacted, whitespace-collapsed, length-bounded. */
  errorMessage?: string
  /** Opaque resume cursor owned by the step family; never interpreted here. */
  cursor?: string
}

export const stepRecordSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1).max(512),
    stepIndex: z.number().int().nonnegative().safe(),
    status: z.enum(STEP_STATUSES),
    idempotencyKey: z.string().min(1).max(STEP_IDEMPOTENCY_KEY_MAX_LENGTH),
    attempt: z.number().int().positive().safe(),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
    dispatchedAt: z.number().finite().nonnegative().optional(),
    completedAt: z.number().finite().nonnegative().optional(),
    completedMessage: z.string().min(1).max(STEP_COMPLETED_MESSAGE_MAX_LENGTH).optional(),
    failedAt: z.number().finite().nonnegative().optional(),
    errorClass: z.enum(STEP_ERROR_CLASSES).optional(),
    errorMessage: z.string().min(1).max(STEP_ERROR_MESSAGE_MAX_LENGTH).optional(),
    cursor: z.string().min(1).max(STEP_CURSOR_MAX_LENGTH).optional(),
  })
  .strict()

/**
 * Storage prefix for every step receipt of one session. `stepStorageKey` and
 * `stepIndexFromKey` are exact inverses over this prefix.
 */
export function stepPrefix(location: LocationLike, sessionID: string): string {
  return `step/v1/${segment(location.project.id)}/${segment(sessionID)}/`
}

/** Key for one step receipt: `step/v1/<project>/<session>/<stepIndex>`. */
export function stepStorageKey(location: LocationLike, sessionID: string, stepIndex: number): string {
  assertStepIndex(stepIndex)
  return `${stepPrefix(location, sessionID)}${stepIndex}`
}

/**
 * Inverse of `stepStorageKey` for scan entries: extracts the numeric step
 * index from a receipt key for the exact project/session prefix. Returns
 * undefined for foreign keys, nested suffixes, and non-canonical numbers
 * (`01`, signs, whitespace, unsafe integers) so malformed keys are never
 * attributed to a step.
 */
export function stepIndexFromKey(key: string, location: LocationLike, sessionID: string): number | undefined {
  const prefix = stepPrefix(location, sessionID)
  if (!key.startsWith(prefix)) return undefined
  const suffix = key.slice(prefix.length)
  if (!/^(?:0|[1-9][0-9]*)$/.test(suffix)) return undefined
  const index = Number(suffix)
  if (!Number.isSafeInteger(index)) return undefined
  return index
}

/**
 * Deterministic idempotency key for a goal-continuation step. The same
 * session, goal generation (`goal.createdAt`), and step index always produce
 * the same key, while a replaced goal (fresh `createdAt`) can never alias an
 * older generation's step.
 */
export function continuationStepIdempotencyKey(sessionID: string, goalCreatedAt: number, stepIndex: number): string {
  return `goal-continuation/${segment(sessionID)}/${goalCreatedAt}/${stepIndex}`
}

/**
 * Bounded, redacted failure text for a receipt: the shared redactor removes
 * known secret patterns and any caller-supplied exact secrets, whitespace is
 * collapsed, and the result is truncated to `STEP_ERROR_MESSAGE_MAX_LENGTH`
 * (with a trailing ellipsis). Returns an empty string for empty/blank input so
 * callers can omit the field instead of storing a meaningless value.
 */
export function boundedStepErrorMessage(value: string, secrets: readonly string[] = []): string {
  return boundedStepMessage(value, secrets, STEP_ERROR_MESSAGE_MAX_LENGTH)
}

/** Shared bounded/redacted text shape for every record message field. */
function boundedStepMessage(value: string, secrets: readonly string[], maxLength: number): string {
  const collapsed = redact(value, secrets).replace(/\s+/g, " ").trim()
  if (collapsed.length === 0) return ""
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, maxLength - 1)}…`
}

export type NewStepRecordInput = {
  sessionID: string
  stepIndex: number
  idempotencyKey: string
  attempt?: number
  cursor?: string
  now?: number
}

/** Deterministic builder for a fresh `pending` receipt (validated on write). */
export function newPendingStepRecord(input: NewStepRecordInput): StepRecord {
  assertStepIndex(input.stepIndex)
  const now = input.now ?? Date.now()
  const record: StepRecord = {
    version: STEP_RECORD_VERSION,
    sessionID: input.sessionID,
    stepIndex: input.stepIndex,
    status: "pending",
    idempotencyKey: input.idempotencyKey,
    attempt: input.attempt ?? 1,
    createdAt: now,
    updatedAt: now,
  }
  if (input.cursor !== undefined) record.cursor = input.cursor
  return record
}

/**
 * Strict, bounded parse: returns the parsed record or undefined for malformed
 * or unknown data. Used by every read/scan path so a corrupt value is skipped,
 * never guessed from and never fatal.
 */
export function parseStepRecord(value: unknown): StepRecord | undefined {
  const parsed = stepRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export type StepListInput = {
  /** Opaque `storage.scan` cursor from a previous page. */
  after?: string
  limit?: number
}

export type StepListResult = {
  version: 1
  sessionID: string
  entries: StepRecord[]
  /** Cursor for the next page when the backend reported one. */
  next?: string
  /** False when `storage.scan` is unavailable or a further page remains. */
  complete: boolean
  /** Malformed or out-of-shape scan entries skipped while collecting. */
  skipped: number
}

/** Reads one receipt by stable project/session/step index. Missing or malformed values read as undefined. */
export async function readStepRecord(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  stepIndex: number,
): Promise<StepRecord | undefined> {
  const keyed = await keyedLocation(storage, location, sessionID)
  return parseStepRecord(await storage.get(stepStorageKey(keyed, sessionID, stepIndex)))
}

/**
 * Writes one receipt after strict schema validation. The key is derived from
 * the record's own session/step index; the caller owns locking. An invalid
 * record throws before anything is written.
 */
export async function writeStepRecord(
  storage: StorageLike,
  location: LocationLike,
  record: StepRecord,
): Promise<StepRecord> {
  const parsed = stepRecordSchema.parse(record)
  const keyed = await keyedLocation(storage, location, parsed.sessionID)
  await storage.set(stepStorageKey(keyed, parsed.sessionID, parsed.stepIndex), parsed)
  return parsed
}

/** Removes one receipt. Removing a missing record is a no-op. */
export async function removeStepRecord(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  stepIndex: number,
): Promise<void> {
  const keyed = await keyedLocation(storage, location, sessionID)
  await storage.remove(stepStorageKey(keyed, sessionID, stepIndex))
}

/**
 * Lists one session's receipts through `storage.scan`, one bounded page per
 * call. Entries are strictly parsed and sorted by numeric step index for
 * deterministic output independent of backend scan order. A missing `scan`
 * returns an empty page with `complete: false` — never an error and never a
 * completeness claim.
 */
export async function listStepRecords(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  input: StepListInput = {},
): Promise<StepListResult> {
  const keyed = await keyedLocation(storage, location, sessionID)
  if (!storage.scan) {
    return { version: 1, sessionID, entries: [], complete: false, skipped: 0 }
  }
  const limit = normalizeListLimit(input.limit)
  const page = await storage.scan({ prefix: stepPrefix(keyed, sessionID), after: input.after, limit })
  const entries: StepRecord[] = []
  let skipped = 0
  for (const entry of page.entries) {
    const index = stepIndexFromKey(entry.key, keyed, sessionID)
    const record = parseStepRecord(entry.value)
    if (index === undefined || !record || record.stepIndex !== index || record.sessionID !== sessionID) {
      skipped += 1
      continue
    }
    entries.push(record)
  }
  entries.sort((a, b) => a.stepIndex - b.stepIndex)
  return {
    version: 1,
    sessionID,
    entries,
    ...(page.next !== undefined ? { next: page.next } : {}),
    complete: page.next === undefined,
    skipped,
  }
}

/**
 * Highest-index `completed` receipt for a session, scanned page by page over
 * the session prefix (bounded by `STEP_SCAN_ENTRY_CAP`). Malformed entries and
 * other statuses are ignored; a missing `scan` returns undefined. This is the
 * "last validated checkpoint" lookup: it is a record read, never a resume or
 * retry decision.
 */
export async function lastCompletedStep(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
): Promise<StepRecord | undefined> {
  const keyed = await keyedLocation(storage, location, sessionID)
  if (!storage.scan) return undefined
  const prefix = stepPrefix(keyed, sessionID)
  let best: StepRecord | undefined
  let scanned = 0
  let afterKey: string | undefined
  for (;;) {
    const page = await storage.scan({ prefix, after: afterKey, limit: STEP_SCAN_PAGE_SIZE })
    for (const entry of page.entries) {
      scanned += 1
      if (scanned > STEP_SCAN_ENTRY_CAP) return best
      const record = parseStepRecord(entry.value)
      if (!record || record.sessionID !== sessionID || record.status !== "completed") continue
      if (!best || record.stepIndex > best.stepIndex) best = record
    }
    if (!page.next) break
    afterKey = page.next
  }
  return best
}

/**
 * Removes every receipt under one session's prefix (session-end cleanup),
 * collecting keys page by page first and then deleting them so scan cursors
 * are never invalidated mid-page. Returns the number of keys removed. A
 * missing `scan` removes nothing (there is no scalable prefix delete here).
 */
export async function removeSessionSteps(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
): Promise<number> {
  const keyed = await keyedLocation(storage, location, sessionID)
  if (!storage.scan) return 0
  const prefix = stepPrefix(keyed, sessionID)
  const keys: string[] = []
  let scanned = 0
  let afterKey: string | undefined
  for (;;) {
    const page = await storage.scan({ prefix, after: afterKey, limit: STEP_SCAN_PAGE_SIZE })
    for (const entry of page.entries) {
      scanned += 1
      if (scanned > STEP_SCAN_ENTRY_CAP) break
      if (stepIndexFromKey(entry.key, keyed, sessionID) !== undefined) keys.push(entry.key)
    }
    if (scanned > STEP_SCAN_ENTRY_CAP || !page.next) break
    afterKey = page.next
  }
  for (const key of keys) await storage.remove(key)
  return keys.length
}

/**
 * Marks a `pending` receipt `dispatched` after delivery was confirmed. No-op
 * for a missing record and for any record that already left `pending`:
 * `dispatched` is idempotent and terminal states (`completed`/`failed`) are
 * never regressed. Returns the stored record, or undefined when none exists.
 */
export async function markStepDispatched(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  stepIndex: number,
  now = Date.now(),
): Promise<StepRecord | undefined> {
  const keyed = await keyedLocation(storage, location, sessionID)
  const key = stepStorageKey(keyed, sessionID, stepIndex)
  const current = parseStepRecord(await storage.get(key))
  if (!current || current.status !== "pending") return current
  const next: StepRecord = { ...current, status: "dispatched", dispatchedAt: now, updatedAt: now }
  await storage.set(key, next)
  return next
}

export type StepFailureInput = {
  errorClass?: StepErrorClass
  errorMessage?: string
  /** Exact caller-known secrets to redact out of `errorMessage` as well. */
  secrets?: readonly string[]
}

/**
 * Marks a receipt `failed` with a bounded, redacted failure. No-op for a
 * missing record and for a `completed` record (a finished step is never
 * downgraded). Repeated failure writes are idempotent: the failure fields are
 * replaced with the latest bounded values at the same step identity.
 */
export async function markStepFailed(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  stepIndex: number,
  input: StepFailureInput = {},
  now = Date.now(),
): Promise<StepRecord | undefined> {
  const keyed = await keyedLocation(storage, location, sessionID)
  const key = stepStorageKey(keyed, sessionID, stepIndex)
  const current = parseStepRecord(await storage.get(key))
  if (!current || current.status === "completed") return current
  const next: StepRecord = { ...current, status: "failed", failedAt: now, updatedAt: now }
  if (input.errorClass !== undefined) next.errorClass = input.errorClass
  if (input.errorMessage !== undefined) {
    const message = boundedStepErrorMessage(input.errorMessage, input.secrets ?? [])
    if (message.length > 0) next.errorMessage = message
  }
  const parsed = stepRecordSchema.parse(next)
  await storage.set(key, parsed)
  return parsed
}

export type StepCompletionInput = {
  /** Optional bounded, redacted completion note stored as `completedMessage`. */
  message?: string
  /** Exact caller-known secrets to redact out of `message` as well. */
  secrets?: readonly string[]
}

/**
 * Marks a delivered receipt `completed` with an optional bounded, redacted
 * completion note. No-op for a missing record, for an already-`completed`
 * record (idempotent: a finished step is never rewritten, so a repeated call
 * keeps the first `completedAt`/`completedMessage`), and for a `failed` record
 * (failure evidence is terminal and is never silently replaced). Blank notes
 * are omitted instead of stored.
 */
export async function markStepCompleted(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  stepIndex: number,
  input: StepCompletionInput = {},
  now = Date.now(),
): Promise<StepRecord | undefined> {
  const keyed = await keyedLocation(storage, location, sessionID)
  const key = stepStorageKey(keyed, sessionID, stepIndex)
  const current = parseStepRecord(await storage.get(key))
  if (!current || current.status === "completed" || current.status === "failed") return current
  const next: StepRecord = { ...current, status: "completed", completedAt: now, updatedAt: now }
  if (input.message !== undefined) {
    const message = boundedStepMessage(input.message, input.secrets ?? [], STEP_COMPLETED_MESSAGE_MAX_LENGTH)
    if (message.length > 0) next.completedMessage = message
  }
  const parsed = stepRecordSchema.parse(next)
  await storage.set(key, parsed)
  return parsed
}

async function keyedLocation(storage: StorageLike, location: LocationLike, sessionID: string): Promise<LocationLike> {
  const projectID = await stableProjectID(storage, location, sessionID)
  return { ...location, project: { id: projectID } }
}

function normalizeListLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return STEP_LIST_LIMIT_DEFAULT
  return Math.min(Math.floor(value), STEP_LIST_LIMIT_MAX)
}

function assertStepIndex(stepIndex: number): void {
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 0) {
    throw new Error(`stepIndex must be a non-negative safe integer, got ${stepIndex}`)
  }
}

function segment(value: string): string {
  return encodeURIComponent(value)
}
