import { z } from "zod"
import { stableProjectID, type LocationLike, type StorageLike } from "../goal/state.js"

/**
 * Publication replay descriptors + fresh-read reconciliation (Phase 5).
 *
 * The two ambiguous publication operations are PR draft creation (a lost POST
 * hides whether a PR now exists) and PR merge (a lost PUT hides whether the
 * merge landed). This module persists a bounded descriptor BEFORE the external
 * mutation and, on any retry or restart, reconciles from fresh remote truth
 * FIRST — never by re-POSTing or re-PUTing blindly.
 *
 * Boundaies:
 * - Descriptors are authorization bookkeeping, not exactly-once. The bounded
 *   open-PR list is a COMPENSATING control: it is page-bounded and racy and
 *   must never be called idempotent. Absence of a match is not proof of
 *   absence; it stays `ambiguous` and a new create/merge requires explicit
 *   lead recovery plus every full precondition.
 * - No descriptor is ever written after a mutation began without the
 *   preconditions having passed first; every existing static config,
 *   capability, per-session gate, confirmation, ancestry, exact-revision
 *   review, conflict, and fresh-view precondition is owned by the tool layer
 *   and unchanged by this module.
 * - Issue creation is out of scope, GitHub APPROVE reviews are never a board
 *   review, and an alternate SHA is never adopted or merged.
 * - This module performs no `gh`, Git, or network calls itself: callers inject
 *   a bounded remote read interface.
 */

export const PUBLISH_REPLAY_RECORD_VERSION = 1
export const PR_CREATE_REPLAY_KIND = "github-pr-create"
export const PR_MERGE_REPLAY_KIND = "github-pr-merge"
export const PUBLISH_REPLAY_MAX_REF = 512
export const PUBLISH_REPLAY_MAX_IDEMPOTENCY_KEY = 512
export const PUBLISH_REPLAY_MAX_REASON = 128

/** Fixed limitation statement for replay tooling. */
export const PUBLISH_REPLAY_LIMITATIONS = [
  "a descriptor makes a replay detectable; it cannot make an external side effect idempotent",
  "the bounded open-PR list is a compensating control: page-bounded, racy, and never an idempotency or exactly-once claim",
  "absence of a list match is not proof of absence; the outcome stays ambiguous and needs explicit lead recovery",
  "all static config, capability, gate, confirmation, ancestry, exact-revision review, conflict, and fresh-view preconditions stay authoritative",
] as const

const fullShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const refSchema = z.string().min(1).max(PUBLISH_REPLAY_MAX_REF)
const reasonSchema = z.string().min(1).max(PUBLISH_REPLAY_MAX_REASON)

const descriptorBase = {
  version: z.literal(PUBLISH_REPLAY_RECORD_VERSION),
  projectID: z.string().min(1),
  sessionID: z.string().min(1),
  taskID: z.string().max(128),
  idempotencyKey: z.string().min(1).max(PUBLISH_REPLAY_MAX_IDEMPOTENCY_KEY),
  repository: z.string().min(3).max(PUBLISH_REPLAY_MAX_REF).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
}

export const PR_CREATE_REPLAY_STATES = ["pending", "adopted", "ambiguous", "blocked"] as const
export type PrCreateReplayState = (typeof PR_CREATE_REPLAY_STATES)[number]

export const PR_MERGE_REPLAY_STATES = ["pending", "merged", "ambiguous", "blocked"] as const
export type PrMergeReplayState = (typeof PR_MERGE_REPLAY_STATES)[number]

export type PrCreateReplayDescriptor = {
  version: 1
  kind: "github-pr-create"
  projectID: string
  sessionID: string
  taskID: string
  idempotencyKey: string
  repository: string
  headRef: string
  baseRef: string
  expectedHeadSHA: string
  expectedBaseSHA: string
  state: PrCreateReplayState
  prNumber?: number
  prURL?: string
  reason?: string
  createdAt: number
  updatedAt: number
}

export type PrMergeReplayDescriptor = {
  version: 1
  kind: "github-pr-merge"
  projectID: string
  sessionID: string
  taskID: string
  idempotencyKey: string
  repository: string
  prNumber: number
  expectedHeadSHA: string
  expectedBaseSHA: string
  state: PrMergeReplayState
  mergeSHA?: string
  reason?: string
  createdAt: number
  updatedAt: number
}

export const prCreateReplaySchema = z
  .object({
    ...descriptorBase,
    kind: z.literal(PR_CREATE_REPLAY_KIND),
    headRef: refSchema,
    baseRef: refSchema,
    expectedHeadSHA: fullShaSchema,
    expectedBaseSHA: fullShaSchema,
    state: z.enum(PR_CREATE_REPLAY_STATES),
    prNumber: z.number().int().positive().safe().optional(),
    prURL: z.string().min(1).max(PUBLISH_REPLAY_MAX_REF).regex(/^https:\/\//).optional(),
    reason: reasonSchema.optional(),
  })
  .strict()

export const prMergeReplaySchema = z
  .object({
    ...descriptorBase,
    kind: z.literal(PR_MERGE_REPLAY_KIND),
    prNumber: z.number().int().positive().safe(),
    expectedHeadSHA: fullShaSchema,
    expectedBaseSHA: fullShaSchema,
    state: z.enum(PR_MERGE_REPLAY_STATES),
    mergeSHA: fullShaSchema.optional(),
    reason: reasonSchema.optional(),
  })
  .strict()

export type PrReplayDescriptor = PrCreateReplayDescriptor | PrMergeReplayDescriptor

export function parsePrReplayDescriptor(value: unknown): PrReplayDescriptor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const kind = (value as { kind?: unknown }).kind
  if (kind === PR_CREATE_REPLAY_KIND) {
    const parsed = prCreateReplaySchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }
  if (kind === PR_MERGE_REPLAY_KIND) {
    const parsed = prMergeReplaySchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }
  return undefined
}

/** Minimal fresh remote snapshot this module needs (structurally satisfied by PullInfo). */
export type ReconcilePullInfo = {
  id: number
  number: number
  html_url: string
  state: string
  merged: boolean
  head?: { ref: string; sha: string }
  base?: { ref: string; sha?: string }
  draft?: boolean
  mergeable?: boolean | null
  mergeableState?: string | null
}

/**
 * Bounded injected reads. A returned `undefined` means the read could not be
 * performed (unavailable); it never means "no match".
 */
export type PrReconcileRemote = {
  listOpenPulls(): Promise<readonly ReconcilePullInfo[] | undefined>
  viewPull(number: number): Promise<ReconcilePullInfo | undefined>
}

export type PrReconcileReason =
  | "descriptor-persist-failed"
  | "descriptor-mismatch"
  | "list-unavailable"
  | "view-unavailable"
  | "no-matching-open-pr"
  | "multiple-matching-prs"
  | "same-refs-different-sha"
  | "incomplete-pr-data"
  | "already-merged"
  | "not-open"
  | "head-moved"
  | "base-moved"
  | "state-changed"

export type PrCreateReconcileOutcome =
  | { status: "proceed"; descriptor: PrCreateReplayDescriptor; descriptorPersisted: true }
  | {
      status: "adopted"
      descriptor: PrCreateReplayDescriptor
      pull: ReconcilePullInfo
      reason: "descriptor-verified" | "open-pr-match"
      descriptorPersisted: boolean
    }
  | { status: "ambiguous"; descriptor?: PrCreateReplayDescriptor; reason: PrReconcileReason }
  | { status: "blocked"; descriptor?: PrCreateReplayDescriptor; reason: PrReconcileReason }
  | { status: "failed"; reason: PrReconcileReason }

export type PrMergeReconcileOutcome =
  | { status: "proceed"; descriptor: PrMergeReplayDescriptor; descriptorPersisted: true }
  | {
      status: "adopted"
      descriptor: PrMergeReplayDescriptor
      pull: ReconcilePullInfo
      mergeSHA?: string
      descriptorPersisted: boolean
    }
  | { status: "ambiguous"; descriptor?: PrMergeReplayDescriptor; reason: PrReconcileReason }
  | { status: "blocked"; descriptor?: PrMergeReplayDescriptor; reason: PrReconcileReason }
  | { status: "failed"; reason: PrReconcileReason }

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/** Deterministic PR-create identity: same repository/refs/expected head = same operation. */
export function prCreateIdempotencyKey(input: {
  repository: string
  headRef: string
  baseRef: string
  expectedHeadSHA: string
}): string {
  return boundKey(`${input.repository}|${input.headRef}|${input.baseRef}|${input.expectedHeadSHA}`)
}

/** Deterministic PR-merge identity: same PR/expected revisions = same operation. */
export function prMergeIdempotencyKey(input: {
  repository: string
  prNumber: number
  expectedHeadSHA: string
  expectedBaseSHA: string
}): string {
  return boundKey(`${input.repository}#${input.prNumber}|${input.expectedHeadSHA}|${input.expectedBaseSHA}`)
}

function boundKey(value: string): string {
  if (value.length <= PUBLISH_REPLAY_MAX_IDEMPOTENCY_KEY) return value
  return value.slice(0, PUBLISH_REPLAY_MAX_IDEMPOTENCY_KEY - 1)
}

/** Storage key for one descriptor: project/session/kind/stable-hash(idempotencyKey). */
export function replayStorageKey(
  projectID: string,
  sessionID: string,
  kind: string,
  idempotencyKey: string,
): string {
  return `publish-replay/v1/${segment(projectID)}/${segment(sessionID)}/${segment(kind)}/${fnv1a64(idempotencyKey)}`
}

async function readDescriptor<T extends PrReplayDescriptor>(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  kind: string,
  idempotencyKey: string,
): Promise<{ projectID: string; descriptor?: T }> {
  const projectID = await stableProjectID(storage, location, sessionID)
  const value = await storage.get(replayStorageKey(projectID, sessionID, kind, idempotencyKey))
  if (value === undefined) return { projectID }
  const parsed = parsePrReplayDescriptor(value)
  if (!parsed || parsed.kind !== kind) {
    console.warn(`Ignoring malformed replay descriptor for ${kind}`)
    return { projectID }
  }
  return { projectID, descriptor: parsed as T }
}

async function writeDescriptor(
  storage: StorageLike,
  descriptor: PrReplayDescriptor,
): Promise<boolean> {
  try {
    const parsed = descriptor.kind === PR_CREATE_REPLAY_KIND ? prCreateReplaySchema.parse(descriptor) : prMergeReplaySchema.parse(descriptor)
    await storage.set(
      replayStorageKey(parsed.projectID, parsed.sessionID, parsed.kind, parsed.idempotencyKey),
      parsed,
    )
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* PR create reconciliation                                            */
/* ------------------------------------------------------------------ */

export type PrCreateReconcileInput = {
  storage: StorageLike
  location: LocationLike
  sessionID: string
  remote: PrReconcileRemote
  repository: string
  headRef: string
  baseRef: string
  expectedHeadSHA: string
  expectedBaseSHA: string
  taskID?: string
  now?: number
}

/**
 * Reconcile a PR draft-create attempt BEFORE any POST.
 *
 * - No descriptor: persist the pending descriptor and `proceed` (the caller
 *   then runs every precondition and creates). A descriptor write failure is a
 *   hard `failed` — the mutation must not start without its identity record.
 * - Descriptor present: a fresh, bounded open-PR list decides. An exact
 *   head.ref + base.ref match with the exact expected SHAs adopts the
 *   number/URL with zero second POST; same refs with a different SHA is
 *   `blocked`; no match stays `ambiguous` (absence is not proof); incomplete
 *   or unreadable reads fail closed.
 */
export async function reconcilePrCreate(input: PrCreateReconcileInput): Promise<PrCreateReconcileOutcome> {
  const now = input.now ?? Date.now()
  const idempotencyKey = prCreateIdempotencyKey(input)
  const read = await readDescriptor<PrCreateReplayDescriptor>(
    input.storage,
    input.location,
    input.sessionID,
    PR_CREATE_REPLAY_KIND,
    idempotencyKey,
  )
  const projectID = read.projectID
  const existing = read.descriptor
  if (existing) {
    const sameIdentity =
      existing.repository === input.repository &&
      existing.headRef === input.headRef &&
      existing.baseRef === input.baseRef &&
      existing.expectedHeadSHA === input.expectedHeadSHA &&
      existing.expectedBaseSHA === input.expectedBaseSHA &&
      existing.idempotencyKey === idempotencyKey
    if (!sameIdentity) return { status: "blocked", descriptor: existing, reason: "descriptor-mismatch" }
    if (existing.state === "adopted" && existing.prNumber !== undefined) {
      const view = await input.remote.viewPull(existing.prNumber)
      if (!view) return { status: "ambiguous", descriptor: existing, reason: "view-unavailable" }
      if (view.state !== "open" || view.merged) {
        return { status: "blocked", descriptor: existing, reason: "not-open" }
      }
      if (view.head?.ref === input.headRef && view.head?.sha === input.expectedHeadSHA && view.base?.sha === input.expectedBaseSHA) {
        return { status: "adopted", descriptor: existing, pull: view, reason: "descriptor-verified", descriptorPersisted: true }
      }
      return { status: "blocked", descriptor: existing, reason: "same-refs-different-sha" }
    }
  }

  const descriptor: PrCreateReplayDescriptor = existing ?? {
    version: PUBLISH_REPLAY_RECORD_VERSION,
    kind: "github-pr-create",
    projectID,
    sessionID: input.sessionID,
    taskID: input.taskID ?? "",
    idempotencyKey,
    repository: input.repository,
    headRef: input.headRef,
    baseRef: input.baseRef,
    expectedHeadSHA: input.expectedHeadSHA,
    expectedBaseSHA: input.expectedBaseSHA,
    state: "pending",
    createdAt: now,
    updatedAt: now,
  }

  if (!existing) {
    const persisted = await writeDescriptor(input.storage, descriptor)
    if (!persisted) return { status: "failed", reason: "descriptor-persist-failed" }
    return { status: "proceed", descriptor, descriptorPersisted: true }
  }

  const openPulls = await input.remote.listOpenPulls()
  if (openPulls === undefined) return { status: "ambiguous", descriptor, reason: "list-unavailable" }
  const matches = openPulls.filter((pull) => pull.head?.ref === input.headRef && pull.base?.ref === input.baseRef)
  if (matches.length === 0) return { status: "ambiguous", descriptor, reason: "no-matching-open-pr" }
  const exact = matches.filter(
    (pull) =>
      pull.head?.sha === input.expectedHeadSHA &&
      pull.base?.sha === input.expectedBaseSHA &&
      pull.state === "open" &&
      !pull.merged,
  )
  if (exact.length === 1) {
    const adopted: PrCreateReplayDescriptor = {
      ...descriptor,
      state: "adopted",
      prNumber: exact[0]!.number,
      prURL: exact[0]!.html_url,
      reason: "open-pr-match",
      updatedAt: now,
    }
    const persisted = await writeDescriptor(input.storage, adopted)
    return { status: "adopted", descriptor: adopted, pull: exact[0]!, reason: "open-pr-match", descriptorPersisted: persisted }
  }
  if (exact.length > 1) return { status: "ambiguous", descriptor, reason: "multiple-matching-prs" }
  const incomplete = matches.some((pull) => !pull.head?.sha || pull.base?.sha === undefined)
  const blocked: PrCreateReplayDescriptor = {
    ...descriptor,
    state: "blocked",
    reason: incomplete ? "incomplete-pr-data" : "same-refs-different-sha",
    updatedAt: now,
  }
  await writeDescriptor(input.storage, blocked)
  return { status: "blocked", descriptor: blocked, reason: blocked.reason === "incomplete-pr-data" ? "incomplete-pr-data" : "same-refs-different-sha" }
}

/** Record the created PR (or the lost-response ambiguity) after a create attempt. */
export async function recordPrCreateResult(
  storage: StorageLike,
  descriptor: PrCreateReplayDescriptor,
  result:
    | { status: "created"; prNumber: number; prURL: string }
    | { status: "lost-response" }
    | { status: "failed" },
  now = Date.now(),
): Promise<boolean> {
  if (result.status === "failed") return true
  const next: PrCreateReplayDescriptor = {
    ...descriptor,
    state: result.status === "created" ? "adopted" : "ambiguous",
    ...(result.status === "created" ? { prNumber: result.prNumber, prURL: result.prURL, reason: "created" } : { reason: "lost-response" }),
    updatedAt: now,
  }
  return writeDescriptor(storage, next)
}

/* ------------------------------------------------------------------ */
/* PR merge reconciliation                                             */
/* ------------------------------------------------------------------ */

export type PrMergeReconcileInput = {
  storage: StorageLike
  location: LocationLike
  sessionID: string
  remote: PrReconcileRemote
  repository: string
  prNumber: number
  expectedHeadSHA: string
  expectedBaseSHA: string
  taskID?: string
  now?: number
}

/**
 * Reconcile a PR merge attempt BEFORE any PUT.
 *
 * - No descriptor: persist the pending descriptor and `proceed` (the caller
 *   then re-runs every precondition and merges). A descriptor write failure is
 *   a hard `failed`.
 * - Descriptor present: a fresh PR view decides. `merged: true` adopts the
 *   merge (with the recorded merge SHA when known) and never re-PUTs; a still
 *   open PR at the exact expected head/base proceeds to the caller's full
 *   precondition re-evaluation (explicit lead recovery); a moved revision,
 *   closed/unknown state, or unavailable view is `ambiguous`/`blocked`.
 */
export async function reconcilePrMerge(input: PrMergeReconcileInput): Promise<PrMergeReconcileOutcome> {
  const now = input.now ?? Date.now()
  const idempotencyKey = prMergeIdempotencyKey(input)
  const read = await readDescriptor<PrMergeReplayDescriptor>(
    input.storage,
    input.location,
    input.sessionID,
    PR_MERGE_REPLAY_KIND,
    idempotencyKey,
  )
  const projectID = read.projectID
  const existing = read.descriptor
  if (existing) {
    const sameIdentity =
      existing.repository === input.repository &&
      existing.prNumber === input.prNumber &&
      existing.expectedHeadSHA === input.expectedHeadSHA &&
      existing.expectedBaseSHA === input.expectedBaseSHA &&
      existing.idempotencyKey === idempotencyKey
    if (!sameIdentity) return { status: "blocked", descriptor: existing, reason: "descriptor-mismatch" }
  }

  const descriptor: PrMergeReplayDescriptor = existing ?? {
    version: PUBLISH_REPLAY_RECORD_VERSION,
    kind: "github-pr-merge",
    projectID,
    sessionID: input.sessionID,
    taskID: input.taskID ?? "",
    idempotencyKey,
    repository: input.repository,
    prNumber: input.prNumber,
    expectedHeadSHA: input.expectedHeadSHA,
    expectedBaseSHA: input.expectedBaseSHA,
    state: "pending",
    createdAt: now,
    updatedAt: now,
  }

  if (!existing) {
    const persisted = await writeDescriptor(input.storage, descriptor)
    if (!persisted) return { status: "failed", reason: "descriptor-persist-failed" }
    return { status: "proceed", descriptor, descriptorPersisted: true }
  }

  const view = await input.remote.viewPull(input.prNumber)
  if (!view) return { status: "ambiguous", descriptor, reason: "view-unavailable" }
  if (view.merged) {
    const adopted: PrMergeReplayDescriptor = {
      ...descriptor,
      state: "merged",
      ...(descriptor.mergeSHA !== undefined ? { mergeSHA: descriptor.mergeSHA } : {}),
      reason: "already-merged",
      updatedAt: now,
    }
    const persisted = await writeDescriptor(input.storage, adopted)
    return {
      status: "adopted",
      descriptor: adopted,
      pull: view,
      ...(adopted.mergeSHA !== undefined ? { mergeSHA: adopted.mergeSHA } : {}),
      descriptorPersisted: persisted,
    }
  }
  if (view.state !== "open") {
    const blocked: PrMergeReplayDescriptor = { ...descriptor, state: "blocked", reason: "not-open", updatedAt: now }
    await writeDescriptor(input.storage, blocked)
    return { status: "blocked", descriptor: blocked, reason: "not-open" }
  }
  if (view.head?.sha !== input.expectedHeadSHA) {
    const blocked: PrMergeReplayDescriptor = { ...descriptor, state: "blocked", reason: "head-moved", updatedAt: now }
    await writeDescriptor(input.storage, blocked)
    return { status: "blocked", descriptor: blocked, reason: "head-moved" }
  }
  if (view.base?.sha !== undefined && view.base.sha !== input.expectedBaseSHA) {
    const blocked: PrMergeReplayDescriptor = { ...descriptor, state: "blocked", reason: "base-moved", updatedAt: now }
    await writeDescriptor(input.storage, blocked)
    return { status: "blocked", descriptor: blocked, reason: "base-moved" }
  }
  // Still open at the exact expected revision: the caller re-evaluates every
  // precondition (draft, mergeable, conflict, ancestry, review, gates) and only
  // then retries the PUT — explicit lead recovery, never a blind re-PUT.
  return { status: "proceed", descriptor, descriptorPersisted: true }
}

/** Record the merge outcome (or the lost-response ambiguity) after a merge attempt. */
export async function recordPrMergeResult(
  storage: StorageLike,
  descriptor: PrMergeReplayDescriptor,
  result: { status: "merged"; mergeSHA?: string } | { status: "lost-response" } | { status: "failed" },
  now = Date.now(),
): Promise<boolean> {
  if (result.status === "failed") return true
  const next: PrMergeReplayDescriptor = {
    ...descriptor,
    state: result.status === "merged" ? "merged" : "ambiguous",
    ...(result.status === "merged" && result.mergeSHA !== undefined ? { mergeSHA: result.mergeSHA } : {}),
    reason: result.status === "merged" ? "merged" : "lost-response",
    updatedAt: now,
  }
  return writeDescriptor(storage, next)
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, "0")
}
