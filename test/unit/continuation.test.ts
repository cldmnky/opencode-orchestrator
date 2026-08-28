import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { buildContinuationPrompt } from "../../src/core/prompts.js"
import { goalStorageKey, newGoal } from "../../src/opencode-v2/goal/state.js"
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
})

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
