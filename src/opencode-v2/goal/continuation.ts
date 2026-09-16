import type { OrchestratorOptions } from "../../core/config.js"
import { buildContinuationPrompt } from "../../core/prompts.js"
import type { DispatchGate } from "../observability/runtime.js"
import { authorityDispatchMetadata, type AuthorityMetadataValue } from "../authority/runtime.js"
import {
  continuationStepIdempotencyKey,
  markStepDispatched,
  newPendingStepRecord,
  removeSessionSteps,
  writeStepRecord,
} from "../orchestration/step-state.js"
import {
  goalStorageKey,
  readAutomationStop,
  readGoal,
  readPlanRun,
  runStorageKey,
  stableProjectID,
  stopStorageKey,
  withSessionLock,
  type GoalRecord,
  type LocationLike,
  type PlanRunRecord,
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
    prompt(input: {
      sessionID: string
      text: string
      delivery: "queue"
      metadata?: { [key: string]: AuthorityMetadataValue }
    }): Promise<unknown>
  }
}

export function startGoalContinuation(
  context: ContinuationContext,
  options: OrchestratorOptions,
  gate?: DispatchGate,
): () => Promise<void> {
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
      // leave stale run/halt/step state (or admit a prompt for a deleted
      // session). Records are keyed by the session's stable origin project, so
      // cleanup resolves that project first.
      await withSessionLock(context.location, sessionID, async () => {
        const keyedLocation = { ...context.location, project: { id: await stableProjectID(context.storage, context.location, sessionID) } }
        await Promise.all([
          context.storage.remove(goalStorageKey(keyedLocation, sessionID)),
          context.storage.remove(runStorageKey(keyedLocation, sessionID)),
          context.storage.remove(stopStorageKey(keyedLocation, sessionID)),
          removeSessionSteps(context.storage, keyedLocation, sessionID),
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
    // Goal/run/halt records stay anchored to the session's stable origin
    // project across session moves, so admit resolves the same project.
    const keyedLocation = { ...context.location, project: { id: await stableProjectID(context.storage, context.location, sessionID) } }
    const key = goalStorageKey(keyedLocation, sessionID)
    const runKey = runStorageKey(keyedLocation, sessionID)
    const stopKey = stopStorageKey(keyedLocation, sessionID)

    // Reserve the turn under the session lock: the ceiling, cooldown, halt,
    // controls gate, plan-run state, and duplicate-idle checks all happen
    // atomically here so concurrent idle edges cannot exceed the ceiling. The
    // only shared mutations performed while holding the lock are the goal
    // reservation and its durable pending step receipt (S1 slice 1); the
    // receipt write is best-effort and can never change the reservation.
    const reserved = await withSessionLock(context.location, sessionID, async () => {
      const goal = await readGoal(context.storage, key)
      if (!goal || goal.status !== "active") return undefined
      if (goal.continuationCount >= options.goal.max_continuations) {
        console.warn(`opencode-orchestrator continuation ceiling reached for ${sessionID}`)
        return undefined
      }
      if (controller.signal.aborted || (await readAutomationStop(context.storage, stopKey))) return undefined
      if (gate) {
        const decision = await gate.allowDispatch(sessionID, "auto")
        if (!decision.allow) {
          console.warn(`opencode-orchestrator continuation stopped by controls for ${sessionID}: ${decision.reason}`)
          return undefined
        }
      }

      const now = Date.now()
      if (goal.lastContinuationAt !== undefined && now - goal.lastContinuationAt < options.goal.cooldown_ms) return undefined

      // A plan run that exists but is not active has no unfinished ledger item
      // to advance: a paused run (halt) and a completed run (no items left)
      // both stop auto-continuation under the same lock, so a concurrent pause
      // cannot race the reservation. An absent run keeps the goal-only path.
      const run = await readPlanRun(context.storage, runKey)
      if (run && run.status !== "active") {
        console.warn(`opencode-orchestrator continuation stopped by plan run state for ${sessionID}: ${run.status}`)
        return undefined
      }

      const next: GoalRecord = {
        ...goal,
        continuationCount: goal.continuationCount + 1,
        lastContinuationAt: now,
        updatedAt: now,
      }
      await context.storage.set(key, next)

      // Durable per-step receipt: the reserved turn is recorded as `pending`
      // under the same lock (so session cleanup serializes with it) before any
      // prompt delivery. A receipt failure is logged and swallowed: receipts
      // are observability and must never change an admission decision.
      try {
        await writeStepRecord(
          context.storage,
          keyedLocation,
          newPendingStepRecord({
            sessionID,
            stepIndex: next.continuationCount,
            idempotencyKey: continuationStepIdempotencyKey(sessionID, goal.createdAt, next.continuationCount),
            now,
          }),
        )
      } catch (error) {
        console.warn(`opencode-orchestrator step receipt write failed for ${sessionID}`, error)
      }
      return { goal: next, run }
    })
    if (!reserved || controller.signal.aborted) return

    // Admission gate, checked after the lock is released: the session prompt
    // must never be queued while holding the lock, but we still re-read the
    // goal, halt flag, and plan run so a pause, completion, replacement, or
    // /halt that raced the reservation fails closed. Only the exact records
    // we reserved may be admitted: identity is compared on the fields the
    // reservation wrote or that a replacement/update would change, so a goal
    // or run that was replaced or updated (not just its continuation count)
    // is never mistaken for the reservation.
    if (await readAutomationStop(context.storage, stopKey)) return
    const current = await readGoal(context.storage, key)
    if (!current || current.status !== "active") return
    if (!isSameReservation(current, reserved.goal)) return
    const currentRun = await readPlanRun(context.storage, runKey)
    if (!isSamePlanRun(currentRun, reserved.run)) return
    if (gate) {
      // Re-check immediately before delivery: budget observations and the
      // review breaker may have changed since the reservation.
      const decision = await gate.allowDispatch(sessionID, "auto")
      if (!decision.allow) {
        console.warn(`opencode-orchestrator continuation stopped by controls before delivery for ${sessionID}: ${decision.reason}`)
        return
      }
    }

    await context.session.prompt({
      sessionID,
      text: buildContinuationPrompt(reserved.goal.objective, reserved.goal.continuationCount, options, reserved.run?.plan),
      delivery: "queue",
      // Phase A N1: a plugin-created goal continuation carries the bounded
      // authority marker only in enforce mode, so the admission hook can
      // re-consult the dispatch gate at admission time.
      ...(options.authority.mode === "enforce" ? { metadata: authorityDispatchMetadata("continuation") } : {}),
    })

    // Delivery confirmed: update the receipt to `dispatched`. The update is
    // serialized with session cleanup under the session lock, is idempotent,
    // and is best-effort like the pending write: it can never fail the
    // continuation or change an admission decision.
    try {
      await withSessionLock(context.location, sessionID, async () => {
        await markStepDispatched(context.storage, keyedLocation, sessionID, reserved.goal.continuationCount)
      })
    } catch (error) {
      console.warn(`opencode-orchestrator step receipt update failed for ${sessionID}`, error)
    }
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

// Identity of the plan run observed at reservation time. The reservation does
// not write the run, so ANY change (pause, completion, replacement via a new
// /run-plan, or deletion) between reservation and delivery means the reserved
// snapshot is stale; only the exact record observed under the lock may be
// admitted. An absent run and a present run never match each other.
function isSamePlanRun(current: PlanRunRecord | undefined, reserved: PlanRunRecord | undefined): boolean {
  if (current === undefined || reserved === undefined) return current === reserved
  return (
    current.plan === reserved.plan &&
    current.status === reserved.status &&
    current.createdAt === reserved.createdAt &&
    current.updatedAt === reserved.updatedAt
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
  // A session move keeps the session in the same workspace but changes its
  // directory; durable goal/run/halt state stays keyed by the stable origin
  // project, so admission only needs workspace identity. Without a workspace
  // to anchor on, fall back to exact directory matching (pre-move behavior).
  if (event.location.workspaceID !== undefined) {
    return event.location.workspaceID === location.workspaceID
  }
  if (location.workspaceID !== undefined) return true
  return event.location.directory === location.directory
}
