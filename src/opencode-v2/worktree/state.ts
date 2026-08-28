import { z } from "zod"

/**
 * Durable worktree lifecycle state (stage 2).
 *
 * Records track the tracked worktree lifecycle through
 * `pending -> ready -> moved/dirty/orphaned -> (cleanup) removed`, with
 * `cleanup-failed` persisting a failed removal for operator review.
 *
 * Key namespace: this module deliberately uses `worktree/v2/...`, NOT the
 * `worktree/v1/...` namespace already claimed by
 * `src/opencode-v2/session/state.ts`. Stage 1 defined a WorktreeRecord there
 * with an incompatible lifecycle enum (`created/attached/closed/removed`) and
 * strict parsing; sharing keys would make each module reject the other's
 * records as malformed and clobber them. The v2 namespace keeps the two
 * generations separate; a later migration stage can alias or fold v1 records.
 *
 * This module is free of filesystem/process/git calls: it only reads and
 * writes durable storage through a storage-like interface.
 */

export type WorktreeStatus = "pending" | "ready" | "moved" | "dirty" | "orphaned" | "cleanup-failed"

export type WorktreeRecord = {
  version: 1
  /** The session that created the worktree. */
  owner: string
  /** The session that owns (or last touched) the worktree. */
  sessionID: string
  /** Origin project the tree is anchored to; the key stays stable across moves. */
  originProjectID: string
  /** Main checkout the worktree was linked from. */
  repoRoot: string
  /** Absolute path of the linked worktree checkout. */
  dir: string
  /** Local branch created for the tree (`git worktree add -b <branch>`). */
  branch: string
  /** Commit-ish the branch was created from. */
  base: string
  status: WorktreeStatus
  createdAt: number
  updatedAt: number
}

/**
 * Last-known session location index. `session.moved` events only carry the
 * *new* project, so the old project key (needed to relocate the stage-1
 * anchor and to find the origin-anchored worktree record) is recovered from
 * this index.
 */
export type SessionIndexRecord = {
  version: 1
  sessionID: string
  /** Last-known current project. */
  projectID: string
  /** First-seen (origin) project, stable across moves. */
  originProjectID: string
  directory: string
  updatedAt: number
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

export type NewWorktreeInput = {
  owner: string
  sessionID: string
  originProjectID: string
  repoRoot: string
  dir: string
  branch: string
  base: string
}

const worktreeSchema = z
  .object({
    version: z.literal(1),
    owner: z.string().min(1),
    sessionID: z.string().min(1),
    originProjectID: z.string().min(1),
    repoRoot: z.string().min(1),
    dir: z.string().min(1),
    branch: z.string().min(1),
    base: z.string().min(1),
    status: z.enum(["pending", "ready", "moved", "dirty", "orphaned", "cleanup-failed"]),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .strict()

const sessionIndexSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1),
    projectID: z.string().min(1),
    originProjectID: z.string().min(1),
    directory: z.string().min(1),
    updatedAt: z.number().finite(),
  })
  .strict()

/** Origin-anchored key for a worktree record (distinct v2 namespace). */
export function worktreeStorageKey(originProjectID: string, sessionID: string): string {
  return `worktree/v2/${segment(originProjectID)}/${segment(sessionID)}`
}

/** Session location index key, kept out of the record scan path's key shape. */
export function sessionIndexStorageKey(sessionID: string): string {
  return `worktree/v2/sessions/${segment(sessionID)}`
}

export function newWorktree(input: NewWorktreeInput, now = Date.now()): WorktreeRecord {
  return {
    version: 1,
    owner: input.owner,
    sessionID: input.sessionID,
    originProjectID: input.originProjectID,
    repoRoot: input.repoRoot,
    dir: input.dir,
    branch: input.branch,
    base: input.base,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  }
}

export async function readWorktree(
  storage: StorageLike,
  originProjectID: string,
  sessionID: string,
): Promise<WorktreeRecord | undefined> {
  return readVersioned(storage, worktreeStorageKey(originProjectID, sessionID), worktreeSchema, "worktree")
}

export async function writeWorktree(storage: StorageLike, record: WorktreeRecord, now = Date.now()): Promise<WorktreeRecord> {
  const next: WorktreeRecord = { ...record, updatedAt: now }
  await storage.set(worktreeStorageKey(next.originProjectID, next.sessionID), next)
  return next
}

export async function readSessionIndex(
  storage: StorageLike,
  sessionID: string,
): Promise<SessionIndexRecord | undefined> {
  return readVersioned(storage, sessionIndexStorageKey(sessionID), sessionIndexSchema, "session index")
}

export async function writeSessionIndex(
  storage: StorageLike,
  record: SessionIndexRecord,
  now = Date.now(),
): Promise<SessionIndexRecord> {
  const next: SessionIndexRecord = { ...record, updatedAt: now }
  await storage.set(sessionIndexStorageKey(next.sessionID), next)
  return next
}

/**
 * Enumerate durable worktree records via `scan` when the storage exposes it.
 * Session index entries share the `worktree/v2` prefix but fail the strict
 * record schema, so they are skipped. Returns `[]` when scan is unavailable.
 */
export async function listWorktrees(storage: StorageLike): Promise<WorktreeRecord[]> {
  if (!storage.scan) return []
  const records: WorktreeRecord[] = []
  let after: string | undefined
  for (;;) {
    const page = await storage.scan({ prefix: "worktree/v2/", after, limit: 100 })
    for (const entry of page.entries) {
      const parsed = worktreeSchema.safeParse(entry.value)
      if (parsed.success) records.push(parsed.data)
    }
    if (!page.next) return records
    after = page.next
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