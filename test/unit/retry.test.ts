import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import {
  RETRY_BURST_MAX_ATTEMPTS,
  RETRY_BURST_WINDOW_MS,
  RETRY_DEFAULT_MAX_DELAY_MS,
  RETRY_HARD_MAX_DELAY_MS,
  classifyRetryError,
  createRetryPolicy,
  decideRetry,
  retryPolicyEnabled,
  type RetryDecision,
  type RetryHookEventLike,
} from "../../src/opencode-v2/observability/retry.js"
import {
  RETRY_ACTIONS,
  RETRY_CLASSES,
  RETRY_TRACE_MAX_ATTEMPT,
  newRetryTrace,
  parseRetryTrace,
  recordRetryAction,
  retryTraceSchema,
  retryTraceStorageKey,
} from "../../src/opencode-v2/observability/trace.js"

const location = { directory: "/workspace", project: { id: "project" } }
const SESSION = "session-1"

function memStorage(values = new Map<string, unknown>()): {
  values: Map<string, unknown>
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
} {
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  }
}

function hookEvent(overrides: Partial<RetryHookEventLike> = {}): RetryHookEventLike {
  return {
    sessionID: SESSION,
    agent: "orchestrator",
    model: { providerID: "provider", id: "model" },
    error: { type: "provider.rate-limit", status: 429 },
    attempt: 2,
    decision: { retry: true, delay: 1_000 },
    ...overrides,
  }
}

function enabledOptions(overrides: Record<string, unknown> = {}) {
  return parseOptions({ retry: { mode: "bounded" }, ...overrides })
}

describe("N5 retry configuration", () => {
  test("defaults stay off with the documented bounded cap", () => {
    const options = parseOptions({})
    expect(options.retry).toEqual({ mode: "off", max_delay_ms: RETRY_DEFAULT_MAX_DELAY_MS })
    expect(retryPolicyEnabled(options)).toBe(false)
    expect(retryPolicyEnabled(parseOptions({ retry: { mode: "off" } }))).toBe(false)
    expect(retryPolicyEnabled(enabledOptions())).toBe(true)
  })
})

describe("bounded retry classes", () => {
  test("maps every documented host error type into a fixed class", () => {
    expect(classifyRetryError({ type: "provider.rate-limit" })).toBe("rate-limited")
    expect(classifyRetryError({ type: "provider.internal", status: 503 })).toBe("provider-internal")
    expect(classifyRetryError({ type: "provider.transport" })).toBe("transport")
    expect(classifyRetryError({ type: "provider.unknown" })).toBe("unknown")
    for (const terminal of [
      "provider.auth",
      "provider.quota",
      "provider.content-filter",
      "provider.invalid-request",
      "provider.unsupported-operation",
      "provider.no-route",
      "provider.invalid-output",
      "aborted",
      "permission.rejected",
      "tool.execution",
      "unknown",
      "",
    ]) {
      expect(classifyRetryError({ type: terminal }), terminal).toBe("terminal")
    }
  })

  test("only positively-classified transient classes keep a host-proposed retry", () => {
    for (const type of ["provider.rate-limit", "provider.internal"]) {
      const result = decideRetry({
        error: { type },
        attempt: 2,
        decision: { retry: true, delay: 250 },
        now: 1_000,
        window: [],
        maxDelayMs: RETRY_DEFAULT_MAX_DELAY_MS,
      })
      expect(result.class, type).toBe(type === "provider.rate-limit" ? "rate-limited" : "provider-internal")
      expect(result.action).toBe("keep")
      expect(result.decision).toEqual({ retry: true, delay: 250 })
    }
    for (const type of ["provider.transport", "provider.unknown", "provider.auth"]) {
      const result = decideRetry({
        error: { type },
        attempt: 2,
        decision: { retry: true, delay: 250 },
        now: 1_000,
        window: [],
        maxDelayMs: RETRY_DEFAULT_MAX_DELAY_MS,
      })
      expect(result.action, type).toBe("veto-class")
      expect(result.decision).toEqual({ retry: false })
    }
  })

  test("caps valid delays downward and never raises them", () => {
    const capped = decideRetry({
      error: { type: "provider.internal" },
      attempt: 3,
      decision: { retry: true, delay: 60_000 },
      now: 1_000,
      window: [],
      maxDelayMs: 30_000,
    })
    expect(capped.action).toBe("cap-delay")
    expect(capped.decision).toEqual({ retry: true, delay: 30_000 })

    const within = decideRetry({
      error: { type: "provider.internal" },
      attempt: 3,
      decision: { retry: true, delay: 10 },
      now: 1_000,
      window: [],
      maxDelayMs: 30_000,
    })
    expect(within.action).toBe("keep")
    expect(within.decision).toEqual({ retry: true, delay: 10 })

    // Zero is a valid delay and stays zero.
    const zero = decideRetry({
      error: { type: "provider.rate-limit" },
      attempt: 2,
      decision: { retry: true, delay: 0 },
      now: 1_000,
      window: [],
      maxDelayMs: 30_000,
    })
    expect(zero.action).toBe("keep")
    expect(zero.decision).toEqual({ retry: true, delay: 0 })
  })

  test("leaves malformed delays untouched for the host fallback", () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const decision: RetryDecision = { retry: true, delay: invalid }
      const result = decideRetry({
        error: { type: "provider.internal" },
        attempt: 2,
        decision,
        now: 1_000,
        window: [],
        maxDelayMs: RETRY_DEFAULT_MAX_DELAY_MS,
      })
      expect(result.action).toBe("keep")
      // The exact malformed value is preserved so the host applies its own
      // computed-delay fallback.
      expect(Object.is((result.decision as { delay: number }).delay, invalid)).toBe(true)
    }
  })

  test("bounds the configured cap and falls back for a malformed cap", () => {
    // A malformed cap falls back to the default bounded cap (never to the
    // hard maximum).
    const malformed = decideRetry({
      error: { type: "provider.internal" },
      attempt: 2,
      decision: { retry: true, delay: 10_000_000 },
      now: 1_000,
      window: [],
      maxDelayMs: Number.POSITIVE_INFINITY,
    })
    expect(malformed.decision).toEqual({ retry: true, delay: RETRY_DEFAULT_MAX_DELAY_MS })

    const aboveHard = decideRetry({
      error: { type: "provider.internal" },
      attempt: 2,
      decision: { retry: true, delay: 10_000_000 },
      now: 1_000,
      window: [],
      maxDelayMs: RETRY_HARD_MAX_DELAY_MS * 2,
    })
    expect(aboveHard.decision).toEqual({ retry: true, delay: RETRY_HARD_MAX_DELAY_MS })

    const corrected = decideRetry({
      error: { type: "provider.internal" },
      attempt: 2,
      decision: { retry: true, delay: 60_000 },
      now: 1_000,
      window: [],
      maxDelayMs: -5,
    })
    expect(corrected.decision).toEqual({ retry: true, delay: RETRY_DEFAULT_MAX_DELAY_MS })
  })

  test("never converts a terminal host decision into a retry", () => {
    for (const classType of ["provider.rate-limit", "provider.internal", "provider.transport", "provider.unknown", "provider.auth"]) {
      const result = decideRetry({
        error: { type: classType },
        attempt: 4,
        decision: { retry: false },
        now: 1_000,
        window: [900, 910, 920],
        maxDelayMs: 30_000,
      })
      expect(result.action, classType).toBe("host-terminal")
      expect(result.decision).toEqual({ retry: false })
    }
  })

  test("gates bursts at the bounded per-session window", () => {
    const now = 100_000
    const within = decideRetry({
      error: { type: "provider.internal" },
      attempt: 2,
      decision: { retry: true, delay: 5 },
      now,
      window: [now - 1, now - 2, now - 3, now - 4, now - 5],
      maxDelayMs: 30_000,
    })
    expect(within.action).toBe("keep")
    expect(within.window).toHaveLength(RETRY_BURST_MAX_ATTEMPTS)

    const burst = decideRetry({
      error: { type: "provider.internal" },
      attempt: 2,
      decision: { retry: true, delay: 5 },
      now,
      window: Array.from({ length: RETRY_BURST_MAX_ATTEMPTS }, (_, index) => now - index),
      maxDelayMs: 30_000,
    })
    expect(burst.action).toBe("veto-burst")
    expect(burst.decision).toEqual({ retry: false })
    expect(burst.window).toHaveLength(RETRY_BURST_MAX_ATTEMPTS)

    // Attempts outside the window do not count and are dropped from the state.
    const stale = decideRetry({
      error: { type: "provider.internal" },
      attempt: 2,
      decision: { retry: true, delay: 5 },
      now,
      window: [now - RETRY_BURST_WINDOW_MS - 1, now - RETRY_BURST_WINDOW_MS * 2],
      maxDelayMs: 30_000,
    })
    expect(stale.action).toBe("keep")
    expect(stale.window).toEqual([now])
  })
})

describe("N5 retry policy runtime", () => {
  test("filters non-orchestrator sessions without changing decisions or recording", async () => {
    const storage = memStorage()
    const runtime = createRetryPolicy({ options: enabledOptions(), storage, location, now: () => 1_000 })
    const worker = hookEvent({ agent: "implementer", decision: { retry: true, delay: 60_000 } })
    await runtime.observe(worker)
    expect(worker.decision).toEqual({ retry: true, delay: 60_000 })
    expect(await runtime.trace(SESSION)).toBeUndefined()
    expect(storage.values.size).toBe(0)
  })

  test("caps delays, vetoes ambiguous classes, and leaves terminal decisions final", async () => {
    let now = 1_000
    const runtime = createRetryPolicy({
      options: enabledOptions({ retry: { mode: "bounded", max_delay_ms: 100 } }),
      storage: memStorage(),
      location,
      now: () => now,
    })

    const capped = hookEvent({ decision: { retry: true, delay: 60_000 } })
    await runtime.observe(capped)
    expect(capped.decision).toEqual({ retry: true, delay: 100 })

    const ambiguous = hookEvent({ error: { type: "provider.unknown" }, decision: { retry: true, delay: 500 } })
    await runtime.observe(ambiguous)
    expect(ambiguous.decision).toEqual({ retry: false })

    const malformed = hookEvent({ decision: { retry: true, delay: Number.NaN } })
    await runtime.observe(malformed)
    expect(Object.is(((malformed.decision as { delay: number }).delay), Number.NaN)).toBe(true)

    const terminal = hookEvent({ error: { type: "provider.auth" }, decision: { retry: false } })
    await runtime.observe(terminal)
    expect(terminal.decision).toEqual({ retry: false })

    const trace = await runtime.trace(SESSION)
    expect(trace).toBeDefined()
    expect(trace?.attempts).toBe(4)
    expect(trace?.capped).toBe(1)
    expect(trace?.vetoedClass).toBe(1)
    expect(trace?.kept).toBe(1)
    expect(trace?.lastAttempt).toBe(2)
    expect(trace?.lastClass).toBe("terminal")
    expect(trace?.lastAction).toBe("host-terminal")

    now = 2_000
    await runtime.observe(hookEvent({ attempt: 3 }))
    const updated = await runtime.trace(SESSION)
    expect(updated?.attempts).toBe(5)
    expect(updated?.lastAttempt).toBe(3)
    expect(updated?.capped).toBe(2)
    expect(updated?.lastAction).toBe("cap-delay")
  })

  test("gates a per-session burst and records it", async () => {
    const runtime = createRetryPolicy({ options: enabledOptions(), storage: memStorage(), location, now: () => 10_000 })
    for (let index = 0; index < RETRY_BURST_MAX_ATTEMPTS; index += 1) {
      const event = hookEvent({ attempt: 2 + index })
      await runtime.observe(event)
      expect(event.decision, `observation ${index}`).toEqual({ retry: true, delay: 1_000 })
    }
    const burst = hookEvent({ attempt: 9 })
    await runtime.observe(burst)
    expect(burst.decision).toEqual({ retry: false })
    const trace = await runtime.trace(SESSION)
    expect(trace?.attempts).toBe(RETRY_BURST_MAX_ATTEMPTS + 1)
    expect(trace?.vetoedBurst).toBe(1)
  })

  test("never throws on malformed events and records nothing for them", async () => {
    const runtime = createRetryPolicy({ options: enabledOptions(), storage: memStorage(), location })
    for (const value of [null, undefined, 42, "event", [], {}, { sessionID: "s", agent: 1 }, { sessionID: "s", agent: "orchestrator", attempt: Number.NaN }, hookEvent({ decision: {} as never })]) {
      await runtime.observe(value)
    }
    expect(await runtime.trace(SESSION)).toBeUndefined()
  })

  test("swallows recording failures and keeps the in-memory trace", async () => {
    const storage = memStorage()
    storage.set = async () => {
      throw new Error("disk full")
    }
    const runtime = createRetryPolicy({
      options: enabledOptions({ trace: { mode: "snapshot" } }),
      storage,
      location,
      now: () => 5_000,
    })
    const event = hookEvent()
    await runtime.observe(event)
    expect(event.decision).toEqual({ retry: true, delay: 1_000 })
    const trace = await runtime.trace(SESSION)
    expect(trace?.attempts).toBe(1)
  })

  test("persists one bounded record in snapshot trace mode and reads it back", async () => {
    const storage = memStorage()
    const runtime = createRetryPolicy({
      options: enabledOptions({ trace: { mode: "snapshot" } }),
      storage,
      location,
      now: () => 7_000,
    })
    await runtime.observe(hookEvent())
    const key = retryTraceStorageKey(location, SESSION)
    expect(storage.values.has(key)).toBe(true)
    const persisted = storage.values.get(key)
    expect(parseRetryTrace(persisted)).toBeDefined()
    const serialized = JSON.stringify(persisted)
    expect(serialized).not.toContain("provider.rate-limit")

    // A fresh runtime for the same session reads the durable record back.
    const reader = createRetryPolicy({ options: enabledOptions({ trace: { mode: "snapshot" } }), storage, location })
    const readBack = await reader.trace(SESSION)
    expect(readBack?.attempts).toBe(1)
    expect(readBack?.lastClass).toBe("rate-limited")
  })

  test("memory trace mode never writes the durable record", async () => {
    const storage = memStorage()
    const runtime = createRetryPolicy({ options: enabledOptions({ trace: { mode: "memory" } }), storage, location })
    await runtime.observe(hookEvent())
    expect(storage.values.size).toBe(0)
    expect((await runtime.trace(SESSION))?.attempts).toBe(1)
  })
})

describe("N5 bounded retry trace record", () => {
  test("versions, counts, and clamps the recorded attempt", () => {
    const fresh = newRetryTrace(SESSION, 1_000)
    expect(fresh).toEqual({
      version: 1,
      sessionID: SESSION,
      attempts: 0,
      kept: 0,
      capped: 0,
      vetoedClass: 0,
      vetoedBurst: 0,
      firstAt: 1_000,
      lastAt: 1_000,
      updatedAt: 1_000,
    })
    const capped = recordRetryAction(fresh, { class: "rate-limited", action: "cap-delay", attempt: 2 }, 1_100)
    expect(capped.attempts).toBe(1)
    expect(capped.capped).toBe(1)
    expect(capped.lastAttempt).toBe(2)
    expect(capped.lastClass).toBe("rate-limited")
    expect(capped.lastAction).toBe("cap-delay")

    const clamped = recordRetryAction(fresh, { class: "unknown", action: "veto-class", attempt: 9_999 }, 1_200)
    expect(clamped.lastAttempt).toBe(RETRY_TRACE_MAX_ATTEMPT)
    const invalid = recordRetryAction(fresh, { class: "terminal", action: "host-terminal", attempt: Number.NaN }, 1_300)
    expect(invalid.lastAttempt).toBeUndefined()
  })

  test("strict schema rejects unknown fields, messages, and out-of-range attempts", () => {
    const valid = newRetryTrace(SESSION, 1_000)
    expect(parseRetryTrace(valid)).toBeDefined()
    expect(parseRetryTrace({ ...valid, message: "raw provider error" })).toBeUndefined()
    expect(parseRetryTrace({ ...valid, lastClass: "made-up" })).toBeUndefined()
    expect(parseRetryTrace({ ...valid, lastAction: "retry-forever" })).toBeUndefined()
    expect(parseRetryTrace({ ...valid, attempts: -1 })).toBeUndefined()
    expect(parseRetryTrace({ ...valid, lastAttempt: RETRY_TRACE_MAX_ATTEMPT + 1 })).toBeUndefined()
    expect(retryTraceSchema.safeParse(null).success).toBe(false)
  })

  test("vocabulary stays aligned with the policy module", () => {
    expect([...RETRY_CLASSES]).toEqual(["rate-limited", "provider-internal", "transport", "unknown", "terminal"])
    expect([...RETRY_ACTIONS]).toEqual(["host-terminal", "keep", "cap-delay", "veto-class", "veto-burst"])
  })
})
