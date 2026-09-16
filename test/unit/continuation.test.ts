import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { buildContinuationPrompt } from "../../src/core/prompts.js"
import {
  goalStorageKey,
  newGoal,
  runStorageKey,
  stopStorageKey,
  type PlanRunRecord,
  type StorageLike,
} from "../../src/opencode-v2/goal/state.js"
import {
  continuationStepIdempotencyKey,
  newPendingStepRecord,
  parseStepRecord,
  stepPrefix,
  stepStorageKey,
} from "../../src/opencode-v2/orchestration/step-state.js"
import { startGoalContinuation } from "../../src/opencode-v2/goal/continuation.js"
import type { DispatchGate } from "../../src/opencode-v2/observability/runtime.js"

// The runtime passes the parsed plugin options to the continuation prompt
// (the universal peer-discovery guidance and any feature guidance are
// composed from them), so reference prompts must use the same options.
const CONTINUATION_OPTIONS = parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } })

describe("goal continuation", () => {
  test("deduplicates idle events, applies the ceiling, and closes the iterator", async () => {
    const location = { directory: "/workspace", project: { id: "project" } }
    const key = goalStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string; delivery: string }> = []
    const stream = createStream()
    const stop = startGoalContinuation(
      {
        event: { subscribe: () => stream },
        location,
        storage: {
          get: async (item) => values.get(item),
          set: async (item, value) => void values.set(item, value),
          remove: async (item) => void values.delete(item),
        },
        session: {
          get: async () => undefined,
          prompt: async (input) => void prompts.push(input),
        },
      },
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-1", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => prompts.length === 1)
    expect(prompts[0]?.text).toContain(buildContinuationPrompt("ship the change", 1, CONTINUATION_OPTIONS))

    stream.push({ id: "idle-1", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(prompts).toHaveLength(1)

    stream.push({ id: "idle-2", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => prompts.length === 2)
    stream.push({ id: "idle-3", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(prompts).toHaveLength(2)

    stop()
    expect(stream.closed).toBe(true)
  })

  test("does not continue a paused or completed goal", async () => {
    for (const status of ["paused", "complete"] as const) {
      const location = { directory: "/workspace", project: { id: `project-${status}` } }
      const key = goalStorageKey(location, "session")
      const values = new Map<string, unknown>([[key, { ...newGoal("session", "ship the change", 1), status }]])
      const prompts: Array<{ text: string }> = []
      const stream = createStream()
      const stop = startGoalContinuation(
        fixture(location, values, prompts, stream),
        parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
      )

      stream.push({ id: `idle-${status}`, type: "session.idle", data: { sessionID: "session" } })
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(prompts).toHaveLength(0)
      expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(0)
      stop()
    }
  })

  test("does not continue a paused or completed plan run and does not burn a reservation", async () => {
    // An existing run that is not active has no unfinished ledger item: both a
    // paused run and a completed run stop auto-continuation under the lock.
    for (const status of ["paused", "complete"] as const) {
      const location = { directory: "/workspace", project: { id: `project-run-${status}` } }
      const key = goalStorageKey(location, "session")
      const runKey = runStorageKey(location, "session")
      const values = new Map<string, unknown>([
        [key, newGoal("session", "ship the change", 1)],
        [runKey, runRecord(status)],
      ])
      const prompts: Array<{ text: string }> = []
      const stream = createStream()
      const stop = startGoalContinuation(
        fixture(location, values, prompts, stream),
        parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
      )

      stream.push({ id: `idle-run-${status}`, type: "session.idle", data: { sessionID: "session" } })
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(prompts, status).toHaveLength(0)
      expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(0)
      stop()
    }
  })

  test("continues with an active plan run and embeds the plan path and ledger behavior in the prompt", async () => {
    const location = { directory: "/workspace", project: { id: "project-run-active" } }
    const key = goalStorageKey(location, "session")
    const runKey = runStorageKey(location, "session")
    const values = new Map<string, unknown>([
      [key, newGoal("session", "ship the change", 1)],
      [runKey, runRecord("active")],
    ])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-run-active", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => prompts.length === 1)
    const text = prompts[0]!.text
    expect(text).toContain(buildContinuationPrompt("ship the change", 1, CONTINUATION_OPTIONS, ".orchestrator/plans/ship.md"))
    // The safe plan path is embedded; the plan file contents are not (the
    // continuation never reads the ledger file).
    expect(text).toContain("Plan ledger: .orchestrator/plans/ship.md")
    expect(text.split("Plan ledger:").length - 1).toBe(1)
    expect(text).toContain("first unfinished item")
    expect(text).toContain("update the ledger")
    expect(text).toContain("next unfinished item in order")
    expect(text).toContain("Continue autonomously through the ledger")
    expect(text).toContain("configured breaker")
    expect(text).toContain("never mark the goal or plan complete without direct evidence")
    expect(text).not.toContain("Validated plan:")
    stop()
  })

  test("skips admission when a run pause races the reservation", async () => {
    const location = { directory: "/workspace", project: { id: "project-run-race" } }
    const key = goalStorageKey(location, "session")
    const runKey = runStorageKey(location, "session")
    const values = new Map<string, unknown>([
      [key, newGoal("session", "ship the change", 1)],
      [runKey, runRecord("active")],
    ])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    // When the reservation is written (count goes 0 -> 1), a concurrent
    // /halt run pauses the plan run before delivery re-reads it.
    const racyStorage: StorageLike = {
      get: async (item) => values.get(item),
      set: async (item, value) => {
        values.set(item, value)
        const goal = value as { continuationCount: number }
        if (item === key && goal.continuationCount === 1) {
          const run = values.get(runKey) as PlanRunRecord
          values.set(runKey, { ...run, status: "paused", updatedAt: run.updatedAt + 1 })
        }
      },
      remove: async (item) => void values.delete(item),
    }
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream, racyStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-run-race", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The turn was reserved, but the paused run is never admitted.
    expect(prompts).toHaveLength(0)
    expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(1)
    expect((values.get(runKey) as PlanRunRecord).status).toBe("paused")
    stop()
  })

  test("skips admission when the plan run is replaced between reservation and delivery", async () => {
    const location = { directory: "/workspace", project: { id: "project-run-replace" } }
    const key = goalStorageKey(location, "session")
    const runKey = runStorageKey(location, "session")
    const values = new Map<string, unknown>([
      [key, newGoal("session", "ship the change", 1)],
      [runKey, runRecord("active")],
    ])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    // A concurrent /run-plan replaces the run with a different active plan:
    // status and count still look reservable, but the run identity changed.
    const racyStorage: StorageLike = {
      get: async (item) => values.get(item),
      set: async (item, value) => {
        values.set(item, value)
        const goal = value as { continuationCount: number }
        if (item === key && goal.continuationCount === 1) {
          const run = values.get(runKey) as PlanRunRecord
          values.set(runKey, { ...run, plan: ".orchestrator/plans/other.md", updatedAt: run.updatedAt + 1 })
        }
      },
      remove: async (item) => void values.delete(item),
    }
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream, racyStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-run-replace", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // A replaced run is never mistaken for the reserved snapshot.
    expect(prompts).toHaveLength(0)
    expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(1)
    stop()
  })

  test("skips admission when a new plan run appears between reservation and delivery", async () => {
    const location = { directory: "/workspace", project: { id: "project-run-appear" } }
    const key = goalStorageKey(location, "session")
    const runKey = runStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    // No run exists at reservation time; a concurrent /run-plan activates one
    // before delivery re-reads the run key.
    const racyStorage: StorageLike = {
      get: async (item) => values.get(item),
      set: async (item, value) => {
        values.set(item, value)
        const goal = value as { continuationCount: number }
        if (item === key && goal.continuationCount === 1) {
          values.set(runKey, runRecord("active"))
        }
      },
      remove: async (item) => void values.delete(item),
    }
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream, racyStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-run-appear", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Absent and present are different identities: the reservation is stale.
    expect(prompts).toHaveLength(0)
    expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(1)
    expect(values.get(runKey)).toBeDefined()
    stop()
  })

  test("does not continue a halted goal and does not burn a reservation", async () => {
    const location = { directory: "/workspace", project: { id: "project-halt" } }
    const key = goalStorageKey(location, "session")
    const stopKey = stopStorageKey(location, "session")
    const values = new Map<string, unknown>([
      [key, newGoal("session", "ship the change", 1)],
      [stopKey, { version: 1, sessionID: "session", stoppedAt: 1 }],
    ])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-halt", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(prompts).toHaveLength(0)
    expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(0)
    stop()
  })

  test("skips admission when a pause races the reservation", async () => {
    const location = { directory: "/workspace", project: { id: "project-race" } }
    const key = goalStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    // When the reservation is written (count goes 0 -> 1), a concurrent
    // command pauses the goal before admission re-reads it.
    const racyStorage: StorageLike = {
      get: async (item) => values.get(item),
      set: async (item, value) => {
        const goal = value as { continuationCount: number }
        values.set(item, value)
        if (item === key && goal.continuationCount === 1) {
          values.set(key, { ...(values.get(key) as object), status: "paused", updatedAt: 2 })
        }
      },
      remove: async (item) => void values.delete(item),
    }
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream, racyStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-race", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The turn was reserved, but the changed goal is never admitted.
    expect(prompts).toHaveLength(0)
    expect((values.get(key) as { status: string; continuationCount: number }).continuationCount).toBe(1)
    expect((values.get(key) as { status: string }).status).toBe("paused")
    stop()
  })

  test("skips admission when a flagged halt races the reservation", async () => {
    const location = { directory: "/workspace", project: { id: "project-halt-race" } }
    const key = goalStorageKey(location, "session")
    const stopKey = stopStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const racyStorage: StorageLike = {
      get: async (item) => values.get(item),
      set: async (item, value) => {
        values.set(item, value)
        if (item === key) {
          values.set(stopKey, { version: 1, sessionID: "session", stoppedAt: 1 })
        }
      },
      remove: async (item) => void values.delete(item),
    }
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream, racyStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-halt-race", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(prompts).toHaveLength(0)
    expect(values.has(stopKey)).toBe(true)
    stop()
  })

  test("skips admission when a goal update races the reservation", async () => {
    const location = { directory: "/workspace", project: { id: "project-update-race" } }
    const key = goalStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    // When the reservation is written (count 0 -> 1), a concurrent
    // `goal_update` pauses and resumes the goal: status is active again and
    // the continuation count still matches the reservation, but updatedAt
    // advanced so this is not the exact record we reserved.
    const racyStorage: StorageLike = {
      get: async (item) => values.get(item),
      set: async (item, value) => {
        values.set(item, value)
        const goal = value as { continuationCount: number; updatedAt: number }
        if (item === key && goal.continuationCount === 1) {
          values.set(key, {
            ...(values.get(key) as object),
            status: "active",
            updatedAt: goal.updatedAt + 1,
          })
        }
      },
      remove: async (item) => void values.delete(item),
    }
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream, racyStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-update-race", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The count alone is not enough: the updated record must not be admitted.
    expect(prompts).toHaveLength(0)
    expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(1)
    stop()
  })

  test("skips admission when a goal replacement races the reservation", async () => {
    const location = { directory: "/workspace", project: { id: "project-replace-race" } }
    const key = goalStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    // When the reservation is written, a concurrent `goal_set` replaces the
    // goal with a fresh record whose continuation identity (createdAt and
    // objective) differs even though the count and lastContinuationAt happen
    // to match the reservation.
    const racyStorage: StorageLike = {
      get: async (item) => values.get(item),
      set: async (item, value) => {
        values.set(item, value)
        const goal = value as { continuationCount: number; lastContinuationAt: number }
        if (item === key && goal.continuationCount === 1) {
          values.set(key, {
            ...newGoal("session", "replaced objective", goal.lastContinuationAt + 1),
            continuationCount: goal.continuationCount,
            lastContinuationAt: goal.lastContinuationAt,
          })
        }
      },
      remove: async (item) => void values.delete(item),
    }
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream, racyStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-replace-race", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // A replaced goal is never mistaken for the reservation.
    expect(prompts).toHaveLength(0)
    expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(1)
    stop()
  })

  test("serializes session.deleted cleanup against an in-flight reservation write", async () => {
    const location = { directory: "/workspace", project: { id: "project-delete-race" } }
    const key = goalStorageKey(location, "session")
    const runKey = runStorageKey(location, "session")
    const stopKey = stopStorageKey(location, "session")
    const values = new Map<string, unknown>([
      [key, newGoal("session", "ship the change", 1)],
      [runKey, { version: 1, sessionID: "session", status: "active", createdAt: 1, updatedAt: 1 }],
    ])
    const prompts: Array<{ text: string }> = []
    // The reservation's goal write blocks until the test releases it, so a
    // concurrent session.deleted cleanup has to queue behind the reservation
    // instead of racing it. A /halt flag lands during the same window.
    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => {
      releaseSet = resolve
    })
    let reservationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      reservationStarted = resolve
    })
    const sharedStorage: StorageLike = {
      get: async (item) => values.get(item),
      set: async (item, value) => {
        if (item === key) {
          reservationStarted()
          await setGate
        }
        values.set(item, value)
        if (item === key) {
          // A concurrent /halt lands while the reservation write is in flight.
          values.set(stopKey, { version: 1, sessionID: "session", stoppedAt: 1 })
        }
      },
      remove: async (item) => void values.delete(item),
    }

    // Instance A reserves the turn and blocks mid-write; instance B observes
    // the session deletion. Both share the module-level session lock.
    const streamA = createStream()
    const streamB = createStream()
    const stopA = startGoalContinuation(
      fixture(location, values, prompts, streamA, sharedStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )
    const stopB = startGoalContinuation(
      fixture(location, values, prompts, streamB, sharedStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    streamA.push({ id: "idle-delete-race", type: "session.idle", data: { sessionID: "session" } })
    await started
    streamB.push({ id: "deleted-race", type: "session.deleted", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseSet()

    // Cleanup runs after the reservation write completes, so the reserved
    // goal and the racing halt flag must not be resurrected by writes that
    // follow the delete.
    await waitFor(() => !values.has(key))
    expect(values.has(runKey)).toBe(false)
    expect(values.has(stopKey)).toBe(false)
    expect(prompts).toHaveLength(0)
    stopA()
    stopB()
  })

  test("cleans up goal, run, and halt storage when the session is deleted", async () => {
    const location = { directory: "/workspace", project: { id: "project-delete" } }
    const goalKey = goalStorageKey(location, "session")
    const runKey = runStorageKey(location, "session")
    const stopKey = stopStorageKey(location, "session")
    const values = new Map<string, unknown>([
      [goalKey, newGoal("session", "ship the change", 1)],
      [runKey, { version: 1, sessionID: "session", status: "active", createdAt: 1, updatedAt: 1 }],
      [stopKey, { version: 1, sessionID: "session", stoppedAt: 1 }],
    ])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "deleted-1", type: "session.deleted", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(values.has(goalKey)).toBe(false)
    expect(values.has(runKey)).toBe(false)
    expect(values.has(stopKey)).toBe(false)

    // A late idle event for the deleted session must not be admitted.
    stream.push({ id: "idle-after-delete", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(prompts).toHaveLength(0)
    stop()
  })

  test("writes a pending step receipt before delivery and marks it dispatched after", async () => {
    const location = { directory: "/workspace", project: { id: "project-step" } }
    const key = goalStorageKey(location, "session")
    const stepKey = stepStorageKey(location, "session", 1)
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const statusAtDelivery: Array<string | undefined> = []
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const stop = startGoalContinuation(
      {
        ...fixture(location, values, prompts, stream),
        session: {
          get: async () => undefined,
          prompt: async (input: { text: string }) => {
            // The receipt must already exist as pending when the prompt is queued.
            statusAtDelivery.push(parseStepRecord(values.get(stepKey))?.status)
            prompts.push(input)
          },
        },
      },
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-step", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => prompts.length === 1)
    await waitFor(() => parseStepRecord(values.get(stepKey))?.status === "dispatched")

    expect(statusAtDelivery).toEqual(["pending"])
    const record = parseStepRecord(values.get(stepKey))
    expect(record?.stepIndex).toBe(1)
    expect(record?.attempt).toBe(1)
    expect(record?.idempotencyKey).toBe(continuationStepIdempotencyKey("session", 1, 1))
    expect(record?.createdAt).toBeGreaterThan(0)
    expect(record?.dispatchedAt).toBeGreaterThanOrEqual(record?.createdAt ?? 0)
    stop()
  })

  test("leaves the receipt pending when prompt delivery fails and records the next step", async () => {
    const location = { directory: "/workspace", project: { id: "project-step-fail" } }
    const key = goalStorageKey(location, "session")
    const firstStepKey = stepStorageKey(location, "session", 1)
    const secondStepKey = stepStorageKey(location, "session", 2)
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    let failNext = true
    const stop = startGoalContinuation(
      {
        ...fixture(location, values, prompts, stream),
        session: {
          get: async () => undefined,
          prompt: async (input: { text: string }) => {
            if (failNext) {
              failNext = false
              throw new Error("prompt delivery failed")
            }
            prompts.push(input)
          },
        },
      },
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-step-fail", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => parseStepRecord(values.get(firstStepKey)) !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(prompts).toHaveLength(0)
    expect(parseStepRecord(values.get(firstStepKey))?.status).toBe("pending")

    // The next idle edge reserves a new step and delivers: only that step is
    // marked dispatched; the failed delivery stays truthfully pending.
    stream.push({ id: "idle-step-fail-2", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => prompts.length === 1)
    await waitFor(() => parseStepRecord(values.get(secondStepKey))?.status === "dispatched")
    expect(parseStepRecord(values.get(firstStepKey))?.status).toBe("pending")
    stop()
  })

  test("a failed step receipt write never blocks continuation delivery", async () => {
    const location = { directory: "/workspace", project: { id: "project-step-write-fail" } }
    const key = goalStorageKey(location, "session")
    const stepKey = stepStorageKey(location, "session", 1)
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const prefix = stepPrefix(location, "session")
    const failingStorage: StorageLike = {
      get: async (item) => values.get(item),
      set: async (item, value) => {
        if (item.startsWith(prefix)) throw new Error("step storage unavailable")
        values.set(item, value)
      },
      remove: async (item) => void values.delete(item),
    }
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream, failingStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-step-write-fail", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => prompts.length === 1)
    expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(1)
    expect(values.has(stepKey)).toBe(false)
    stop()
  })

  test("removes step receipts with the rest of the session state on delete", async () => {
    const location = { directory: "/workspace", project: { id: "project-step-delete" } }
    const goalKey = goalStorageKey(location, "session")
    const firstStepKey = stepStorageKey(location, "session", 1)
    const secondStepKey = stepStorageKey(location, "session", 2)
    const otherSessionKey = stepStorageKey(location, "other-session", 1)
    const values = new Map<string, unknown>([
      [goalKey, newGoal("session", "ship the change", 1)],
      [firstStepKey, newPendingStepRecord({ sessionID: "session", stepIndex: 1, idempotencyKey: continuationStepIdempotencyKey("session", 1, 1), now: 1 })],
      [secondStepKey, newPendingStepRecord({ sessionID: "session", stepIndex: 2, idempotencyKey: continuationStepIdempotencyKey("session", 1, 2), now: 2 })],
      [otherSessionKey, newPendingStepRecord({ sessionID: "other-session", stepIndex: 1, idempotencyKey: continuationStepIdempotencyKey("other-session", 1, 1), now: 1 })],
    ])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream, scanningStorage(values)),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "deleted-steps", type: "session.deleted", data: { sessionID: "session" } })
    await waitFor(() => !values.has(firstStepKey))

    expect(values.has(secondStepKey)).toBe(false)
    expect(values.has(goalKey)).toBe(false)
    expect(values.has(otherSessionKey)).toBe(true)
    stop()
  })

  test("serializes step receipt writes with session.deleted cleanup", async () => {
    // A reservation blocked mid-write must keep its pending receipt inside the
    // lock: the delete queues behind it and removes the receipt, so a delete
    // can never be followed by a resurrected step record.
    const location = { directory: "/workspace", project: { id: "project-step-delete-race" } }
    const key = goalStorageKey(location, "session")
    const stopKey = stopStorageKey(location, "session")
    const stepKey = stepStorageKey(location, "session", 1)
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    let releaseSet!: () => void
    const setGate = new Promise<void>((resolve) => {
      releaseSet = resolve
    })
    let reservationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      reservationStarted = resolve
    })
    const sharedStorage: StorageLike = {
      get: async (item) => values.get(item),
      set: async (item, value) => {
        if (item === key) {
          reservationStarted()
          await setGate
        }
        values.set(item, value)
        if (item === key) {
          // A concurrent /halt lands while the reservation write is in flight,
          // so admission deterministically stops after the lock is released.
          values.set(stopKey, { version: 1, sessionID: "session", stoppedAt: 1 })
        }
      },
      remove: async (item) => void values.delete(item),
      scan: async ({ prefix, after, limit }) => {
        const matches = [...values.keys()].sort().filter((item) => item.startsWith(prefix) && (after === undefined || item > after))
        const page = matches.slice(0, limit)
        const next = matches.length > page.length ? page[page.length - 1] : undefined
        return { entries: page.map((item) => ({ key: item, value: values.get(item) })), ...(next !== undefined ? { next } : {}) }
      },
    }
    const prompts: Array<{ text: string }> = []
    const streamA = createStream()
    const streamB = createStream()
    const stopA = startGoalContinuation(
      fixture(location, values, prompts, streamA, sharedStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )
    const stopB = startGoalContinuation(
      fixture(location, values, prompts, streamB, sharedStorage),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    streamA.push({ id: "idle-step-delete-race", type: "session.idle", data: { sessionID: "session" } })
    await started
    streamB.push({ id: "deleted-step-race", type: "session.deleted", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseSet()

    await waitFor(() => !values.has(key))
    expect(values.has(stepKey)).toBe(false)
    expect(prompts).toHaveLength(0)
    stopA()
    stopB()
  })

  test("does not admit a gate-blocked continuation and does not burn a reservation", async () => {
    const location = { directory: "/workspace", project: { id: "project-gate-block" } }
    const key = goalStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const gate: DispatchGate = {
      allowDispatch: async () => ({
        allow: false,
        reason: "stop-between-steps: budget exceeded",
        evaluation: { version: 1, mode: "stop-between-steps", verdict: "exceeded", limits: [] },
      }),
    }
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
      gate,
    )

    stream.push({ id: "idle-gate-block", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(prompts).toHaveLength(0)
    expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(0)
    stop()
  })

  test("skips delivery when the gate closes between reservation and delivery", async () => {
    const location = { directory: "/workspace", project: { id: "project-gate-delivery" } }
    const key = goalStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    let calls = 0
    const gate: DispatchGate = {
      allowDispatch: async () => {
        calls += 1
        const allow = calls === 1
        return {
          allow,
          reason: allow ? undefined : "review circuit is open",
          evaluation: { version: 1, mode: "advisory", verdict: "within", limits: [] },
        }
      },
    }
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
      gate,
    )

    stream.push({ id: "idle-gate-delivery", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The reservation advanced, but the delivery re-check stopped the prompt.
    expect(prompts).toHaveLength(0)
    expect(calls).toBe(2)
    expect((values.get(key) as { continuationCount: number }).continuationCount).toBe(1)
    stop()
  })

  test("auto-continuation prompts include bounded-review and budget guidance only when enabled", async () => {
    const location = { directory: "/workspace", project: { id: "project-guidance" } }
    const key = goalStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const options = parseOptions({
      review: { mode: "bounded", max_rounds: 3 },
      budget: { mode: "stop-between-steps", max_steps: 5 },
    })
    const stop = startGoalContinuation(fixture(location, values, prompts, stream), options)

    stream.push({ id: "idle-guidance", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => prompts.length === 1)
    expect(prompts[0]?.text).toContain("Bounded review mode is configured")
    expect(prompts[0]?.text).toContain("orchestrator_review_transition")
    expect(prompts[0]?.text).toContain("stop-between-steps budget mode is configured")
    expect(prompts[0]?.text).toContain("in-flight provider and tool calls are never interrupted")
    expect(prompts[0]?.text).toContain("not an automatic completion gate")
    stop()
  })

  test("default auto-continuation prompts carry no review or budget guidance", async () => {
    const location = { directory: "/workspace", project: { id: "project-guidance-default" } }
    const key = goalStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0 } }),
    )

    stream.push({ id: "idle-guidance-default", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => prompts.length === 1)
    expect(prompts[0]?.text).not.toContain("Bounded review mode is configured")
    expect(prompts[0]?.text).not.toContain("orchestrator_review_transition")
    expect(prompts[0]?.text).not.toContain("stop-between-steps budget mode is configured")
    stop()
  })

  test("keeps the stream alive when admission prompt delivery fails", async () => {
    const location = { directory: "/workspace", project: { id: "project-error" } }
    const key = goalStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    let failNext = true
    const stream = createStream()
    const stop = startGoalContinuation(
      {
        ...fixture(location, values, prompts, stream),
        session: {
          get: async () => undefined,
          prompt: async (input: { text: string }) => {
            if (failNext) {
              failNext = false
              throw new Error("prompt delivery failed")
            }
            prompts.push(input)
          },
        },
      },
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-err-1", type: "session.idle", data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(prompts).toHaveLength(0)

    // A later idle edge still works: the failure did not wedge in-flight state.
    stream.push({ id: "idle-err-2", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => prompts.length === 1)
    expect(prompts[0]?.text).toContain(buildContinuationPrompt("ship the change", 2, CONTINUATION_OPTIONS))
    stop()
  })

  test("continues a goal keyed to the stable origin project after a move", async () => {
    // After a session move the anchor records the origin project, and goal/run/halt state
    // stays keyed to that origin: admission must find and reserve the goal
    // under the origin-project key, not abandon it after the move.
    const location = { directory: "/workspace", project: { id: "project" } }
    const originKey = goalStorageKey({ ...location, project: { id: "origin" } }, "session")
    const values = new Map<string, unknown>([
      [originKey, newGoal("session", "ship the change", 1)],
      // Anchor at the current project records the stable origin.
      ["session/v1/project/session", {
        version: 1,
        sessionID: "session",
        originProjectID: "origin",
        originDirectory: "/origin",
        currentProjectID: "project",
        currentDirectory: "/workspace",
        updatedAt: 1,
      }],
    ])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({ id: "idle-origin", type: "session.idle", data: { sessionID: "session" } })
    await waitFor(() => prompts.length === 1)
    expect(prompts[0]?.text).toContain(buildContinuationPrompt("ship the change", 1, CONTINUATION_OPTIONS))
    // The reservation advanced the origin-keyed record, not a project-keyed one.
    expect((values.get(originKey) as { continuationCount: number }).continuationCount).toBe(1)
    expect(values.has(goalStorageKey(location, "session"))).toBe(false)
    stop()
  })

  test("continues a session whose idle events carry the moved directory", async () => {
    // A session move changes the session directory but keeps the workspace; idle
    // events for the moved session must still be admitted.
    const location = { directory: "/workspace", project: { id: "project-here" }, workspaceID: "ws-1" }
    const key = goalStorageKey(location, "session")
    const values = new Map<string, unknown>([[key, newGoal("session", "ship the change", 1)]])
    const prompts: Array<{ text: string }> = []
    const stream = createStream()
    const stop = startGoalContinuation(
      fixture(location, values, prompts, stream),
      parseOptions({ goal: { auto_continue: true, cooldown_ms: 0, max_continuations: 2 } }),
    )

    stream.push({
      id: "idle-moved",
      type: "session.idle",
      data: { sessionID: "session" },
      location: { directory: "/moved/elsewhere", workspaceID: "ws-1" },
    })
    await waitFor(() => prompts.length === 1)
    expect(prompts[0]?.text).toContain(buildContinuationPrompt("ship the change", 1, CONTINUATION_OPTIONS))
    stop()
  })
})

function fixture(
  location: { directory: string; project: { id: string }; workspaceID?: string },
  values: Map<string, unknown>,
  prompts: Array<{ text: string }>,
  stream: ReturnType<typeof createStream>,
  storageOverride?: StorageLike,
): {
  event: { subscribe: () => ReturnType<typeof createStream> }
  location: { directory: string; project: { id: string }; workspaceID?: string }
  storage: StorageLike
  session: {
    get(): Promise<unknown>
    prompt(input: { text: string }): Promise<void>
  }
} {
  return {
    event: { subscribe: () => stream },
    location,
    storage:
      storageOverride ??
      ({
        get: async (item: string) => values.get(item),
        set: async (item: string, value: unknown) => void values.set(item, value),
        remove: async (item: string) => void values.delete(item),
      } satisfies StorageLike),
    session: {
      get: async () => undefined,
      prompt: async (input: { text: string }) => void prompts.push(input),
    },
  }
}

function scanningStorage(values: Map<string, unknown>): StorageLike {
  return {
    get: async (item: string) => values.get(item),
    set: async (item: string, value: unknown) => void values.set(item, value),
    remove: async (item: string) => void values.delete(item),
    scan: async ({ prefix, after, limit }) => {
      const matches = [...values.keys()].sort().filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      const page = matches.slice(0, limit)
      const next = matches.length > page.length ? page[page.length - 1] : undefined
      return { entries: page.map((key) => ({ key, value: values.get(key) })), ...(next !== undefined ? { next } : {}) }
    },
  }
}

function runRecord(status: PlanRunRecord["status"], plan = ".orchestrator/plans/ship.md"): PlanRunRecord {
  return {
    version: 1,
    sessionID: "session",
    plan,
    status,
    createdAt: 1,
    updatedAt: 1,
  }
}

function createStream(): AsyncIterable<any> & { push(value: unknown): void; closed: boolean } {
  const queue: unknown[] = []
  const waiters: Array<(result: IteratorResult<unknown>) => void> = []
  let closed = false
  const iterator = {
    next: () => {
      if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
      if (closed) return Promise.resolve({ done: true, value: undefined })
      return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve))
    },
    return: async () => {
      closed = true
      for (const resolve of waiters.splice(0)) resolve({ done: true, value: undefined })
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator]() {
      return this
    },
    push(value: unknown) {
      if (closed) return
      const resolve = waiters.shift()
      if (resolve) resolve({ done: false, value })
      else queue.push(value)
    },
    get closed() {
      return closed
    },
  }
  return iterator
}

async function waitFor(check: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for continuation")
}
