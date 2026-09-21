import type { OrchestratorOptions } from "../../core/config.js"
import { OBSERVABILITY_TOOL_PERMISSION } from "../../core/permissions.js"
import type { LocationLike, StorageLike } from "../goal/state.js"
import type { ToolDraftLike } from "../compat.js"
import { readAuthoritySnapshot } from "./state.js"

/**
 * Read-only effective-authority snapshot lookup (Phase C / V4b).
 *
 * Registered only in opt-in `authority.mode: "enforce"` (default off registers
 * no tool, so the default tool list is unchanged). It reads the durable
 * `authority/v1/...` record written during a configured-role child's own
 * admission; it never writes, never mutates, and is NOT part of any admission,
 * permission, gate, review, or publication decision.
 *
 * The tool is orchestrator-only twice over: it shares the read-only
 * `orchestrator_observability` permission action (the installer and agent
 * transform already grant it to the orchestrator and deny it to workers), and
 * the execute handler rejects a non-orchestrator agent regardless of
 * visibility. No new permission action is introduced, so installer output and
 * the agent transform stay unchanged. That action is also deliberately outside
 * N1 runtime enforcement, so the read surface stays available while a gate
 * refuses — a stopped run can still be inspected.
 *
 * Missing, malformed, and unreadable records all resolve to `unknown`; the
 * output discloses the limits plainly and never claims filesystem, process,
 * worktree, or atomic isolation.
 */

type ToolResult = { content: string }

export type AuthorityToolsDeps = {
  options: OrchestratorOptions
  storage: StorageLike
  location: LocationLike
}

export const AUTHORITY_TOOL_LIMITATIONS = [
  "tool-action containment only: not filesystem, process, worktree, or atomic child isolation",
  "family-wide rules only (`resource: \"*\"`); scoped-resource rules are not represented",
  "snapshots are records, never decisions: no admission, permission, gate, review, or publication path reads them",
  "missing, malformed, or unreadable snapshots are unknown, never assumed permissive or restrictive",
  "one current record per session under authority/v1, serialized by the process-local session lock (no CAS, transactions, or cross-process guarantee)",
  "snapshots are cleared when the authority runtime that wrote them exits; a cleared or absent record reads as unknown",
  "caller identity cannot be proven by the plugin; the orchestrator agent check is the only access gate",
]

export function addAuthorityTools(draft: ToolDraftLike, deps: AuthorityToolsDeps): void {
  if (deps.options.authority.mode !== "enforce") return

  draft.add({
    name: "authority_get",
    description:
      "Read the read-only durable effective-authority snapshot (authority/v1) recorded for a session during configured-role child admission: parent rules, plugin worker policy, installed rules, and their per-action intersection. Missing, malformed, or unreadable records are unknown. Records never change admission decisions; tool-action containment only, not filesystem or process isolation. Orchestrator-only.",
    input: authorityGetInput,
    options: { namespace: "orchestrator", permission: OBSERVABILITY_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const sessionID = stringField(input, "sessionID")
      if (!sessionID) {
        return resultContent(
          JSON.stringify({
            version: 1,
            sessionID: null,
            snapshot: null,
            state: "unknown",
            reason: "missing",
            message: "sessionID is required",
            limitations: AUTHORITY_TOOL_LIMITATIONS,
          }),
        )
      }
      const read = await readAuthoritySnapshot(deps.storage, deps.location, sessionID)
      return resultContent(
        JSON.stringify({
          version: 1,
          sessionID,
          snapshot: read.state === "found" ? read.snapshot : null,
          state: read.state,
          ...(read.state === "unknown" ? { reason: read.reason } : {}),
          limitations: AUTHORITY_TOOL_LIMITATIONS,
        }),
      )
    },
  })
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) {
    throw new Error("authority snapshot lookup is available only to the orchestrator")
  }
}

function stringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function resultContent(content: string): ToolResult {
  return { content }
}

const authorityGetInput = {
  type: "object",
  properties: {
    sessionID: { type: "string", minLength: 1 },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const
