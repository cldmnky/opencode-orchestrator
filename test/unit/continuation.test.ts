import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { buildContinuationPrompt } from "../../src/core/prompts.js"
import {
  goalStorageKey,
  newGoal,
  runStorageKey,
  stopStorageKey,
  type StorageLike,
} from "../../src/opencode-v2/goal/state.js"
import { startGoalContinuation } from "../../src/opencode-v2/goal/continuation.js"

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
    expect(prompts[0]?.text).toContain(buildContinuationPrompt("ship the change", 1))

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
    expect(prompts[0]?.text).toContain(buildContinuationPrompt("ship the change", 2))
    stop()
  })
})

function fixture(
  location: { directory: string; project: { id: string } },
  values: Map<string, unknown>,
  prompts: Array<{ text: string }>,
  stream: ReturnType<typeof createStream>,
  storageOverride?: StorageLike,
): {
  event: { subscribe: () => ReturnType<typeof createStream> }
  location: { directory: string; project: { id: string } }
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
