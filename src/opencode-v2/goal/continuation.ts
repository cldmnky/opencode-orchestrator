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
      await Promise.all([
        context.storage.remove(goalStorageKey(context.location, sessionID)),
        context.storage.remove(runStorageKey(context.location, sessionID)),
        context.storage.remove(stopStorageKey(context.location, sessionID)),
      ])
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
    await withSessionLock(context.location, sessionID, async () => {
      const key = goalStorageKey(context.location, sessionID)
      const goal = await readGoal(context.storage, key)
      if (!goal || goal.status !== "active") return
      if (goal.continuationCount >= options.goal.max_continuations) {
        console.warn(`opencode-orchestrator continuation ceiling reached for ${sessionID}`)
        return
      }
      if (controller.signal.aborted || (await readAutomationStop(context.storage, stopStorageKey(context.location, sessionID)))) return

      const now = Date.now()
      if (goal.lastContinuationAt !== undefined && now - goal.lastContinuationAt < options.goal.cooldown_ms) return

      // Reserve the turn before admission so duplicate idle edges cannot exceed the ceiling.
      const next: GoalRecord = {
        ...goal,
        continuationCount: goal.continuationCount + 1,
        lastContinuationAt: now,
        updatedAt: now,
      }
      await context.storage.set(key, next)
      if (
        controller.signal.aborted ||
        (await readAutomationStop(context.storage, stopStorageKey(context.location, sessionID))) ||
        (await readGoal(context.storage, key))?.status !== "active"
      ) {
        return
      }
      await context.session.prompt({
        sessionID,
        text: buildContinuationPrompt(goal.objective, next.continuationCount),
        delivery: "queue",
      })
    })
  }
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
