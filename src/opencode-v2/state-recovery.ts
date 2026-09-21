import { z } from "zod"
import { authoritySnapshotSchema } from "./authority/state.js"
import { gatesSchema } from "./gates/state.js"
import { goalSchema, planRunSchema, automationStopSchema, type StorageLike } from "./goal/state.js"
import { leadBoardSchema } from "./orchestration/lead-board.js"
import { leadBoardV2Schema } from "./orchestration/lead-board-v2.js"
import { reviewV1RecordSchema } from "./observability/review.js"
import { retryTraceSchema, traceSummarySchema } from "./observability/trace.js"
import { reviewV2RecordSchema } from "./observability/review-v2.js"
import { prCreateReplaySchema, prMergeReplaySchema } from "./publish/reconcile.js"
import { sessionAnchorSchema } from "./session/state.js"
import { stepRecordSchema } from "./orchestration/step-state.js"
import { verificationReceiptSchema } from "./verification/state.js"
import { sessionIndexSchema, worktreeSchema } from "./worktree/state.js"

/** A deliberately small storage surface used by operator recovery only. */
export type RecoveryStorage = StorageLike

export const STATE_RECOVERY_VERSION = 1
export const STATE_RECOVERY_MAX_RECORDS = 256
export const STATE_RECOVERY_MAX_SCAN_PAGE = 64
export const STATE_RECOVERY_MAX_SCAN_PAGES = 4096
export const STATE_RECOVERY_MAX_LEGACY_SCAN = 128

type SchemaLike = {
  safeParse(value: unknown): {
    success: boolean
    error?: { issues: readonly { path: readonly PropertyKey[]; code: string }[] }
  }
}

type FamilySpec = {
  name: StateFamily
  prefix: string
  sessionIndex: number
  exactSegments?: number
  schema: SchemaLike
  legacy?: boolean
}

export const STATE_FAMILIES = [
  "goal",
  "run",
  "halt",
  "lead-board-v1",
  "lead-board-v2",
  "step",
  "review-v1",
  "review-v2",
  "trace",
  "retry-trace",
  "authority",
  "gates",
  "worktree-v1",
  "worktree-v2",
  "worktree-index",
  "session-anchor",
  "verification",
  "publish-replay",
] as const
export type StateFamily = (typeof STATE_FAMILIES)[number]

const replaySchema = z.union([prCreateReplaySchema, prMergeReplaySchema])

/**
 * Historical V1 worktree values are validated only by recovery. The runtime
 * worktree model lives in `worktree/state.ts`; keeping this schema here avoids
 * reintroducing the removed V1 worktree helpers into session state.
 */
const legacyWorktreeSchema = z
  .object({
    version: z.literal(1),
    owner: z.string().min(1),
    sessionID: z.string().min(1),
    originProjectID: z.string().min(1),
    repositoryRoot: z.string().min(1),
    directory: z.string().min(1),
    branch: z.string().min(1),
    base: z.string().min(1),
    status: z.enum(["pending", "created", "attached", "closed", "removed"]),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .strict()

const FAMILY_SPECS: readonly FamilySpec[] = [
  { name: "goal", prefix: "goal/v1/", sessionIndex: 3, exactSegments: 4, schema: goalSchema },
  { name: "run", prefix: "run/v1/", sessionIndex: 3, exactSegments: 4, schema: planRunSchema },
  { name: "halt", prefix: "halt/v1/", sessionIndex: 3, exactSegments: 4, schema: automationStopSchema },
  { name: "lead-board-v1", prefix: "lead-board/v1/", sessionIndex: 3, exactSegments: 4, schema: leadBoardSchema, legacy: true },
  { name: "lead-board-v2", prefix: "lead-board/v2/", sessionIndex: 3, exactSegments: 4, schema: leadBoardV2Schema },
  { name: "step", prefix: "step/v1/", sessionIndex: 3, exactSegments: 5, schema: stepRecordSchema },
  { name: "review-v1", prefix: "review/v1/", sessionIndex: 3, exactSegments: 4, schema: reviewV1RecordSchema, legacy: true },
  { name: "review-v2", prefix: "review/v2/", sessionIndex: 3, exactSegments: 4, schema: reviewV2RecordSchema },
  { name: "trace", prefix: "trace/v1/", sessionIndex: 3, exactSegments: 4, schema: traceSummarySchema },
  { name: "retry-trace", prefix: "retry-trace/v1/", sessionIndex: 3, exactSegments: 4, schema: retryTraceSchema },
  { name: "authority", prefix: "authority/v1/", sessionIndex: 3, exactSegments: 4, schema: authoritySnapshotSchema },
  { name: "gates", prefix: "gates/v1/", sessionIndex: 2, exactSegments: 3, schema: gatesSchema },
  { name: "worktree-v1", prefix: "worktree/v1/", sessionIndex: 3, exactSegments: 4, schema: legacyWorktreeSchema, legacy: true },
  { name: "worktree-v2", prefix: "worktree/v2/", sessionIndex: 3, exactSegments: 4, schema: worktreeSchema },
  { name: "worktree-index", prefix: "worktree/v2/sessions/", sessionIndex: 3, exactSegments: 4, schema: sessionIndexSchema },
  { name: "session-anchor", prefix: "session/v1/", sessionIndex: 3, exactSegments: 4, schema: sessionAnchorSchema },
  { name: "verification", prefix: "verification/v1/", sessionIndex: 3, exactSegments: 5, schema: verificationReceiptSchema },
  { name: "publish-replay", prefix: "publish-replay/v1/", sessionIndex: 3, exactSegments: 6, schema: replaySchema },
]

export type StateIssue = {
  path: string
  code: string
}

export type StateRecordMetadata = {
  family: StateFamily
  key: string
  version?: number
  valid: boolean
  issues: StateIssue[]
  status?: string
  state?: string
  round?: number
  stepIndex?: number
}

export type StateInspection = {
  version: 1
  sessionID: string
  records: StateRecordMetadata[]
  complete: boolean
  recordCount: number
  limitations: string[]
}

export type StateMutationResult = StateInspection & {
  operation: "archive" | "reset"
  archived: number
  removed: number
  archiveNamespace: string
}

export class StateRecoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StateRecoveryError"
  }
}

/** Export bounded metadata for exactly one operator-supplied session. */
export async function exportSessionState(storage: RecoveryStorage, sessionID: string): Promise<StateInspection> {
  return inspectSessionState(storage, sessionID)
}

/** Validate every discoverable record and return only schema paths/codes. */
export async function validateSessionState(storage: RecoveryStorage, sessionID: string): Promise<StateInspection> {
  return inspectSessionState(storage, sessionID)
}

export async function inspectSessionState(storage: RecoveryStorage, sessionID: string): Promise<StateInspection> {
  assertSessionID(sessionID)
  const collected = await collectSessionEntries(storage, sessionID)
  const records = collected.entries
    .map(({ spec, key, value }) => metadata(spec, key, value))
    .sort((left, right) => left.family.localeCompare(right.family) || left.key.localeCompare(right.key))
  return {
    version: STATE_RECOVERY_VERSION,
    sessionID,
    records,
    complete: collected.complete,
    recordCount: records.length,
    limitations: collected.limitations,
  }
}

/**
 * Archive all records for one session before removing them. Every archive
 * write completes before the first original key is removed; a failed archive
 * therefore leaves the live state untouched.
 */
export async function archiveSessionState(
  storage: RecoveryStorage,
  sessionID: string,
  now = Date.now(),
): Promise<StateMutationResult> {
  assertSessionID(sessionID)
  const collected = await collectSessionEntries(storage, sessionID)
  requireComplete(collected)
  return archiveEntries(storage, sessionID, collected.entries, now, "archive")
}

/** Reset one explicit family, requiring an explicit confirmation at the API boundary. */
export async function resetSessionState(
  storage: RecoveryStorage,
  sessionID: string,
  family: StateFamily,
  confirmed: boolean,
  now = Date.now(),
): Promise<StateMutationResult> {
  assertSessionID(sessionID)
  if (!isStateFamily(family)) throw new StateRecoveryError(`unknown state family: ${family}`)
  if (!confirmed) throw new StateRecoveryError("state reset requires explicit confirmation")
  const collected = await collectSessionEntries(storage, sessionID)
  requireComplete(collected)
  const selected = collected.entries.filter((entry) => entry.spec.name === family)
  return archiveEntries(storage, sessionID, selected, now, "reset", family)
}

/** Count legacy records without exposing their values; used by live doctor. */
export async function countLegacyState(storage: RecoveryStorage): Promise<number | undefined> {
  if (!storage.scan) return undefined
  let count = 0
  for (const spec of FAMILY_SPECS.filter((candidate) => candidate.legacy)) {
    let after: string | undefined
    const cursors = new Set<string>()
    let pages = 0
    for (;;) {
      if (pages >= STATE_RECOVERY_MAX_SCAN_PAGES) return STATE_RECOVERY_MAX_LEGACY_SCAN
      let page: ScanPage | undefined
      try {
        page = scanPage(await storage.scan({ prefix: spec.prefix, ...(after ? { after } : {}), limit: STATE_RECOVERY_MAX_SCAN_PAGE }))
      } catch {
        return undefined
      }
      pages += 1
      if (!page || page.entries.some((entry) => !isStorageEntry(entry))) return undefined
      count += page.entries.filter((entry): entry is { key: string; value: unknown } => isStorageEntry(entry)).filter((entry) => matchesShape(entry.key, spec)).length
      if (count >= STATE_RECOVERY_MAX_LEGACY_SCAN) return STATE_RECOVERY_MAX_LEGACY_SCAN
      if (page.next === undefined) break
      if (cursors.has(page.next)) return undefined
      cursors.add(page.next)
      after = page.next
    }
  }
  return count
}

function assertSessionID(sessionID: string): void {
  if (typeof sessionID !== "string" || sessionID.length === 0 || sessionID.length > 512) {
    throw new StateRecoveryError("state recovery requires a non-empty session ID of at most 512 characters")
  }
}

function isStateFamily(value: string): value is StateFamily {
  return (STATE_FAMILIES as readonly string[]).includes(value)
}

type CollectedEntry = { spec: FamilySpec; key: string; value: unknown }
type Collection = { entries: CollectedEntry[]; complete: boolean; limitations: string[] }
type ScanPage = { entries: readonly unknown[]; next?: string }

function scanPage(value: unknown): ScanPage | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries) || value.entries.length > STATE_RECOVERY_MAX_SCAN_PAGE) {
    return undefined
  }
  if (!Object.hasOwn(value, "next") || value.next === undefined) return { entries: value.entries }
  if (typeof value.next !== "string" || value.next.length === 0 || value.next.length > 512) return undefined
  return { entries: value.entries, next: value.next }
}

async function collectSessionEntries(storage: RecoveryStorage, sessionID: string): Promise<Collection> {
  if (!storage.scan) {
    return { entries: [], complete: false, limitations: ["storage.scan is unavailable; no durable records were inspected"] }
  }
  const entries: CollectedEntry[] = []
  const seen = new Set<string>()
  const limitations: string[] = []
  let complete = true
  for (const spec of FAMILY_SPECS) {
    let after: string | undefined
    const cursors = new Set<string>()
    let pages = 0
    for (;;) {
      if (pages >= STATE_RECOVERY_MAX_SCAN_PAGES) {
        complete = false
        limitations.push(`scan page cap ${STATE_RECOVERY_MAX_SCAN_PAGES} reached for ${spec.name}`)
        return { entries, complete, limitations }
      }
      let page: ScanPage | undefined
      try {
        page = scanPage(await storage.scan({ prefix: spec.prefix, ...(after ? { after } : {}), limit: STATE_RECOVERY_MAX_SCAN_PAGE }))
      } catch {
        complete = false
        limitations.push(`scan failed for ${spec.name}; remaining records were not inspected`)
        break
      }
      pages += 1
      if (!page) {
        complete = false
        limitations.push(`scan returned an invalid page for ${spec.name}; remaining records were not inspected`)
        break
      }
      for (const entry of page.entries) {
        if (!isStorageEntry(entry)) {
          complete = false
          limitations.push(`scan returned an invalid entry for ${spec.name}; destructive recovery is unavailable`)
          continue
        }
        if (!matchesSession(entry.key, spec, sessionID) || seen.has(entry.key)) continue
        seen.add(entry.key)
        entries.push({ spec, key: entry.key, value: entry.value })
        if (entries.length >= STATE_RECOVERY_MAX_RECORDS) {
          complete = false
          limitations.push(`record cap ${STATE_RECOVERY_MAX_RECORDS} reached`)
          return { entries, complete, limitations }
        }
      }
      if (page.next === undefined) break
      if (cursors.has(page.next)) {
        complete = false
        limitations.push(`scan returned a repeated or invalid cursor for ${spec.name}`)
        break
      }
      cursors.add(page.next)
      after = page.next
    }
  }
  return { entries, complete, limitations }
}

function requireComplete(collection: Collection): void {
  if (!collection.complete) throw new StateRecoveryError(`state recovery is incomplete: ${collection.limitations.join("; ")}`)
}

async function archiveEntries(
  storage: RecoveryStorage,
  sessionID: string,
  entries: readonly CollectedEntry[],
  now: number,
  operation: "archive" | "reset",
  family?: StateFamily,
): Promise<StateMutationResult> {
  const archiveNamespace = await allocateArchiveNamespace(storage, now, entries)
  const archiveKeys: Array<{ original: string; archive: string }> = []
  for (const [index, entry] of entries.entries()) {
    const archive = `${archiveNamespace}/${index}-${stableHash(entry.key)}`
    try {
      await storage.set(archive, { version: 1, originalKey: entry.key, archivedAt: now, value: entry.value })
    } catch {
      throw new StateRecoveryError("state archive write failed; live state was not removed")
    }
    archiveKeys.push({ original: entry.key, archive })
  }
  let removed = 0
  try {
    for (const item of archiveKeys) {
      await storage.remove(item.original)
      removed += 1
    }
  } catch {
    let restored = true
    for (const entry of entries) {
      try {
        await storage.set(entry.key, entry.value)
      } catch {
        restored = false
      }
    }
    throw new StateRecoveryError(
      restored
        ? "state removal failed; live state was restored from the completed archive"
        : "state removal failed and live state could not be fully restored; archive remains available",
    )
  }
  const inspection = await inspectSessionState(storage, sessionID)
  return {
    ...inspection,
    operation,
    archived: archiveKeys.length,
    removed,
    archiveNamespace,
    ...(family ? { limitations: inspection.limitations } : {}),
  }
}

function matchesSession(key: string, spec: FamilySpec, sessionID: string): boolean {
  if (!matchesShape(key, spec)) return false
  const segments = key.split("/")
  return decodeSegment(segments[spec.sessionIndex]) === sessionID
}

function matchesShape(key: string, spec: FamilySpec): boolean {
  if (!key.startsWith(spec.prefix)) return false
  const segments = key.split("/")
  if (spec.name === "worktree-v2" && segments[2] === "sessions") return false
  return spec.exactSegments === undefined || segments.length === spec.exactSegments
}

function decodeSegment(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function metadata(spec: FamilySpec, key: string, value: unknown): StateRecordMetadata {
  const result = spec.schema.safeParse(value)
  const raw = isRecord(value) ? value : undefined
  const issues = result.success
    ? []
    : (result.error?.issues ?? [{ path: [], code: "invalid_record" }]).map((issue) => ({ path: formatPath(issue.path), code: issue.code }))
  const output: StateRecordMetadata = {
    family: spec.name,
    key: boundKey(key),
    ...(raw && typeof raw.version === "number" ? { version: raw.version } : {}),
    valid: result.success,
    issues: dedupeIssues(issues),
  }
  if (raw) {
    if (typeof raw.status === "string" && raw.status.length <= 64) output.status = raw.status
    if (typeof raw.state === "string" && raw.state.length <= 64) output.state = raw.state
    if (typeof raw.round === "number" && Number.isInteger(raw.round)) output.round = raw.round
    if (typeof raw.stepIndex === "number" && Number.isInteger(raw.stepIndex)) output.stepIndex = raw.stepIndex
  }
  return output
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "$"
  return path.map((part) => (typeof part === "number" ? `[${part}]` : String(part))).join(".")
}

function dedupeIssues(issues: readonly StateIssue[]): StateIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.path}:${issue.code}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function boundKey(key: string): string {
  return key.length <= 512 ? key : `${key.slice(0, 509)}...`
}

async function allocateArchiveNamespace(
  storage: RecoveryStorage,
  now: number,
  entries: readonly CollectedEntry[],
): Promise<string> {
  const base = `orchestrator-state-archive/v1/${now}`
  if (entries.length === 0) return base
  for (let suffix = 0; suffix < 128; suffix += 1) {
    const namespace = suffix === 0 ? base : `${base}-${suffix}`
    let page: ScanPage | undefined
    try {
      page = scanPage(await storage.scan!({ prefix: `${namespace}/`, limit: 1 }))
    } catch {
      throw new StateRecoveryError("could not verify a collision-free state archive namespace")
    }
    if (!page || (page.entries.length === 0 && page.next !== undefined)) {
      throw new StateRecoveryError("state archive namespace scan returned an invalid page")
    }
    if (page.entries.length === 0) return namespace
  }
  throw new StateRecoveryError("could not allocate a collision-free state archive namespace")
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStorageEntry(value: unknown): value is { key: string; value: unknown } {
  return isRecord(value) && typeof value.key === "string" && Object.hasOwn(value, "value")
}
