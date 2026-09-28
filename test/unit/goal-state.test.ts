import { describe, expect, test } from "bun:test"
import {
  SESSION_LOCK_TIMEOUT_MS,
  SessionLockTimeoutError,
  withSessionLock,
} from "../../src/opencode-v2/goal/state.js"

const location = { directory: "/workspace", project: { id: "project" } }

/** Resolves after `ms`; used to hold a lock deterministically. */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("withSessionLock", () => {
  test("serializes actions for the same session and lets independent sessions run concurrently", async () => {
    const order: string[] = []
    const first = withSessionLock(location, "s1", async () => {
      order.push("a-start")
      await delay(20)
      order.push("a-end")
    })
    const second = withSessionLock(location, "s1", async () => {
      order.push("b-start")
      order.push("b-end")
    })
    const other = withSessionLock(location, "s2", async () => {
      order.push("other")
    })
    await Promise.all([first, second, other])

    expect(order.indexOf("a-end")).toBeLessThan(order.indexOf("b-start"))
    expect(order).toContain("other")
  })

  test("refuses with a timeout instead of running the action without the lock", async () => {
    let released!: () => void
    const holderGate = new Promise<void>((resolve) => {
      released = resolve
    })
    let secondRan = false

    const holder = withSessionLock(location, "timeout", async () => {
      await holderGate
      return "holder"
    })
    // Give the holder a turn to acquire before the contender queues behind it.
    await delay(5)

    const contender = withSessionLock(
      location,
      "timeout",
      async () => {
        secondRan = true
        return "contender"
      },
      20,
    )

    await expect(contender).rejects.toBeInstanceOf(SessionLockTimeoutError)
    expect(secondRan).toBe(false)

    released()
    await expect(holder).resolves.toBe("holder")
    expect(secondRan).toBe(false)
  })

  test("a timed-out waiter does not deadlock the session and ordering is preserved", async () => {
    const order: string[] = []
    let released!: () => void
    const holderGate = new Promise<void>((resolve) => {
      released = resolve
    })

    const holder = withSessionLock(location, "recover", async () => {
      order.push("holder-start")
      await holderGate
      order.push("holder-end")
    })
    await delay(5)

    const timedOut = withSessionLock(location, "recover", async () => order.push("timed-out-ran"), 15)
    await expect(timedOut).rejects.toBeInstanceOf(SessionLockTimeoutError)

    // A later caller still queues behind the real holder and runs after it.
    const later = withSessionLock(location, "recover", async () => order.push("later-ran"))
    released()
    await Promise.all([holder, later])

    expect(order).toEqual(["holder-start", "holder-end", "later-ran"])
  })

  test("propagates an action error and still releases the lock", async () => {
    await expect(
      withSessionLock(location, "errors", async () => {
        throw new Error("action failed")
      }),
    ).rejects.toThrow("action failed")

    await expect(withSessionLock(location, "errors", async () => "ok")).resolves.toBe("ok")
  })

  test("exposes an explicit default bound", () => {
    expect(SESSION_LOCK_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
