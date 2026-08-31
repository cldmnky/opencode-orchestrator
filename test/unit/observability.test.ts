import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { OBSERVABILITY_TOOL_PERMISSION } from "../../src/core/permissions.js"
import { configuredBudgetLimits, evaluateBudget, type BudgetEvaluation } from "../../src/opencode-v2/observability/budget.js"
import {
  TRACE_MAX_PENDING_CALLS,
  TRACE_MAX_TOOL_ENTRIES,
  applyToolCallEnd,
  applyToolCallOutcome,
  applyToolCallStart,
  newTraceSummary,
  parseTraceSummary,
  recordStep,
  recordUsageSnapshot,
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
import { REVIEW_V1_CHECK_KEYS } from "../../src/opencode-v2/observability/review.js"
import { addObservabilityTools, reviewTransitionInput, type ObservabilityToolsDeps } from "../../src/opencode-v2/observability/tools.js"

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
  test("defaults preserve previous behavior: trace off, budget advisory, review prompt with 2 rounds", () => {
    const options = parseOptions({})
    expect(options.trace).toEqual({ mode: "off" })
    expect(options.budget).toEqual({ mode: "advisory" })
    for (const name of ["max_steps", "max_tokens", "max_cost_usd", "max_wall_clock_ms", "max_retries"] as const) {
      expect(options.budget[name]).toBeUndefined()
    }
    expect(options.review).toEqual({ mode: "prompt", max_rounds: 2 })
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
  })

  test("a single enabled mode is enough to activate the runtime", () => {
    expect(shouldStartObservability(parseOptions({ trace: { mode: "memory" } }))).toBe(true)
    expect(shouldStartObservability(parseOptions({ budget: { mode: "stop-between-steps" } }))).toBe(true)
    expect(shouldStartObservability(parseOptions({ review: { mode: "bounded" } }))).toBe(true)
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

  test("bounded review adds review_get and review_transition", () => {
    // Even with a runtime attached, bounded review alone does not register
    // observability_get (it requires trace or stop-between-steps budget).
    const tools = collect(parseOptions({ review: { mode: "bounded" } }), fakeRuntime() as ObservabilityToolsDeps["runtime"])
    expect([...tools.keys()].sort()).toEqual(["review_get", "review_transition"])
    for (const tool of tools.values()) {
      expect(tool.options?.permission).toBe(OBSERVABILITY_TOOL_PERMISSION)
    }
  })

  test("all modes together add all three tools and the transition enforces the review role", async () => {
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
    expect([...tools.keys()].sort()).toEqual(["observability_get", "review_get", "review_transition"])

    const transition = tools.get("review_transition")!
    // Wrong review role is rejected before any transition runs.
    const wrongRole = await transition.execute(
      {
        sessionID: "s1",
        signal: {
          action: "start",
          taskId: "task-1",
          runId: "run-1",
          maker: "implementer",
          checker: "not-the-reviewer",
          admissionState: "review-pending",
        },
      },
      { sessionID: "s1", agent: "orchestrator" },
    )
    expect(wrongRole.content).toContain("checker-role-mismatch")
    expect(storage.values.has("review/v1/project/s1")).toBe(false)

    // A valid start persists the bounded record.
    const started = await transition.execute(
      {
        sessionID: "s1",
        signal: {
          action: "start",
          taskId: "task-1",
          runId: "run-1",
          maker: "implementer",
          checker: "reviewer",
          admissionState: "review-pending",
        },
      },
      { sessionID: "s1", agent: "orchestrator" },
    )
    expect(started.content).toContain('"accepted":true')
    expect(started.content).toContain("manual-start")
    expect(JSON.parse(started.content).record.state).toBe("pending")
    expect(storage.values.has("review/v1/project/s1")).toBe(true)

    // Non-orchestrator agents are rejected regardless of visibility rules.
    await expect(
      transition.execute(
        { sessionID: "s1", signal: { action: "block" } },
        { sessionID: "s1", agent: "implementer" },
      ),
    ).rejects.toThrow("only to the orchestrator")
  })

  test("review_transition is scoped to the current record and persists fixed decisions", async () => {
    const options = parseOptions({ review: { mode: "bounded", max_rounds: 2 } })
    const storage = memStorage()
    const tools = new Map<string, ToolEntry>()
    addObservabilityTools(
      { add: (tool) => tools.set(tool.name, tool as unknown as ToolEntry) },
      {
        options,
        storage,
        location,
      },
    )
    const transition = tools.get("review_transition")!
    const agent = { sessionID: "s1", agent: "orchestrator" }

    const start = await transition.execute(
      {
        sessionID: "s1",
        signal: { action: "start", taskId: "t1", runId: "r1", maker: "implementer", checker: "reviewer", admissionState: "review-pending" },
      },
      agent,
    )
    expect(JSON.parse(start.content).accepted).toBe(true)

    // A pending different task cannot be overwritten.
    const overwrite = await transition.execute(
      {
        sessionID: "s1",
        signal: { action: "start", taskId: "t2", runId: "r2", maker: "implementer", checker: "reviewer", admissionState: "review-pending" },
      },
      agent,
    )
    expect(JSON.parse(overwrite.content)).toMatchObject({ accepted: false, reason: "pending-task-locked" })
  })

  test("model-facing review_transition schema matches the runtime per-action strictness and fixed checks", () => {
    const signalSchema = reviewTransitionInput.properties.signal as unknown as {
      oneOf: Array<{
        properties: Record<string, any>
        required: string[]
      }>
    }
    expect(signalSchema.oneOf).toHaveLength(4)
    const byAction = new Map(
      signalSchema.oneOf.map((variant) => [(variant.properties.action as { enum: string[] }).enum[0], variant]),
    )

    // start: exactly the six fields, all required, nothing else.
    const startVariant = byAction.get("start")!
    expect(Object.keys(startVariant.properties).sort()).toEqual([
      "action",
      "admissionState",
      "checker",
      "maker",
      "runId",
      "taskId",
    ])
    expect(startVariant.required).toEqual(["action", "taskId", "runId", "maker", "checker", "admissionState"])

    // approve: exactly the fixed checks, all required, nothing else.
    const approveVariant = byAction.get("approve")!
    expect(Object.keys(approveVariant.properties)).toEqual(["action", "checks"])
    expect(approveVariant.required).toEqual(["action", "checks"])
    const checks = approveVariant.properties.checks as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(checks.properties).sort()).toEqual([...REVIEW_V1_CHECK_KEYS].sort())
    expect(checks.required).toEqual([...REVIEW_V1_CHECK_KEYS])

    // request-changes / block: exactly the action.
    for (const action of ["request-changes", "block"]) {
      const variant = byAction.get(action)!
      expect(Object.keys(variant.properties)).toEqual(["action"])
      expect(variant.required).toEqual(["action"])
    }
  })

  test("review_transition runtime rejects every per-action extra field and approve without all fixed checks", async () => {
    const options = parseOptions({ review: { mode: "bounded", max_rounds: 2 } })
    const storage = memStorage()
    const tools = new Map<string, ToolEntry>()
    addObservabilityTools(
      { add: (tool) => tools.set(tool.name, tool as unknown as ToolEntry) },
      { options, storage, location },
    )
    const transition = tools.get("review_transition")!
    const agent = { sessionID: "s1", agent: "orchestrator" }
    const startValid = {
      action: "start",
      taskId: "t1",
      runId: "r1",
      maker: "implementer",
      checker: "reviewer",
      admissionState: "review-pending",
    }

    const invalid: Array<Record<string, unknown>> = [
      { signal: { ...startValid, memo: "extra" } },
      { signal: { ...startValid, checks: { diff: true, scope: true, verification: true } } },
      { signal: { action: "start", taskId: "t1", runId: "r1", maker: "implementer", checker: "reviewer" } }, // missing admissionState
      { signal: { action: "approve" } },
      { signal: { action: "approve", checks: { diff: true, scope: true } } }, // missing verification
      { signal: { action: "approve", checks: { diff: true, scope: true, verification: true, extra: true } } },
      { signal: { action: "approve", checks: { ratio: true, scope: true, verification: true } } },
      { signal: { action: "request-changes", note: "why" } },
      { signal: { action: "block", note: "why" } },
    ]
    for (const input of invalid) {
      const result = await transition.execute({ sessionID: "s1", ...input }, agent)
      expect(JSON.parse(result.content), JSON.stringify(input)).toMatchObject({ accepted: false, reason: "invalid-signal" })
      expect(storage.values.has("review/v1/project/s1")).toBe(false)
    }

    // Valid approve with all fixed checks passes once a record exists.
    const started = await transition.execute({ sessionID: "s1", signal: startValid }, agent)
    expect(JSON.parse(started.content).accepted).toBe(true)
    const approved = await transition.execute(
      { sessionID: "s1", signal: { action: "approve", checks: { diff: true, scope: true, verification: true } } },
      agent,
    )
    expect(JSON.parse(approved.content)).toMatchObject({ accepted: true, reason: "approval-complete" })
    expect(JSON.parse(approved.content).record.state).toBe("approved")
  })
})

function fakeRuntime(): Pick<ObservabilityRuntime, "summary" | "evaluation"> {
  return {
    summary: async () => newTraceSummary("s1", "memory", 1000),
    evaluation: async () => ({ version: 1, mode: "advisory", verdict: "unknown", limits: [] }),
  }
}