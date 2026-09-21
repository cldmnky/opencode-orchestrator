import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"
import { activatePlugin } from "./helpers/activate-plugin.js"
import { createMockOpenAI, openAIError, openAIText, type MockOpenAI } from "./helpers/mock-openai.js"

/**
 * Phase C pinned-host contract probe for the sessionless `ctx.generate.text`
 * surface (pinned `@opencode/plugin`/`@opencode/sdk` `2.0.11`).
 *
 * Measurement only: no production wiring, no configuration, no trace fields,
 * no tools, and no runtime behavior change. The probe boots an embedded host
 * against a throwaway directory, registers a test-only provider plugin, and
 * calls the captured `ctx.generate.text` directly.
 *
 * Measured surface (see `docs/phase-1/n4-sessionless-generate-compatibility.md`):
 *   - the accepted input is exactly `{ prompt, model? }` and the resolved
 *     output is exactly `{ text }`,
 *   - the declared contract is sessionless: no session, inbox item, history,
 *     or tool call exists or changes, and the session-scoped `generate`,
 *     `model.request`, and `http.request` hooks never fire,
 *   - a deterministic local OpenAI-compatible endpoint returns the fixture
 *     text without contacting an external provider,
 *   - `Generate.ModelSelectionError` (unknown model) and
 *     `Generate.UnavailableError` (provider failure) are catchable and leave no
 *     session-side effects,
 *   - the whole suite performs no external network traffic: the host boots with
 *     `models.fetch: false` and the probe holds a fetch guard that rejects any
 *     non-loopback request; the ambient `OPENCODE_API_KEY` variable is removed
 *     for the lifetime of each probe host, and its value is captured only so it
 *     can be restored on cleanup (never passed to the host, logged, or
 *     persisted).
 *
 * Harness fact measured here, not assumed: released 2.0.11 resolves the
 *   configured OpenAI-compatible model through its native provider route, so
 *   this contract uses a loopback HTTP endpoint instead of the beta-era
 *   in-process AISDK hook replacement.
 */

const PROBE_PROVIDER = "phase-c-probe"
const PROBE_MODEL = "deterministic"
/**
 * The native provider package used by the released host.
 */
const PROBE_PACKAGE = "@ai-sdk/openai-compatible"
const FIXTURE_PROMPT = "[phase-c-probe] deterministic fixture prompt"
const FIXTURE_TEXT = "[phase-c-probe] deterministic fixture output"
const PROVIDER_FAILURE = "[phase-c-probe] injected provider failure"
const HOST_CREATION_FAILURE = "[phase-c-probe] injected host creation failure"
/** Fake stand-in for the ambient credential in the failure-path regression; never a real secret. */
const CREDENTIAL_SENTINEL = "[phase-c-probe] sentinel credential (not a real secret)"
const TEST_TIMEOUT = 20_000

type ModelRef = { providerID: string; id: string }
type GenerateApi = { text(input: { prompt: string; model?: ModelRef }): Promise<{ text: string }> }
type Host = Awaited<ReturnType<typeof OpenCode.create>>

type Probe = {
  plugin: ReturnType<typeof Plugin.define>
  generate: GenerateApi | undefined
  /** Session-scoped hooks that would fire if generation used a session. */
  sessionGenerateHooks: string[]
  modelRequestHooks: string[]
  httpRequestHooks: string[]
  /** Tool dispatches observed through `tool.hook("execute.before"/"after")`. */
  toolHooks: string[]
  setupCount: number
  started: Promise<void>
  stop: () => void
}

function createProbe(): Probe {
  const controller = new AbortController()
  let resolveStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const probe: Probe = {
    plugin: undefined as never,
    generate: undefined,
    sessionGenerateHooks: [],
    modelRequestHooks: [],
    httpRequestHooks: [],
    toolHooks: [],
    setupCount: 0,
    started,
    stop: () => controller.abort(),
  }

  probe.plugin = Plugin.define({
    id: "phase-c-generate-probe",
    async setup(ctx) {
      probe.setupCount += 1
      probe.generate = ctx.generate as unknown as GenerateApi

      // Session-scoped recorders: a session-backed generation path would fire
      // these; the sessionless surface must not.
      await ctx.session.hook("generate", (event) => {
        probe.sessionGenerateHooks.push(event.sessionID)
      })
      await ctx.session.hook("model.request", (event) => {
        probe.modelRequestHooks.push(`${event.sessionID}:${event.kind}`)
      })
      await ctx.session.hook("http.request", (event) => {
        probe.httpRequestHooks.push(event.request.url)
      })
      await ctx.tool.hook("execute.before", (event) => {
        probe.toolHooks.push(`before:${event.tool}`)
      })
      await ctx.tool.hook("execute.after", (event) => {
        probe.toolHooks.push(`after:${event.tool}`)
      })

      resolveStarted()
      return () => controller.abort()
    },
  })

  return probe
}

type NetworkGuard = {
  /** Every fetch call, tagged with the probe phase that made it. */
  calls: Array<{ url: string; phase: string }>
  /** Non-loopback attempts; the guard rejects before any real send. */
  externalAttempts: string[]
  phase: string
  restore: () => void
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

function isLoopback(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Process-wide fetch guard: every call is recorded and any non-loopback URL is
 * rejected before a real request is made. The host's own local provider
 * detection (loopback ports) is allowed but still recorded.
 */
function installNetworkGuard(): NetworkGuard {
  const realFetch = globalThis.fetch
  const guard: NetworkGuard = { calls: [], externalAttempts: [], phase: "boot", restore: () => {} }
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input)
    guard.calls.push({ url, phase: guard.phase })
    if (!isLoopback(url)) {
      guard.externalAttempts.push(url)
      throw new Error(`[phase-c-probe] blocked external network attempt: ${url}`)
    }
    return realFetch(input as never, init as never)
  }) as typeof fetch
  guard.restore = () => {
    globalThis.fetch = realFetch
  }
  return guard
}

function probeConfig(baseURL: string): string {
  return JSON.stringify({
    providers: {
      [PROBE_PROVIDER]: {
        name: "Phase C Probe",
        settings: { baseURL },
        models: {
          [PROBE_MODEL]: { name: "Phase C Deterministic Probe", package: PROBE_PACKAGE },
        },
      },
    },
  })
}

/**
 * Test-only injection point for the host-creation failure regression: the
 * default factory is the pinned `OpenCode.create`, and the regression replaces
 * it with a deterministic offline rejection that exercises the same failure
 * path (cleanup must run even when embedded host creation rejects).
 */
type CreateHost = (input: { root: string; directory: string }) => Promise<Host>

type WithProbeHostOptions = {
  /** Test-only override; the contract cases omit it and use the pinned `OpenCode.create`. */
  createHost?: CreateHost
}

async function withProbeHost(
  run: (input: {
    host: Host
    probe: Probe
    guard: NetworkGuard
    directory: string
    mock: MockOpenAI
    failNextCall: () => void
  }) => Promise<void>,
  options: WithProbeHostOptions = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-phase-c-"))
  const directory = join(root, "project")
  const probe = createProbe()
  let failNextCall = false
  const mock = createMockOpenAI(({ body }) => {
    if (failNextCall) {
      failNextCall = false
      return openAIError(500, PROVIDER_FAILURE)
    }
    return openAIText(FIXTURE_TEXT, body.model)
  })
  const guard = installNetworkGuard()
  // No live credential may be reachable by the probe host. The ambient value is
  // captured only so it can be restored on cleanup; it is never passed to the
  // host, logged, or persisted.
  const credential = process.env.OPENCODE_API_KEY
  delete process.env.OPENCODE_API_KEY
  const createHost: CreateHost =
    options.createHost ??
    (({ root: hostRoot, directory: hostDirectory }) =>
      OpenCode.create({
        plugins: [probe.plugin],
        fs: { filewatcher: false },
        // Disable the models.dev catalog refresh so host startup makes no
        // external catalog request; the pinned bundled snapshot still
        // populates the catalog.
        models: { fetch: false },
        database: { path: join(hostRoot, "database.sqlite") },
        config: { directory: hostDirectory, content: probeConfig(mock.baseURL) },
      }))
  let host: Host | undefined
  try {
    host = await createHost({ root, directory })
    await activatePlugin(host, directory)
    await probe.started
    await run({ host, probe, guard, directory, mock, failNextCall: () => (failNextCall = true) })
  } finally {
    probe.stop()
    try {
      if (host) await host.close()
    } finally {
      guard.restore()
      mock.close()
      if (credential === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = credential
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** Reject an operation and return the raw thrown value for shape assertions. */
async function captureFailure(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  return promise.then(
    () => {
      throw new Error("expected the generation call to fail")
    },
    (error: unknown) => error as Record<string, unknown>,
  )
}

function probeModel(): ModelRef {
  return { providerID: PROBE_PROVIDER, id: PROBE_MODEL }
}

/** Assert the probe process recorded no external network attempt. */
function expectNoExternalTraffic(guard: NetworkGuard): void {
  expect(guard.externalAttempts).toEqual([])
}

/** Session-scoped recorders that would fire on any session-backed generation. */
function expectNoSessionSideEffects(probe: Probe): void {
  expect(probe.sessionGenerateHooks).toEqual([])
  expect(probe.modelRequestHooks).toEqual([])
  expect(probe.httpRequestHooks).toEqual([])
  expect(probe.toolHooks).toEqual([])
}

describe("phase C sessionless generate contract (pinned 2.0.11)", () => {
  test("returns the exact text envelope from a deterministic local provider", async () => {
    await withProbeHost(async ({ probe, guard, mock }) => {
      const generate = probe.generate as GenerateApi
      expect(probe.setupCount).toBeGreaterThanOrEqual(1)

      guard.phase = "generate"
      const result = await generate.text({ prompt: FIXTURE_PROMPT, model: probeModel() })

      // The resolved output is exactly `{ text }` with the injected fixture.
      expect(Object.keys(result)).toEqual(["text"])
      expect(result.text).toBe(FIXTURE_TEXT)

      expect(mock.requests).toHaveLength(1)

      // Accepted input shape: the fixture prompt is a single user text message
      // with no system parts, no history, and no tools.
      const call = mock.requests[0] as { messages?: unknown[]; tools?: unknown[] }
      expect(call.messages).toEqual([{ role: "user", content: FIXTURE_PROMPT }])
      expect(call.tools).toBeUndefined()

      expect(mock.requests).toHaveLength(1)
      expectNoExternalTraffic(guard)
      expectNoSessionSideEffects(probe)
    })
  }, TEST_TIMEOUT)

  test("creates no session, inbox item, or session history", async () => {
    await withProbeHost(async ({ host, probe, guard, directory, mock }) => {
      const generate = probe.generate as GenerateApi

      // A pre-existing session (and its history) must be untouched by a
      // sessionless generation call.
      const session = await host.session.create({ location: { directory } })
      const messagesBefore = await host.message.list({ sessionID: session.id })
      const inboxBefore = await host.session.inbox.list({ sessionID: session.id })

      guard.phase = "generate"
      const result = await generate.text({ prompt: FIXTURE_PROMPT, model: probeModel() })
      expect(result.text).toBe(FIXTURE_TEXT)

      // No new session and no active session state appeared.
      const sessions = await host.session.list({ location: { directory } })
      expect(sessions.data.map((item: { id: string }) => item.id)).toEqual([session.id])
      expect(await host.session.active()).toEqual({})

      // The pre-existing session's message history and inbox are unchanged.
      const messagesAfter = await host.message.list({ sessionID: session.id })
      expect(messagesAfter.data).toEqual(messagesBefore.data)
      const inboxAfter = await host.session.inbox.list({ sessionID: session.id })
      expect(inboxAfter).toEqual(inboxBefore)

      expectNoSessionSideEffects(probe)
      expect(mock.requests).toHaveLength(1)
      expectNoExternalTraffic(guard)
    })
  }, TEST_TIMEOUT)

  test("returns a catchable model-selection failure without session-side effects", async () => {
    await withProbeHost(async ({ host, probe, guard, directory }) => {
      const generate = probe.generate as GenerateApi
      guard.phase = "generate"

      const error = await captureFailure(
        generate.text({ prompt: FIXTURE_PROMPT, model: { providerID: PROBE_PROVIDER, id: "missing-model" } }),
      )

      expect(error).toBeInstanceOf(Error)
      expect(error._tag).toBe("Generate.ModelSelectionError")
      expect(String(error.message)).toContain(`Model unavailable: ${PROBE_PROVIDER}/missing-model`)

      // The failure is fail-closed: no session, no tool call, no injected
      // provider call (the suite asserts an empty injected-call record).
      const sessions = await host.session.list({ location: { directory } })
      expect(sessions.data).toEqual([])
      expect(guard.calls.filter((entry) => entry.phase === "generate")).toEqual([])
      expectNoSessionSideEffects(probe)
      expectNoExternalTraffic(guard)
    })
  }, TEST_TIMEOUT)

  test("returns a catchable provider failure without session-side effects", async () => {
    await withProbeHost(async ({ host, probe, guard, directory, mock, failNextCall }) => {
      const generate = probe.generate as GenerateApi
      guard.phase = "generate"
      failNextCall()

      const error = await captureFailure(generate.text({ prompt: FIXTURE_PROMPT, model: probeModel() }))

      expect(error).toBeInstanceOf(Error)
      expect(error._tag).toBe("Generate.UnavailableError")
      expect(String(error.message)).toContain(PROVIDER_FAILURE)

      // The rejected call is catchable and leaves no session-side effects.
      const sessions = await host.session.list({ location: { directory } })
      expect(sessions.data).toEqual([])
      expect(mock.requests).toHaveLength(1)
      expectNoSessionSideEffects(probe)
      expectNoExternalTraffic(guard)
    })
  }, TEST_TIMEOUT)

  test("rejects external network attempts and allows none during generation", async () => {
    // Guard liveness: an external URL must be recorded and rejected before a
    // real send, so a passing "no external traffic" assertion cannot be vacuous.
    // The fixture host is under the reserved `.invalid` TLD, which never
    // resolves; the guard rejects it before any real fetch is attempted.
    const standalone = installNetworkGuard()
    try {
      const blocked = await captureFailure(fetch("https://phase-c-probe.invalid/generate") as Promise<unknown>)
      expect(blocked).toBeInstanceOf(Error)
      expect(String(blocked.message)).toContain("blocked external network attempt")
      expect(standalone.externalAttempts).toEqual(["https://phase-c-probe.invalid/generate"])
      expect(standalone.calls).toHaveLength(1)
    } finally {
      standalone.restore()
    }

    await withProbeHost(async ({ probe, guard, mock }) => {
      const generate = probe.generate as GenerateApi
      guard.phase = "generate"
      const result = await generate.text({ prompt: FIXTURE_PROMPT, model: probeModel() })
      expect(result.text).toBe(FIXTURE_TEXT)
      expect(mock.requests).toHaveLength(1)
      // The host's own startup may probe loopback provider ports, but no
      // non-loopback request may be attempted anywhere in the probe lifetime.
      expect(guard.calls.every((call) => isLoopback(call.url))).toBe(true)
      expectNoExternalTraffic(guard)
    })
  }, TEST_TIMEOUT)

  test("restores fetch, credential, and temp root when host creation fails", async () => {
    // Regression for the harness-cleanup defect: `OpenCode.create` rejection
    // must restore `globalThis.fetch` and the ambient credential variable and
    // delete the temporary root. The injected factory rejects offline where the
    // pinned `OpenCode.create` would, so the failure path is deterministic and
    // makes no external network call; the sentinel credential is a fake value,
    // so no real credential can appear in test output.
    const originalFetch = globalThis.fetch
    const ambientCredential = process.env.OPENCODE_API_KEY
    let observedRoot: string | undefined
    const createHost: CreateHost = async ({ root }) => {
      observedRoot = root
      // Preconditions on the failure path: the guard is already installed and
      // the temp root already exists, so a leak would be observable.
      expect(existsSync(root)).toBe(true)
      expect(globalThis.fetch).not.toBe(originalFetch)
      throw new Error(HOST_CREATION_FAILURE)
    }
    const runMustNotExecute = async () => {
      throw new Error("[phase-c-probe] run callback must not execute when host creation fails")
    }
    const rejectHostCreation = () =>
      withProbeHost(runMustNotExecute, { createHost }).then(
        () => {
          throw new Error("expected withProbeHost to reject when host creation fails")
        },
        (thrown: unknown) => thrown as Error,
      )

    try {
      process.env.OPENCODE_API_KEY = CREDENTIAL_SENTINEL
      const error = await rejectHostCreation()
      expect(error).toBeInstanceOf(Error)
      expect(String(error.message)).toContain(HOST_CREATION_FAILURE)
      expect(observedRoot).toBeDefined()
      // The temp root existed during creation and is gone after the failure.
      expect(existsSync(observedRoot as string)).toBe(false)
      // The process-wide fetch guard is restored to the original function.
      expect(globalThis.fetch).toBe(originalFetch)
      // The ambient credential variable is restored, not left deleted.
      expect(process.env.OPENCODE_API_KEY).toBe(CREDENTIAL_SENTINEL)

      // Absent ambient credential: the failure path must leave it absent.
      delete process.env.OPENCODE_API_KEY
      await rejectHostCreation()
      expect("OPENCODE_API_KEY" in process.env).toBe(false)
      expect(globalThis.fetch).toBe(originalFetch)
    } finally {
      globalThis.fetch = originalFetch
      if (ambientCredential === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = ambientCredential
    }
  }, TEST_TIMEOUT)
})
