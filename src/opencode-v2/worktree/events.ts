import type { OrchestratorOptions } from "../../core/config.js"
import { moveSessionAnchor, newSessionAnchor, readSessionAnchor, writeSessionAnchor } from "../session/state.js"
import {
  readSessionIndex,
  readWorktree,
  writeSessionIndex,
  writeWorktree,
  type StorageLike,
} from "./state.js"
import type { SessionMoveCoordinator } from "../session/move-coordinator.js"

/**
 * `session.moved` synchronization (stage 2).
 *
 * A move event only carries the *new* project ID, so the old project key
 * (where the stage-1 anchor currently lives) is recovered from the durable
 * session index this module maintains. The anchor is relocated with the
 * stage-1 primitive (origin preserved), the index advances to the new
 * project, and any durable worktree record owned by the moved session is
 * marked `moved` so cleanup/push never mistake a relocated owner for an
 * idle one. Returns a stop function that closes the subscription.
 */

export type WorktreeEventsContext = {
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
  }
  storage: StorageLike
  /** Helper-owned moves are verified and reconciled by the move helper. */
  moveCoordinator?: SessionMoveCoordinator
}

type SessionMovedEvent = {
  id?: string
  type: "session.moved"
  data: {
    sessionID: string
    projectID: string
    location?: { directory: string; workspaceID?: string }
    subpath?: string
  }
}

export function startWorktreeEventSync(
  context: WorktreeEventsContext,
  _options: OrchestratorOptions,
): () => Promise<void> {
  const controller = new AbortController()
  const iterable = context.event.subscribe({ signal: controller.signal })
  const iterator = iterable[Symbol.asyncIterator]()
  let finished!: Promise<void>

  finished = consume().catch((error) => {
    if (!controller.signal.aborted) console.error("opencode-orchestrator worktree event stream stopped", error)
  })

  return async () => {
    controller.abort()
    await iterator.return?.()
    await finished
  }

  async function consume(): Promise<void> {
    while (!controller.signal.aborted) {
      const next = await iterator.next()
      if (next.done) return
      if (controller.signal.aborted) return
      if (isSessionMoved(next.value)) await reconcile(next.value)
    }
  }

  async function reconcile(event: SessionMovedEvent): Promise<void> {
    const { sessionID, projectID } = event.data
    const directory = event.data.location?.directory ?? ""
    if (await context.moveCoordinator?.awaitEvent(sessionID, directory)) return
    const workspaceID = event.data.location?.workspaceID
    const subpath = event.data.subpath

    const index = await readSessionIndex(context.storage, sessionID)
    const oldProjectID = index?.projectID
    const originProjectID = index?.originProjectID ?? projectID
    const existing = oldProjectID ? await readSessionAnchor(context.storage, oldProjectID, sessionID) : undefined
    const currentDirectory = directory || existing?.currentDirectory || index?.directory
    const now = Date.now()

    if (oldProjectID && oldProjectID !== projectID) {
      const moved = await moveSessionAnchor(context.storage, oldProjectID, sessionID, {
        projectID,
        directory: currentDirectory ?? directory,
        workspaceID,
        subpath,
      })
      if (!moved) {
        // No stage-1 anchor at the old key (pre-created sessions): write a
        // fresh anchor at the new key without guessing a stable origin.
        if (currentDirectory) {
          await writeSessionAnchor(
            context.storage,
            newSessionAnchor({
              sessionID,
              originProjectID,
              originDirectory: index?.directory ?? currentDirectory,
              currentProjectID: projectID,
              currentDirectory,
              workspaceID,
              subpath,
            }),
            now,
          )
        }
      }
    } else if (existing && currentDirectory) {
      await writeSessionAnchor(
        context.storage,
        {
          ...existing,
          currentProjectID: projectID,
          currentDirectory,
          ...(workspaceID !== undefined ? { workspaceID } : {}),
          ...(subpath !== undefined ? { subpath } : {}),
          status: "moved",
        },
        now,
      )
    } else if (currentDirectory) {
      await writeSessionAnchor(
        context.storage,
        newSessionAnchor({
          sessionID,
          originProjectID,
          originDirectory: index?.directory ?? currentDirectory,
          currentProjectID: projectID,
          currentDirectory,
          workspaceID,
          subpath,
        }),
        now,
      )
    }

    await writeSessionIndex(context.storage, {
      version: 1,
      sessionID,
      projectID,
      originProjectID,
      directory: directory || index?.directory || "/",
      updatedAt: now,
    })

    // The worktree record stays origin-anchored; only its status changes so
    // the tree remains locatable no matter where the owner moved.
    if (index?.originProjectID) {
      const record = await readWorktree(context.storage, index.originProjectID, sessionID)
      if (record && (record.status === "pending" || record.status === "ready")) {
        await writeWorktree(context.storage, { ...record, status: "moved" }, now)
      }
    }
  }
}

function isSessionMoved(value: unknown): value is SessionMovedEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Partial<SessionMovedEvent>
  return (
    event.type === "session.moved" &&
    typeof event.data?.sessionID === "string" &&
    typeof event.data?.projectID === "string"
  )
}
