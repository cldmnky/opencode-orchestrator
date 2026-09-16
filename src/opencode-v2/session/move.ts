import { resolve } from "node:path"
import { realpath, stat } from "node:fs/promises"
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
import { redact } from "../process/redact.js"
import type { SessionMoveCoordinator } from "./move-coordinator.js"

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
 *
 * Every human-readable target/session/error text in a failure reason passes
 * through the canonical process redactor (`../process/redact.js`), so known
 * secret shapes never reach a transcript. This path threads no caller-known
 * exact secrets (there is no secret input here); the exact-secret layer runs
 * only where callers supply one (GitHub/worktree tool deps). See
 * `docs/v4-redaction-threat-model.md`.
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
  /** Injectable bounded-delay hook for post-move session verification. */
  wait?: (milliseconds: number) => Promise<void>
  /** Coordinates helper-owned moves with `session.moved` event reconciliation. */
  moveCoordinator?: SessionMoveCoordinator
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
  /**
   * OpenCode V2 may accept a current-session move for the next safe boundary.
   * When set, a bounded read-after-write miss is reported as pending so the
   * `session.moved` backstop can reconcile it after the tool returns.
   */
  deferVerification?: boolean
  /** Reconcile an already-completed move without enqueueing another one. */
  reconcileOnly?: boolean
}

export type MoveSessionFailure = { ok: false; reason: string; pending?: boolean }
export type MoveSessionSuccess = { ok: true; session: SessionInfoLike; anchor: SessionAnchor }
export type MoveSessionOutcome = MoveSessionSuccess | MoveSessionFailure

/** One immediate read plus three bounded retries for a lagging session projection. */
const POST_MOVE_VERIFICATION_ATTEMPTS = 4
const POST_MOVE_VERIFICATION_DELAY_MS = 50

export async function moveSessionToDirectory(deps: MoveSessionDeps, input: MoveSessionInput): Promise<MoveSessionOutcome> {
  let before: SessionInfoLike | undefined
  try {
    before = sessionInfo(await deps.session.get({ sessionID: input.sessionID }))
  } catch {
    return { ok: false, reason: "could not read the current session before moving" }
  }
  if (!before) return { ok: false, reason: "could not read the current session before moving" }
  if (before.id !== input.sessionID) return { ok: false, reason: "session move verification failed: session ID changed" }

  const baseDirectory = typeof before.location?.directory === "string" ? before.location.directory : deps.location.directory
  const invalid = validateTarget(input.target)
  if (invalid) return { ok: false, reason: invalid }

  const target = resolve(baseDirectory, input.target)
  const probe = deps.pathInfo ?? statProbe
  const info = await probe(target)
  if (!info.exists) return { ok: false, reason: `target does not exist: ${redact(target)}` }
  if (!info.isDirectory) return { ok: false, reason: `target is not a directory: ${redact(target)}` }

  const canonicalTarget = await canonicalDirectory(target)
  const beforeDirectory = typeof before.location?.directory === "string" ? before.location.directory : ""
  if (beforeDirectory && (await canonicalDirectory(beforeDirectory)) === canonicalTarget) {
    try {
      const anchor = await relocateAnchor(deps, input.sessionID, {
        before,
        after: before,
        target,
        fallbackOrigin: { directory: baseDirectory, projectID: before.projectID ?? deps.location.project.id },
      })
      return { ok: true, session: before, anchor }
    } catch (error) {
      return { ok: false, reason: `session move reconciliation failed: ${redact(errorMessage(error))}` }
    }
  }
  if (input.reconcileOnly) {
    return {
      ok: false,
      reason: `session move verification failed: session is at ${redact(beforeDirectory)}, expected ${redact(canonicalTarget)}`,
    }
  }

  const workspaceID = typeof before.location?.workspaceID === "string" ? before.location.workspaceID : deps.location.workspaceID
  const lease = deps.moveCoordinator?.begin(input.sessionID, target)
  try {
    await deps.session.move({
      sessionID: input.sessionID,
      directory: target,
      ...(workspaceID !== undefined ? { workspaceID } : {}),
      ...(input.delivery ? { delivery: input.delivery } : {}),
    })
  } catch (error) {
    lease?.cancel()
    return { ok: false, reason: `session move failed: ${redact(errorMessage(error))}` }
  }

  let verified: Awaited<ReturnType<typeof verifyMovedSession>>
  try {
    verified = await verifyMovedSession(deps, input.sessionID, target)
  } catch (error) {
    if (input.deferVerification) lease?.cancel()
    else lease?.suppressEvent()
    throw error
  }
  if (!verified.ok) {
    if (input.deferVerification) {
      // The V2 API accepted the move, but the current session cannot expose
      // its new location until the current execution reaches a safe boundary.
      // Let the event backstop reconcile after this tool has returned. This
      // result is deliberately not a successful enter receipt.
      lease?.cancel()
      return { ...verified, pending: true }
    }
    // A helper-owned event must not mutate durable state when the helper was
    // asked to require immediate verification. The caller can retry safely.
    lease?.suppressEvent()
    return verified
  }

  const after = verified.session
  try {
    const anchor = await relocateAnchor(deps, input.sessionID, {
      before,
      after,
      target,
      fallbackOrigin: { directory: baseDirectory, projectID: before.projectID ?? deps.location.project.id },
    })
    // A successful native move may emit before, during, or just after the
    // verification loop. Only this helper may reconcile that event.
    lease?.suppressEvent()
    return { ok: true, session: after, anchor }
  } catch (error) {
    // Durable reconciliation failed after the native move was verified. Let
    // the event backstop repair the durable state instead of swallowing it.
    lease?.cancel()
    throw error
  }
}

/**
 * Session moves are asynchronous in the beta server: immediately after a
 * successful `session.move`, a `session.get` can briefly expose the previous
 * location. Retry only this read-after-write check, with a short fixed bound,
 * before deciding the move failed. Canonical filesystem paths make equivalent
 * aliases (such as `/tmp` and `/private/tmp` on macOS) compare equal.
 */
async function verifyMovedSession(
  deps: MoveSessionDeps,
  sessionID: string,
  target: string,
): Promise<{ ok: true; session: SessionInfoLike } | MoveSessionFailure> {
  const expected = await canonicalDirectory(target)
  let after: SessionInfoLike | undefined
  let afterDirectory = ""

  for (let attempt = 0; attempt < POST_MOVE_VERIFICATION_ATTEMPTS; attempt += 1) {
    try {
      after = sessionInfo(await deps.session.get({ sessionID }))
    } catch {
      after = undefined
    }
    afterDirectory = typeof after?.location?.directory === "string" ? after.location.directory : ""
    const actual = afterDirectory ? await canonicalDirectory(afterDirectory) : ""
    if (after?.id === sessionID && actual === expected) return { ok: true, session: after }

    if (attempt < POST_MOVE_VERIFICATION_ATTEMPTS - 1) {
      await (deps.wait ?? wait)(POST_MOVE_VERIFICATION_DELAY_MS)
    }
  }

  if (!after) return { ok: false, reason: "could not re-read the session after moving" }
  if (after.id !== sessionID) return { ok: false, reason: "session move verification failed: session ID changed" }
  return {
    ok: false,
    reason: `session move verification failed: session is at ${redact(afterDirectory)}, expected ${redact(target)}`,
  }
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

async function canonicalDirectory(directory: string): Promise<string> {
  const absolute = resolve(directory)
  return realpath(absolute).catch(() => absolute)
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
