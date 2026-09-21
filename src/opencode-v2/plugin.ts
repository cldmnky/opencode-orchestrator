import type { Context } from "@opencode/plugin/promise/plugin"
import { defineTuiAwarePlugin, type ToolDefinition, type ToolDraftLike } from "./compat.js"
import { parseOptions } from "../core/config.js"
import { delegationGraphSummary } from "../core/roles.js"
import { PEER_DISCOVERY_GUIDANCE, PUBLICATION_POLICY_GUIDANCE, terminalDriveGuidance } from "../core/policy.js"
import { applyAgentTransform, validateAgentSet, type AgentInfoLike } from "./agents.js"
import { applyCommandTransform } from "./commands/index.js"
import { runCommand } from "./commands/runtime.js"
import { startGoalContinuation } from "./goal/continuation.js"
import { addGoalTools } from "./goal/tools.js"
import { addGatesTools } from "./gates/tools.js"
import { gatesRpcDefinition, parseGatesGetInput, parseGatesSetInput } from "./gates/rpc.js"
import { gateChangeMessage, gateStatuses, setGateDisabled } from "./gates/state.js"
import { diagnosticsRpcDefinition } from "./diagnostics-rpc.js"
import { parseProgressInput, progressRpcDefinition, unavailableProgressView } from "./progress/rpc.js"
import { buildProgressView } from "./progress/status.js"
import { createStateRpcHandlers, stateRpcDefinition } from "./state-rpc.js"
import { countLegacyState } from "./state-recovery.js"
import { addGhTools } from "./gh/tools.js"
import { addWorktreeTools } from "./worktree/tools.js"
import { addOrchestrationTools } from "./orchestration/tools.js"
import { addObservabilityTools } from "./observability/tools.js"
import { addPublishTools } from "./publish/tools.js"
import { addPeerTools } from "./peers/tools.js"
import { createDispatchGate, shouldStartObservability, startObservability } from "./observability/runtime.js"
import { createRetryPolicy, retryPolicyEnabled } from "./observability/retry.js"
import { shouldStartAuthority, startAuthority } from "./authority/runtime.js"
import { addAuthorityTools } from "./authority/tools.js"
import { startWorktreeEventSync } from "./worktree/events.js"
import { SpawnRunner } from "./process/runner.js"
import { createSessionMoveCoordinator } from "./session/move-coordinator.js"
import { createWorkerModelRuntime, type WorkerModelRuntime } from "./worker-models/runtime.js"
import { startVerificationRuntime } from "./verification/runtime.js"
import { addVerificationTools } from "./verification/tools.js"
import { startDispatchAdmission } from "./dispatch/runtime.js"
import { redact } from "./process/redact.js"
import { DISTRIBUTION_NAME, RUNTIME_PLUGIN_ID } from "../core/package-identity.js"

export const orchestratorPlugin = defineTuiAwarePlugin({
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
    const registeredToolNames = new Set<string>()
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

    // N5 bounded retry policy (opt-in): when `retry.mode: "bounded"` is
    // configured, one session retry hook is registered below and filtered to
    // orchestrator sessions. `retry.mode: "off"` (the default) creates no
    // policy and registers no hook, so every existing behavior stays
    // byte-identical. The host's own maximum attempt count stays the hard limit.
    const retryPolicy = retryPolicyEnabled(options)
      ? createRetryPolicy({ options, storage: ctx.storage, location: ctx.location })
      : undefined

    // Phase A runtime authority (opt-in): N1 admission/permission enforcement
    // and N2 child-only containment. `authority.mode: "off"` (the default)
    // registers nothing and leaves the default setup byte-identical. In enforce
    // mode the runtime also records durable effective-authority snapshots
    // (authority/v1) after rule install; snapshots never gate.
    const authority = shouldStartAuthority(options)
      ? await startAuthority({
          options,
          gate: controlGate,
          session: ctx.session,
          permission: ctx.permission,
          storage: ctx.storage,
          location: ctx.location,
        })
      : undefined
    if (authority) registrations.push({ dispose: () => authority.dispose() })

    try {
      registrations.push(
        await startVerificationRuntime({
          options,
          storage: ctx.storage,
          location: ctx.location,
          session: ctx.session,
          tool: ctx.tool,
          runner,
          redact,
        }),
      )

      registrations.push(
        await startDispatchAdmission({
          options,
          session: ctx.session,
          tool: ctx.tool,
        }),
      )

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
          const trackedDraft: ToolDraftLike = {
            add: (tool: ToolDefinition) => {
              if (typeof tool.name === "string") registeredToolNames.add(tool.name)
              draft.add(tool)
            },
          }
          addGoalTools(trackedDraft, ctx.storage, ctx.location, options)
          addGatesTools(trackedDraft, { storage: ctx.storage, location: ctx.location, options })
          addGhTools(trackedDraft, { storage: ctx.storage, runner, location: ctx.location, options })
          addWorktreeTools(trackedDraft, {
            storage: ctx.storage,
            runner,
            location: ctx.location,
            options,
            session: ctx.session,
            moveCoordinator,
          })
          addOrchestrationTools(trackedDraft, {
            options,
            location: ctx.location,
            storage: ctx.storage,
            session: ctx.session,
            vcs: ctx.vcs,
          })
          addVerificationTools(trackedDraft, { options, storage: ctx.storage, location: ctx.location, session: ctx.session })
          addAuthorityTools(trackedDraft, { options, storage: ctx.storage, location: ctx.location })
          addObservabilityTools(trackedDraft, {
            options,
            storage: ctx.storage,
            location: ctx.location,
            session: ctx.session,
            runtime: observability,
          })
          addPublishTools(trackedDraft, { storage: ctx.storage, location: ctx.location, options })
          addPeerTools(trackedDraft, { storage: ctx.storage, location: ctx.location, options })
        }),
      )

      registrations.push(
        await ctx.rpc.register(gatesRpcDefinition, {
          get: async (input) => {
            const parsed = parseGatesGetInput(input)
            if (!parsed) return { sessionID: "", gates: [], message: "sessionID is required" }
            return { sessionID: parsed.sessionID, gates: await gateStatuses(ctx.storage, ctx.location, parsed.sessionID, options) }
          },
          set: async (input) => {
            const parsed = parseGatesSetInput(input)
            if (!parsed) return { sessionID: "", gates: [], message: "sessionID, gate, and disabled are required" }
            await setGateDisabled(ctx.storage, parsed.sessionID, parsed.gate, parsed.disabled)
            const gates = await gateStatuses(ctx.storage, ctx.location, parsed.sessionID, options)
            const status = gates.find((candidate) => candidate.gate === parsed.gate)
            return {
              sessionID: parsed.sessionID,
              gates,
              ...(status ? { message: gateChangeMessage(status) } : {}),
            }
          },
        }),
      )

      registrations.push(
        await ctx.rpc.register(diagnosticsRpcDefinition, {
          get: async () => {
            return {
              pluginID: RUNTIME_PLUGIN_ID,
              githubCapabilityProbe: {
                available: registeredToolNames.has("github_capabilities"),
                configured: options.github.enabled,
              },
              worktreeTools: {
                available: registeredToolNames.has("worktree_list"),
                configured: options.worktree.enabled,
              },
              tuiExport: { observable: true, available: true },
              legacyStateCount: await countLegacyState(ctx.storage),
            }
          },
        }),
      )

      // Read-only progress for the CLI plugin.  The TUI is a separate plugin
      // instance and must use this RPC rather than importing server storage or
      // durable-state modules directly.
      registrations.push(
        await ctx.rpc.register(progressRpcDefinition, {
          get: async (input) => {
            const parsed = parseProgressInput(input)
            if (!parsed) return unavailableProgressView("unknown", "sessionID is required")
            try {
              return await buildProgressView({ storage: ctx.storage, location: ctx.location, options, observability }, parsed.sessionID)
            } catch {
              return unavailableProgressView(parsed.sessionID, "progress state could not be assembled")
            }
          },
        }),
      )

      // State recovery is operator-owned and deliberately not a model tool.
      // Older/embedded hosts may not expose storage.scan; in that case do not
      // register a misleading destructive surface and let the CLI report the
      // unavailable backend explicitly.
      if (typeof (ctx.storage as unknown as { scan?: unknown }).scan === "function") {
        registrations.push(await ctx.rpc.register(stateRpcDefinition, createStateRpcHandlers(ctx.storage)))
      }

      registrations.push(
        await ctx.session.hook("context", (event) => {
          if (event.agent !== options.orchestrator) return
          event.system.push({
            type: "text",
            text: [
              `Runtime role map: planning=${options.roles.planning}; research=${options.roles.research}; implementation=${options.roles.implementation}; review=${options.roles.review}.`,
              `Configured dispatch admission: max_parallel=${options.max_parallel} for configured-role subagent calls in this plugin process; it is not a scheduler or cross-process limit.`,
              "Delegate with the child-task contract: Task, Expected outcome, Scope/file ownership, Must do, Must not do, Verification, and handoff.",
              `Nested delegation is bounded to the role graph: ${delegationGraphSummary()}.`,
              "A delegating worker stays accountable for its children, and research never delegates.",
              "Parallel writes require an exact disjoint write scope from every child.",
              "Separate established facts from assumptions.",
              "Use orchestrator_goal with get, set, pause, resume, complete, or clear actions for session goal state.",
              "Use orchestrator_board_get and orchestrator_board_action for the durable lead board. Use action variants init, create-task, assign-task, transition, or complete; a delivered prompt never completes a task.",
              "Use orchestrator_status with mode single and sessionID for one-session detail, or mode list for a bounded same-project session list.",
              ...(options.review.mode === "bounded"
                ? ["After plugin-observed validation, start review directly with orchestrator_review_start; review start and submit apply the legal board state internally."]
                : []),
              "Inspect or toggle the durable project-scoped publication capability with /publish (status|enable|disable).",
              "It is a capability toggle, not caller authentication.",
              "It never mutates Git or GitHub and never weakens the static github/worktree gates.",
              "The user can narrow or disable individual gates for the current session with /gates or the TUI gate picker.",
              "Then inspect the effective per-session gates with orchestrator_gates_get.",
              "A gate disabled for this session is final: never re-enable it yourself, never work around it, and report the refusing step truthfully.",
              PEER_DISCOVERY_GUIDANCE,
              ...(options.worktree.enabled
                ? [
                    "Use orchestrator_worktree_list, orchestrator_worktree_create, orchestrator_worktree_status, orchestrator_worktree_sync, orchestrator_worktree_enter, orchestrator_worktree_push, and orchestrator_worktree_cleanup only for the current session's managed worktree.",
                    "Delegated children get no atomic isolation.",
                    "Worktree lifecycle is enabled and orchestrator-owned.",
                    "Implementation delegation MUST be preceded by orchestrator_worktree_create -> orchestrator_worktree_enter -> delegate to the implementer.",
                    "orchestrator_worktree_enter moves only the current session into its tracked worktree; session ID and history are preserved.",
                    "Children delegated afterward inherit or start from that context.",
                    "Only the orchestrator creates, enters, pushes, and cleans up managed worktrees.",
                    "A pending or failed worktree_enter result is not a successful receipt: wait for the V2 safe boundary and retry until entered:true before delegating.",
                    "When any of these is unavailable, stop and ask the user instead of delegating implementation from the main checkout:",
                    "the worktree tools;",
                    "a whitelisted worktree.root;",
                    "allow_mutations;",
                    "a ready tracked worktree;",
                    "a successful worktree_enter result.",
                  ]
                : []),
              ...(options.github.enabled
                ? [
                    "GitHub lifecycle is enabled and orchestrator-owned.",
                    "Preflight with orchestrator_github_capabilities; implementers never push branches or create/merge pull requests.",
                    "The orchestrator pushes the branch and creates the pull request only after validated maker/checker review and direct verification.",
                    "Pushing, draft PR creation, the ready transition, approval, and merge are autonomous when the durable publish capability and the per-session gates allow them.",
                    "That means no separate user merge instruction is required.",
                    "Merge still runs the full fail-closed chain (fresh exact-SHA conflict-free view, exact-revision approved internal review, base ancestry, post-merge verification).",
                    "It stops truthfully on stale, refused, conflicted, or branch-protected states.",
                    "A gate disabled for this session or a missing capability stops the chain truthfully.",
                  ]
                : []),
              ...(options.publish.enabled ? [PUBLICATION_POLICY_GUIDANCE] : []),
              ...(options.github.enabled || options.publish.enabled ? [terminalDriveGuidance(options)] : []),
              "Use orchestrator_verification_get after lead shell checks to discover bounded receipt IDs; pass those IDs, never caller-supplied pass labels, to lead validation.",
              "Use orchestrator_handoff_validate (callable, not an automatic gate) before using a worker handoff downstream.",
              "Use the handoff format from the agent instructions and report direct verification evidence.",
              ...(options.review.mode === "bounded"
                ? [
                    "Bounded review is enabled.",
                    "Use orchestrator_review_get and orchestrator_review_start from the lead; delegate the configured reviewer child and have it call orchestrator_review_submit.",
                    "Review start and submit apply legal board state internally; no separate transition call is required for the review flow.",
                    "V2 submit derives reviewer agent/session identity from ToolContext; V1 records are legacy-unproven and never publication or completion proof.",
                    "Stop when the record is blocked or tripped.",
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
              ...(options.authority.mode === "enforce"
                ? [
                    "Runtime authority is in enforce mode: tagged plugin dispatches are checked before admission and configured-role children get tool-action containment.",
                    "Use orchestrator_authority_get (read-only) to inspect the recorded effective-authority snapshot for a session.",
                    "Snapshots never change admission decisions, and containment is not filesystem or process isolation.",
                  ]
                : []),
            ].join("\n"),
          })
        }),
      )

      // N5 bounded retry policy (opt-in): the hook is registered only when
      // `retry.mode: "bounded"` is configured. It filters to orchestrator
      // sessions inside the handler and never throws into the model request;
      // disposal is handled by the shared registration cleanup below.
      if (retryPolicy) {
        registrations.push(await ctx.session.hook("retry", (event) => retryPolicy.observe(event)))
      }

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
