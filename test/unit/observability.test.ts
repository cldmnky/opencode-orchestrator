import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { OBSERVABILITY_TOOL_PERMISSION } from "../../src/core/permissions.js"
import { configuredBudgetLimits, evaluateBudget, type BudgetEvaluation } from "../../src/opencode-v2/observability/budget.js"
import {
  GENERATION_HINT_MAX_HINT_CHARS,
  GENERATION_HINT_MAX_PROMPT_CHARS,
  GENERATION_HINT_RECORD_VERSION,
  TRACE_MAX_PENDING_CALLS,
  TRACE_MAX_TOOL_ENTRIES,
  applyToolCallEnd,
  applyToolCallOutcome,
  applyToolCallStart,
  generationHintSchema,
  newGenerationHint,
  newRetryTrace,
  newTraceSummary,
  parseGenerationHint,
  parseRetryTrace,
  parseTraceSummary,
  recordRetry,
  recordRetryAction,
  recordStep,
  recordUsageSnapshot,
  retryTraceStorageKey,
  traceStorageKey,
  traceSummarySchema,
  usageTokensTotal,
} from "../../src/opencode-v2/observability/trace.js"
import {
  createDispatchGate,
  shouldStartObservability,
  startObservability,
  type ObservabilityDeps,
  type ObservabilityRuntime,
} from "../../src/opencode-v2/observability/runtime.js"
import { addObservabilityTools, reviewStartInput, reviewSubmitInput, type ObservabilityToolsDeps } from "../../src/opencode-v2/observability/tools.js"

const location = { directory: "/workspace", project: { id: "project" } }

function memStorage(values = new Map<string, unknown>()): StorageLike & { values: Map<string, unknown> } {
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  }
}

type StorageLike = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

function createStream(): AsyncIterable<unknown> & { push(event: unknown): void; closed: boolean } {
  const queue: unknown[] = []
  const waiters: Array<(result: IteratorResult<unknown>) => void> = []
  let closed = false
  const iterator = {
    next: () => {
      if (closed) return Promise.resolve({ done: true as const, value: undefined })
      const event = queue.shift()
      if (event !== undefined) return Promise.resolve({ done: false as const, value: event })
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
  }
  return {
    push(event) {
      const waiter = waiters.shift()
      if (waiter) waiter({ done: false, value: event })
      else queue.push(event)
    },
    get closed() {
      return closed
    },
    [Symbol.asyncIterator]() {
      return iterator
    },
  }
}

function hookFixture(stream: AsyncIterable<unknown>) {
  const before: Array<(event: unknown) => Promise<void> | void> = []
  const after: Array<(event: unknown) => Promise<void> | void> = []
  const disposed: string[] = []
  const deps: ObservabilityDeps = {
    options: parseOptions({ trace: { mode: "snapshot" } }),
    event: { subscribe: () => stream },
    tool: {
      hook: async (name, callback) => {
        if (name === "execute.before") before.push(callback)
        else after.push(callback)
        return { dispose: async () => void disposed.push("hook") }
      },
    },
    storage: memStorage(),
    location,
  }
  return { deps, before, after, disposed }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

describe("S3/V1 strict configuration", () => {
  test("defaults preserve previous behavior: trace off, budget advisory, review prompt with 2 rounds, retry off", () => {
    const options = parseOptions({})
    expect(options.trace).toEqual({ mode: "off" })
    expect(options.budget).toEqual({ mode: "advisory" })
    for (const name of ["max_steps", "max_tokens", "max_cost_usd", "max_wall_clock_ms", "max_retries"] as const) {
      expect(options.budget[name]).toBeUndefined()
    }
    expect(options.review).toEqual({ mode: "prompt", max_rounds: 2 })
    // N5 defaults preserve previous behavior exactly: off with the documented
    // bounded cap, and no S3 runtime activation.
    expect(options.retry).toEqual({ mode: "off", max_delay_ms: 30_000 })
    expect(shouldStartObservability(options)).toBe(false)
  })

  test("opt-in blocks and partial fills are strict and preserve fields", () => {
    const options = parseOptions({
      trace: { mode: "memory" },
      budget: { mode: "stop-between-steps", max_steps: 5, max_cost_usd: null },
      review: { mode: "bounded", max_rounds: 4 },
    })
    expect(options.trace).toEqual({ mode: "memory" })
    expect(options.budget.mode).toBe("stop-between-steps")
    expect(options.budget.max_steps).toBe(5)
    expect(options.budget.max_cost_usd).toBe(null)
    expect(options.review).toEqual({ mode: "bounded", max_rounds: 4 })
    expect(shouldStartObservability(options)).toBe(true)
  })

  test("unknown keys and invalid mode/limit values are rejected", () => {
    expect(() => parseOptions({ trace: { mode: "warn" } })).toThrow()
    expect(() => parseOptions({ trace: { extra: true } })).toThrow()
    expect(() => parseOptions({ budget: { mode: "block" } })).toThrow()
    expect(() => parseOptions({ budget: { extra: 1 } })).toThrow()
    expect(() => parseOptions({ budget: { max_tokens: -1 } })).toThrow()
    expect(() => parseOptions({ budget: { max_tokens: Infinity } })).toThrow()
    expect(() => parseOptions({ budget: { max_steps: 1.5 } })).toThrow()
    expect(() => parseOptions({ review: { mode: "auto" } })).toThrow()
    expect(() => parseOptions({ review: { extra: 1 } })).toThrow()
    expect(() => parseOptions({ review: { max_rounds: 0 } })).toThrow()
    expect(() => parseOptions({ review: { max_rounds: 9 } })).toThrow()
    // N5 retry block: strict both ways.
    expect(() => parseOptions({ retry: { mode: "auto" } })).toThrow()
    expect(() => parseOptions({ retry: { extra: true } })).toThrow()
    expect(() => parseOptions({ retry: { max_delay_ms: -1 } })).toThrow()
    expect(() => parseOptions({ retry: { max_delay_ms: 1.5 } })).toThrow()
    expect(() => parseOptions({ retry: { max_delay_ms: 900_001 } })).toThrow()
    expect(() => parseOptions({ retry: { max_delay_ms: Number.POSITIVE_INFINITY } })).toThrow()
    expect(parseOptions({ retry: { mode: "bounded", max_delay_ms: 0 } }).retry).toEqual({
      mode: "bounded",
      max_delay_ms: 0,
    })
  })

  test("a single enabled mode is enough to activate the runtime", () => {
    expect(shouldStartObservability(parseOptions({ trace: { mode: "memory" } }))).toBe(true)
    expect(shouldStartObservability(parseOptions({ budget: { mode: "stop-between-steps" } }))).toBe(true)
    expect(shouldStartObservability(parseOptions({ review: { mode: "bounded" } }))).toBe(true)
  })

  test("retry mode never activates the S3 observability runtime by itself", () => {
    // N5 owns its hook and its bounded retry trace record; the S3 runtime,
    // its tool registration, and its event counting are untouched by the
    // retry configuration and stay off unless their own modes are enabled.
    const options = parseOptions({ retry: { mode: "bounded" } })
    expect(shouldStartObservability(options)).toBe(false)
    const withTrace = parseOptions({ retry: { mode: "bounded" }, trace: { mode: "memory" } })
    expect(shouldStartObservability(withTrace)).toBe(true)
  })
})

describe("deterministic budget evaluation", () => {
  const limits = { max_steps: 5, max_tokens: 100, max_cost_usd: 2, max_wall_clock_ms: 1000, max_retries: 3 }

  test("within at exact boundaries, exceeded just past them", () => {
    const within = evaluateBudget({
      observed: { steps: 5, tokens: 100, costUsd: 2, retries: 3, startedAt: 0, now: 1000 },
      limits,
      mode: "advisory",
    })
    expect(within.verdict).toBe("within")
    const exceeded = evaluateBudget({
      observed: { steps: 6, tokens: 101, costUsd: 2.01, retries: 4, startedAt: 0, now: 1001 },
      limits,
      mode: "advisory",
    })
    expect(exceeded.verdict).toBe("exceeded")
    for (const detail of exceeded.limits) expect(detail.status).toBe("exceeded")
  })

  test("missing observations are unknown, never zero, in advisory mode", () => {
    const evaluation = evaluateBudget({ observed: {}, limits, mode: "advisory" })
    expect(evaluation.verdict).toBe("unknown")
    for (const detail of evaluation.limits) {
      expect(detail.status).toBe("unknown")
      expect(detail.reason).toContain("unknown")
    }
  })

  test("stop-between-steps fails closed only for unknown token/cost coverage", () => {
    const withoutUsage = evaluateBudget({ observed: {}, limits, mode: "stop-between-steps" })
    expect(withoutUsage.verdict).toBe("exceeded")
    const tokensDetail = withoutUsage.limits.find((detail) => detail.limit === "max_tokens")
    const costDetail = withoutUsage.limits.find((detail) => detail.limit === "max_cost_usd")
    const stepsDetail = withoutUsage.limits.find((detail) => detail.limit === "max_steps")
    expect(tokensDetail?.status).toBe("exceeded")
    expect(tokensDetail?.reason).toContain("fails closed")
    expect(costDetail?.status).toBe("exceeded")
    // Steps are not token/cost coverage: unknown steps stay unknown.
    expect(stepsDetail?.status).toBe("unknown")

    const withUsage = evaluateBudget({
      observed: { steps: 1, tokens: 10, costUsd: 0.5, retries: 1, startedAt: 0, now: 5 },
      limits,
      mode: "stop-between-steps",
    })
    expect(withUsage.verdict).toBe("within")
  })

  test("advisory mode never yields exceeded for unknown coverage", () => {
    const advisory = evaluateBudget({ observed: {}, limits, mode: "advisory" })
    expect(advisory.verdict === "exceeded").toBe(false)
  })

  test("no configured limits evaluates within with a versioned result", () => {
    const evaluation = evaluateBudget({ observed: {}, limits: {}, mode: "advisory" })
    expect(evaluation).toEqual({ version: 1, mode: "advisory", verdict: "within", limits: [] })
    expect(configuredBudgetLimits({})).toEqual([])
    expect(configuredBudgetLimits(limits)).toEqual([
      "max_steps",
      "max_tokens",
      "max_cost_usd",
      "max_wall_clock_ms",
      "max_retries",
    ])
  })
})

describe("bounded metadata-only trace summaries", () => {
  test("tool calls aggregate counts, failures, and durations without any call IDs", () => {
    let summary = newTraceSummary("s1", "memory", 1000)
    summary = applyToolCallStart(summary, 1001)
    summary = applyToolCallEnd(summary, 1002)
    summary = applyToolCallOutcome(summary, { tool: "bash", failed: false, durationMs: 1 }, 1002)
    expect(summary.pending).toBe(0)
    expect(summary.completedCalls).toBe(1)
    expect(summary.tools).toEqual([{ name: "bash", count: 1, failed: 0, durationMs: 1 }])
    expect(JSON.stringify(summary)).not.toContain("call-")
  })

  test("failed calls count separately and pending never goes negative", () => {
    let summary = newTraceSummary("s1", "memory", 1000)
    summary = applyToolCallStart(summary, 1001)
    summary = applyToolCallEnd(summary, 1002)
    summary = applyToolCallOutcome(summary, { tool: "edit", failed: true }, 1002)
    summary = applyToolCallEnd(summary, 1003)
    expect(summary.failedCalls).toBe(1)
    expect(summary.completedCalls).toBe(0)
    expect(summary.pending).toBe(0)
  })

  test("usage snapshots replace instead of accumulating (no double counting)", () => {
    let summary = newTraceSummary("s1", "memory", 1000)
    summary = recordUsageSnapshot(
      summary,
      { costUsd: 1, tokensInput: 100, tokensOutput: 50, tokensReasoning: 10, tokensCacheRead: 5, tokensCacheWrite: 2, observedAt: 1100 },
      1100,
    )
    summary = recordUsageSnapshot(
      summary,
      { costUsd: 2, tokensInput: 300, tokensOutput: 100, tokensReasoning: 20, tokensCacheRead: 9, tokensCacheWrite: 4, observedAt: 1200 },
      1200,
    )
    // The later snapshot REPLACES the earlier one; totals are 300/100/20, never summed.
    expect(summary.usage?.tokensInput).toBe(300)
    expect(summary.usage?.tokensOutput).toBe(100)
    expect(summary.usage?.tokensReasoning).toBe(20)
    expect(summary.usage?.costUsd).toBe(2)
    expect(summary.usage?.observedAt).toBe(1200)
    expect(usageTokensTotal(summary.usage!)).toBe(420)
  })

  test("tool entries are bounded: extra tools fold into an other bucket", () => {
    let summary = newTraceSummary("s1", "memory", 1000)
    for (let index = 0; index < TRACE_MAX_TOOL_ENTRIES + 1; index += 1) {
      summary = applyToolCallOutcome(summary, { tool: `tool-${index}`, failed: false }, 1000 + index)
    }
    expect(summary.tools.length).toBeLessThanOrEqual(TRACE_MAX_TOOL_ENTRIES + 1)
    expect(summary.tools.some((entry) => entry.name === "other")).toBe(true)
  })

  test("steps and retries accumulate on the bounded summary", () => {
    let summary = newTraceSummary("s1", "memory", 1000)
    summary = recordStep(summary, 1001)
    summary = recordStep(summary, 1002)
    expect(summary.steps).toBe(2)
  })

  test("the S3 retry counter stays independent from the bounded retry trace record", () => {
    // S3 `retries` counts host-scheduled retries from `session.retry.scheduled`
    // events; the N5 record counts policy-observed attempts. They are separate
    // records under separate keys and never double count each other.
    let summary = newTraceSummary("s1", "memory", 1000)
    summary = recordRetry(summary, 1001)
    summary = recordRetry(summary, 1002)
    expect(summary.retries).toBe(2)

    const retryTrace = recordRetryAction(
      newRetryTrace("s1", 1000),
      { class: "rate-limited", action: "cap-delay", attempt: 2 },
      1001,
    )
    expect(retryTrace.attempts).toBe(1)
    expect(retryTrace.capped).toBe(1)
    expect(summary.retries).toBe(2)
    expect(retryTraceStorageKey(location, "s1")).toBe("retry-trace/v1/project/s1")
    expect(traceStorageKey(location, "s1")).toBe("trace/v1/project/s1")
    expect(parseRetryTrace(retryTrace)).toBeDefined()
    expect(parseTraceSummary(summary)).toBeDefined()
  })

  test("strict schema rejects raw payload fields and malformed records", () => {
    const parsed = traceSummarySchema.safeParse({
      version: 1,
      sessionID: "s1",
      mode: "snapshot",
      prompt: "the raw prompt must never be persisted",
      toolOutput: "raw transcript",
    })
    expect(parsed.success).toBe(false)
    const valid = newTraceSummary("s1", "snapshot", 1000)
    expect(parseTraceSummary(valid)).toBeDefined()
    expect(parseTraceSummary({ ...valid, extra: true })).toBeUndefined()
  })
})

describe("bounded metadata-only generation-hint records", () => {
  const baseHint = {
    status: "completed" as const,
    level: "worker" as const,
    verdict: "pass" as const,
    checkCount: 7,
    model: "probe/deterministic",
    outputChars: 12,
    outputRedacted: false,
    outputTruncated: false,
    durationMs: 5,
    capturedAt: 1000,
  }

  test("builds a versioned record with a fixed bounded key set", () => {
    const record = newGenerationHint({ ...baseHint, promptChars: 300, hint: "keep the receipt scoped" })
    expect(record.version).toBe(GENERATION_HINT_RECORD_VERSION)
    expect(record.kind).toBe("handoff-validate")
    expect(Object.keys(record).sort()).toEqual(
      [
        "capturedAt",
        "checkCount",
        "durationMs",
        "hint",
        "kind",
        "level",
        "model",
        "outputChars",
        "outputRedacted",
        "outputTruncated",
        "promptChars",
        "status",
        "verdict",
        "version",
      ].sort(),
    )
    expect(parseGenerationHint(record)).toEqual(record)
    // No prompt, transcript, tool payload, or error field exists at all.
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain("prompt\"")
    expect(serialized).not.toContain("transcript")
    expect(serialized).not.toContain("error")
  })

  test("clamps recorded sizes instead of fabricating unbounded values", () => {
    const record = newGenerationHint({ ...baseHint, promptChars: GENERATION_HINT_MAX_PROMPT_CHARS * 5, outputChars: Number.NaN })
    expect(record.promptChars).toBe(GENERATION_HINT_MAX_PROMPT_CHARS)
    expect(record.outputChars).toBe(0)
  })

  test("strict schema rejects malformed, unknown-shaped, and over-long records", () => {
    const valid = newGenerationHint({ ...baseHint, promptChars: 10 })
    expect(generationHintSchema.safeParse(valid).success).toBe(true)
    for (const malformed of [
      undefined,
      null,
      "hint",
      [],
      { ...valid, extra: true },
      { ...valid, status: "running" },
      { ...valid, level: "parent" },
      { ...valid, verdict: "unknown" },
      { ...valid, reason: "raw provider error text" },
      { ...valid, hint: "x".repeat(GENERATION_HINT_MAX_HINT_CHARS + 1) },
      { ...valid, hint: "" },
      { ...valid, model: "m".repeat(201) },
      { ...valid, durationMs: -1 },
      { ...valid, capturedAt: "now" },
    ]) {
      expect(parseGenerationHint(malformed)).toBeUndefined()
    }
    // A skip record may omit the hint but must carry a known reason.
    const skipped = newGenerationHint({ ...baseHint, status: "skipped", reason: "verdict-not-pass", promptChars: 0, outputChars: 0 })
    expect(parseGenerationHint(skipped)).toEqual(skipped)
    expect(parseGenerationHint({ ...skipped, reason: undefined })).toBeDefined()
  })
})

describe("observability runtime hooks and events", () => {
  test("execute.before/after metadata is bounded, payload-free, and id-free on disk", async () => {
    const stream = createStream()
    const fixture = hookFixture(stream)
    fixture.deps.options = parseOptions({ trace: { mode: "snapshot" } })
    const storage = memStorage()
    fixture.deps.storage = storage
    const runtime = await startObservability(fixture.deps)

    await fixture.before[0]({
      id: "call-1",
      sessionID: "s1",
      agent: "implementer",
      tool: "bash",
      input: { command: "echo SECRET_VALUE=abc123" },
    })
    await fixture.after[0]({
      id: "call-1",
      sessionID: "s1",
      agent: "implementer",
      tool: "bash",
      status: "error",
      input: { command: "echo SECRET_VALUE=abc123" },
      error: { message: "raw failure transcript 9f8e7d6c5b4a" },
    })
    await tick()

    const record = storage.values.get(traceStorageKey(location, "s1"))
    expect(record).toBeDefined()
    const serialized = JSON.stringify(record)
    expect(serialized).toContain("failedCalls")
    // Metadata only: no payloads, no transcripts, no call IDs.
    expect(serialized).not.toContain("SECRET_VALUE")
    expect(serialized).not.toContain("abc123")
    expect(serialized).not.toContain("9f8e7d6c5b4a")
    expect(serialized).not.toContain("call-1")
    expect(serialized).not.toContain("failure transcript")
    expect(parseTraceSummary(record)).toBeDefined()

    await runtime.dispose()
  })

  test("usage aggregate events are snapshots (replace), never additive", async () => {
    const stream = createStream()
    const fixture = hookFixture(stream)
    const storage = memStorage()
    fixture.deps.storage = storage
    fixture.deps.options = parseOptions({ trace: { mode: "snapshot" }, budget: { mode: "stop-between-steps", max_tokens: 1000 } })
    const runtime = await startObservability(fixture.deps)

    stream.push({
      id: "usage-1",
      type: "session.usage.updated",
      data: { sessionID: "s1", cost: 1, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } } },
    })
    stream.push({
      id: "usage-2",
      type: "session.usage.updated",
      data: { sessionID: "s1", cost: 2, tokens: { input: 300, output: 100, reasoning: 20, cache: { read: 9, write: 4 } } },
    })
    await tick()

    const summary = await runtime.summary("s1")
    expect(summary?.usage?.tokensInput).toBe(300)
    expect(summary?.usage?.costUsd).toBe(2)
    const evaluation = await runtime.evaluation("s1")
    expect(evaluation.verdict).toBe("within") // 300+100+20 = 420 <= 1000, not 1650

    await runtime.dispose()
  })

  test("missing event coverage is unknown for budget checks, never zero", async () => {
    const stream = createStream()
    const fixture = hookFixture(stream)
    fixture.deps.options = parseOptions({ trace: { mode: "memory" }, budget: { mode: "stop-between-steps", max_tokens: 100 } })
    const runtime = await startObservability(fixture.deps)

    // No usage event was ever delivered.
    const summary = await runtime.summary("s1")
    expect(summary?.usage).toBeUndefined()
    const evaluation = await runtime.evaluation("s1")
    expect(evaluation.verdict).toBe("exceeded") // unknown token coverage fails closed

    await runtime.dispose()
  })

  test("session.deleted cleans memory and the durable snapshot record", async () => {
    const stream = createStream()
    const fixture = hookFixture(stream)
    const storage = memStorage()
    fixture.deps.storage = storage
    fixture.deps.options = parseOptions({ trace: { mode: "snapshot" } })
    const runtime = await startObservability(fixture.deps)

    await fixture.before[0]({ id: "call-x", sessionID: "s1", tool: "bash", input: { command: "true" } })
    await fixture.after[0]({ id: "call-x", sessionID: "s1", tool: "bash", status: "completed", input: { command: "true" } })
    await tick()
    expect(storage.values.has(traceStorageKey(location, "s1"))).toBe(true)

    stream.push({ id: "deleted-1", type: "session.deleted", data: { sessionID: "s1" } })
    await tick()

    expect(storage.values.has(traceStorageKey(location, "s1"))).toBe(false)
    expect(await runtime.summary("s1")).toBeUndefined()

    await runtime.dispose()
  })

  test("cleanup aborts the event stream and disposes hook registrations", async () => {
    const stream = createStream()
    const fixture = hookFixture(stream)
    const runtime = await startObservability(fixture.deps)
    expect(stream.closed).toBe(false)
    await runtime.dispose()
    expect(stream.closed).toBe(true)
    expect(fixture.disposed).toHaveLength(2)
  })

  test("malformed hook and event input cannot break orchestration", async () => {
    const stream = createStream()
    const fixture = hookFixture(stream)
    fixture.deps.options = parseOptions({ trace: { mode: "memory" }, budget: { mode: "stop-between-steps", max_steps: 10 } })
    const runtime = await startObservability(fixture.deps)

    const summary = await runtime.summary("s1")
    expect(summary).toBeUndefined()
    await runtime.dispose()
  })

  test("pending-cap eviction counts droppedUnmatched on the evicted call's session", async () => {
    const stream = createStream()
    const fixture = hookFixture(stream)
    fixture.deps.options = parseOptions({ trace: { mode: "memory" } })
    const runtime = await startObservability(fixture.deps)

    // Fill the global pending map with starts from session "s-a".
    for (let index = 0; index < TRACE_MAX_PENDING_CALLS; index += 1) {
      await fixture.before[0]({ id: `a-${index}`, sessionID: "s-a", tool: "bash", input: { command: `run ${index}` } })
    }
    // The next start from a DIFFERENT session evicts the oldest tracked start,
    // which belongs to "s-a". The dropped-unmatched counter must land on the
    // evicted session, never on the session that triggered the eviction.
    await fixture.before[0]({ id: "b-1", sessionID: "s-b", tool: "bash", input: { command: "SECRET_INPUT=xyz" } })
    await tick()

    const summaryA = await runtime.summary("s-a")
    const summaryB = await runtime.summary("s-b")
    expect(summaryA?.droppedUnmatched).toBe(1)
    expect(summaryB?.droppedUnmatched).toBe(0)
    expect(summaryA?.pending).toBe(TRACE_MAX_PENDING_CALLS - 1)
    expect(summaryB?.pending).toBe(1)

    // No call IDs or payload values leak into any summary.
    const serialized = JSON.stringify([summaryA, summaryB])
    expect(serialized).not.toContain("a-0")
    expect(serialized).not.toContain("b-1")
    expect(serialized).not.toContain("SECRET_INPUT")
    expect(serialized).not.toContain("xyz")

    await runtime.dispose()
  })
})

describe("dispatch gate", () => {
  test("bounded review breaker blocks auto dispatch on blocked/tripped and allows command dispatch", async () => {
    const options = parseOptions({ review: { mode: "bounded", max_rounds: 2 } })
    const storage = memStorage()
    const base = {
      version: 1 as const,
      taskId: "task-1",
      runId: "run-1",
      maker: "implementer",
      checker: "reviewer",
      round: 1,
      maxRounds: 2,
      createdAt: 1,
      updatedAt: 1,
    }
    for (const state of ["blocked", "tripped"] as const) {
      const values = new Map<string, unknown>([
        [`review/v1/project/s-${state}`, { ...base, state, requiresHuman: state === "blocked" }],
      ])
      const gate = createDispatchGate({ options, storage: memStorage(values), location, runtime: undefined })
      const blocked = await gate.allowDispatch(`s-${state}`, "auto")
      expect(blocked.allow).toBe(false)
      expect(blocked.reviewBreaker).toContain("review circuit is open")
      expect(blocked.reason).toContain("review circuit is open")
      const command = await gate.allowDispatch(`s-${state}`, "command")
      expect(command.allow).toBe(true)
    }
  })

  test("bounded review pending/approved states do not trip the breaker", async () => {
    const options = parseOptions({ review: { mode: "bounded", max_rounds: 2 } })
    const base = {
      version: 1 as const,
      taskId: "task-1",
      runId: "run-1",
      maker: "implementer",
      checker: "reviewer",
      round: 1,
      maxRounds: 2,
      createdAt: 1,
      updatedAt: 1,
    }
    for (const state of ["pending", "approved", "changes-requested"] as const) {
      const values = new Map<string, unknown>([[`review/v1/project/s-${state}`, { ...base, state, requiresHuman: false }]])
      const gate = createDispatchGate({ options, storage: memStorage(values), location, runtime: undefined })
      const decision = await gate.allowDispatch(`s-${state}`, "auto")
      expect(decision.allow).toBe(true)
    }
  })

  test("prompt-only review mode never applies the breaker even with a stored record", async () => {
    const options = parseOptions({})
    const record = {
      version: 1 as const,
      taskId: "task-1",
      runId: "run-1",
      maker: "implementer",
      checker: "reviewer",
      state: "blocked" as const,
      round: 1,
      maxRounds: 2,
      requiresHuman: true,
      createdAt: 1,
      updatedAt: 1,
    }
    const values = new Map<string, unknown>([["review/v1/project/s1", record]])
    const gate = createDispatchGate({ options, storage: memStorage(values), location, runtime: undefined })
    const decision = await gate.allowDispatch("s1", "auto")
    expect(decision.allow).toBe(true)
  })

  test("stop-between-steps budget blocks auto and command dispatch when exceeded", async () => {
    const options = parseOptions({ budget: { mode: "stop-between-steps", max_steps: 2, max_tokens: 100 } })
    const storage = memStorage()
    const stream = createStream()
    const fixture = hookFixture(stream)
    fixture.deps.storage = storage
    fixture.deps.options = options
    const runtime = await startObservability(fixture.deps)
    const gate = createDispatchGate({ options, storage, location, runtime })

    // Unknown token coverage fails closed in stop-between-steps.
    const early = await gate.allowDispatch("s1", "command")
    expect(early.allow).toBe(false)
    expect(early.reason).toContain("fails closed")

    // After a within-budget usage snapshot and under the step limit: allowed.
    stream.push({
      id: "usage-ok",
      type: "session.usage.updated",
      data: { sessionID: "s1", cost: 0.01, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 0, write: 0 } } },
    })
    stream.push({ id: "step-1", type: "session.step.started", data: { sessionID: "s1" } })
    await tick()
    const within = await gate.allowDispatch("s1", "auto")
    expect(within.allow).toBe(true)

    await runtime.dispose()
  })

  test("advisory budget never blocks even over the configured limits", async () => {
    const options = parseOptions({ budget: { mode: "advisory", max_steps: 1, max_tokens: 1 } })
    const runtime = fakeRuntimeWithUsage() as ObservabilityRuntime
    const gate = createDispatchGate({ options, storage: memStorage(), location, runtime })
    const decision = await gate.allowDispatch("s1", "auto")
    expect(decision.allow).toBe(true)
    expect(decision.evaluation.verdict).toBe("exceeded")
  })
})

function fakeRuntimeWithUsage(): { evaluation(sessionID: string): Promise<BudgetEvaluation> } {
  return {
    evaluation: async () =>
      evaluateBudget({ observed: { steps: 9, tokens: 500, costUsd: 5 }, limits: { max_steps: 1, max_tokens: 1 }, mode: "advisory" }),
  }
}

describe("conditional orchestrator-only tool registration", () => {
  type ToolEntry = {
    name: string
    input?: unknown
    options?: { namespace?: string; permission?: string }
    execute(input: unknown, tool: { sessionID: string; agent: string }): Promise<{ content: string }>
  }

  function collect(options: ReturnType<typeof parseOptions>, runtime?: ObservabilityToolsDeps["runtime"]): Map<string, ToolEntry> {
    const tools = new Map<string, ToolEntry>()
    addObservabilityTools(
      {
        add(tool) {
          tools.set(tool.name, tool as unknown as ToolEntry)
        },
      },
      {
        options,
        storage: memStorage(),
        location,
        runtime,
      },
    )
    return tools
  }

  test("default configuration registers no observability tools", () => {
    const tools = collect(parseOptions({}))
    expect(tools.size).toBe(0)
  })

  test("trace mode adds observability_get under the orchestrator namespace and shared permission", () => {
    const tools = collect(parseOptions({ trace: { mode: "memory" } }), fakeRuntime() as ObservabilityToolsDeps["runtime"])
    expect([...tools.keys()]).toEqual(["observability_get"])
    const tool = tools.get("observability_get")!
    expect(tool.options?.namespace).toBe("orchestrator")
    expect(tool.options?.permission).toBe(OBSERVABILITY_TOOL_PERMISSION)
  })

  test("bounded review adds separate review_get, review_start, and review_submit tools", () => {
    // Even with a runtime attached, bounded review alone does not register
    // observability_get (it requires trace or stop-between-steps budget).
    const tools = collect(parseOptions({ review: { mode: "bounded" } }), fakeRuntime() as ObservabilityToolsDeps["runtime"])
    expect([...tools.keys()].sort()).toEqual(["review_get", "review_start", "review_submit"])
    expect(tools.get("review_get")?.options?.permission).toBe(OBSERVABILITY_TOOL_PERMISSION)
    expect(tools.get("review_start")?.options?.permission).toBe(OBSERVABILITY_TOOL_PERMISSION)
    expect(tools.get("review_submit")?.options?.permission).toBe("orchestrator_review_submit")
  })

  test("all modes together add the trace and split V2 review tools", async () => {
    const options = parseOptions({ trace: { mode: "memory" }, review: { mode: "bounded", max_rounds: 2 } })
    const storage = memStorage()
    const tools = new Map<string, ToolEntry>()
    addObservabilityTools(
      { add: (tool) => tools.set(tool.name, tool as unknown as ToolEntry) },
      {
        options,
        storage,
        location,
        runtime: fakeRuntime() as ObservabilityToolsDeps["runtime"],
      },
    )
    expect([...tools.keys()].sort()).toEqual(["observability_get", "review_get", "review_start", "review_submit"])
    expect(tools.get("review_submit")?.options?.permission).toBe("orchestrator_review_submit")
  })

  test("model-facing V2 start and submit schemas keep identity out of input", () => {
    expect(Object.keys(reviewStartInput.properties).sort()).toEqual(["baseSha", "headSha", "runId", "taskId"])
    expect(reviewStartInput.required).toEqual(["taskId", "runId", "headSha", "baseSha"])
    expect((reviewStartInput.properties.headSha as { pattern?: string }).pattern).toBe("^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
    expect(Object.keys(reviewSubmitInput.properties).sort()).toEqual(["decision", "leadSessionID", "round"])
    expect(reviewSubmitInput.required).toEqual(["leadSessionID", "round", "decision"])
    expect(JSON.stringify(reviewSubmitInput)).not.toContain("reviewerAgentID")
    expect(JSON.stringify(reviewSubmitInput)).not.toContain("reviewerSessionID")
  })

})

function fakeRuntime(): Pick<ObservabilityRuntime, "summary" | "evaluation"> {
  return {
    summary: async () => newTraceSummary("s1", "memory", 1000),
    evaluation: async () => ({ version: 1, mode: "advisory", verdict: "unknown", limits: [] }),
  }
}
