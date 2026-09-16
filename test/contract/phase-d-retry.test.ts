import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"
import { APICallError } from "ai"

/**
 * Phase D (N5) pinned-host contract probe and production wiring measurement
 * (pinned `@opencode/plugin`/`@opencode/sdk` `0.0.0-beta-19507`).
 *
 * The probe boots embedded hosts against a throwaway directory with a
 * deterministic in-process provider. It performs no external network traffic:
 * the host boots with `models.fetch: false`, a process-wide fetch guard
 * rejects every non-loopback URL before a real send, and the ambient
 * `OPENCODE_API_KEY` variable is removed for the lifetime of each host (its
 * value is captured only so it can be restored; it is never passed to the
 * host, logged, or persisted).
 *
 * Measured surface (recorded in `docs/phase-1/n5-retry-compatibility.md`):
 *   - the callback shape is exactly `{ sessionID, agent, model, error,
 *     attempt, decision }`; `model` carries `variant`, `error` is the
 *     classified session error, `attempt` is physical (the first retry is 2),
 *   - a hook override of `{ retry: true, delay: 0 }` is honored (the retry is
 *     scheduled immediately); the built-in schedule is
 *     `max(exponential 2 s, recurs(4))`, so the hook is invoked at most four
 *     times and the fifth attempt is never made,
 *   - malformed overrides (`NaN`, negative) fall back to the host's computed
 *     delay,
 *   - the host calls the hook once even for a terminal classification and
 *     never schedules a retry then,
 *   - the same `session.retry.scheduled` event (identical id) is delivered
 *     more than once to one subscription,
 *   - disposing the hook registration stops callbacks (idempotently),
 *   - with the production plugin default (`retry` unset) the host proposal is
 *     untouched; with `retry.mode: "bounded"` the production hook runs before
 *     the probe hook and its cap/veto/orchestrator filter are observable, and
 *     in `trace.mode: "snapshot"` it writes a bounded metadata-only record
 *     under `retry-trace/v1/...`.
 */

const PROBE_PROVIDER = "phase-d-probe"
const PROBE_MODEL = "deterministic"
const PROBE_PACKAGE = "aisdk:@ai-sdk/openai-compatible"
const ORCHESTRATOR_AGENT = "orchestrator"
const WORKER_AGENT = "build"
const FIXTURE_TEXT = "[phase-d-probe] deterministic fixture output"
const FIXTURE_FAILURE = "[phase-d-probe] deterministic provider failure"
const TEST_TIMEOUT = 20_000
const BUILT_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url))

type Host = Awaited<ReturnType<typeof OpenCode.create>>

type RetryEventSnapshot = {
  keys: string[]
  sessionID: unknown
  agent: unknown
  model: unknown
  error: unknown
  attempt: unknown
  decision: unknown
  /** Delay the probe wrote into the decision, when it applied an override. */
  applied: unknown
}

type ScheduledSnapshot = {
  keys: string[]
  attempt: unknown
  at: unknown
  error: unknown
  observedAt: number
  id?: unknown
  sessionID?: unknown
}

type Probe = {
  plugin: ReturnType<typeof Plugin.define>
  sdkHooks: string[]
  languageHooks: string[]
  retryEvents: RetryEventSnapshot[]
  scheduledEvents: ScheduledSnapshot[]
  scheduledEventIDs: Set<string>
  streamCalls: number
  /** Remaining `doStream` attempts that reject before a call streams text. */
  failuresRemaining: number
  /** Error thrown while `failuresRemaining > 0`. */
  failureError: Error
  /** When set, the probe retry hook rewrites every host-proposed retry delay. */
  overrideDelay: number | undefined
  retryRegistration: { dispose(): Promise<void> } | undefined
  setupCount: number
  started: Promise<void>
  stop: () => void
}

function deterministicLanguageModel(probe: Probe) {
  return {
    specificationVersion: "v3" as const,
    provider: PROBE_PROVIDER,
    modelId: PROBE_MODEL,
    supportedUrls: {},
    async doStream() {
      probe.streamCalls += 1
      if (probe.failuresRemaining > 0) {
        probe.failuresRemaining -= 1
        throw probe.failureError
      }
      const parts = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "phase-d-text" },
        { type: "text-delta", id: "phase-d-text", delta: FIXTURE_TEXT },
        { type: "text-end", id: "phase-d-text" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: {}, outputTokens: {} },
        },
      ]
      const stream = new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part)
          controller.close()
        },
      })
      return { stream }
    },
    async doGenerate(): Promise<never> {
      throw new Error("[phase-d-probe] doGenerate is not part of this probe")
    },
  }
}

function createProbe(): Probe {
  const controller = new AbortController()
  let resolveStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const probe: Probe = {
    plugin: undefined as never,
    sdkHooks: [],
    languageHooks: [],
    retryEvents: [],
    scheduledEvents: [],
    scheduledEventIDs: new Set(),
    streamCalls: 0,
    failuresRemaining: 0,
    failureError: new Error(FIXTURE_FAILURE),
    overrideDelay: undefined,
    retryRegistration: undefined,
    setupCount: 0,
    started,
    stop: () => controller.abort(),
  }

  probe.plugin = Plugin.define({
    id: "phase-d-retry-probe",
    async setup(ctx) {
      probe.setupCount += 1

      const scope = { providerID: PROBE_PROVIDER }
      await ctx.aisdk.hook(
        "sdk",
        (event) => {
          probe.sdkHooks.push(`${event.model.providerID}:${event.package}`)
          event.sdk = { languageModel: () => deterministicLanguageModel(probe) }
        },
        scope,
      )
      await ctx.aisdk.hook(
        "language",
        (event) => {
          probe.languageHooks.push(`${event.model.providerID}:${event.model.id}`)
          event.language = deterministicLanguageModel(probe)
        },
        scope,
      )

      probe.retryRegistration = await ctx.session.hook("retry", (event) => {
        const snapshot: RetryEventSnapshot = {
          keys: Object.keys(event).sort(),
          sessionID: event.sessionID,
          agent: event.agent,
          model: { ...event.model },
          error: { ...event.error },
          attempt: event.attempt,
          decision: { ...event.decision },
          applied: undefined,
        }
        probe.retryEvents.push(snapshot)
        if (probe.overrideDelay !== undefined && event.decision.retry) {
          // Never resurrect a vetoed decision: the override only speeds up a
          // retry the host/policy already allowed.
          snapshot.applied = probe.overrideDelay
          event.decision = { retry: true, delay: probe.overrideDelay }
        }
      })

      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const scoped = event as {
            id?: unknown
            type?: unknown
            data?: { attempt?: unknown; at?: unknown; error?: unknown; sessionID?: unknown }
          }
          if (scoped.type !== "session.retry.scheduled" || !scoped.data) continue
          // The pinned host delivers the SAME scheduled event (identical id)
          // more than once to one subscription; count it once, exactly like
          // the S3 runtime's event dedupe.
          const eventID = typeof scoped.id === "string" ? scoped.id : undefined
          if (eventID !== undefined && probe.scheduledEventIDs.has(eventID)) continue
          if (eventID !== undefined) probe.scheduledEventIDs.add(eventID)
          probe.scheduledEvents.push({
            keys: Object.keys(scoped.data).sort(),
            attempt: scoped.data.attempt,
            at: scoped.data.at,
            error: scoped.data.error,
            observedAt: Date.now(),
            id: scoped.id,
            sessionID: scoped.data.sessionID,
          })
        }
      })().catch(() => {})

      resolveStarted()
      return () => controller.abort()
    },
  })

  return probe
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

function isLoopback(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

type NetworkGuard = {
  calls: Array<{ url: string }>
  externalAttempts: string[]
  restore: () => void
}

function installNetworkGuard(): NetworkGuard {
  const realFetch = globalThis.fetch
  const guard: NetworkGuard = { calls: [], externalAttempts: [], restore: () => {} }
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input)
    guard.calls.push({ url })
    if (!isLoopback(url)) {
      guard.externalAttempts.push(url)
      throw new Error(`[phase-d-probe] blocked external network attempt: ${url}`)
    }
    return realFetch(input as never, init as never)
  }) as typeof fetch
  guard.restore = () => {
    globalThis.fetch = realFetch
  }
  return guard
}

function probeConfig(): string {
  return JSON.stringify({
    providers: {
      [PROBE_PROVIDER]: {
        name: "Phase D Probe",
        models: {
          [PROBE_MODEL]: { name: "Phase D Deterministic Probe", package: PROBE_PACKAGE },
        },
      },
    },
    agents: {
      [ORCHESTRATOR_AGENT]: { mode: "primary", model: `${PROBE_PROVIDER}/${PROBE_MODEL}` },
      [WORKER_AGENT]: { mode: "primary", model: `${PROBE_PROVIDER}/${PROBE_MODEL}` },
    },
  })
}

type WithProbeHostOptions = {
  /** Extra directly-passed plugins, in host order, before the probe. */
  plugins?: unknown[]
}

async function withProbeHost(
  run: (input: { host: Host; probe: Probe; guard: NetworkGuard; directory: string }) => Promise<void>,
  options: WithProbeHostOptions = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-phase-d-"))
  const directory = join(root, "project")
  const probe = createProbe()
  const guard = installNetworkGuard()
  // No live credential may be reachable by the probe host. The ambient value
  // is captured only so it can be restored on cleanup.
  const credential = process.env.OPENCODE_API_KEY
  delete process.env.OPENCODE_API_KEY
  let host: Host | undefined
  try {
    host = await OpenCode.create({
      plugins: [...((options.plugins ?? []) as never[]), probe.plugin],
      models: { fetch: false },
      database: { path: join(root, "database.sqlite") },
      config: { directory, content: probeConfig() },
    })
    await host.plugin.awaitActivation()
    await probe.started
    await run({ host, probe, guard, directory })
  } finally {
    probe.stop()
    try {
      if (host) await host.close()
    } finally {
      guard.restore()
      if (credential === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = credential
      rmSync(root, { recursive: true, force: true })
    }
  }
}

async function createSession(host: Host, directory: string, title: string, agent: string): Promise<string> {
  const session = await host.session.create({ location: { directory }, title, agent })
  // The agent's configured model is not applied to the embedded-host session
  // (measured: the session resolved the ambient default provider), so pin the
  // deterministic probe model explicitly instead of relying on config.
  await host.session.switchModel({ sessionID: session.id, model: { providerID: PROBE_PROVIDER, id: PROBE_MODEL } })
  return session.id
}

async function promptAndWait(host: Host, sessionID: string, text: string): Promise<void> {
  await host.session.prompt({ sessionID, text })
  await host.session.wait({ sessionID })
}

function terminalFailure(): APICallError {
  return new APICallError({
    message: "[phase-d-probe] injected authentication failure",
    url: "https://phase-d-probe.invalid/v1/chat",
    requestBodyValues: {},
    statusCode: 401,
    responseHeaders: {},
    responseBody: JSON.stringify({ error: { code: "authentication_error" } }),
    isRetryable: false,
    data: { error: { code: "authentication_error" } },
  })
}

/** A positively-classified transient failure (429 -> provider.rate-limit). */
function rateLimitedFailure(): APICallError {
  return new APICallError({
    message: "[phase-d-probe] injected rate limit",
    url: "https://phase-d-probe.invalid/v1/chat",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: {},
    responseBody: JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
    isRetryable: true,
    data: { error: { code: "rate_limit_exceeded" } },
  })
}

let cachedBuiltPlugin: unknown

async function loadBuiltPlugin(): Promise<unknown> {
  if (!existsSync(BUILT_ENTRY)) {
    throw new Error(`missing built entry ${BUILT_ENTRY}; run \`bun run build\` before this contract suite`)
  }
  if (cachedBuiltPlugin === undefined) cachedBuiltPlugin = (await import(BUILT_ENTRY)).default
  return cachedBuiltPlugin
}

/**
 * Boots the real built plugin with injected options (the embedded SDK host
 * always hands directly-passed plugins `ctx.options = {}`, verified by the
 * Phase A suite) and captures every storage write and retry-hook registration
 * so the production slice can be measured end-to-end.
 */
function wrapBuiltPlugin(
  built: unknown,
  options: Record<string, unknown>,
  capture: {
    writes: Array<{ key: string; value: unknown }>
    sessionHooks: string[]
    setups: number
  },
): { id: string; setup(ctx: any): Promise<unknown> } {
  const plugin = built as { id: string; setup(ctx: any): Promise<unknown> }
  return {
    id: plugin.id,
    setup(ctx) {
      capture.setups += 1
      const storage = {
        ...ctx.storage,
        set: async (key: string, value: unknown) => {
          capture.writes.push({ key, value })
          return ctx.storage.set(key, value)
        },
      }
      return plugin.setup({
        ...ctx,
        options: { ...ctx.options, ...options },
        storage,
        session: {
          ...ctx.session,
          hook: async (name: string, callback: (event: any) => Promise<void> | void) => {
            capture.sessionHooks.push(name)
            return ctx.session.hook(name, callback)
          },
        },
      })
    },
  }
}

describe("phase D retry-hook contract (pinned beta-19507)", () => {
  test("delivers the documented callback shape with physical attempt numbering", async () => {
    await withProbeHost(async ({ host, probe, directory, guard }) => {
      const sessionID = await createSession(host, directory, "phase-d shape", ORCHESTRATOR_AGENT)
      probe.failuresRemaining = 1
      probe.overrideDelay = 0

      await promptAndWait(host, sessionID, "phase-d prompt")

      expect(probe.retryEvents.length).toBeGreaterThanOrEqual(1)
      // The embedded host invokes a directly-passed plugin's setup more than
      // once; the probe records one callback per host decision.
      expect(probe.setupCount).toBeGreaterThanOrEqual(1)
      const first = probe.retryEvents[0]
      expect(first.keys).toEqual(["agent", "attempt", "decision", "error", "model", "sessionID"])
      expect(first.sessionID).toBe(sessionID)
      expect(first.agent).toBe(ORCHESTRATOR_AGENT)
      expect(first.model).toEqual({ providerID: PROBE_PROVIDER, id: PROBE_MODEL, variant: "default" })
      expect(first.attempt).toBe(2)
      expect(first.error).toEqual({ type: "provider.unknown", message: FIXTURE_FAILURE })
      expect(first.decision).toEqual({ retry: true, delay: expect.any(Number) })

      // The override delay 0 was honored: the second attempt ran immediately.
      expect(probe.streamCalls).toBe(2)
      expect(guard.externalAttempts).toEqual([])
    })
  }, TEST_TIMEOUT)

  test("honors an overridden delay and schedules the retry immediately", async () => {
    await withProbeHost(async ({ host, probe, directory }) => {
      const sessionID = await createSession(host, directory, "phase-d delay override", ORCHESTRATOR_AGENT)
      probe.failuresRemaining = 1
      probe.overrideDelay = 0

      await promptAndWait(host, sessionID, "phase-d prompt")

      expect(probe.scheduledEvents).toHaveLength(1)
      const scheduled = probe.scheduledEvents[0]
      expect(scheduled.keys).toEqual(["assistantMessageID", "at", "attempt", "error", "sessionID"])
      expect(scheduled.attempt).toBe(2)
      expect(scheduled.error).toEqual({ type: "provider.unknown", message: FIXTURE_FAILURE })
      // The 0 ms override is honored: the scheduled retry time is essentially
      // the observation time instead of the host's ~2 s exponential delay.
      expect((scheduled.at as number) - scheduled.observedAt).toBeLessThan(250)
      expect(probe.streamCalls).toBe(2)
    })
  }, TEST_TIMEOUT)

  test("falls back to the computed delay for malformed overrides", async () => {
    await withProbeHost(async ({ host, probe, directory }) => {
      for (const invalid of [NaN, -1]) {
        const sessionID = await createSession(host, directory, `phase-d invalid ${String(invalid)}`, ORCHESTRATOR_AGENT)
        const eventsBefore = probe.retryEvents.length
        const scheduledBefore = probe.scheduledEvents.length
        probe.failuresRemaining = 1
        probe.overrideDelay = invalid

        await promptAndWait(host, sessionID, "phase-d prompt")

        // The hook proposed the malformed delay; the host normalized it back
        // to its computed exponential delay (base 2 s, jittered).
        expect(probe.retryEvents).toHaveLength(eventsBefore + 1)
        const observed = probe.retryEvents[eventsBefore]
        expect(observed.decision).toEqual({ retry: true, delay: expect.any(Number) })
        expect(Object.is(observed.applied, invalid)).toBe(true)
        expect(probe.scheduledEvents).toHaveLength(scheduledBefore + 1)
        const scheduled = probe.scheduledEvents[scheduledBefore]
        const delay = (scheduled.at as number) - scheduled.observedAt
        expect(delay).toBeGreaterThanOrEqual(1_400)
        expect(delay).toBeLessThan(3_500)
      }
    })
  }, TEST_TIMEOUT)

  test("never retries a terminal classification and calls the hook exactly once", async () => {
    await withProbeHost(async ({ host, probe, directory }) => {
      const sessionID = await createSession(host, directory, "phase-d terminal", ORCHESTRATOR_AGENT)
      probe.failuresRemaining = 1
      probe.failureError = terminalFailure()

      await promptAndWait(host, sessionID, "phase-d prompt")

      expect(probe.retryEvents).toHaveLength(1)
      const terminal = probe.retryEvents[0]
      expect(terminal.error).toEqual({
        type: "provider.auth",
        message: "[phase-d-probe] injected authentication failure",
        status: 401,
      })
      expect(terminal.attempt).toBe(2)
      expect(terminal.decision).toEqual({ retry: false })
      expect(probe.scheduledEvents).toEqual([])
      expect(probe.streamCalls).toBe(1)
    })
  }, TEST_TIMEOUT)

  test("bounds attempts at the built-in maximum even when the hook keeps retrying", async () => {
    await withProbeHost(async ({ host, probe, directory }) => {
      const sessionID = await createSession(host, directory, "phase-d ceiling", ORCHESTRATOR_AGENT)
      probe.failuresRemaining = Number.POSITIVE_INFINITY
      probe.overrideDelay = 0

      await promptAndWait(host, sessionID, "phase-d prompt")

      // The built-in schedule is `max(exponential, recurs(4))`: four physical
      // retries (attempts 2..5), then the request fails with no further hook.
      expect(probe.retryEvents.map((event) => event.attempt)).toEqual([2, 3, 4, 5])
      expect(probe.scheduledEvents.map((event) => event.attempt)).toEqual([2, 3, 4, 5])
      expect(probe.streamCalls).toBe(5)
    })
  }, TEST_TIMEOUT)

  test("disposing the hook registration stops callbacks, idempotently", async () => {
    await withProbeHost(async ({ host, probe, directory }) => {
      const sessionID = await createSession(host, directory, "phase-d cleanup", ORCHESTRATOR_AGENT)

      // Live hook: a terminal classification still produces exactly one event.
      probe.failuresRemaining = 1
      probe.failureError = terminalFailure()
      await promptAndWait(host, sessionID, "phase-d prompt before dispose")
      expect(probe.retryEvents).toHaveLength(1)

      await probe.retryRegistration?.dispose()
      await probe.retryRegistration?.dispose()

      probe.failuresRemaining = 1
      await promptAndWait(host, sessionID, "phase-d prompt after dispose")
      // No new callback and no scheduled retry: the disposed hook is gone.
      expect(probe.retryEvents).toHaveLength(1)
      expect(probe.scheduledEvents).toEqual([])
      expect(probe.streamCalls).toBe(2)
    })
  }, TEST_TIMEOUT)

  test("rejects external network attempts and allows none during retries", async () => {
    // Guard liveness: an external URL must be recorded and rejected before a
    // real send, so a passing "no external traffic" assertion cannot be vacuous.
    const standalone = installNetworkGuard()
    try {
      const blocked = await fetch("https://phase-d-probe.invalid/retry").then(
        () => {
          throw new Error("expected the guarded fetch to reject")
        },
        (error: unknown) => error as Error,
      )
      expect(String(blocked.message)).toContain("blocked external network attempt")
      expect(standalone.externalAttempts).toEqual(["https://phase-d-probe.invalid/retry"])
    } finally {
      standalone.restore()
    }

    await withProbeHost(async ({ host, probe, guard, directory }) => {
      // The ambient credential variable was removed for the host's lifetime:
      // the deterministic provider needs no credential and none is reachable.
      expect("OPENCODE_API_KEY" in process.env).toBe(false)
      const sessionID = await createSession(host, directory, "phase-d network", ORCHESTRATOR_AGENT)
      probe.failuresRemaining = 1
      probe.overrideDelay = 0
      await promptAndWait(host, sessionID, "phase-d prompt")
      expect(probe.streamCalls).toBe(2)
      // The host's own startup may probe loopback provider ports, but no
      // non-loopback request may be attempted anywhere in the probe lifetime.
      expect(guard.calls.every((call) => isLoopback(call.url))).toBe(true)
      expect(guard.externalAttempts).toEqual([])
    })
  }, TEST_TIMEOUT)
})

describe("phase D production wiring (retry.mode bounded vs default off)", () => {
  test("default off leaves the host retry proposal untouched", async () => {
    const capture = { writes: [] as Array<{ key: string; value: unknown }>, sessionHooks: [] as string[], setups: 0 }
    await withProbeHost(
      async ({ host, probe, directory }) => {
        const sessionID = await createSession(host, directory, "phase-d default off", ORCHESTRATOR_AGENT)
        probe.failuresRemaining = 1
        probe.overrideDelay = 0
        await promptAndWait(host, sessionID, "phase-d prompt")

        // The production plugin registered only its context hook (no retry)
        // for every setup invocation, and the probe observed the uncapped host
        // proposal before its own (test-only) zero-delay override.
        expect(capture.setups).toBeGreaterThanOrEqual(1)
        expect(capture.sessionHooks.filter((name) => name === "retry")).toEqual([])
        expect(capture.sessionHooks.every((name) => name === "context")).toBe(true)
        expect(probe.retryEvents).toHaveLength(1)
        const decision = probe.retryEvents[0].decision as { retry: boolean; delay: number }
        expect(decision.retry).toBe(true)
        expect(decision.delay).toBeGreaterThanOrEqual(1_400)
        expect(probe.streamCalls).toBe(2)
        // No retry trace record exists in the default configuration.
        expect(capture.writes.filter((write) => write.key.startsWith("retry-trace/"))).toEqual([])
      },
      { plugins: [wrapBuiltPlugin(await loadBuiltPlugin(), {}, capture)] },
    )
  }, TEST_TIMEOUT)

  test("bounded mode caps delays, vetoes ambiguous classes, and records bounded attempts", async () => {
    const capture = { writes: [] as Array<{ key: string; value: unknown }>, sessionHooks: [] as string[], setups: 0 }
    await withProbeHost(
      async ({ host, probe, directory }) => {
        const sessionID = await createSession(host, directory, "phase-d bounded", ORCHESTRATOR_AGENT)

        // Capped: the production hook runs before the probe hook, so the
        // observed decision is the capped 1 ms delay, not the host's ~2 s.
        probe.failuresRemaining = 1
        probe.failureError = rateLimitedFailure()
        await promptAndWait(host, sessionID, "phase-d prompt")
        expect(capture.sessionHooks).toContain("retry")
        expect(capture.sessionHooks).toContain("context")
        expect(probe.retryEvents).toHaveLength(1)
        expect(probe.retryEvents[0].decision).toEqual({ retry: true, delay: 1 })
        expect(probe.streamCalls).toBe(2)

        // Ambiguous class (provider.unknown): the production hook vetoes the
        // host-proposed retry before the probe hook sees it.
        probe.failuresRemaining = 1
        probe.failureError = new Error(FIXTURE_FAILURE)
        await promptAndWait(host, sessionID, "phase-d prompt")
        expect(probe.retryEvents).toHaveLength(2)
        expect(probe.retryEvents[1].decision).toEqual({ retry: false })
        expect(probe.streamCalls).toBe(3)

        // Terminal classification: the host proposes no retry and the
        // production hook leaves it final.
        probe.failuresRemaining = 1
        probe.failureError = terminalFailure()
        await promptAndWait(host, sessionID, "phase-d prompt")
        expect(probe.retryEvents).toHaveLength(3)
        expect(probe.retryEvents[2].decision).toEqual({ retry: false })
        expect(probe.streamCalls).toBe(4)

        // Bounded trace metadata: written only under the retry key and free of
        // error text, prompts, or credentials.
        const retryWrites = capture.writes.filter((write) => write.key.startsWith("retry-trace/"))
        expect(retryWrites.length).toBeGreaterThanOrEqual(1)
        for (const write of retryWrites) {
          expect(write.key).toMatch(/^retry-trace\/v1\//)
          const serialized = JSON.stringify(write.value)
          expect(serialized).not.toContain(FIXTURE_FAILURE)
          expect(serialized).not.toContain("injected authentication failure")
        }
        const last = retryWrites[retryWrites.length - 1].value as {
          attempts?: number
          capped?: number
          vetoedClass?: number
          lastAction?: string
        }
        expect(last.attempts).toBe(3)
        expect(last.capped).toBe(1)
        expect(last.vetoedClass).toBe(1)
        expect(last.lastAction).toBe("host-terminal")
      },
      {
        plugins: [
          wrapBuiltPlugin(
            await loadBuiltPlugin(),
            { retry: { mode: "bounded", max_delay_ms: 1 }, trace: { mode: "snapshot" } },
            capture,
          ),
        ],
      },
    )
  }, TEST_TIMEOUT)

  test("bounded mode filters worker sessions and gates retry bursts", async () => {
    const capture = { writes: [] as Array<{ key: string; value: unknown }>, sessionHooks: [] as string[], setups: 0 }
    await withProbeHost(
      async ({ host, probe, directory }) => {
        // Worker session: the production hook filters it out, so the recorded
        // proposal keeps the host's full uncapped delay.
        probe.overrideDelay = 0
        const worker = await createSession(host, directory, "phase-d worker", WORKER_AGENT)
        probe.failuresRemaining = 1
        probe.failureError = rateLimitedFailure()
        await promptAndWait(host, worker, "phase-d prompt")
        expect(probe.retryEvents).toHaveLength(1)
        const workerDecision = probe.retryEvents[0].decision as { retry: boolean; delay: number }
        expect(workerDecision.retry).toBe(true)
        expect(workerDecision.delay).toBeGreaterThanOrEqual(1_400)

        // Orchestrator burst: the first request consumes four observations
        // (attempts 2..5); the second request's third retry observation is the
        // seventh inside the burst window, so it is vetoed and the request
        // ends one attempt before the built-in ceiling.
        const orchestrator = await createSession(host, directory, "phase-d burst", ORCHESTRATOR_AGENT)
        probe.failuresRemaining = Number.POSITIVE_INFINITY
        probe.failureError = rateLimitedFailure()
        await promptAndWait(host, orchestrator, "phase-d prompt")
        const firstRequest = probe.retryEvents.filter((event) => event.sessionID === orchestrator)
        expect(firstRequest.map((event) => event.attempt)).toEqual([2, 3, 4, 5])
        expect(firstRequest.map((event) => (event.decision as { retry: boolean }).retry)).toEqual([true, true, true, true])

        probe.failuresRemaining = Number.POSITIVE_INFINITY
        await promptAndWait(host, orchestrator, "phase-d prompt")
        const secondRequest = probe.retryEvents.filter((event) => event.sessionID === orchestrator).slice(4)
        // The seventh observation inside the burst window is vetoed, so the
        // second request ends at that point (three observations) instead of
        // reaching the built-in ceiling.
        expect(secondRequest.map((event) => event.attempt)).toEqual([2, 3, 4])
        expect(secondRequest.map((event) => (event.decision as { retry: boolean }).retry)).toEqual([true, true, false])
        // Exactly one scheduled event per allowed retry: 4 (first request) + 2
        // (second request) and none for the vetoed observation.
        const orchestratorScheduled = probe.scheduledEvents.filter((event) => event.sessionID === orchestrator)
        expect(orchestratorScheduled.map((event) => event.attempt)).toEqual([2, 3, 4, 5, 2, 3])
        // 2 (worker) + 5 (first request) + 3 (second request: initial + two
        // retries; the vetoed fourth hook call never runs a retry).
        expect(probe.streamCalls).toBe(2 + 5 + 3)
      },
      {
        plugins: [
          wrapBuiltPlugin(await loadBuiltPlugin(), { retry: { mode: "bounded", max_delay_ms: 0 } }, capture),
        ],
      },
    )
  }, TEST_TIMEOUT)
})
