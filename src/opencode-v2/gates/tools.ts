/**
 * Read-only per-session gate inspection (`orchestrator_gates_get`).
 *
 * The orchestrator can always see the effective gate state for its session:
 * each gate's effective value, whether the project/config ceiling allows it,
 * whether this session explicitly disabled it, and why a ceiling is off. There
 * is deliberately NO model-facing setter: a session record can only narrow a
 * ceiling, and a prompt-injected model must not be able to re-enable a gate the
 * user turned off. Only `/gates`, the TUI picker, and the user-facing RPC can
 * write the narrowing record.
 *
 * The handler is orchestrator-only via the shared `orchestrator_gates`
 * permission action plus the runtime agent check, and it never mutates
 * storage, Git, or GitHub.
 */
import type { OrchestratorOptions } from "../../core/config.js"
import { GATES_TOOL_PERMISSION } from "../../core/permissions.js"
import { gateStatuses, type LocationLike, type StorageLike } from "./state.js"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"

type ToolDraftLike = {
  add(tool: ToolInfo<any, undefined>): void
}

type ToolResult = { content: string }

export type GatesToolsDeps = {
  storage: StorageLike
  location: LocationLike
  options: OrchestratorOptions
}

export function addGatesTools(draft: ToolDraftLike, deps: GatesToolsDeps): void {
  draft.add({
    name: "gates_get",
    description:
      "Inspect the effective per-session orchestrator gates: publish steps (push, pr-draft-create, pr-ready-transition, approve-after-review, merge) plus github-mutations and worktree-mutations.",
    input: emptyInput,
    options: { namespace: "orchestrator", permission: GATES_TOOL_PERMISSION },
    execute: async (_input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const gates = await gateStatuses(deps.storage, deps.location, tool.sessionID, deps.options)
      return result(
        JSON.stringify(
          {
            sessionID: tool.sessionID,
            gates,
            note: "Session gates can only narrow the project/config ceiling. A gate disabled for this session is final until the user re-enables it with /gates or the TUI gate picker; attempt the step and report a refusal truthfully.",
          },
          null,
          2,
        ),
      )
    },
  })
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) {
    throw new Error("session gate tools are available only to the orchestrator")
  }
}

function result(content: string): ToolResult {
  return { content }
}

const emptyInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const
