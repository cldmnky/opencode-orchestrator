import type { Definition } from "@opencode/plugin/tui/plugin"
import type { Context, KeymapCommand } from "@opencode/plugin/tui/context"
import { commandDefinitions } from "./opencode-v2/commands/index.js"
import { gatesRpcDefinition, parseGatesView } from "./opencode-v2/gates/rpc.js"
import type { GateStatus } from "./opencode-v2/gates/state.js"
import { parseOptions, type OrchestratorOptions } from "./core/config.js"
import { formatModelReference, parseModelReference, type ModelReference } from "./core/model-reference.js"
import { workerAgentRoles } from "./core/roles.js"
import { RUNTIME_PLUGIN_ID } from "./core/package-identity.js"
import { filterOrchestratorSessions, renderSidebar, type SessionStatus, type SidebarTheme } from "./tui/sidebar.js"

export const tuiPlugin = {
  id: RUNTIME_PLUGIN_ID,
  async setup(context: Context) {
    const options = parseOptions(context.options)
    const location = context.location ?? context.data.location.default()

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
            commands: commandDefinitions(options)
              .filter((spec) => available.get(spec.name) === spec.description)
              .map((spec) => tuiCommand(context, spec.name, spec.description)),
          }
        })
        return null
      },
    })

    // Read-only live sidebar list of orchestrator sessions. Requires session
    // tabs to derive the "busy" state, so hosts without tabs skip it entirely.
    const stopSidebar = registerSidebar(context, options)

    try {
      await context.data.location.command.sync(location)
    } catch (error) {
      stopFailureNotice()
      stopCommandUpdates()
      stopLayer()
      stopSidebar?.()
      throw error
    }

    return () => {
      stopFailureNotice()
      stopCommandUpdates()
      stopLayer()
      stopSidebar?.()
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
function registerSidebar(context: Context, options: OrchestratorOptions): (() => void) | undefined {
  if (!context.ui.tabs) return undefined

  const refresh = (sessionID: string): void => {
    context.data.session.invalidate(sessionID)
    void context.data.session.sync(sessionID)
  }
  const stopRefresh = [
    context.data.on("session.execution.started", (event) => refresh(event.data.sessionID)),
    context.data.on("session.execution.succeeded", (event) => refresh(event.data.sessionID)),
    context.data.on("session.execution.failed", (event) => refresh(event.data.sessionID)),
    context.data.on("session.execution.interrupted", (event) => refresh(event.data.sessionID)),
    context.data.on("session.status", (event) => refresh(event.data.sessionID)),
    context.data.on("session.usage.updated", (event) => refresh(event.data.sessionID)),
    context.data.on("session.renamed", (event) => refresh(event.data.sessionID)),
    context.data.on("session.created", (event) => refresh(event.data.sessionID)),
  ]
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
      return renderSidebar({ sessions, statuses, costs, tabs, theme: sidebarTheme(context) })
    },
  })
  return () => {
    for (const stop of stopRefresh) stop()
    stopSidebar()
  }
}

function tuiCommand(context: Context, name: string, description: string): KeymapCommand {
  return {
    id: `${RUNTIME_PLUGIN_ID}.${name}`,
    title: `/${name}`,
    description,
    group: "OpenCode Orchestrator",
    // Palette + slash: short `/name` titles (the group header already says
    // who owns them), with the worker-models picker interception in `run`.
    palette: true,
    slash: { name, arguments: true },
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
          command: name,
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
  await context.client.session.command({ sessionID, command: "worker-models", text, delivery: "steer" })
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
