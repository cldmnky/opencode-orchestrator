import type { Definition } from "@opencode/plugin/tui/plugin"
import type { Context, KeymapCommand } from "@opencode/plugin/tui/context"
import { commandDefinitions, tuiCommandSurface, type CommandName } from "./opencode-v2/commands/index.js"
import { gatesRpcDefinition, parseGatesView } from "./opencode-v2/gates/rpc.js"
import type { GateStatus } from "./opencode-v2/gates/state.js"
import { parseOptions, type OrchestratorOptions } from "./core/config.js"
import { formatModelReference, parseModelReference, type ModelReference } from "./core/model-reference.js"
import { workerAgentRoles } from "./core/roles.js"
import { RUNTIME_PLUGIN_ID } from "./core/package-identity.js"
import { filterOrchestratorSessions, renderSidebar, type SessionStatus, type SidebarTheme } from "./tui/sidebar.js"
import { formatProgressDetail } from "./tui/progress.js"
import { parseProgressView, progressRpcDefinition, unavailableProgressView, type ProgressView } from "./opencode-v2/progress/rpc.js"

export const tuiPlugin = {
  id: RUNTIME_PLUGIN_ID,
  async setup(context: Context) {
    const options = parseOptions(context.options)
    const location = context.location ?? context.data.location.default()
    const progress = createProgressCache(context, location, options)

    const stopFailureNotice = context.data.on("session.execution.failed", (event) => {
      const sessionID = event.data.sessionID
      if (activeSessionID(context) !== sessionID) return
      context.ui.toast.show({
        title: "Orchestrator",
        message: "The current orchestration turn failed. Inspect the session for details.",
        variant: "error",
      })
    })

    const refreshCommands = () => {
      context.data.location.command.invalidate(location)
      void context.data.location.command.sync(location)
    }
    const stopCommandUpdates = context.data.on("command.updated", refreshCommands)

    // Keymap layers are owned by a component rendered inside the host's
    // providers; `setup` runs outside them, so calling `keymap.layer` here
    // throws "Keymap.Provider is missing". Register the layer from the
    // always-mounted app slot's render component instead.
    const stopLayer = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => {
          const available = new Map(
            (context.data.location.command.list(location) ?? []).map((command) => [command.name, command.description]),
          )
          return {
            mode: "global",
            priority: 20,
            commands: [
              ...commandDefinitions(options)
                .filter(
                  (spec) => available.get(spec.name) === spec.description && tuiCommandSurface(spec.name) === "palette",
                )
                .map((spec) => tuiCommand(context, spec.name, spec.description)),
              progressCommand(context, progress),
            ],
          }
        })
        return null
      },
    })

    // Read-only live sidebar list of orchestrator sessions. Requires session
    // tabs to derive the "busy" state, so hosts without tabs skip it entirely.
    const stopSidebar = registerSidebar(context, options, progress)

    try {
      await context.data.location.command.sync(location)
    } catch (error) {
      stopFailureNotice()
      stopCommandUpdates()
      stopLayer()
      stopSidebar?.()
      progress.clear()
      throw error
    }

    return () => {
      stopFailureNotice()
      stopCommandUpdates()
      stopLayer()
      stopSidebar?.()
      progress.clear()
    }
  },
} satisfies Definition

/**
 * Registers the read-only `sidebar.content` orchestrator session list.
 *
 * The contribution is strictly read-only: it only reads reactive client
 * caches (`context.data.session.*`, `context.ui.tabs`) and subscribes to
 * events to invalidate/sync those caches. It never writes storage, git,
 * GitHub, commands, prompts, or mutations, and it never reads server
 * storage directly. Because the "busy" state comes from session tabs, hosts
 * that do not expose `context.ui.tabs` skip the contribution entirely.
 */
type ProgressCacheState = {
  summaries: Record<string, ProgressView | null>
}

type ProgressCache = {
  refresh(sessionID: string): Promise<ProgressView | undefined>
  refreshVisible(): Promise<void>
  get(sessionID: string): ProgressView | undefined
  values(sessionIDs: readonly string[]): ProgressView[]
  clear(): void
}

/**
 * Client-local, ephemeral progress cache.  The server RPC is the only source
 * of durable state; `memory` is used only to make slot renders reactive and to
 * avoid a second sidebar/state implementation in the TUI plugin.
 */
function createProgressCache(context: Context, location: { directory: string }, options: OrchestratorOptions): ProgressCache {
  const contextWithStorage = context as Context & {
    storage?: {
      memory?: (
        key: string,
        options: { initial: ProgressCacheState },
      ) => readonly [ProgressCacheState, (mutation: (draft: ProgressCacheState) => void) => void]
    }
  }
  const memory = contextWithStorage.storage?.memory
  const [state, setState]: readonly [
    ProgressCacheState,
    ((mutation: (draft: ProgressCacheState) => void) => void) | undefined,
  ] = memory
    ? memory(`${RUNTIME_PLUGIN_ID}.progress.${location.directory}`, { initial: { summaries: {} } })
    : [({ summaries: {} } satisfies ProgressCacheState), undefined]
  const update = (mutation: (draft: ProgressCacheState) => void): void => {
    if (setState) setState(mutation)
    else mutation(state)
  }
  const inFlight = new Set<string>()

  return { refresh, refreshVisible, get, values, clear }

  async function refresh(sessionID: string): Promise<ProgressView | undefined> {
    if (!sessionID || inFlight.has(sessionID)) return get(sessionID)
    const visible = visibleSessionIDs()
    if (!visible.includes(sessionID)) return get(sessionID)
    inFlight.add(sessionID)
    try {
      const client = (context as unknown as { client?: { rpc?: (definition: unknown) => { get(input: unknown, options: unknown): Promise<unknown> } } }).client
      if (!client?.rpc) throw new Error("progress RPC is unavailable")
      const rpc = client.rpc(progressRpcDefinition)
      const raw = await rpc.get({ sessionID }, { location })
      const view = parseProgressView(raw)
      const result = view ?? unavailableProgressView(sessionID, "progress RPC returned an invalid response")
      update((draft) => {
        draft.summaries[sessionID] = result ?? null
      })
      return result
    } catch {
      // A server plugin from before Phase 9, a disconnected remote, or a
      // malformed response is represented as unknown.  Do not print transport
      // errors or retain arbitrary response text in the TUI cache.
      update((draft) => {
        draft.summaries[sessionID] = unavailableProgressView(sessionID, "progress RPC is unavailable")
      })
      return get(sessionID)
    } finally {
      inFlight.delete(sessionID)
    }
  }

  async function refreshVisible(): Promise<void> {
    const sessionIDs = visibleSessionIDs()
    const visible = new Set(sessionIDs)
    update((draft) => {
      for (const sessionID of Object.keys(draft.summaries)) {
        if (!visible.has(sessionID)) delete draft.summaries[sessionID]
      }
    })
    await Promise.all(sessionIDs.map((sessionID) => refresh(sessionID)))
  }

  function get(sessionID: string): ProgressView | undefined {
    return state.summaries[sessionID] ?? undefined
  }

  function values(sessionIDs: readonly string[]): ProgressView[] {
    return sessionIDs.map((sessionID) => state.summaries[sessionID]).filter((value): value is ProgressView => value !== null && value !== undefined)
  }

  function clear(): void {
    update((draft) => {
      draft.summaries = {}
    })
  }

  function visibleSessionIDs(): string[] {
    const sessions = context.data.session?.list?.() ?? []
    return filterOrchestratorSessions(sessions, options.orchestrator).map((session) => session.id)
  }
}

function progressCommand(context: Context, progress: ProgressCache): KeymapCommand {
  return {
    id: `${RUNTIME_PLUGIN_ID}.progress`,
    title: "View orchestrator progress",
    description: "Read-only goal, board, review, budget, worktree, and gate details",
    group: "OpenCode Orchestrator",
    palette: true,
    enabled: () => activeSessionID(context) !== undefined,
    run: async () => {
      const sessionID = activeSessionID(context)
      if (!sessionID) {
        context.ui.toast.show({ title: "Orchestrator", message: "Open a session before viewing progress.", variant: "warning" })
        return
      }
      const view = (await progress.refresh(sessionID)) ?? progress.get(sessionID)
      if (!view) {
        await context.ui.dialog.alert({
          title: "Orchestrator progress",
          message: "Progress is unknown or unavailable. The server plugin may be older, disconnected, or still loading.",
        })
        return
      }
      await context.ui.dialog.alert({ title: "Orchestrator progress", message: formatProgressDetail(view) })
    },
  }
}

function registerSidebar(context: Context, options: OrchestratorOptions, progress: ProgressCache): (() => void) | undefined {
  if (!context.ui.tabs) return undefined

  const refresh = (sessionID: string): void => {
    context.data.session.invalidate(sessionID)
    void context.data.session.sync(sessionID)
  }
  const refreshWithProgress = (sessionID: string): void => {
    refresh(sessionID)
    void progress.refresh(sessionID)
  }
  const stopRefresh = [
    context.data.on("session.execution.started", (event) => refreshWithProgress(event.data.sessionID)),
    context.data.on("session.execution.succeeded", (event) => refreshWithProgress(event.data.sessionID)),
    context.data.on("session.execution.failed", (event) => refreshWithProgress(event.data.sessionID)),
    context.data.on("session.execution.interrupted", (event) => refreshWithProgress(event.data.sessionID)),
    context.data.on("session.status", (event) => refreshWithProgress(event.data.sessionID)),
    context.data.on("session.idle", (event) => refreshWithProgress(event.data.sessionID)),
    context.data.on("session.usage.updated", (event) => refreshWithProgress(event.data.sessionID)),
    context.data.on("session.renamed", (event) => refreshWithProgress(event.data.sessionID)),
    context.data.on("session.created", () => void progress.refreshVisible()),
    context.data.on("tui.command.execute", () => void progress.refreshVisible()),
  ]
  void progress.refreshVisible()
  const stopSidebar = context.ui.slot({
    append: "sidebar.content",
    render: () => {
      const sessions = filterOrchestratorSessions(context.data.session.list() ?? [], options.orchestrator)
      const tabs = context.ui.tabs.list()
      const statuses = new Map<string, SessionStatus>()
      const costs = new Map<string, number>()
      for (const session of sessions) {
        statuses.set(session.id, context.data.session.status(session.id))
        costs.set(session.id, context.data.session.cost(session.id))
      }
      return renderSidebar({ sessions, statuses, costs, tabs, summaries: progress.values(sessions.map((session) => session.id)), theme: sidebarTheme(context) })
    },
  })
  return () => {
    for (const stop of stopRefresh) stop()
    stopSidebar()
    progress.clear()
  }
}

function tuiCommand(context: Context, name: CommandName, description: string): KeymapCommand {
  return {
    id: `${RUNTIME_PLUGIN_ID}.${name}`,
    title: name,
    description,
    group: "OpenCode Orchestrator",
    // Execution workflows are registered by the server command transform and
    // already appear in native slash completion. Only add palette controls to
    // the CLI keymap; mirroring server commands with a keymap `slash` entry
    // creates duplicate `/name` rows in the TUI.
    palette: true,
    enabled: () => activeSessionID(context) !== undefined,
    run: async (input) => {
      const sessionID = activeSessionID(context)
      if (!sessionID) {
        context.ui.toast.show({ title: "Orchestrator", message: "Open a session before running this command.", variant: "warning" })
        return
      }

      try {
        if (name === "worker-models" && !(input?.trim() ?? "")) {
          await openWorkerModelPicker(context)
          return
        }
        if (name === "gates" && !(input?.trim() ?? "")) {
          await openGatesDialog(context)
          return
        }
        await context.client.session.command({
          sessionID,
          name,
          text: input?.trim() ?? "",
          delivery: "steer",
        })
      } catch (error) {
        context.ui.toast.show({
          title: "Orchestrator",
          message: error instanceof Error ? error.message : "Could not dispatch the command.",
          variant: "error",
        })
      }
    },
  }
}

type TuiModel = {
  id: string
  providerID: string
  name: string
  enabled?: boolean
  capabilities?: { tools?: boolean }
  variants?: readonly { id: string }[]
}

type TuiAgent = {
  id: string
  model?: ModelReference
}

type WorkerChoice =
  | { kind: "worker"; agentID: string }
  | { kind: "reset" }

type ModelChoice =
  | { kind: "default" }
  | { kind: "model"; reference: ModelReference }

async function openWorkerModelPicker(context: Context): Promise<void> {
  const sessionID = activeSessionID(context)
  if (!sessionID) {
    context.ui.toast.show({ title: "Orchestrator", message: "Open a session before selecting worker models.", variant: "warning" })
    return
  }

  try {
    const options = parseOptions(context.options)
    const location = context.location ?? context.data.location.default()
    const [modelResponse, agentResponse] = await Promise.all([
      context.client.model.list({ location }),
      context.client.agent.list({ location }),
    ])
    const models = responseData<TuiModel>(modelResponse)
    const agents = new Map(responseData<TuiAgent>(agentResponse).map((agent) => [agent.id, agent]))
    const roles = workerAgentRoles(options.orchestrator, options.roles)
    const workerOptions: Array<{ title: string; value: WorkerChoice; description?: string }> = [...roles].map(([agentID, names]) => ({
      title: `${agentID} (${names.join(", ")})`,
      value: { kind: "worker", agentID },
      description: agents.get(agentID)?.model ? `Current: ${formatModelReference(agents.get(agentID)!.model!)}` : "Uses the configured model",
    }))
    workerOptions.push({
      title: "Reset all worker overrides",
      value: { kind: "reset" },
      description: "Restore all workers to their configured models",
    })

    if (workerOptions.length === 1) {
      context.ui.toast.show({ title: "Orchestrator", message: "No configured worker agents are available.", variant: "warning" })
      return
    }

    const worker = await context.ui.dialog.select<WorkerChoice>({
      title: "Select worker agent",
      options: workerOptions,
    })
    if (!worker) return
    if (worker.kind === "reset") {
      await dispatchModelCommand(context, sessionID, "reset")
      return
    }

    const current = agents.get(worker.agentID)?.model
    const modelOptions: Array<{ title: string; value: ModelChoice; description?: string; category?: string }> = [
      {
        title: "Use configured default",
        value: { kind: "default" },
        description: current ? `Current effective model: ${formatModelReference(current)}` : "Remove the runtime override",
        category: "Configuration",
      },
    ]
    for (const model of models.filter((candidate) => candidate.enabled !== false && candidate.capabilities?.tools === true)) {
      const base: ModelReference = { providerID: model.providerID, id: model.id }
      addModelChoice(modelOptions, model, base, current)
      for (const variant of model.variants ?? []) {
        addModelChoice(modelOptions, model, { ...base, variant: variant.id }, current)
      }
    }

    if (modelOptions.length === 1) {
      await context.ui.dialog.alert({ title: "Worker models", message: "No enabled tool-capable models are available." })
      return
    }
    const model = await context.ui.dialog.select<ModelChoice>({
      title: `Select model for ${worker.agentID}`,
      options: modelOptions,
    })
    if (!model) return
    await dispatchModelCommand(
      context,
      sessionID,
      model.kind === "default" ? `${worker.agentID}=default` : `${worker.agentID}=${formatModelReference(model.reference)}`,
    )
  } catch (error) {
    context.ui.toast.show({
      title: "Orchestrator",
      message: error instanceof Error ? error.message : "Could not load worker models.",
      variant: "error",
    })
  }
}

type GateChoice = { kind: "gate"; status: GateStatus } | { kind: "close" }

/**
 * One-screen session gate toggler, built on the worker-models picker pattern:
 * every gate is listed with its effective state and source, selecting a row
 * toggles it through the server RPC (which enforces the ceiling), and the
 * dialog re-renders with the returned state. The picker never widens a gate:
 * rows whose ceiling is off are disabled and explained.
 */
async function openGatesDialog(context: Context): Promise<void> {
  const sessionID = activeSessionID(context)
  if (!sessionID) {
    context.ui.toast.show({ title: "Orchestrator", message: "Open a session before configuring gates.", variant: "warning" })
    return
  }

  const location = context.location ?? context.data.location.default()
  const rpc = context.client.rpc(gatesRpcDefinition)
  try {
    for (;;) {
      const view = parseGatesView(await rpc.get({ sessionID }, { location }))
      if (!view) {
        context.ui.toast.show({
          title: "Orchestrator",
          message: "Could not load the session gate state.",
          variant: "error",
        })
        return
      }

      const options: Array<{ title: string; value: GateChoice; description?: string; disabled?: boolean }> = view.gates.map(
        (status) => ({
          title: `${status.enabled ? "[on]" : "[off]"} ${status.gate}`,
          value: { kind: "gate", status },
          description: gateChoiceDescription(status),
          // A row is actionable while it can be narrowed or its narrowing
          // cleared; only a gate that is ceiling-off AND un-narrowed has no
          // action at all.
          disabled: !status.ceiling && !status.sessionDisabled,
        }),
      )
      options.push({ title: "Done", value: { kind: "close" }, description: "Close without further changes" })

      const selected = await context.ui.dialog.select<GateChoice>({
        title: "Session gates (select to toggle)",
        options,
      })
      if (!selected || selected.kind === "close") return

      const disabled = !selected.status.sessionDisabled
      const updated = parseGatesView(await rpc.set({ sessionID, gate: selected.status.gate, disabled }, { location }))
      if (updated?.message) {
        context.ui.toast.show({ title: "Orchestrator", message: updated.message })
      }
    }
  } catch (error) {
    context.ui.toast.show({
      title: "Orchestrator",
      message: error instanceof Error ? error.message : "Could not load the session gates.",
      variant: "error",
    })
  }
}

function gateChoiceDescription(status: GateStatus): string {
  if (status.sessionDisabled) {
    return status.ceiling
      ? "Off for this session — select to follow the project ceiling again"
      : `Off for this session; the ceiling is also off (${status.ceilingReason ?? "the ceiling is off"}) — select to follow the ceiling again`
  }
  if (!status.ceiling) return `Unavailable: ${status.ceilingReason ?? "the ceiling is off"}`
  const source = status.ceilingSource === "project" ? "the project capability" : "config"
  return `Allowed by ${source} — select to turn off for this session`
}

function addModelChoice(
  options: Array<{ title: string; value: ModelChoice; description?: string; category?: string }>,
  model: TuiModel,
  reference: ModelReference,
  current: ModelReference | undefined,
): void {
  const encoded = formatModelReference(reference)
  try {
    parseModelReference(encoded)
  } catch {
    return
  }
  const isCurrent = current?.providerID === reference.providerID && current.id === reference.id && current.variant === reference.variant
  options.push({
    title: `${model.name || model.id}${reference.variant ? ` [${reference.variant}]` : ""}${isCurrent ? " (current)" : ""}`,
    value: { kind: "model", reference },
    description: encoded,
    category: model.providerID,
  })
}

async function dispatchModelCommand(context: Context, sessionID: string, text: string): Promise<void> {
  await context.client.session.command({ sessionID, name: "worker-models", text, delivery: "steer" })
}

/**
 * Reads the host's semantic text colors for the sidebar. The theme object
 * always exists on a live host; the guard keeps the contribution unstyled
 * (rather than throwing) on hosts that do not provide one.
 */
function sidebarTheme(context: Context): SidebarTheme | undefined {
  const text = (context as { theme?: { text?: { default?: SidebarTheme["text"]; subdued?: SidebarTheme["subdued"]; status?: { running?: SidebarTheme["running"] } } } }).theme?.text
  if (!text?.default || !text?.subdued || !text?.status?.running) return undefined
  return { text: text.default, subdued: text.subdued, running: text.status.running }
}

function responseData<T>(response: unknown): T[] {
  if (Array.isArray(response)) return response as T[]
  if (response && typeof response === "object" && Array.isArray((response as { data?: unknown }).data)) {
    return (response as { data: T[] }).data
  }
  return []
}

function activeSessionID(context: Context): string | undefined {
  const route = context.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

export default tuiPlugin
