import { z } from "zod"

/**
 * Durable session anchor state.
 *
 * Anchors track where a session started (`originProjectID`/`originDirectory`)
 * vs. where it currently lives (`currentProjectID`/`currentDirectory`). The
 * record is keyed by the *current* project so reads always match the live
 * location, while `originProjectID` is preserved across moves.
 *
 * This module is intentionally free of filesystem/process/gh/git calls: it
 * only reads and writes durable storage through a storage-like interface.
 */

export type SessionStatus = "active" | "moved"

export type SessionAnchor = {
  version: 1
  sessionID: string
  originProjectID: string
  originDirectory: string
  currentProjectID: string
  currentDirectory: string
  workspaceID?: string
  subpath?: string
  status?: SessionStatus
  updatedAt: number
}

export type StorageLike = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export type NewSessionAnchorInput = {
  sessionID: string
  originProjectID: string
  originDirectory: string
  currentProjectID: string
  currentDirectory: string
  workspaceID?: string
  subpath?: string
}

export type MoveSessionAnchorInput = {
  projectID: string
  directory: string
  workspaceID?: string
  subpath?: string
}

export const sessionAnchorSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1),
    originProjectID: z.string().min(1),
    originDirectory: z.string().min(1),
    currentProjectID: z.string().min(1),
    currentDirectory: z.string().min(1),
    workspaceID: z.string().min(1).optional(),
    subpath: z.string().min(1).optional(),
    status: z.enum(["active", "moved"]).optional(),
    updatedAt: z.number().finite(),
  })
  .strict()

/**
 * A pre-migration anchor record that predates origin tracking (has current
 * location but no origin fields). Migration infers `originProjectID` from the
 * current project only when it is the unique candidate, so we never guess a
 * stable origin from ambiguous history.
 */
const sessionAnchorUpgradeSchema = z
  .object({
    sessionID: z.string().min(1),
    originProjectID: z.string().min(1).optional(),
    originDirectory: z.string().min(1).optional(),
    currentProjectID: z.string().min(1),
    currentDirectory: z.string().min(1),
    workspaceID: z.string().min(1).optional(),
    subpath: z.string().min(1).optional(),
    updatedAt: z.number().finite(),
  })
  .strict()

/** Stable project-anchored key for a session anchor, keyed by the current project. */
export function sessionAnchorStorageKey(projectID: string, sessionID: string): string {
  return `session/v1/${segment(projectID)}/${segment(sessionID)}`
}

export function newSessionAnchor(input: NewSessionAnchorInput, now = Date.now()): SessionAnchor {
  return {
    version: 1,
    sessionID: input.sessionID,
    originProjectID: input.originProjectID,
    originDirectory: input.originDirectory,
    currentProjectID: input.currentProjectID,
    currentDirectory: input.currentDirectory,
    workspaceID: input.workspaceID,
    subpath: input.subpath,
    status: "active",
    updatedAt: now,
  }
}

/**
 * Returns `currentProjectID` as the inferred origin only when it is the sole
 * candidate project. With zero or multiple candidates the origin is
 * ambiguous and this returns `undefined`, signalling that we must not guess.
 */
export function inferOriginProjectID(currentProjectID: string, candidates: readonly string[]): string | undefined {
  const unique = new Set(candidates)
  if (unique.size !== 1) return undefined
  const only = [...unique][0]
  return only === currentProjectID ? only : undefined
}

/**
 * Reads and strictly parses a session anchor for the current project.
 *
 * When a stored record predates origin tracking (missing `originProjectID`),
 * migration infers it from the current project but only when it is the unique
 * candidate among `options.candidates`. Otherwise the malformed record is
 * ignored rather than guessed.
 */
export async function readSessionAnchor(
  storage: StorageLike,
  projectID: string,
  sessionID: string,
  options?: { candidates?: readonly string[] },
): Promise<SessionAnchor | undefined> {
  const raw = await storage.get(sessionAnchorStorageKey(projectID, sessionID))
  if (raw === undefined) return undefined

  const direct = sessionAnchorSchema.safeParse(raw)
  if (direct.success) return direct.data

  const upgrade = sessionAnchorUpgradeSchema.safeParse(raw)
  if (upgrade.success && !upgrade.data.originProjectID && !upgrade.data.originDirectory) {
    const candidates = options?.candidates ?? [upgrade.data.currentProjectID]
    const originProjectID = inferOriginProjectID(upgrade.data.currentProjectID, candidates)
    if (originProjectID) {
      return {
        version: 1,
        sessionID: upgrade.data.sessionID,
        originProjectID,
        originDirectory: upgrade.data.currentDirectory,
        currentProjectID: upgrade.data.currentProjectID,
        currentDirectory: upgrade.data.currentDirectory,
        workspaceID: upgrade.data.workspaceID,
        subpath: upgrade.data.subpath,
        updatedAt: upgrade.data.updatedAt,
      }
    }
  }

  console.warn(`Ignoring malformed session anchor state at ${sessionAnchorStorageKey(projectID, sessionID)}`)
  return undefined
}

/**
 * Writes a session anchor at the *current* project key, preserving whatever
 * `originProjectID`/`originDirectory` the caller carried in. Use this after a
 * move with the record produced by `moveSessionAnchor` (or a hand-authored
 * anchor) so the origin stays stable.
 */
export async function writeSessionAnchor(
  storage: StorageLike,
  anchor: SessionAnchor,
  now = Date.now(),
): Promise<SessionAnchor> {
  const next: SessionAnchor = { ...anchor, updatedAt: now }
  await storage.set(sessionAnchorStorageKey(next.currentProjectID, next.sessionID), next)
  return next
}

/**
 * Moves an existing anchor to a new current project, preserving the origin.
 * Reads the stored anchor at `projectID`; if found it carries
 * `originProjectID`/`originDirectory` into the record written at the new key
 * and removes the old key. Returns `undefined` when no anchor exists to move.
 */
export async function moveSessionAnchor(
  storage: StorageLike,
  projectID: string,
  sessionID: string,
  next: MoveSessionAnchorInput,
  now = Date.now(),
): Promise<SessionAnchor | undefined> {
  const record = await readSessionAnchor(storage, projectID, sessionID)
  if (!record) return undefined

  const moved: SessionAnchor = {
    version: 1,
    sessionID,
    originProjectID: record.originProjectID,
    originDirectory: record.originDirectory,
    currentProjectID: next.projectID,
    currentDirectory: next.directory,
    workspaceID: next.workspaceID,
    subpath: next.subpath,
    status: "moved",
    updatedAt: now,
  }
  await storage.set(sessionAnchorStorageKey(next.projectID, sessionID), moved)
  await storage.remove(sessionAnchorStorageKey(projectID, sessionID))
  return moved
}

function segment(value: string): string {
  return encodeURIComponent(value)
}
