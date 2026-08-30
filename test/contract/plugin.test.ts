import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import {
  GH_TOOL_PERMISSION,
  GOAL_TOOL_PERMISSION,
  ORCHESTRATION_TOOL_PERMISSION,
  WORKTREE_TOOL_PERMISSION,
} from "../../src/core/permissions.js"
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
    const tools: Array<{
      name: string
      options?: { namespace?: string; permission?: string }
      execute(input: unknown, context: any): Promise<any>
    }> = []
    const disposed: string[] = []
    const switches: string[] = []
    const prompts: any[] = []
    let contextHook: ((event: any) => void) | undefined
    const stream = eventStream()

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
      options: {
        goal: { auto_continue: false },
        github: { enabled: true, allow_mutations: true },
        worktree: { enabled: true, allow_mutations: true, root: "/srv/worktrees" },
      },
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
      event: {
        subscribe: () => stream,
      },
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => void storage.set(key, value),
        remove: async (key: string) => void storage.delete(key),
      },
      session: {
        hook: async (name: string, callback: (event: any) => void) => {
          if (name === "context") contextHook = callback
          return registration("session-hook")
        },
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
      "cd",
    ])
    const commandNames = new Set(commands.map((command) => command.name))
    expect(commandNames.has("cd")).toBe(true)

    // The tool transform registers the goal family plus the orchestrator-only
    // github, worktree, and orchestration validation families with their shared
    // permission actions: 3 goal + 8 github + 5 worktree + 3 validation = 19.
    const allToolNames = tools.map((tool) => `${tool.options?.namespace}_${tool.name}`)
    expect(allToolNames).toEqual([
      "orchestrator_goal_get",
      "orchestrator_goal_set",
      "orchestrator_goal_update",
      "orchestrator_github_capabilities",
      "orchestrator_github_repo_view",
      "orchestrator_github_issue_view",
      "orchestrator_github_issue_list",
      "orchestrator_github_issue_create",
      "orchestrator_github_pr_view",
      "orchestrator_github_pr_list",
      "orchestrator_github_pr_create",
      "orchestrator_worktree_list",
      "orchestrator_worktree_create",
      "orchestrator_worktree_status",
      "orchestrator_worktree_push",
      "orchestrator_worktree_cleanup",
      "orchestrator_task_complexity_classify",
      "orchestrator_handoff_validate",
      "orchestrator_admission_transition",
    ])
    expect(allToolNames).toHaveLength(19)
    expect(tools.filter((tool) => tool.options?.permission === GH_TOOL_PERMISSION).length).toBeGreaterThanOrEqual(8)
    expect(tools.filter((tool) => tool.options?.permission === WORKTREE_TOOL_PERMISSION).length).toBe(5)
    const goalTools = tools.filter((tool) => tool.options?.permission === GOAL_TOOL_PERMISSION)
    expect(goalTools).toHaveLength(3)
    // Every registered goal tool must declare the shared permission action so
    // a single rule grants or revokes the whole family.
    for (const tool of goalTools) {
      expect(tool.options?.permission).toBe(GOAL_TOOL_PERMISSION)
    }
    // The three serialized runtime validation tools share their own permission.
    const validationTools = tools.filter((tool) => tool.options?.permission === ORCHESTRATION_TOOL_PERMISSION)
    expect(validationTools.map((tool) => tool.name).sort()).toEqual([
      "admission_transition",
      "handoff_validate",
      "task_complexity_classify",
    ])
    for (const tool of validationTools) {
      expect(tool.options?.namespace).toBe("orchestrator")
    }
    // The orchestrator-only feature families share one permission action each.
    for (const tool of tools.filter((tool) => tool.options?.permission === GH_TOOL_PERMISSION)) {
      expect(tool.options?.namespace).toBe("orchestrator")
    }
    expect(agents.get("orchestrator")?.system).toContain("conductor")
    expect(agents.get("orchestrator")?.system).toContain("Expected outcome")
    expect(agents.get("orchestrator")?.system).toContain("exact disjoint write scope")

    const contextText: string[] = []
    contextHook?.({
      agent: "orchestrator",
      system: { push: (item: { text: string }) => void contextText.push(item.text) },
    })
    expect(contextText.join("\n")).toContain("orchestrator_goal_get")
    expect(contextText.join("\n")).toContain("orchestrator_goal_set")
    expect(contextText.join("\n")).toContain("orchestrator_goal_update")
    expect(contextText.join("\n")).toContain("/cd")
    expect(contextText.join("\n")).toContain("orchestrator_worktree_create")
    expect(contextText.join("\n")).toContain("orchestrator_task_complexity_classify")
    expect(contextText.join("\n")).toContain("orchestrator_handoff_validate")
    expect(contextText.join("\n")).toContain("orchestrator_admission_transition")
    expect(contextText.join("\n")).toContain("not an automatic gate")
    expect(contextText.join("\n")).toContain("exact disjoint write scope")
    expect(contextText.join("\n")).not.toMatch(/\bgoal_(get|set|update)\b/)

    await commands[0]?.execute({ sessionID: "session", prompt: { text: "fix the bug" }, delivery: "queue" })
    expect(switches).toEqual(["agent:orchestrator", "model:orchestrator-model"])
    expect(prompts[0].text).toContain("fix the bug")
    expect(prompts[0].delivery).toBe("queue")

    await cleanup?.()
    expect(disposed).toEqual(["hook", "session-hook", "tool", "command", "agent"])
    // The worktree event sync registered its own real dispose, which closed
    // the subscribed event stream.
    expect(stream.closed).toBe(true)
  })
})

// Minimal async event stream: holds `next()` until `return()` resolves it with
// `done`, so the plugin's event subscriptions can be torn down without a live
// server.
function eventStream(): AsyncIterable<any> & { closed: boolean } {
  const waiters: Array<(result: IteratorResult<unknown>) => void> = []
  let closed = false
  const iterator = {
    next: () => {
      if (closed) return Promise.resolve({ done: true, value: undefined })
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
    get closed() {
      return closed
    },
  }
  return iterator
}