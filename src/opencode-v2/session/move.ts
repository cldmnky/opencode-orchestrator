import { resolve } from "node:path"
import { stat } from "node:fs/promises"
import {
  moveSessionAnchor,
  newSessionAnchor,
  readSessionAnchor,
  writeSessionAnchor,
  type SessionAnchor,
  type StorageLike as SessionStorageLike,
} from "./state.js"
import {
  readSessionIndex,
  readWorktree,
  writeSessionIndex,
  writeWorktree,
  type StorageLike as WorktreeStorageLike,
} from "../worktree/state.js"

/**
 * Reusable session-move primitive (stage 4).
 *
 * `orchestrator_worktree_enter` and native session moves share one helper so
 * both preserve the durable session anchor, the worktree session index, and
 * the tracked worktree ownership when a session changes directory:
 *
 * - The target is resolved against the session's *current* location (from
 *   `session.get`), not the plugin's load-time location, so a session that
 *   already moved keeps resolving relative paths where it lives.
 * - The target must exist and be a directory. NUL bytes, flag-shaped tokens,
 *   and shell metacharacters are rejected; the move never runs a shell.
 * - `session.move` is called with the workspace ID carried over from the
 *   session's current location and the caller's delivery (queue/steer), so
 *   the same session keeps its ID and history.
 * - After the move the session is re-read and the target is verified; only
 *   then is durable state updated. The anchor is relocated to the new
 *   project with `originProjectID`/`originDirectory` preserved (or written
 *   fresh when no anchor exists yet), the worktree session index advances,
 *   and any tracked worktree owned by the session is marked `moved` so
 *   push/cleanup never mistake the relocated owner for an idle one.
 *
 * Goal/run/halt state is NOT touched here: those keys are scoped to the
 * plugin's stable origin project, so they remain findable after the move
 * (see `stableProjectID` in `../goal/state.ts`).
 */

export type MoveSessionDeps = {
  session: {
    get(input: { sessionID: string }): Promise<unknown>
    move(input: {
      sessionID: string
      directory: string
      workspaceID?: string
      delivery?: "steer" | "queue" | null
    }): Promise<void>
  }
  storage: SessionStorageLike & WorktreeStorageLike
  /** The plugin's stable origin location; used as the fallback origin. */
  location: { directory: string; workspaceID?: string; project: { id: string } }
  /** Injectable existence/directory probe; defaults to `stat`. */
  pathInfo?: (directory: string) => Promise<{ exists: boolean; isDirectory: boolean }>
}

export type SessionInfoLike = {
  id: string
  projectID?: string
  location?: { directory?: unknown; workspaceID?: unknown }
  subpath?: unknown
}

export type MoveSessionInput = {
  sessionID: string
  /** Raw target: absolute, or relative to the session's current directory. */
  target: string
  delivery?: "steer" | "queue" | null
}

export type MoveSessionFailure = { ok: false; reason: string }
export type MoveSessionSuccess = { ok: true; session: SessionInfoLike; anchor: SessionAnchor }
export type MoveSessionOutcome = MoveSessionSuccess | MoveSessionFailure

export async function moveSessionToDirectory(deps: MoveSessionDeps, input: MoveSessionInput): Promise<MoveSessionOutcome> {
  const before = sessionInfo(await deps.session.get({ sessionID: input.sessionID }))
  if (!before) return { ok: false, reason: "could not read the current session before moving" }

  const baseDirectory = typeof before.location?.directory === "string" ? before.location.directory : deps.location.directory
  const invalid = validateTarget(input.target)
  if (invalid) return { ok: false, reason: invalid }

  const target = resolve(baseDirectory, input.target)
  const probe = deps.pathInfo ?? statProbe
  const info = await probe(target)
  if (!info.exists) return { ok: false, reason: `target does not exist: ${redact(target)}` }
  if (!info.isDirectory) return { ok: false, reason: `target is not a directory: ${redact(target)}` }

  const workspaceID = typeof before.location?.workspaceID === "string" ? before.location.workspaceID : deps.location.workspaceID
  try {
    await deps.session.move({
      sessionID: input.sessionID,
      directory: target,
      ...(workspaceID !== undefined ? { workspaceID } : {}),
      ...(input.delivery ? { delivery: input.delivery } : {}),
    })
  } catch (error) {
    return { ok: false, reason: `session move failed: ${redact(errorMessage(error))}` }
  }

  const after = sessionInfo(await deps.session.get({ sessionID: input.sessionID }))
  if (!after) return { ok: false, reason: "could not re-read the session after moving" }
  if (after.id !== input.sessionID) return { ok: false, reason: `session move verification failed: session ID changed` }
  const afterDirectory = typeof after.location?.directory === "string" ? after.location.directory : ""
  if (resolve(afterDirectory) !== target) {
    return { ok: false, reason: `session move verification failed: session is at ${redact(afterDirectory)}, expected ${redact(target)}` }
  }

  const anchor = await relocateAnchor(deps, input.sessionID, {
    before,
    after,
    target,
    fallbackOrigin: { directory: baseDirectory, projectID: before.projectID ?? deps.location.project.id },
  })
  return { ok: true, session: after, anchor }
}

async function relocateAnchor(
  deps: MoveSessionDeps,
  sessionID: string,
  input: {
    before: SessionInfoLike
    after: SessionInfoLike
    target: string
    fallbackOrigin: { directory: string; projectID: string }
  },
): Promise<SessionAnchor> {
  const storage = deps.storage
  const now = Date.now()
  // The session index records the last-known current project. The anchor is
  // keyed by the *current* project, so the pre-move project is recovered from
  // the index when available (or from the pre-move session itself).
  const index = await readSessionIndex(storage, sessionID)
  const oldProjectID = index?.projectID ?? input.before.projectID ?? input.fallbackOrigin.projectID
  const originProjectID = index?.originProjectID ?? input.before.projectID ?? input.fallbackOrigin.projectID
  const newProjectID = input.after.projectID ?? oldProjectID
  const workspaceID =
    (typeof input.after.location?.workspaceID === "string" && input.after.location.workspaceID) ||
    (typeof input.before.location?.workspaceID === "string" && input.before.location.workspaceID) ||
    deps.location.workspaceID
  const subpath = typeof input.after.subpath === "string" ? input.after.subpath : undefined

  const existing = await readSessionAnchor(storage, oldProjectID, sessionID)
  let anchor: SessionAnchor
  if (existing) {
    const movedRecord: SessionAnchor = {
      ...existing,
      currentProjectID: newProjectID,
      currentDirectory: input.target,
      ...(workspaceID !== undefined ? { workspaceID } : {}),
      ...(subpath !== undefined ? { subpath } : {}),
      status: "moved",
      updatedAt: now,
    }
    if (oldProjectID === newProjectID) {
      // Same-project move (e.g. into a subdir of the same repository):
      // `moveSessionAnchor` would set-then-remove the *same* key and destroy
      // the record, so rewrite it in place with the origin preserved.
      anchor = await writeSessionAnchor(storage, movedRecord, now)
    } else {
      const relocated = await moveSessionAnchor(storage, oldProjectID, sessionID, {
        projectID: newProjectID,
        directory: input.target,
        ...(workspaceID !== undefined ? { workspaceID } : {}),
        ...(subpath !== undefined ? { subpath } : {}),
      })
      anchor = relocated ?? movedRecord
    }
  } else {
    anchor = await writeSessionAnchor(
      storage,
      newSessionAnchor({
        sessionID,
        originProjectID,
        originDirectory: index?.directory ?? input.fallbackOrigin.directory,
        currentProjectID: newProjectID,
        currentDirectory: input.target,
        ...(workspaceID !== undefined ? { workspaceID } : {}),
        ...(subpath !== undefined ? { subpath } : {}),
      }),
      now,
    )
  }

  await writeSessionIndex(storage, {
    version: 1,
    sessionID,
    projectID: newProjectID,
    originProjectID,
    directory: input.target,
    updatedAt: now,
  })

  // The tracked worktree record stays origin-anchored; only its status
  // changes so the tree remains locatable no matter where the owner moved.
  const record = await readWorktree(storage, originProjectID, sessionID)
  if (record && (record.status === "pending" || record.status === "ready")) {
    await writeWorktree(storage, { ...record, status: "moved" }, now)
  }

  return anchor
}

/**
 * Reject empty/NUL targets, flag-shaped tokens, and shell metacharacters.
 * Returns a human-readable reason, or `undefined` when the target is usable.
 */
export function validateTarget(target: string): string | undefined {
  const trimmed = target.trim()
  if (!trimmed) return "target must not be empty"
  if (trimmed.includes("\0")) return "target must not contain NUL bytes"
  if (trimmed.startsWith("-")) return "target must not look like a flag"
  if (/[;&|<>$`"'\\()[\]{}*?#!\r\n]/.test(trimmed)) {
    return "target must not contain shell metacharacters"
  }
  return undefined
}

/** Defensive unwrap: `session.get` may resolve a session directly or wrapped. */
function sessionInfo(value: unknown): SessionInfoLike | undefined {
  const direct = asSession(value)
  if (direct) return direct
  if (value && typeof value === "object" && "data" in value) return asSession((value as { data: unknown }).data)
  return undefined
}

function asSession(value: unknown): SessionInfoLike | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<SessionInfoLike>
  if (typeof candidate.id !== "string") return undefined
  return {
    id: candidate.id,
    ...(typeof candidate.projectID === "string" ? { projectID: candidate.projectID } : {}),
    location:
      candidate.location && typeof candidate.location === "object"
        ? {
            ...(typeof candidate.location.directory === "string" ? { directory: candidate.location.directory } : {}),
            ...(typeof candidate.location.workspaceID === "string" ? { workspaceID: candidate.location.workspaceID } : {}),
          }
        : undefined,
    ...(typeof candidate.subpath === "string" ? { subpath: candidate.subpath } : {}),
  }
}

async function statProbe(directory: string): Promise<{ exists: boolean; isDirectory: boolean }> {
  const info = await stat(directory).catch(() => undefined)
  if (!info) return { exists: false, isDirectory: false }
  return { exists: true, isDirectory: info.isDirectory() }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redact(value: string): string {
  return value.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
}