import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"

/**
 * Phase F pinned-host probe for the native `subagent` tool boundary.
 *
 * The probe uses deterministic in-process language models, never reaches the
 * network, and records only bounded hook metadata. It deliberately measures
 * native dispatch behavior rather than importing the production admission
 * runtime so the contract remains independent of implementation assumptions.
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
}

function createProbe(refuseSubagent = false): Probe {
  const probe: Probe = { plugin: undefined as never, hooks: [], toolCalls: 0 }
  const parentModel = model({
    onToolCall() {
      probe.toolCalls += 1
      return {
        agent: CHILD_AGENT,
        description: "phase-f child",
        prompt: "return a short result",
        background: false,
      }
    },
  })
  const childModel = model()

  probe.plugin = Plugin.define({
    id: "phase-f-subagent-probe",
    async setup(ctx) {
      await ctx.aisdk.hook("sdk", (event) => {
        event.sdk = {
          languageModel: () => event.model.id === PARENT_MODEL ? parentModel : childModel,
        }
      }, { providerID: PROVIDER })
      await ctx.aisdk.hook("language", (event) => {
        event.language = event.model.id === PARENT_MODEL ? parentModel : childModel
      }, { providerID: PROVIDER })
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

function model(input: { onToolCall?: () => Record<string, unknown> } = {}) {
  let sent = false
  return {
    specificationVersion: "v3" as const,
    provider: PROVIDER,
    modelId: input.onToolCall ? PARENT_MODEL : CHILD_MODEL,
    supportedUrls: {},
    async doStream(options: Record<string, unknown>) {
      if (input.onToolCall && !sent) {
        const tools = Array.isArray(options.tools) ? options.tools : []
        const subagent = tools.find(
          (tool) => tool && typeof tool === "object" && (tool as { name?: unknown }).name === "subagent",
        )
        if (!subagent) throw new Error("phase-f probe did not receive the native subagent tool")
        sent = true
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "phase-f-subagent-call",
            toolName: "subagent",
            input: JSON.stringify(input.onToolCall()),
          },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: { inputTokens: {}, outputTokens: {} } },
        ])
      }
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "phase-f-text" },
        { type: "text-delta", id: "phase-f-text", delta: "[phase-f-probe] done" },
        { type: "text-end", id: "phase-f-text" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: {}, outputTokens: {} } },
      ])
    },
    async doGenerate(): Promise<never> {
      throw new Error("phase-f probe only exercises streaming")
    },
  }
}

function stream(parts: readonly Record<string, unknown>[]): { stream: ReadableStream<any> } {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part)
        controller.close()
      },
    }),
  }
}

function config(directory: string): string {
  return JSON.stringify({
    providers: {
      [PROVIDER]: {
        name: "Phase F Probe",
        models: {
          [PARENT_MODEL]: { name: "Phase F Parent", package: "aisdk:@ai-sdk/openai-compatible" },
          [CHILD_MODEL]: { name: "Phase F Child", package: "aisdk:@ai-sdk/openai-compatible" },
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
  let host: Awaited<ReturnType<typeof OpenCode.create>> | undefined
  try {
    host = await OpenCode.create({
      plugins: [probe.plugin],
      models: { fetch: false },
      database: { path: join(root, "database.sqlite") },
      config: { directory, content: config(directory) },
    })
    await host.plugin.awaitActivation()
    return await run(host, directory)
  } finally {
    if (host) await host.close()
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
