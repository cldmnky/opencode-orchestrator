import { Plugin } from "@opencode-ai/plugin"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { parseOptions } from "../core/config.js"
import { applyAgentTransform, validateAgentSet, type AgentInfoLike } from "./agents.js"
import { applyCommandTransform } from "./commands/index.js"
import { runCommand } from "./commands/runtime.js"
import { startGoalContinuation } from "./goal/continuation.js"
import { addGoalTools } from "./goal/tools.js"
import { DISTRIBUTION_NAME, RUNTIME_PLUGIN_ID } from "../core/package-identity.js"

export const orchestratorPlugin = Plugin.define({
  id: RUNTIME_PLUGIN_ID,
  tui: true,
  async setup(ctx: Context) {
    const options = parseOptions(ctx.options)
    const agentResponse = await ctx.agent.list()
    const agents = responseData<AgentInfoLike>(agentResponse)
    const bootstrapIsEmpty = isEmptyResponse(agentResponse, agents)
    const agentIssues = validateAgentSet(agents, options)
    if (!bootstrapIsEmpty && agentIssues.length > 0 && options.strict_agents) {
      throw new Error(
        `${RUNTIME_PLUGIN_ID} agent setup failed: ${agentIssues.join("; ")}. Run ${DISTRIBUTION_NAME} install.`,
      )
    }
    if (!bootstrapIsEmpty && agentIssues.length > 0) {
      console.warn(`${RUNTIME_PLUGIN_ID} agent setup is partial: ${agentIssues.join("; ")}`)
    }

    const existingCommands = responseData<{ name: string }>(await ctx.command.list())
    // Config-backed agents are loaded by a later built-in plugin during startup.
    // An empty response is therefore not evidence that the configured roles are missing.
    const semanticRoles = bootstrapIsEmpty
      ? new Set(["orchestrator", ...Object.keys(options.roles)])
      : availableRoles(agents, options)
    const registrations: Array<{ dispose(): Promise<void> }> = []
    const lateAgentSetup = bootstrapIsEmpty ? startLateAgentSetup(ctx, options) : undefined

    try {
      registrations.push(
        await ctx.agent.transform((draft) => {
          applyAgentTransform(draft, options)
        }),
      )

      let commandResult = { collisions: [] as string[], unavailable: [] as string[] }
      registrations.push(
        await ctx.command.transform((draft) => {
          commandResult = applyCommandTransform(
            draft,
            options,
            (name, input) => runCommand(ctx, options, name, input, undefined),
            new Set(existingCommands.map((command) => command.name)),
            semanticRoles,
          )
        }),
      )
      if (commandResult.collisions.length > 0) {
        console.warn(`${RUNTIME_PLUGIN_ID} preserved existing commands: ${commandResult.collisions.join(", ")}`)
      }
      if (commandResult.unavailable.length > 0) {
        console.warn(`${RUNTIME_PLUGIN_ID} omitted commands with unavailable roles: ${commandResult.unavailable.join(", ")}`)
      }

      registrations.push(
        await ctx.tool.transform((draft) => {
          addGoalTools(draft, ctx.storage, ctx.location, options)
        }),
      )

      registrations.push(
        await ctx.session.hook("context", (event) => {
          if (event.agent !== options.orchestrator) return
          event.system.push({
            type: "text",
            text: [
              `Runtime role map: planning=${options.roles.planning}; research=${options.roles.research}; implementation=${options.roles.implementation}; review=${options.roles.review}.`,
              `Runtime parallelism ceiling: ${options.max_parallel}.`,
              "Delegate with the child-task contract: Task, Expected outcome, Scope/file ownership, Must do, Must not do, Verification, and handoff.",
              "Parallel writes require an exact disjoint write scope from every child; separate established facts from assumptions.",
              "Use orchestrator_goal_get, orchestrator_goal_set, and orchestrator_goal_update for session goal state.",
              "Use the handoff format from the agent instructions and report direct verification evidence.",
            ].join("\n"),
          })
        }),
      )

      registrations.push(
        await ctx.tool.hook("execute.after", (event) => {
          if (event.status === "error" && event.tool.startsWith("orchestrator_")) {
            console.warn(`${RUNTIME_PLUGIN_ID} tool failed: ${event.error.message}`)
          }
        }),
      )

      const stopContinuation = options.goal.auto_continue ? startGoalContinuation(ctx, options) : undefined
      return async () => {
        await stopContinuation?.()
        await lateAgentSetup?.stop()
        const lateRegistration = await lateAgentSetup?.registration
        if (lateRegistration) await lateRegistration.dispose()
        for (const registration of [...registrations].reverse()) await registration.dispose()
      }
    } catch (error) {
      await lateAgentSetup?.stop()
      const lateRegistration = await lateAgentSetup?.registration
      if (lateRegistration) await lateRegistration.dispose()
      for (const registration of [...registrations].reverse()) await registration.dispose()
      throw error
    }
  },
})

function availableRoles(agents: readonly AgentInfoLike[], options: ReturnType<typeof parseOptions>): Set<string> {
  const ids = new Set(agents.map((agent) => agent.id))
  const roles = new Set<string>()
  if (ids.has(options.orchestrator)) roles.add("orchestrator")
  for (const [role, id] of Object.entries(options.roles)) {
    if (ids.has(id)) roles.add(role)
  }
  return roles
}

function responseData<T>(response: unknown): T[] {
  if (Array.isArray(response)) return response as T[]
  if (response && typeof response === "object" && Array.isArray((response as { data?: unknown }).data)) {
    return (response as { data: T[] }).data
  }
  return []
}

function isEmptyResponse(response: unknown, data: readonly unknown[]): boolean {
  return (
    data.length === 0 &&
    response !== null &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    Array.isArray((response as { data?: unknown }).data)
  )
}

function startLateAgentSetup(
  context: Context,
  options: ReturnType<typeof parseOptions>,
): { stop(): Promise<void>; registration: Promise<{ dispose(): Promise<void> } | undefined> } {
  const controller = new AbortController()
  const iterable = context.event.subscribe({ signal: controller.signal })
  const iterator = iterable[Symbol.asyncIterator]()
  let stopped = false
  let settled = false
  let resolveRegistration!: (registration: { dispose(): Promise<void> } | undefined) => void
  const registration = new Promise<{ dispose(): Promise<void> } | undefined>((resolve) => {
    resolveRegistration = resolve
  })
  let closing: Promise<void> | undefined

  void consume()

  return { stop, registration }

  async function stop(): Promise<void> {
    if (closing) return closing
    stopped = true
    controller.abort()
    settle(undefined)
    closing = (async () => {
      try {
        await iterator.return?.()
      } catch (error) {
        console.warn(`${RUNTIME_PLUGIN_ID} could not close late agent setup`, error)
      }
    })()
    await closing
  }

  async function consume(): Promise<void> {
    try {
      while (!stopped) {
        const next = await iterator.next()
        if (next.done || stopped) return
        if (!isAgentUpdate(next.value)) continue

        const current = responseData<AgentInfoLike>(await context.agent.list())
        const issues = validateAgentSet(current, options)
        if (issues.length > 0) {
          if (!requiredAgentIDs(options).some((id) => !current.some((agent) => agent.id === id))) {
            console.warn(`${RUNTIME_PLUGIN_ID} could not finalize configured agents: ${issues.join("; ")}`)
          }
          continue
        }

        const lateRegistration = await context.agent.transform((draft) => {
          applyAgentTransform(draft, options)
        })
        if (stopped) {
          await lateRegistration.dispose()
        } else {
          settle(lateRegistration)
        }
        return
      }
    } catch (error) {
      if (!stopped) console.warn(`${RUNTIME_PLUGIN_ID} could not finalize configured agents`, error)
    } finally {
      controller.abort()
      await iterator.return?.()
      settle(undefined)
    }
  }

  function settle(value: { dispose(): Promise<void> } | undefined): void {
    if (settled) return
    settled = true
    resolveRegistration(value)
  }
}

function isAgentUpdate(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "agent.updated")
}

function requiredAgentIDs(options: ReturnType<typeof parseOptions>): string[] {
  return [options.orchestrator, ...Object.values(options.roles)]
}
