import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import {
  GATES_TOOL_PERMISSION,
  GH_TOOL_PERMISSION,
  GOAL_TOOL_PERMISSION,
  OBSERVABILITY_TOOL_PERMISSION,
  ORCHESTRATION_TOOL_PERMISSION,
  PEER_TOOL_PERMISSION,
  PUBLISH_TOOL_PERMISSION,
  WORKTREE_TOOL_PERMISSION,
} from "../../src/core/permissions.js"
import { orchestratorPlugin } from "../../src/index.js"

describe("server plugin contract", () => {
  type FakeAgent = {
    id: string
    mode: "primary" | "subagent"
    model?: { id: string; providerID: string }
    system?: string
    description?: string
  }

  function seedAgents(): Map<string, FakeAgent> {
    return new Map<string, FakeAgent>(
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
  }

  test("registers runtime surfaces, dispatches a command, and cleans up", async () => {
    const agents = seedAgents()
    const commands: Array<{ name: string; execute(input: any): Promise<void> }> = []
    const tools: Array<{
      name: string
      options?: { namespace?: string; permission?: string }
      execute(input: unknown, context: any): Promise<any>
    }> = []
    const disposed: string[] = []
    const switches: string[] = []
    const prompts: any[] = []
    const rpcRegistrations: Array<{ definition: any; handlers: any }> = []
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
        hook: async (name: string) => registration(name),
      },
      rpc: {
        register: async (definition: unknown, handlers: unknown) => {
          rpcRegistrations.push({ definition, handlers })
          return registration("rpc")
        },
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
      "worker-models",
      "goal",
      "restructure",
      "run-plan",
      "halt",
      "handover",
      "polish",
      "stress-plan",
      "publish",
      "gates",
    ])
    const commandNames = new Set(commands.map((command) => command.name))
    expect(commandNames.has("cd")).toBe(false)
    // The gates command is orchestrator-only and carries no required argument.
    const gatesCommand = commands.find((command) => command.name === "gates")
    expect(gatesCommand).toBeDefined()
    // The gates RPC surface is registered for the TUI picker; the model only
    // gets the read-only gates tool.
    expect(rpcRegistrations).toHaveLength(1)
    expect(rpcRegistrations[0]?.definition).toMatchObject({ id: "opencode-orchestrator.gates" })
    expect(typeof rpcRegistrations[0]?.handlers?.get).toBe("function")
    expect(typeof rpcRegistrations[0]?.handlers?.set).toBe("function")

    // The tool transform registers the goal family plus the read-only
    // per-session gates surface and the orchestrator-only github, worktree,
    // orchestration validation, publish policy, and peer discovery families
    // with their shared permission actions:
    // 3 goal + 1 gates + 11 github + 7 worktree + 3 validation + 1 publish + 2 peer = 28.
    const allToolNames = tools.map((tool) => `${tool.options?.namespace}_${tool.name}`)
    expect(allToolNames).toEqual([
      "orchestrator_goal_get",
      "orchestrator_goal_set",
      "orchestrator_goal_update",
      "orchestrator_gates_get",
      "orchestrator_github_capabilities",
      "orchestrator_github_repo_view",
      "orchestrator_github_issue_view",
      "orchestrator_github_issue_list",
      "orchestrator_github_issue_create",
      "orchestrator_github_pr_view",
      "orchestrator_github_pr_list",
      "orchestrator_github_pr_create",
      "orchestrator_github_pr_ready",
      "orchestrator_github_pr_approve",
      "orchestrator_github_pr_merge",
      "orchestrator_worktree_list",
      "orchestrator_worktree_create",
      "orchestrator_worktree_status",
      "orchestrator_worktree_sync",
      "orchestrator_worktree_push",
      "orchestrator_worktree_cleanup",
      "orchestrator_worktree_enter",
      "orchestrator_task_complexity_classify",
      "orchestrator_handoff_validate",
      "orchestrator_admission_transition",
      "orchestrator_publish_policy_get",
      "orchestrator_peer_list",
      "orchestrator_session_status",
    ])
    expect(allToolNames).toHaveLength(28)
    expect(tools.filter((tool) => tool.options?.permission === GH_TOOL_PERMISSION).length).toBe(11)
    expect(tools.filter((tool) => tool.options?.permission === WORKTREE_TOOL_PERMISSION).length).toBe(7)
    expect(tools.filter((tool) => tool.options?.permission === PUBLISH_TOOL_PERMISSION).length).toBe(1)
    expect(tools.filter((tool) => tool.options?.permission === PEER_TOOL_PERMISSION).length).toBe(2)
    // The read-only per-session gates surface shares its own permission action.
    const gatesTools = tools.filter((tool) => tool.options?.permission === GATES_TOOL_PERMISSION)
    expect(gatesTools.map((tool) => `${tool.options?.namespace}_${tool.name}`)).toEqual(["orchestrator_gates_get"])
    expect(gatesTools[0]?.options?.permission).toBe("orchestrator_gates")
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
    // The prompt-only vertical-slice MVP folds guidance into existing prompt
    // kinds: no new tool, command, schema, or gate surface is registered.
    const orchestratorSystem = agents.get("orchestrator")?.system ?? ""
    expect(orchestratorSystem).toContain("Prefer the smallest coherent end-to-end implementation slice over the smallest file or layer")
    expect(orchestratorSystem).toContain(
      "Unavoidable coupling between files is resolved by sequencing or serialization with integrated parent verification — never by concurrent overlapping writes.",
    )
    expect(orchestratorSystem).toContain("A slice is a coordination unit, never a permission or filesystem boundary")
    expect(orchestratorSystem).toContain("prefer coherent end-to-end slices")
    expect(orchestratorSystem).not.toMatch(/scheduler|semaphore/i)
    expect(orchestratorSystem).toContain("prompt-level disjoint write scopes do not equal filesystem isolation")

    const contextText: string[] = []
    contextHook?.({
      agent: "orchestrator",
      system: { push: (item: { text: string }) => void contextText.push(item.text) },
    })
    expect(contextText.join("\n")).toContain("orchestrator_goal_get")
    expect(contextText.join("\n")).toContain("orchestrator_goal_set")
    expect(contextText.join("\n")).toContain("orchestrator_goal_update")
    expect(contextText.join("\n")).toContain("Nested delegation is bounded to the role graph")
    expect(contextText.join("\n")).toContain("implementation→planning,research")
    expect(contextText.join("\n")).toContain("research→no delegation")
    expect(contextText.join("\n")).not.toContain("/cd")
    expect(contextText.join("\n")).toContain("orchestrator_worktree_create")
    expect(contextText.join("\n")).toContain("orchestrator_worktree_enter")
    expect(contextText.join("\n")).toContain("orchestrator_worktree_create -> orchestrator_worktree_enter -> delegate to the implementer")
    expect(contextText.join("\n")).toContain("GitHub lifecycle is enabled")
    // Per-session gates: the runtime context discloses the user-mediated
    // narrowing surface and the read-only inspection tool.
    expect(contextText.join("\n")).toContain("The user can narrow or disable individual gates for the current session with /gates or the TUI gate picker")
    expect(contextText.join("\n")).toContain("inspect the effective per-session gates with orchestrator_gates_get")
    expect(contextText.join("\n")).toContain("A gate disabled for this session is final")
    // Merge is autonomous (no separate user instruction) and the terminal-drive
    // Definition of Done is part of the orchestrator runtime context.
    expect(contextText.join("\n")).toContain("merge are autonomous when the durable publish capability and the per-session gates allow them")
    expect(contextText.join("\n")).toContain("no separate user merge instruction is required")
    expect(contextText.join("\n")).toContain("Definition of Done (terminal drive)")
    expect(contextText.join("\n")).toContain("orchestrator_task_complexity_classify")
    expect(contextText.join("\n")).toContain("orchestrator_handoff_validate")
    expect(contextText.join("\n")).toContain("orchestrator_admission_transition")
    expect(contextText.join("\n")).toContain("not an automatic gate")
    expect(contextText.join("\n")).toContain("exact disjoint write scope")
    expect(contextText.join("\n")).not.toMatch(/\bgoal_(get|set|update)\b/)
    // Publication and peer surfaces are part of the runtime context: the
    // capability toggle note and the peer-discovery disclosure are universal,
    // while the full publication policy appears only when publish.enabled.
    expect(contextText.join("\n")).toContain("/publish (status|enable|disable)")
    expect(contextText.join("\n")).toContain("capability toggle, not caller authentication")
    expect(contextText.join("\n")).toContain("same stable project only")
    expect(contextText.join("\n")).toContain("never live-complete")
    expect(contextText.join("\n")).not.toContain("Durable publication authorization is capability policy")

    await commands[0]?.execute({ sessionID: "session", prompt: { text: "fix the bug" }, delivery: "queue" })
    expect(switches).toEqual(["agent:orchestrator", "model:orchestrator-model"])
    expect(prompts[0].text).toContain("fix the bug")
    // The orchestrate prompt built by the prompt builder prefers a coherent
    // end-to-end slice before delegating parallel work.
    expect(prompts[0].text).toContain("prefer the smallest coherent end-to-end slice over a file-by-file or layer-by-layer split")
    expect(prompts[0].text).toContain("split only at a verified boundary and serialize unknown coupling")
    expect(prompts[0].delivery).toBe("queue")

    await cleanup?.()
    expect(disposed).toEqual(["execute.after", "session-hook", "rpc", "tool", "command", "agent"])
    // The worktree event sync registered its own real dispose, which closed
    // the subscribed event stream.
    expect(stream.closed).toBe(true)
  })

  test("enabled S3/V1 modes add their tools, gates, and hooks without breaking the default contract", async () => {
    const agents = seedAgents()
    const commands: Array<{ name: string; execute(input: any): Promise<void> }> = []
    const tools: Array<{
      name: string
      options?: { namespace?: string; permission?: string }
      execute(input: unknown, context: any): Promise<any>
    }> = []
    const disposed: string[] = []
    const switches: string[] = []
    const prompts: any[] = []
    const rpcRegistrations: Array<{ definition: any; handlers: any }> = []
    const stream = eventStream()
    let contextHook: ((event: any) => void) | undefined
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
        trace: { mode: "snapshot" },
        budget: { mode: "stop-between-steps", max_steps: 5, max_tokens: 1000 },
        review: { mode: "bounded", max_rounds: 2 },
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
        hook: async (name: string) => registration(name),
      },
      rpc: {
        register: async (definition: unknown, handlers: unknown) => {
          rpcRegistrations.push({ definition, handlers })
          return registration("rpc")
        },
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

    // The existing families are unchanged and the conditional tools are added.
    for (const name of [
      "orchestrator_goal_get",
      "orchestrator_handoff_validate",
      "orchestrator_admission_transition",
      "orchestrator_observability_get",
      "orchestrator_review_get",
      "orchestrator_review_transition",
    ]) {
      expect(tools.some((tool) => `${tool.options?.namespace}_${tool.name}` === name)).toBe(true)
    }
    expect(tools.filter((tool) => tool.options?.permission === OBSERVABILITY_TOOL_PERMISSION).map((tool) => tool.name).sort()).toEqual([
      "observability_get",
      "review_get",
      "review_transition",
    ])

    // The orchestrator system prompt embeds the bounded flow guidance.
    expect(agents.get("orchestrator")?.system).toContain("Bounded review mode is configured")
    expect(agents.get("orchestrator")?.system).toContain("stop-between-steps budget mode is configured")

    // With github and worktree disabled, the session context hook omits the
    // feature lifecycle lines entirely while keeping the universal guidance.
    const disabledContext: string[] = []
    contextHook?.({
      agent: "orchestrator",
      system: { push: (item: { text: string }) => void disabledContext.push(item.text) },
    })
    expect(disabledContext.join("\n")).toContain("orchestrator_goal_get")
    expect(disabledContext.join("\n")).not.toContain("orchestrator_worktree_create")
    expect(disabledContext.join("\n")).not.toContain("GitHub lifecycle is enabled")
    expect(disabledContext.join("\n")).not.toContain("orchestrator_github_pr_merge")
    // The terminal-drive Definition of Done is gated on github||publish too.
    expect(disabledContext.join("\n")).not.toContain("Definition of Done (terminal drive)")
    expect(disabledContext.join("\n")).toContain("orchestrator_task_complexity_classify")
    // The read-only gates surface and its user-mediated narrowing note are
    // universal context regardless of feature flags.
    expect(disabledContext.join("\n")).toContain("orchestrator_gates_get")
    expect(disabledContext.join("\n")).toContain("A gate disabled for this session is final")

    await cleanup?.()
    // Disposal order is reverse registration order: the worktree sync (inline
    // dispose, no named registration), the plugin's execute.after warn hook,
    // the session hook, the gates rpc, the tool/command/agent transforms, and
    // the observability runtime last (which disposes its before/after hooks).
    expect(disposed).toEqual(["execute.after", "session-hook", "rpc", "tool", "command", "agent", "execute.before", "execute.after"])
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
