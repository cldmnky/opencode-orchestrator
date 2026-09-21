/**
 * Narrow compatibility boundary for the pinned OpenCode 2.0.11 plugin types.
 *
 * OpenCode 2.0.11's runtime accepts the plugin's `tui: true` field, but its
 * `Plugin.define` declaration omits that field. Tool registrations also need
 * one structural draft type because the generic editor signature is stricter
 * than the JSON-schema definitions assembled by this plugin. Keep both casts
 * here rather than spreading them through production modules.
 */
import { Plugin } from "@opencode/plugin"
import type { Context, Cleanup, Plugin as PromisePlugin } from "@opencode/plugin/promise/plugin"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"

export type TuiAwarePluginDefinition = Omit<PromisePlugin, "setup"> & {
  readonly tui: true
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}

export type ToolDefinition = ToolInfo<any, undefined>

export type ToolDraftLike = {
  add(tool: ToolDefinition): void
}

const defineTuiAware = Plugin.define as unknown as (definition: TuiAwarePluginDefinition) => TuiAwarePluginDefinition

export function defineTuiAwarePlugin(definition: TuiAwarePluginDefinition): TuiAwarePluginDefinition {
  return defineTuiAware(definition)
}
