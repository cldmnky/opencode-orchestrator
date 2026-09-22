import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"
import { activatePlugin } from "./helpers/activate-plugin.js"
import { createMockOpenAI, openAIToolCall, openAIText, type MockOpenAI } from "./helpers/mock-openai.js"

/**
 * Phase E pinned-host probe for native shell-tool execution hooks.
 *
 * This is deliberately measurement-only. It records bounded event shapes in
 * memory and does not wire receipts or change the production plugin. The
 * deterministic loopback provider emits one native shell call, then a final
 * response.
 */

const PROBE_PROVIDER = "phase-e-probe"
const PROBE_MODEL = "deterministic"
const PROBE_PACKAGE = "@ai-sdk/openai-compatible"
const COMMAND = "printf '[phase-e-probe] ok'"
const TEST_TIMEOUT = 20_000

type HookSnapshot = {
  phase: "before" | "after"
  keys: string[]
  tool: unknown
  sessionID: unknown
  agent: unknown
  messageID: unknown
  id: unknown
  input: unknown
  status?: unknown
  resultKeys?: string[]
  resultExit?: unknown
  resultMetadataExit?: unknown
  resultStatus?: unknown
  errorKeys?: string[]
}

type Probe = {
  plugin: ReturnType<typeof Plugin.define>
  hooks: HookSnapshot[]
  modelCalls: Array<{ toolNames: string[]; input: unknown }>
  command: string
  toolCallSent: boolean
}

function createProbe(command = COMMAND, blockBefore = false): Probe {
  const probe: Probe = { plugin: undefined as never, hooks: [], modelCalls: [], command, toolCallSent: false }

  probe.plugin = Plugin.define({
    id: "phase-e-verification-probe",
    async setup(ctx) {
      await ctx.tool.hook("execute.before", (event) => {
        probe.hooks.push(snapshot("before", event))
        if (blockBefore) throw new Error("phase-e before refusal")
      })
      await ctx.tool.hook("execute.after", (event) => {
        probe.hooks.push(snapshot("after", event))
      })
    },
  })
  return probe
}

function respond(probe: Probe, body: { model?: string; tools?: unknown[] }): Response {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const toolNames = tools
    .map((tool) => (tool && typeof tool === "object" && typeof (tool as { function?: { name?: unknown } }).function?.name === "string"
      ? (tool as { function: { name: string } }).function.name
      : ""))
    .filter((name) => name.length > 0)
  const toolName = toolNames.find((name) => name === "bash" || name === "shell")
  if (!toolName) return openAIText("title", body.model)
  if (!probe.toolCallSent) {
    probe.toolCallSent = true
    probe.modelCalls.push({ toolNames, input: { command: probe.command } })
    return openAIToolCall(toolName, { command: probe.command }, { model: body.model })
  }
  probe.modelCalls.push({ toolNames, input: undefined })
  return openAIText("[phase-e-probe] done", body.model)
}

function snapshot(phase: "before" | "after", event: Record<string, unknown>): HookSnapshot {
  const result = event.result
  const error = event.error
  return {
    phase,
    keys: Object.keys(event).sort(),
    tool: event.tool,
    sessionID: event.sessionID,
    agent: event.agent,
    messageID: event.messageID,
    id: event.id,
    input: event.input,
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(result && typeof result === "object" ? { resultKeys: Object.keys(result as object).sort() } : {}),
    ...(error && typeof error === "object" ? { errorKeys: Object.keys(error as object).sort() } : {}),
    ...(phase === "after" ? resultFields(result) : {}),
  }
}

function resultFields(value: unknown): Pick<HookSnapshot, "resultExit" | "resultMetadataExit" | "resultStatus"> {
  if (!value || typeof value !== "object") return {}
  const result = value as { output?: unknown; metadata?: unknown }
  const output = result.output && typeof result.output === "object" ? (result.output as { exit?: unknown; status?: unknown }) : undefined
  const metadata = result.metadata && typeof result.metadata === "object" ? (result.metadata as { exit?: unknown }) : undefined
  return {
    ...(output?.exit !== undefined ? { resultExit: output.exit } : {}),
    ...(metadata?.exit !== undefined ? { resultMetadataExit: metadata.exit } : {}),
    ...(output?.status !== undefined ? { resultStatus: output.status } : {}),
  }
}

function config(directory: string, baseURL: string): string {
  return JSON.stringify({
    providers: {
      [PROBE_PROVIDER]: {
        name: "Phase E Probe",
        settings: { baseURL },
        models: { [PROBE_MODEL]: { name: "Phase E Deterministic Probe", package: PROBE_PACKAGE } },
      },
    },
    agents: {
      orchestrator: {
        mode: "primary",
        model: `${PROBE_PROVIDER}/${PROBE_MODEL}`,
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      },
    },
    directory,
  })
}

describe("phase E native verification hook contract (pinned 2.0.14)", () => {
  test("pairs a native shell call with stable identity and explicit result status", async () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-phase-e-"))
    const directory = join(root, "project")
    const probe = createProbe()
    const mock = createMockOpenAI(({ body }) => respond(probe, body))
    let host: Awaited<ReturnType<typeof OpenCode.create>> | undefined
    const ambientCredential = process.env.OPENCODE_API_KEY
    delete process.env.OPENCODE_API_KEY
    try {
      host = await OpenCode.create({
        plugins: [probe.plugin],
        fs: { filewatcher: false },
        models: { fetch: false },
        database: { path: join(root, "database.sqlite") },
        config: { directory, content: config(directory, mock.baseURL) },
      })
      await activatePlugin(host, directory)
      const session = await host.session.create({ location: { directory }, agent: "orchestrator" })
      await host.session.switchModel({ sessionID: session.id, model: { providerID: PROBE_PROVIDER, id: PROBE_MODEL } })
      await host.session.prompt({ sessionID: session.id, text: "Run the verification command." })
      await host.session.wait({ sessionID: session.id })

      const before = probe.hooks.filter((event) => event.phase === "before")
      const after = probe.hooks.filter((event) => event.phase === "after")
      expect(probe.modelCalls[0]?.toolNames).toContain("shell")
      expect(before).toHaveLength(1)
      expect(after).toHaveLength(1)
      expect(probe.hooks.map((event) => event.phase)).toEqual(["before", "after"])
      expect(before[0]?.tool).toBe("shell")
      expect(after[0]?.tool).toBe("shell")
      expect(after[0]?.status).toBe("completed")
      expect(before[0]?.sessionID).toBe(session.id)
      expect(after[0]?.sessionID).toBe(session.id)
      expect(before[0]?.agent).toBe("orchestrator")
      expect(after[0]?.agent).toBe("orchestrator")
      expect(before[0]?.messageID).toBe(after[0]?.messageID)
      expect(before[0]?.id).toBe(after[0]?.id)
      expect(before[0]?.input).toEqual({ command: COMMAND })
      expect(after[0]?.input).toEqual({ command: COMMAND })
      expect(before[0]?.keys).toEqual(["agent", "id", "input", "messageID", "sessionID", "tool"])
      expect(after[0]?.keys).toEqual(["agent", "id", "input", "messageID", "result", "sessionID", "status", "tool"])
      expect(after[0]?.resultKeys).toContain("content")
      expect(after[0]?.resultExit).toBe(0)
      expect(after[0]?.resultMetadataExit).toBe(0)
      expect(after[0]?.resultStatus).toBe("completed")
    } finally {
      if (host) await host.close()
      mock.close()
      if (ambientCredential === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = ambientCredential
      rmSync(root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT)

  test("reports a non-zero shell exit without turning it into a passing result", async () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-phase-e-failure-"))
    const directory = join(root, "project")
    const probe = createProbe("exit 7")
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
      const session = await host.session.create({ location: { directory }, agent: "orchestrator" })
      await host.session.switchModel({ sessionID: session.id, model: { providerID: PROBE_PROVIDER, id: PROBE_MODEL } })
      await host.session.prompt({ sessionID: session.id, text: "Run the failing verification command." })
      await host.session.wait({ sessionID: session.id })

      const after = probe.hooks.find((event) => event.phase === "after")
      expect(after?.tool).toBe("shell")
      expect(after?.status).toBe("completed")
      expect(after?.resultExit).toBe(7)
      expect(after?.resultMetadataExit).toBe(7)
      // The outer hook status is also "completed" and the nested output
      // status is not a success discriminator; exit is authoritative.
      expect(after?.resultStatus).toBe("completed")
    } finally {
      if (host) await host.close()
      mock.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT)

  test("a throwing before hook prevents the shell call and produces no after receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-phase-e-before-"))
    const directory = join(root, "project")
    const probe = createProbe(COMMAND, true)
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
      const session = await host.session.create({ location: { directory }, agent: "orchestrator" })
      await host.session.switchModel({ sessionID: session.id, model: { providerID: PROBE_PROVIDER, id: PROBE_MODEL } })
      await host.session.prompt({ sessionID: session.id, text: "Run the blocked verification command." })
      await host.session.wait({ sessionID: session.id })

      expect(probe.hooks.filter((event) => event.phase === "before")).toHaveLength(1)
      expect(probe.hooks.filter((event) => event.phase === "after")).toHaveLength(0)
    } finally {
      if (host) await host.close()
      mock.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT)
})
