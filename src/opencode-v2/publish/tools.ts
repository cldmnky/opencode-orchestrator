/**
 * Publication policy tool (`orchestrator_publish_policy_get`).
 *
 * Read-only inspection surface for the durable publication authorization:
 * the orchestrator can always see the current project-scoped policy, the
 * `publish.enabled` config master switch, and the unchanged static gates —
 * even when the config switch is off, so a stale durable authorization
 * stays visible and can be revoked via `/publish disable`.
 *
 * The tool is orchestrator-only via the shared `orchestrator_publish`
 * permission action plus the runtime agent check, and it never mutates
 * storage, Git, or GitHub. Every result states the policy limitations:
 * authorization bookkeeping, not caller authentication; issue creation is
 * never authorized by this capability; existing static gates are never
 * weakened. Per-session narrowing (including of merge) is a separate
 * `orchestrator_gates_get` surface.
 */
import type { OrchestratorOptions } from "../../core/config.js"
import { PUBLISH_TOOL_PERMISSION } from "../../core/permissions.js"
import { publicationStatus, type LocationLike, type StorageLike } from "./state.js"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"

type ToolDraftLike = {
  add(tool: ToolInfo<any, undefined>): void
}

type ToolResult = { content: string }

export type PublishToolsDeps = {
  storage: StorageLike
  location: LocationLike
  options: OrchestratorOptions
}

export const PUBLISH_POLICY_LIMITATIONS = [
  "authorization policy only, not caller authentication: nothing in this record proves a human invoked /publish",
  "never authorizes issue creation (still requires github.allow_mutations plus confirm: true)",
  "never widens or bypasses a per-session gate narrowing; /gates can disable push, PR steps, merge, or mutations for the current session only",
  "never weakens the static github.enabled, github.allow_mutations, worktree.enabled, or worktree.allow_mutations gates",
  "does not itself mutate Git or GitHub",
]

export function addPublishTools(draft: ToolDraftLike, deps: PublishToolsDeps): void {
  draft.add({
    name: "publish_policy_get",
    description:
      "Read the durable project-scoped publication authorization policy, the publish.enabled config master switch, and the static github/worktree gates. Orchestrator-only; read-only policy inspection that never mutates Git or GitHub.",
    input: policyGetInput,
    options: { namespace: "orchestrator", permission: PUBLISH_TOOL_PERMISSION },
    execute: async (_input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const status = await publicationStatus(deps.storage, deps.location, tool.sessionID, deps.options)
      return resultContent(JSON.stringify({ ...status, limitations: PUBLISH_POLICY_LIMITATIONS }))
    },
  })
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) {
    throw new Error("publication policy tools are available only to the orchestrator")
  }
}

function resultContent(content: string): ToolResult {
  return { content }
}

const policyGetInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const