import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"
import { activatePlugin } from "./helpers/activate-plugin.js"
import { createMockOpenAI, openAIToolCall, openAIText } from "./helpers/mock-openai.js"

/**
 * Phase F pinned-host probe for the native `subagent` tool boundary.
 *
 * The probe uses a deterministic loopback OpenAI-compatible provider, never
 * reaches an external network, and records only bounded hook metadata. It
 * deliberately measures native dispatch behavior rather than importing the
 * production admission runtime so the contract remains independent of
 * implementation assumptions.
 */

const PROVIDER = "phase-f-probe"
const PARENT_MODEL = "parent"
const CHILD_MODEL = "child"
const CHILD_AGENT = "phase-f-child"
const TEST_TIMEOUT = 20_000

type HookRecord = {
  phase: "before" | "after"
  tool: unknown
  sessionID: unknown
  agent: unknown
  messageID: unknown
  id: unknown
  input: unknown
  status?: unknown
  result?: unknown
}

type Probe = {
  plugin: ReturnType<typeof Plugin.define>
  hooks: HookRecord[]
  toolCalls: number
  parentToolCallSent: boolean
}

function createProbe(refuseSubagent = false): Probe {
  const probe: Probe = { plugin: undefined as never, hooks: [], toolCalls: 0, parentToolCallSent: false }

  probe.plugin = Plugin.define({
    id: "phase-f-subagent-probe",
    async setup(ctx) {
      await ctx.tool.hook("execute.before", (event) => {
        probe.hooks.push({
          phase: "before",
          tool: event.tool,
          sessionID: event.sessionID,
          agent: event.agent,
          messageID: event.messageID,
          id: event.id,
          input: event.input,
        })
        if (refuseSubagent && event.tool === "subagent") throw new Error("phase-f refusal")
      })
      await ctx.tool.hook("execute.after", (event) => {
        probe.hooks.push({
          phase: "after",
          tool: event.tool,
          sessionID: event.sessionID,
          agent: event.agent,
          messageID: event.messageID,
          id: event.id,
          input: event.input,
          status: event.status,
          ...(event.status === "completed" ? { result: event.result } : {}),
        })
      })
    },
  })
  return probe
}

function respond(probe: Probe, body: { model?: string; tools?: unknown[] }): Response {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const hasSubagent = tools.some(
    (tool) => tool && typeof tool === "object" && (tool as { function?: { name?: unknown } }).function?.name === "subagent",
  )
  if (!hasSubagent) return openAIText("title", body.model)
  if (body.model === PARENT_MODEL && !probe.parentToolCallSent) {
    probe.parentToolCallSent = true
    probe.toolCalls += 1
    return openAIToolCall(
      "subagent",
      {
        agent: CHILD_AGENT,
        description: "phase-f child",
        prompt: "return a short result",
        background: false,
      },
      { model: body.model, id: "phase-f-subagent-call" },
    )
  }
  return openAIText("[phase-f-probe] done", body.model)
}

function config(directory: string, baseURL: string): string {
  return JSON.stringify({
    providers: {
      [PROVIDER]: {
        name: "Phase F Probe",
        settings: { baseURL },
        models: {
          [PARENT_MODEL]: { name: "Phase F Parent", package: "@ai-sdk/openai-compatible" },
          [CHILD_MODEL]: { name: "Phase F Child", package: "@ai-sdk/openai-compatible" },
        },
      },
    },
    agents: {
      orchestrator: {
        mode: "primary",
        model: `${PROVIDER}/${PARENT_MODEL}`,
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      },
      [CHILD_AGENT]: {
        mode: "subagent",
        model: `${PROVIDER}/${CHILD_MODEL}`,
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      },
    },
    directory,
  })
}

async function withHost<T>(probe: Probe, run: (host: Awaited<ReturnType<typeof OpenCode.create>>, directory: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "opencode-orchestrator-phase-f-"))
  const directory = join(root, "project")
  const ambientCredential = process.env.OPENCODE_API_KEY
  delete process.env.OPENCODE_API_KEY
  const mock = createMockOpenAI(({ body }) => respond(probe, body))
  let host: Awaited<ReturnType<typeof OpenCode.create>> | undefined
  try {
    host = await OpenCode.create({
      plugins: [probe.plugin],
      fs: { filewatcher: false },
      models: { fetch: false },
      database: { path: join(root, "database.sqlite") },
      config: { directory, content: config(directory, mock.baseURL) },
    })
    await activatePlugin(host, directory)
    return await run(host, directory)
  } finally {
    if (host) await host.close()
    mock.close()
    if (ambientCredential === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = ambientCredential
    rmSync(root, { recursive: true, force: true })
  }
}

describe("phase F pinned-host subagent hook contract", () => {
  test("pairs configured foreground subagent dispatch and preserves identity", async () => {
    const probe = createProbe()
    await withHost(probe, async (host, directory) => {
      const session = await host.session.create({ location: { directory }, agent: "orchestrator" })
      await host.session.switchModel({ sessionID: session.id, model: { providerID: PROVIDER, id: PARENT_MODEL } })
      await host.session.prompt({ sessionID: session.id, text: "delegate the measured child" })
      await host.session.wait({ sessionID: session.id })

      const hooks = probe.hooks.filter((event) => event.tool === "subagent")
      expect(probe.toolCalls).toBe(1)
      expect(hooks).toHaveLength(2)
      expect(hooks.map((event) => event.phase)).toEqual(["before", "after"])
      expect(hooks[0]?.sessionID).toBe(session.id)
      expect(hooks[1]?.sessionID).toBe(session.id)
      expect(hooks[0]?.agent).toBe("orchestrator")
      expect(hooks[1]?.agent).toBe("orchestrator")
      expect(hooks[0]?.messageID).toBe(hooks[1]?.messageID)
      expect(hooks[0]?.id).toBe(hooks[1]?.id)
      expect(hooks[0]?.input).toEqual(hooks[1]?.input)
      expect(hooks[1]?.status).toBe("completed")
      expect((hooks[1]?.result as { metadata?: { sessionID?: string; status?: string } })?.metadata?.status).toBe("completed")
      const children = await host.session.list({ parentID: session.id })
      expect(children.data).toHaveLength(1)
      expect(children.data[0]?.agent).toBe(CHILD_AGENT)
    })
  }, TEST_TIMEOUT)

  test("throwing from before prevents child creation and produces no after event", async () => {
    const probe = createProbe(true)
    await withHost(probe, async (host, directory) => {
      const session = await host.session.create({ location: { directory }, agent: "orchestrator" })
      await host.session.switchModel({ sessionID: session.id, model: { providerID: PROVIDER, id: PARENT_MODEL } })
      await host.session.prompt({ sessionID: session.id, text: "attempt the refused child" })
      await host.session.wait({ sessionID: session.id })

      const hooks = probe.hooks.filter((event) => event.tool === "subagent")
      expect(hooks.map((event) => event.phase)).toEqual(["before"])
      expect((await host.session.list({ parentID: session.id })).data).toEqual([])
    })
  }, TEST_TIMEOUT)

})
