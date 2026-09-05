import type { Definition } from "@opencode-ai/plugin/tui/plugin"
import type { Context, KeymapCommand } from "@opencode-ai/plugin/tui/context"
import { commandDefinitions } from "./opencode-v2/commands/index.js"
import { parseOptions } from "./core/config.js"
import { formatModelReference, parseModelReference, type ModelReference } from "./core/model-reference.js"
import { workerAgentRoles } from "./core/roles.js"
import { RUNTIME_PLUGIN_ID } from "./core/package-identity.js"

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

    try {
      await context.data.location.command.sync(location)
    } catch (error) {
      stopFailureNotice()
      stopCommandUpdates()
      stopLayer()
      throw error
    }

    return () => {
      stopFailureNotice()
      stopCommandUpdates()
      stopLayer()
    }
  },
} satisfies Definition

function tuiCommand(context: Context, name: string, description: string): KeymapCommand {
  return {
    id: `${RUNTIME_PLUGIN_ID}.${name}`,
    title: `Orchestrator: /${name}`,
    description,
    group: "OpenCode Orchestrator",
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
