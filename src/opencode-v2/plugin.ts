import { Plugin } from "@opencode-ai/plugin"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { parseOptions } from "../core/config.js"
import { applyAgentTransform, validateAgentSet, type AgentInfoLike } from "./agents.js"
import { applyCommandTransform } from "./commands/index.js"
import { runCommand } from "./commands/runtime.js"
import { startGoalContinuation } from "./goal/continuation.js"
import { addGoalTools } from "./goal/tools.js"
import { addGhTools } from "./gh/tools.js"
import { addWorktreeTools } from "./worktree/tools.js"
import { addOrchestrationTools } from "./orchestration/tools.js"
import { addObservabilityTools } from "./observability/tools.js"
import { createDispatchGate, shouldStartObservability, startObservability } from "./observability/runtime.js"
import { startWorktreeEventSync } from "./worktree/events.js"
import { SpawnRunner } from "./process/runner.js"
import { createSessionMoveCoordinator } from "./session/move-coordinator.js"
import { createWorkerModelRuntime, type WorkerModelRuntime } from "./worker-models/runtime.js"
import { DISTRIBUTION_NAME, RUNTIME_PLUGIN_ID } from "../core/package-identity.js"

export const orchestratorPlugin = (Plugin.define as any)({
  id: RUNTIME_PLUGIN_ID,
  tui: true,
  async setup(ctx: Context) {
    const options = parseOptions(ctx.options)
    const runner = new SpawnRunner()
    const workerModels = await createWorkerModelRuntime({
      storage: ctx.storage,
      location: ctx.location,
      options,
      runner,
      catalog: ctx.catalog,
      agent: ctx.agent,
    })
    const agentResponse = await ctx.agent.list()
    const agents = responseData<AgentInfoLike>(agentResponse)
    const agentIssues = validateAgentSet(agents, options)
    // Config-backed agents are materialized by a later built-in plugin during
    // beta startup. On 187xx the early list was an empty `{data:[]}` envelope;
    // on 18999 it is the built-in set (build/general/explore/...) without the
    // configured roles yet. Either shape means "pending", never fatal: warn
    // and finish via the `agent.updated` late setup instead of throwing.
    const missingAgents = requiredAgentIDs(options).filter((id) => !agents.some((agent) => agent.id === id))
    const pendingAgents = missingAgents.length > 0 || isEmptyResponse(agentResponse, agents)
    if (pendingAgents && agentIssues.length > 0) {
      console.warn(
        `${RUNTIME_PLUGIN_ID} agent setup is pending (config-backed agents not yet materialized): ${agentIssues.join("; ")}`,
      )
    } else if (agentIssues.length > 0 && options.strict_agents) {
      throw new Error(
        `${RUNTIME_PLUGIN_ID} agent setup failed: ${agentIssues.join("; ")}. Run ${DISTRIBUTION_NAME} install.`,
      )
    } else if (agentIssues.length > 0) {
      console.warn(`${RUNTIME_PLUGIN_ID} agent setup is partial: ${agentIssues.join("; ")}`)
    }

    const existingCommands = responseData<{ name: string }>(await ctx.command.list())
    // Optimistic when pending: assume all semantic roles so commands register
    // now; the late transform applies the system prompts once agents arrive.
    const semanticRoles = pendingAgents
      ? new Set(["orchestrator", ...Object.keys(options.roles)])
      : availableRoles(agents, options)
    const registrations: Array<{ dispose(): Promise<void> }> = []
    const lateAgentSetup = pendingAgents ? startLateAgentSetup(ctx, options, workerModels) : undefined

    // S3/V1 observability runtime: started only when trace, stop-between-steps
    // budget, or bounded review is configured. Defaults keep the previous
    // behavior exactly (no extra hooks, events, tools, or gates).
    const observability = shouldStartObservability(options)
      ? await startObservability({ options, event: ctx.event, tool: ctx.tool, storage: ctx.storage, location: ctx.location })
      : undefined
    if (observability) registrations.push({ dispose: () => observability.dispose() })
    const controlGate = createDispatchGate({ options, storage: ctx.storage, location: ctx.location, runtime: observability })
    const moveCoordinator = createSessionMoveCoordinator()

    try {
      registrations.push(
        await ctx.agent.transform((draft) => {
          applyAgentTransform(draft, options, workerModels.overrides)
        }),
      )

      let commandResult = { collisions: [] as string[], unavailable: [] as string[] }
      registrations.push(
        await ctx.command.transform((draft) => {
          commandResult = applyCommandTransform(
            draft,
            options,
            (name, input) => runCommand(ctx, options, name, input, undefined, controlGate, workerModels),
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
          addGhTools(draft, { storage: ctx.storage, runner, location: ctx.location, options })
          addWorktreeTools(draft, {
            storage: ctx.storage,
            runner,
            location: ctx.location,
            options,
            session: ctx.session,
            moveCoordinator,
          })
          addOrchestrationTools(draft, {
            options,
            location: ctx.location,
            session: ctx.session,
            vcs: ctx.vcs,
          })
          addObservabilityTools(draft, {
            options,
            storage: ctx.storage,
            location: ctx.location,
            runtime: observability,
          })
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
              ...(options.worktree.enabled
                ? [
                    "Use orchestrator_worktree_list, orchestrator_worktree_create, orchestrator_worktree_status, orchestrator_worktree_enter, orchestrator_worktree_push, and orchestrator_worktree_cleanup only for the current session's managed worktree; delegated children get no atomic isolation.",
                    "Worktree lifecycle is enabled and orchestrator-owned: implementation delegation MUST be preceded by orchestrator_worktree_create -> orchestrator_worktree_enter -> delegate to the implementer. orchestrator_worktree_enter moves only the current session into its tracked worktree (session ID and history preserved); children delegated afterward inherit or start from that context. Only the orchestrator creates, enters, pushes, and cleans up managed worktrees. When the worktree tools, a whitelisted worktree.root, allow_mutations, a ready tracked worktree, or a successful worktree_enter are unavailable, stop and ask the user instead of delegating implementation from the main checkout.",
                  ]
                : []),
              ...(options.github.enabled
                ? [
                    "GitHub lifecycle is enabled and orchestrator-owned: preflight with orchestrator_github_capabilities; implementers never push branches or create/merge pull requests. The orchestrator pushes the branch and creates the pull request only after validated maker/checker review and direct verification, and merges only after a separate explicit user request: a fresh orchestrator_github_pr_view with the exact expected head SHA, a literal confirm: true, and post-merge verification. confirm: true and checker approval are never user authorization; stale, refused, or failed merges stop truthfully.",
                  ]
                : []),
              "Use orchestrator_task_complexity_classify (advisory, user-overridable), orchestrator_handoff_validate (callable, not an automatic gate), and orchestrator_admission_transition (stateless) to classify complexity, validate worker handoffs before downstream use, and track admission state.",
              "Use the handoff format from the agent instructions and report direct verification evidence.",
              ...(options.review.mode === "bounded"
                ? [
                    "Bounded review is enabled: use orchestrator_review_get and orchestrator_review_transition (start -> delegate reviewer -> record fixed checks/decision -> map through orchestrator_admission_transition) and stop when the record is blocked or tripped.",
                  ]
                : []),
              ...(options.budget.mode === "stop-between-steps"
                ? [
                    "stop-between-steps budget is enabled: plugin-owned next dispatches are checked against the configured limits before dispatch; inspect orchestrator_observability_get for the evaluation.",
                  ]
                : []),
              ...(options.trace.mode !== "off"
                ? ["Trace is enabled: orchestrator_observability_get reads the bounded metadata summary and budget evaluation for a session."]
                : []),
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

      // Anchor reconciliation for `session.moved` events (native moves and
      // orchestrator_worktree_enter): relocates the durable anchor to the new
      // project, preserves the origin, and marks any tracked worktree owned by
      // the moved session as moved.
      const stopWorktreeEventSync = startWorktreeEventSync({ ...ctx, moveCoordinator }, options)
      registrations.push({
        dispose: async () => {
          moveCoordinator.dispose()
          await stopWorktreeEventSync()
        },
      })

      const stopContinuation = options.goal.auto_continue ? startGoalContinuation(ctx, options, controlGate) : undefined
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
  workerModels: WorkerModelRuntime,
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
          applyAgentTransform(draft, options, workerModels.overrides)
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
