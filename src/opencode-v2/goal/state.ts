import { z } from "zod"
import { readSessionAnchor } from "../session/state.js"

export type GoalStatus = "active" | "paused" | "complete"

export type GoalRecord = {
  version: 1
  sessionID: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  continuationCount: number
  lastContinuationAt?: number
  completedAt?: number
  completionEvidence?: string
}

export type PlanRunStatus = "active" | "paused" | "complete"

export type PlanRunRecord = {
  version: 1
  sessionID: string
  plan?: string
  status: PlanRunStatus
  createdAt: number
  updatedAt: number
}

export type AutomationStop = {
  version: 1
  sessionID: string
  stoppedAt: number
}

export type StorageLike = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan?: (options: { prefix: string; after?: string; limit?: number }) => Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }>
}

export type LocationLike = {
  directory: string
  workspaceID?: string
  project: {
    id: string
  }
}

export const goalSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1),
    objective: z.string().min(1),
    status: z.enum(["active", "paused", "complete"]),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    continuationCount: z.number().int().nonnegative(),
    lastContinuationAt: z.number().finite().optional(),
    completedAt: z.number().finite().optional(),
    completionEvidence: z.string().min(1).optional(),
  })
  .strict()

export const planRunSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1),
    plan: z.string().min(1).optional(),
    status: z.enum(["active", "paused", "complete"]),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .strict()

export const automationStopSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1),
    stoppedAt: z.number().finite(),
  })
  .strict()

export function goalStorageKey(location: LocationLike, sessionID: string): string {
  return `goal/v1/${segment(location.project.id)}/${segment(sessionID)}`
}

/**
 * Storage prefix under which every goal record for one project lives.
 * Peer discovery scans exactly this prefix so it can never read records
 * keyed under another project.
 */
export function goalProjectPrefix(projectID: string): string {
  return `goal/v1/${segment(projectID)}/`
}

/**
 * Inverse of `goalStorageKey` for scan entries: extracts the session ID
 * suffix from a goal record key for `projectID`. Returns undefined for keys
 * that do not match the exact `goal/v1/<project>/<session>` shape (extra or
 * missing segments), so malformed or foreign keys are never attributed to a
 * session.
 */
export function goalSessionIDFromKey(key: string, projectID: string): string | undefined {
  const prefix = goalProjectPrefix(projectID)
  if (!key.startsWith(prefix)) return undefined
  const session = key.slice(prefix.length)
  if (!session || session.length === 0 || session.includes("/") || session.length > 512) return undefined
  try {
    return decodeURIComponent(session)
  } catch {
    return undefined
  }
}

/**
 * Parses one candidate goal record value without touching storage.
 * Safe read helper for scan paths (peer discovery): a malformed value
 * returns undefined instead of throwing and is counted by the caller.
 */
export function parseGoalRecord(value: unknown): GoalRecord | undefined {
  const parsed = goalSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * Resolves the project ID durable goal/run/halt state is keyed under for a
 * session: the session anchor's stable `originProjectID` when an anchor is
 * present at the given location, otherwise the location's own project ID.
 *
 * A session that moved via `orchestrator_worktree_enter` (or a native
 * `session.moved` event) relocates its anchor to the *current* project, so
 * reads here deliberately target the plugin's stable origin location:
 * goal/run/halt records were created under that project and must remain
 * findable after the move. Only an anchor that
 * still lives at the origin project (and records a different origin) changes
 * the answer. This keeps storage keys project-stable across moves.
 */
export async function stableProjectID(storage: StorageLike, location: LocationLike, sessionID: string): Promise<string> {
  try {
    const anchor = await readSessionAnchor(storage, location.project.id, sessionID)
    if (anchor?.originProjectID) return anchor.originProjectID
  } catch {
    // Fall through to the location's own project ID.
  }
  return location.project.id
}

export function runStorageKey(location: LocationLike, sessionID: string): string {
  return `run/v1/${segment(location.project.id)}/${segment(sessionID)}`
}

export function stopStorageKey(location: LocationLike, sessionID: string): string {
  return `halt/v1/${segment(location.project.id)}/${segment(sessionID)}`
}

const sessionLocks = new Map<string, Promise<void>>()

/**
 * Bound on how long one operation waits for a session's process-local lock.
 * The lock serializes reservations, board mutations, review writes, and step
 * receipts for one session; a holder that never returns would otherwise queue
 * every later operation forever with no diagnostic. Exceeding the bound is a
 * refusal, never a silent parallel run: the timed-out caller joins the end of
 * the queue so mutual exclusion is preserved for whoever holds the lock next.
 */
export const SESSION_LOCK_TIMEOUT_MS = 30_000

export class SessionLockTimeoutError extends Error {
  readonly sessionID: string

  constructor(sessionID: string, timeoutMs: number) {
    super(`session lock wait exceeded ${timeoutMs}ms for ${sessionID}; the holding operation did not finish`)
    this.name = "SessionLockTimeoutError"
    this.sessionID = sessionID
  }
}

export async function withSessionLock<T>(
  location: LocationLike,
  sessionID: string,
  action: () => Promise<T>,
  timeoutMs: number = SESSION_LOCK_TIMEOUT_MS,
): Promise<T> {
  const key = `${location.project.id}:${sessionID}`
  const previous = sessionLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  sessionLocks.set(key, tail)
  // Cleanup is attached to the chain itself rather than to the caller, so a
  // timed-out waiter still removes its slot once the chain drains.
  void tail
    .then(() => {
      if (sessionLocks.get(key) === tail) sessionLocks.delete(key)
    })
    .catch(() => undefined)

  if (!(await acquireWithin(previous, timeoutMs))) {
    // Never run the action without the lock. Releasing our slot keeps the
    // queue draining for everyone already waiting behind us.
    release()
    throw new SessionLockTimeoutError(sessionID, timeoutMs)
  }
  try {
    return await action()
  } finally {
    release()
  }
}

/** Resolves true once `previous` settles, false when the bound elapses first. */
function acquireWithin(previous: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, timeoutMs)
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref()
    void previous.then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export async function readGoal(storage: StorageLike, key: string): Promise<GoalRecord | undefined> {
  return readVersioned(storage, key, goalSchema, "goal")
}

export async function readPlanRun(storage: StorageLike, key: string): Promise<PlanRunRecord | undefined> {
  return readVersioned(storage, key, planRunSchema, "plan run")
}

export async function readAutomationStop(storage: StorageLike, key: string): Promise<AutomationStop | undefined> {
  return readVersioned(storage, key, automationStopSchema, "halt")
}

export function newGoal(sessionID: string, objective: string, now = Date.now()): GoalRecord {
  return {
    version: 1,
    sessionID,
    objective: objective.trim(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    continuationCount: 0,
  }
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

async function readVersioned<T>(
  storage: StorageLike,
  key: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T | undefined> {
  const value = await storage.get(key)
  if (value === undefined) return undefined
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    console.warn(`Ignoring malformed ${label} state at ${key}`)
    return undefined
  }
  return parsed.data
}
