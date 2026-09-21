import type { OrchestratorOptions } from "../../core/config.js"
import { buildContinuationPrompt } from "../../core/prompts.js"
import type { DispatchGate } from "../observability/runtime.js"
import { authorityDispatchMetadata, type AuthorityMetadataValue } from "../authority/runtime.js"
import {
  continuationStepIdempotencyKey,
  markStepCompleted,
  markStepDispatched,
  newPendingStepRecord,
  parseStepRecord,
  removeSessionSteps,
  removeStepRecord,
  stepStorageKey,
  writeStepRecord,
} from "../orchestration/step-state.js"
import {
  hydrateLeadBoardV2,
  leadBoardV2StorageKey,
  leadTaskPacketTextV2,
  leadTaskStepIdempotencyKey,
  parseLeadBoardV2,
  reconcileLeadBoardV2,
  releaseLeadReservationV2,
  removeLeadBoardV2,
  reserveNextLeadTaskV2,
  transitionLeadTaskV2,
  writeLeadBoardV2,
  type LeadBoardV2 as LeadBoard,
  type LeadStepObservation,
} from "../orchestration/lead-board-v2.js"
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
  // Index of the most recently delivered continuation step per session, kept in
  // memory only: the next idle edge marks that receipt `completed` before any
  // new admission is attempted. A restart simply loses the observation; it
  // never replays or resumes anything.
  const lastDispatched = new Map<string, number>()
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
          removeLeadBoardV2(context.storage, keyedLocation, sessionID),
          removeSessionSteps(context.storage, keyedLocation, sessionID),
        ])
      })
      inFlight.delete(sessionID)
      lastEvent.delete(sessionID)
      lastDispatched.delete(sessionID)
      return
    }

    const marker = event.id ?? `${event.type}:${sessionID}:${event.created ?? ""}`
    if (lastEvent.get(sessionID) === marker) return
    lastEvent.set(sessionID, marker)
    if (event.type !== "session.idle" || inFlight.has(sessionID)) return

    inFlight.add(sessionID)
    try {
      // A new idle edge means the previously delivered turn is over: record its
      // receipt as `completed` before this edge can reserve a new step. The
      // mark is best-effort and serialized under the session lock; it never
      // changes the admission decision below (a refused admission still leaves
      // the prior step truthfully completed).
      await settlePreviousStep(sessionID)
      await admitContinuation(sessionID)
    } catch (error) {
      if (!controller.signal.aborted) console.error(`opencode-orchestrator continuation failed for ${sessionID}`, error)
    } finally {
      inFlight.delete(sessionID)
    }
  }

  // Marks the last delivered step's receipt `completed`, best-effort: the write
  // is serialized with session cleanup under the same per-session lock the
  // reservation uses, and every failure is logged and swallowed so it can never
  // block or alter an admission. The tracked index is deleted only after the
  // attempt returns (success or a missing receipt); a storage failure keeps it
  // so a later idle edge can retry the idempotent mark.
  async function settlePreviousStep(sessionID: string): Promise<void> {
    const stepIndex = lastDispatched.get(sessionID)
    if (stepIndex === undefined) return
    try {
      const keyedLocation = { ...context.location, project: { id: await stableProjectID(context.storage, context.location, sessionID) } }
      await withSessionLock(context.location, sessionID, async () => {
        await markStepCompleted(context.storage, keyedLocation, sessionID, stepIndex)
      })
      lastDispatched.delete(sessionID)
    } catch (error) {
      console.warn(`opencode-orchestrator step receipt completion failed for ${sessionID}`, error)
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
    // atomically here so concurrent idle edges cannot exceed the ceiling.
    //
    // Two admission paths exist:
    // - a board exists for this goal generation: hydrate, reconcile receipts
    //   conservatively, reserve the next ready task + persist its pending step
    //   receipt + bump the goal count (in that order) before any prompt;
    // - no board (legacy goal): the goal-only path is unchanged, with a
    //   best-effort pending receipt exactly like before.
    const reserved = await withSessionLock(context.location, sessionID, async (): Promise<Reservation | undefined> => {
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

      const hydration = await hydrateLeadBoardV2(context.storage, context.location, sessionID, { goalGeneration: goal.createdAt })
      if (hydration.status === "unavailable" || hydration.status === "legacy") {
        // Malformed or identity-mismatched board: never overwrite, never
        // dispatch. Recovery requires explicit lead/goal action.
        console.warn(`opencode-orchestrator lead board unavailable for ${sessionID}: ${hydration.warning ?? "unknown"}`)
        return undefined
      }
      if (hydration.status === "missing") {
        // Legacy goal without an enrolled board: keep the goal-only
        // continuation path exactly as before (board-missing is not an error).
        const next: GoalRecord = {
          ...goal,
          continuationCount: goal.continuationCount + 1,
          lastContinuationAt: now,
          updatedAt: now,
        }
        await context.storage.set(key, next)
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
        return { kind: "legacy", goal: next, run, stepIndex: next.continuationCount }
      }

      const board = hydration.board
      if (!board || board.status !== "active") return undefined

      // Deterministic restart recovery: rebuild observations for claim-holding
      // tasks from their exact linked step receipts, then reconcile
      // conservatively (ambiguous on possible effect, at most
      // awaiting-validation on a completed idle edge). No mutation on read;
      // the recovered board is persisted before any reservation.
      const reconciled = await reconcileHydratedBoard(board, sessionID, keyedLocation)
      let working = reconciled.board
      if (reconciled.changed) {
        try {
          working = await writeLeadBoardV2(context.storage, keyedLocation, working)
        } catch (error) {
          console.warn(`opencode-orchestrator lead board recovery write failed for ${sessionID}`, error)
          return undefined
        }
      }

      const selection = reserveNextLeadTaskV2(working, { stepIndex: goal.continuationCount + 1, now })
      if (!selection.reservation) {
        if (selection.board !== working) {
          try {
            await writeLeadBoardV2(context.storage, keyedLocation, selection.board)
          } catch (error) {
            console.warn(`opencode-orchestrator lead board promotion write failed for ${sessionID}`, error)
          }
        }
        return undefined
      }
      const selectionTask = selection.board.tasks.find((task) => task.taskID === selection.reservation!.taskID)
      if (!selectionTask) return undefined

      // Persist reservation + step identity + pending receipt BEFORE queueing
      // the prompt. Order: step, board, goal. Any failure aborts delivery and
      // compensates what was already written, so a failed write is a safety
      // outcome that is never guessed around.
      const pending = newPendingStepRecord({
        sessionID,
        stepIndex: selection.reservation.stepIndex,
        idempotencyKey: selection.reservation.stepIdempotencyKey,
        attempt: selection.reservation.attempt,
        ...(selectionTask.cursor !== undefined ? { cursor: selectionTask.cursor } : {}),
        now,
      })
      try {
        await writeStepRecord(context.storage, keyedLocation, pending)
      } catch (error) {
        console.warn(`opencode-orchestrator lead board step receipt write failed for ${sessionID}`, error)
        return undefined
      }
      try {
        await writeLeadBoardV2(context.storage, keyedLocation, selection.board)
      } catch (error) {
        console.warn(`opencode-orchestrator lead board reservation write failed for ${sessionID}`, error)
        await removeStepRecord(context.storage, keyedLocation, sessionID, selection.reservation.stepIndex).catch(() => undefined)
        return undefined
      }
      const nextGoal: GoalRecord = {
        ...goal,
        continuationCount: selection.reservation.stepIndex,
        lastContinuationAt: now,
        updatedAt: now,
      }
      try {
        await context.storage.set(key, nextGoal)
      } catch (error) {
        console.warn(`opencode-orchestrator goal reservation write failed for ${sessionID}`, error)
        await writeLeadBoardV2(context.storage, keyedLocation, working).catch(() => undefined)
        await removeStepRecord(context.storage, keyedLocation, sessionID, selection.reservation.stepIndex).catch(() => undefined)
        return undefined
      }
      return {
        kind: "board",
        goal: nextGoal,
        run,
        taskID: selectionTask.taskID,
        stepIndex: selection.reservation.stepIndex,
        lifecycleVersion: selectionTask.lifecycleVersion,
        boardRevision: selection.board.boardRevision,
        packet: leadTaskPacketTextV2(selectionTask),
      }
    })
    if (!reserved || controller.signal.aborted) return

    // Admission gate, checked after the lock is released: the session prompt
    // must never be queued while holding the lock, but we still re-read the
    // goal, halt flag, plan run, and (for board reservations) the board so a
    // pause, completion, replacement, or /halt that raced the reservation
    // fails closed. Only the exact records we reserved may be admitted.
    if (await readAutomationStop(context.storage, stopKey)) return
    const current = await readGoal(context.storage, key)
    if (!current || current.status !== "active") return
    if (!isSameReservation(current, reserved.goal)) return
    const currentRun = await readPlanRun(context.storage, runKey)
    if (!isSamePlanRun(currentRun, reserved.run)) return
    if (reserved.kind === "board" && !(await boardReservationStillCurrent(reserved, keyedLocation, sessionID))) {
      return
    }
    if (gate) {
      // Re-check immediately before delivery: budget observations and the
      // review breaker may have changed since the reservation.
      const decision = await gate.allowDispatch(sessionID, "auto")
      if (!decision.allow) {
        console.warn(`opencode-orchestrator continuation stopped by controls before delivery for ${sessionID}: ${decision.reason}`)
        if (reserved.kind === "board") {
          await releaseStaleBoardReservation(reserved, keyedLocation, sessionID, "dispatch gate closed before delivery")
        }
        return
      }
    }

    try {
      await context.session.prompt({
        sessionID,
        text: buildContinuationPrompt(
          reserved.goal.objective,
          reserved.goal.continuationCount,
          options,
          reserved.run?.plan,
          reserved.kind === "board" ? reserved.packet : undefined,
        ),
        delivery: "queue",
        // Phase A N1: a plugin-created goal continuation carries the bounded
        // authority marker only in enforce mode, so the admission hook can
        // re-consult the dispatch gate at admission time.
        ...(options.authority.mode === "enforce" ? { metadata: authorityDispatchMetadata("continuation") } : {}),
      })
    } catch (error) {
      // Delivery outcome is unknown: the prompt may or may not have been
      // queued. Never resubmit blindly; a board reservation becomes ambiguous
      // while its scope claim is retained.
      if (reserved.kind === "board") {
        await markBoardDeliveryUnknown(reserved, keyedLocation, sessionID)
      }
      throw error
    }

    // Delivery confirmed: update the receipt to `dispatched` and (for a board
    // reservation) advance the task to `in-progress`. Both writes are
    // serialized with session cleanup under the session lock and are
    // best-effort like the pending write: they can never fail the
    // continuation, and a failed board write is reconciled conservatively on
    // the next hydration.
    try {
      await withSessionLock(context.location, sessionID, async () => {
        await markStepDispatched(context.storage, keyedLocation, sessionID, reserved.stepIndex)
        if (reserved.kind === "board") {
          const latest = parseLeadBoardV2(await context.storage.get(leadBoardV2StorageKey(keyedLocation, sessionID)))
          const task = latest?.tasks.find((candidate) => candidate.taskID === reserved.taskID)
          if (!latest || !task || task.status !== "reserved" || task.lifecycleVersion !== reserved.lifecycleVersion) return
          const delivered = transitionLeadTaskV2({
            board: latest,
            taskID: reserved.taskID,
            expectedVersion: task.lifecycleVersion,
            actorSessionID: sessionID,
            action: "deliver",
          })
          if (delivered.ok) await writeLeadBoardV2(context.storage, keyedLocation, delivered.board)
        }
      })
    } catch (error) {
      console.warn(`opencode-orchestrator step receipt update failed for ${sessionID}`, error)
    }
    // Remember the delivered step so the next idle edge can mark its receipt
    // completed. Tracking is memory-only and independent of the best-effort
    // update above: the completion mark targets the logical step, and a failed
    // dispatched write must not erase it.
    lastDispatched.set(sessionID, reserved.stepIndex)
  }

  // Reads the exact linked step receipt for every claim-holding task and
  // reconciles it conservatively. The step this process just delivered is
  // skipped so a live turn is never mistaken for a crashed one.
  async function reconcileHydratedBoard(
    board: LeadBoard,
    sessionID: string,
    keyedLocation: LocationLike,
  ): Promise<{ board: LeadBoard; changed: boolean }> {
    const observations = new Map<string, LeadStepObservation>()
    for (const task of board.tasks) {
      if ((task.status !== "reserved" && task.status !== "in-progress") || task.stepIndex === undefined) continue
      observations.set(task.taskID, await observeTaskStep(board, task.taskID, task.attempt, task.stepIndex, sessionID, keyedLocation))
    }
    const liveStepIndex = lastDispatched.get(sessionID)
    const result = reconcileLeadBoardV2(board, {
      observations,
      ...(liveStepIndex !== undefined ? { liveStepIndex } : {}),
    })
    return { board: result.board, changed: result.changes.length > 0 }
  }

  // One conservative observation: a missing/malformed/unreadable receipt and a
  // mismatched identity all reconcile the same way (never replay, never infer
  // success). The step receipt is observability, so a read failure is an
  // observation, not an error.
  async function observeTaskStep(
    board: LeadBoard,
    taskID: string,
    attempt: number,
    stepIndex: number,
    sessionID: string,
    keyedLocation: LocationLike,
  ): Promise<LeadStepObservation> {
    try {
      const value = await context.storage.get(stepStorageKey(keyedLocation, sessionID, stepIndex))
      if (value === undefined) return { state: "missing" }
      const record = parseStepRecord(value)
      if (!record || record.sessionID !== sessionID || record.stepIndex !== stepIndex) return { state: "malformed" }
      if (record.idempotencyKey !== leadTaskStepIdempotencyKey(board.boardID, taskID, attempt)) return { state: "malformed" }
      return {
        state: record.status,
        stepIndex: record.stepIndex,
        idempotencyKey: record.idempotencyKey,
      }
    } catch {
      return { state: "unreadable" }
    }
  }

  // Pre-delivery re-read: only the exact reserved board revision + task
  // lifecycle version + step index may be delivered. Anything else is stale
  // and is released/hold instead of delivered.
  async function boardReservationStillCurrent(
    reserved: BoardReservation,
    keyedLocation: LocationLike,
    sessionID: string,
  ): Promise<boolean> {
    const latest = parseLeadBoardV2(await context.storage.get(leadBoardV2StorageKey(keyedLocation, sessionID)))
    if (!latest || latest.status !== "active") return false
    const task = latest.tasks.find((candidate) => candidate.taskID === reserved.taskID)
    if (
      !task ||
      task.status !== "reserved" ||
      task.lifecycleVersion !== reserved.lifecycleVersion ||
      task.stepIndex !== reserved.stepIndex ||
      latest.boardRevision !== reserved.boardRevision
    ) {
      await releaseStaleBoardReservation(reserved, keyedLocation, sessionID, "stale pre-delivery board state")
      return false
    }
    return true
  }

  async function releaseStaleBoardReservation(
    reserved: BoardReservation,
    keyedLocation: LocationLike,
    sessionID: string,
    reason: string,
  ): Promise<void> {
    try {
      await withSessionLock(context.location, sessionID, async () => {
        const latest = parseLeadBoardV2(await context.storage.get(leadBoardV2StorageKey(keyedLocation, sessionID)))
        if (!latest) return
        const released = releaseLeadReservationV2({
          board: latest,
          taskID: reserved.taskID,
          expectedLifecycleVersion: reserved.lifecycleVersion,
          expectedBoardRevision: reserved.boardRevision,
          reason,
        })
        if (!released.ok) return
        await writeLeadBoardV2(context.storage, keyedLocation, released.board)
        // The reservation never delivered, so its pending receipt is an
        // orphan: remove it best-effort. A failure leaves a bounded receipt
        // that no task links to (it is never read for resume).
        await removeStepRecord(context.storage, keyedLocation, sessionID, reserved.stepIndex).catch(() => undefined)
      })
    } catch (error) {
      console.warn(`opencode-orchestrator lead board reservation release failed for ${sessionID}`, error)
    }
  }

  // Delivery outcome unknown: retain the claim and mark the task ambiguous.
  // Never resubmit; recovery is a fresh read plus explicit lead action.
  async function markBoardDeliveryUnknown(reserved: BoardReservation, keyedLocation: LocationLike, sessionID: string): Promise<void> {
    try {
      await withSessionLock(context.location, sessionID, async () => {
        const latest = parseLeadBoardV2(await context.storage.get(leadBoardV2StorageKey(keyedLocation, sessionID)))
        const task = latest?.tasks.find((candidate) => candidate.taskID === reserved.taskID)
        if (!latest || !task || task.status !== "reserved" || task.lifecycleVersion !== reserved.lifecycleVersion) return
        const ambiguous = transitionLeadTaskV2({
          board: latest,
          taskID: reserved.taskID,
          expectedVersion: task.lifecycleVersion,
          actorSessionID: sessionID,
          action: "ambiguous",
          note: "prompt delivery outcome unknown",
        })
        if (ambiguous.ok) await writeLeadBoardV2(context.storage, keyedLocation, ambiguous.board)
      })
    } catch (error) {
      console.warn(`opencode-orchestrator lead board ambiguity write failed for ${sessionID}`, error)
    }
  }
}

type BoardReservation = {
  kind: "board"
  goal: GoalRecord
  run: PlanRunRecord | undefined
  taskID: string
  stepIndex: number
  lifecycleVersion: number
  boardRevision: number
  packet: string
}

type LegacyReservation = {
  kind: "legacy"
  goal: GoalRecord
  run: PlanRunRecord | undefined
  stepIndex: number
}

type Reservation = BoardReservation | LegacyReservation

// Identity of the exact record the reservation wrote, used at admission time.
// A replacement (`orchestrator_goal` action `set`) or update (`pause`,
// `resume`, or `complete`) changes these fields,
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
