import type { Definition } from "@opencode-ai/plugin/tui/plugin"
import type { Context, KeymapCommand } from "@opencode-ai/plugin/tui/context"
import { commandDefinitions } from "./opencode-v2/commands/index.js"
import { parseOptions } from "./core/config.js"
import { RUNTIME_PLUGIN_ID } from "./core/package-identity.js"

export const tuiPlugin = {
  id: RUNTIME_PLUGIN_ID,
  async setup(context: Context) {
    const options = parseOptions(context.options)
    const location = context.location ?? context.data.location.default()
    await context.data.location.command.sync(location)
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

    context.keymap.layer(() => {
      const available = new Map((context.data.location.command.list(location) ?? []).map((command) => [command.name, command.description]))
      return {
        mode: "global",
        priority: 20,
        commands: commandDefinitions(options)
          .filter((spec) => available.get(spec.name) === spec.description)
          .map((spec) => tuiCommand(context, spec.name, spec.description)),
      }
    })

    return () => {
      stopFailureNotice()
      stopCommandUpdates()
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

function activeSessionID(context: Context): string | undefined {
  const route = context.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

export default tuiPlugin
