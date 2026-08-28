import type { OrchestratorOptions } from "../../core/config.js"
import { buildContinuationPrompt } from "../../core/prompts.js"
import {
  goalStorageKey,
  readAutomationStop,
  readGoal,
  runStorageKey,
  stopStorageKey,
  withSessionLock,
  type GoalRecord,
  type LocationLike,
  type StorageLike,
} from "./state.js"

export type ContinuationContext = {
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
  }
  location: LocationLike
  storage: StorageLike
  session: {
    get(input: { sessionID: string }): Promise<unknown>
    prompt(input: { sessionID: string; text: string; delivery: "queue" }): Promise<unknown>
  }
}

export function startGoalContinuation(context: ContinuationContext, options: OrchestratorOptions): () => Promise<void> {
  const controller = new AbortController()
  const iterable = context.event.subscribe({ signal: controller.signal })
  const iterator = iterable[Symbol.asyncIterator]()
  const inFlight = new Set<string>()
  const lastEvent = new Map<string, string>()
  let finished!: Promise<void>

  finished = consumeEvents().catch((error) => {
    if (!controller.signal.aborted) console.error("opencode-orchestrator goal event stream stopped", error)
  })

  return async () => {
    controller.abort()
    await iterator.return?.()
    await finished
  }

  async function consumeEvents(): Promise<void> {
    while (!controller.signal.aborted) {
      const next = await iterator.next()
      if (next.done) return
      const event = next.value
      if (controller.signal.aborted) return
      await handleEvent(event)
    }
  }

  async function handleEvent(event: unknown): Promise<void> {
    if (!isEvent(event)) return
    if (!matchesLocation(event, context.location)) return

    const sessionID = event.data.sessionID
    if (event.type === "session.deleted") {
      // Serialize cleanup under the same per-session lock the reservation uses
      // so a delete cannot interleave with an in-flight reservation write and
      // leave stale run/halt state (or admit a prompt for a deleted session).
      await withSessionLock(context.location, sessionID, async () => {
        await Promise.all([
          context.storage.remove(goalStorageKey(context.location, sessionID)),
          context.storage.remove(runStorageKey(context.location, sessionID)),
          context.storage.remove(stopStorageKey(context.location, sessionID)),
        ])
      })
      inFlight.delete(sessionID)
      lastEvent.delete(sessionID)
      return
    }

    const marker = event.id ?? `${event.type}:${sessionID}:${event.created ?? ""}`
    if (lastEvent.get(sessionID) === marker) return
    lastEvent.set(sessionID, marker)
    if (event.type !== "session.idle" || inFlight.has(sessionID)) return

    inFlight.add(sessionID)
    try {
      await admitContinuation(sessionID)
    } catch (error) {
      if (!controller.signal.aborted) console.error(`opencode-orchestrator continuation failed for ${sessionID}`, error)
    } finally {
      inFlight.delete(sessionID)
    }
  }

  async function admitContinuation(sessionID: string): Promise<void> {
    const key = goalStorageKey(context.location, sessionID)
    const stopKey = stopStorageKey(context.location, sessionID)

    // Reserve the turn under the session lock: the ceiling, cooldown, halt,
    // and duplicate-idle checks all happen atomically here so concurrent idle
    // edges cannot exceed the ceiling. The reservation itself is the only
    // shared mutation performed while holding the lock.
    const reserved = await withSessionLock(context.location, sessionID, async () => {
      const goal = await readGoal(context.storage, key)
      if (!goal || goal.status !== "active") return undefined
      if (goal.continuationCount >= options.goal.max_continuations) {
        console.warn(`opencode-orchestrator continuation ceiling reached for ${sessionID}`)
        return undefined
      }
      if (controller.signal.aborted || (await readAutomationStop(context.storage, stopKey))) return undefined

      const now = Date.now()
      if (goal.lastContinuationAt !== undefined && now - goal.lastContinuationAt < options.goal.cooldown_ms) return undefined

      const next: GoalRecord = {
        ...goal,
        continuationCount: goal.continuationCount + 1,
        lastContinuationAt: now,
        updatedAt: now,
      }
      await context.storage.set(key, next)
      return next
    })
    if (!reserved || controller.signal.aborted) return

    // Admission gate, checked after the lock is released: the session prompt
    // must never be queued while holding the lock, but we still re-read the
    // goal and halt flag so a pause, completion, replacement, or /halt that
    // raced the reservation fails closed. Only the exact record we reserved
    // may be admitted: identity is compared on the fields the reservation
    // wrote or that a replacement/update would change, so a goal that was
    // replaced or updated (not just its continuation count) is never mistaken
    // for the reservation.
    if (await readAutomationStop(context.storage, stopKey)) return
    const current = await readGoal(context.storage, key)
    if (!current || current.status !== "active") return
    if (!isSameReservation(current, reserved)) return

    await context.session.prompt({
      sessionID,
      text: buildContinuationPrompt(reserved.objective, reserved.continuationCount),
      delivery: "queue",
    })
  }
}

// Identity of the exact record the reservation wrote, used at admission time.
// A replacement (`goal_set`) or update (`goal_update`) changes these fields,
// so comparing them on top of the continuation count prevents an older or
// replaced goal from being mistaken for the reservation.
function isSameReservation(current: GoalRecord, reserved: GoalRecord): boolean {
  return (
    current.objective === reserved.objective &&
    current.createdAt === reserved.createdAt &&
    current.updatedAt === reserved.updatedAt &&
    current.lastContinuationAt === reserved.lastContinuationAt &&
    current.continuationCount === reserved.continuationCount
  )
}

type SessionEvent = {
  id?: string
  created?: number
  type: "session.idle" | "session.deleted"
  data: { sessionID: string }
  location?: { directory: string; workspaceID?: string }
}

function isEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Partial<SessionEvent>
  return (
    (event.type === "session.idle" || event.type === "session.deleted") &&
    typeof event.data?.sessionID === "string"
  )
}

function matchesLocation(event: SessionEvent, location: LocationLike): boolean {
  if (!event.location) return true
  if (event.location.directory !== location.directory) return false
  return event.location.workspaceID === undefined || event.location.workspaceID === location.workspaceID
}
