import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { orchestratorPlugin } from "../../src/index.js"

describe("server plugin contract", () => {
  test("registers runtime surfaces, dispatches a command, and cleans up", async () => {
    type FakeAgent = {
      id: string
      mode: "primary" | "subagent"
      model?: { id: string; providerID: string }
      system?: string
      description?: string
    }
    const agents = new Map<string, FakeAgent>(
      [
        ["orchestrator", "primary"],
        ["planner", "subagent"],
        ["explore", "subagent"],
        ["implementer", "subagent"],
        ["reviewer", "subagent"],
      ].map(([id, mode]) => [
        id,
        {
          id,
          mode: mode as FakeAgent["mode"],
          model: id === "orchestrator" ? { id: "orchestrator-model", providerID: "provider" } : undefined,
        },
      ]),
    )
    const commands: Array<{ name: string; execute(input: any): Promise<void> }> = []
    const tools: Array<{ name: string; options?: { namespace?: string }; execute(input: unknown, context: any): Promise<any> }> = []
    const disposed: string[] = []
    const switches: string[] = []
    const prompts: any[] = []

    const registration = (name: string) => ({
      dispose: async () => {
        disposed.push(name)
      },
    })
    const draft = {
      list: () => [...agents.values()],
      get: (id: string) => agents.get(id),
      update: (id: string, update: (agent: any) => void) => {
        const agent = agents.get(id)
        if (agent) update(agent)
      },
    }
    const storage = new Map<string, unknown>()
    const context = {
      options: { goal: { auto_continue: false } },
      location: { directory: "/workspace", project: { id: "project" } },
      agent: {
        list: async () => [...agents.values()],
        get: async ({ agentID }: { agentID: string }) => agents.get(agentID),
        transform: async (callback: (draft: any) => void) => {
          callback(draft)
          return registration("agent")
        },
      },
      command: {
        list: async () => [],
        transform: async (callback: (draft: { add(definition: any): void }) => void) => {
          callback({ add: (definition) => commands.push(definition) })
          return registration("command")
        },
      },
      tool: {
        transform: async (callback: (draft: { add(tool: any): void }) => void) => {
          callback({ add: (tool) => tools.push(tool) })
          return registration("tool")
        },
        hook: async () => registration("hook"),
      },
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => void storage.set(key, value),
        remove: async (key: string) => void storage.delete(key),
      },
      session: {
        hook: async () => registration("session-hook"),
        switchAgent: async ({ agent }: { agent: string }) => void switches.push(`agent:${agent}`),
        switchModel: async ({ model }: { model: { id: string } }) => void switches.push(`model:${model.id}`),
        prompt: async (input: unknown) => void prompts.push(input),
      },
    } as unknown as Context

    const cleanup = await orchestratorPlugin.setup(context)

    expect(commands.map((command) => command.name)).toEqual([
      "orchestrate",
      "goal",
      "restructure",
      "run-plan",
      "halt",
      "handover",
      "polish",
      "stress-plan",
    ])
    expect(tools.map((tool) => `${tool.options?.namespace}_${tool.name}`)).toEqual([
      "orchestrator_goal_get",
      "orchestrator_goal_set",
      "orchestrator_goal_update",
    ])
    expect(agents.get("orchestrator")?.system).toContain("conductor")

    await commands[0]?.execute({ sessionID: "session", prompt: { text: "fix the bug" }, delivery: "queue" })
    expect(switches).toEqual(["agent:orchestrator", "model:orchestrator-model"])
    expect(prompts[0].text).toContain("fix the bug")
    expect(prompts[0].delivery).toBe("queue")

    await cleanup?.()
    expect(disposed).toEqual(["hook", "session-hook", "tool", "command", "agent"])
  })
})
