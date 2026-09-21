import type { OrchestratorOptions } from "../../core/config.js"
import { ORCHESTRATION_TOOL_PERMISSION } from "../../core/permissions.js"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"
import type { LocationLike, StorageLike } from "../goal/state.js"
import { listVerificationReceipts } from "./state.js"

type ToolDraftLike = {
  add(tool: ToolInfo<any, undefined>): void
}

type ToolResult = { content: string }

type SessionLike = {
  get(input: { sessionID: string }): Promise<unknown>
}

export type VerificationToolsDeps = {
  options: OrchestratorOptions
  storage: StorageLike
  location: LocationLike
  session?: SessionLike
}

export const VERIFICATION_TOOL_LIMITATIONS = [
  "read-only bounded metadata: no command input, stdout, stderr, transcript, or credentials",
  "receipt IDs identify plugin-observed host shell calls; they do not grant permission or prove filesystem isolation",
  "lead validation still requires the configured orchestrator agent, exact revision, lifecycle timestamp, and freshness bound",
  "missing, malformed, or unavailable records are unknown and never treated as passing proof",
] as const

/**
 * Read-only receipt discovery for the lead. A model cannot know the opaque
 * receipt ID produced by a host tool call otherwise, while exposing arbitrary
 * session IDs would turn this into a cross-session inspection surface.
 */
export function addVerificationTools(draft: ToolDraftLike, deps: VerificationToolsDeps): void {
  draft.add({
    name: "verification_get",
    description:
      "Read the current root session's bounded plugin-observed shell verification receipts so receiptIDs can be supplied to lead validation. Read-only; never returns raw command input/output, transcripts, or credentials. Orchestrator-only and not a permission or completion gate.",
    input: verificationGetInput,
    options: { namespace: "orchestrator", permission: ORCHESTRATION_TOOL_PERMISSION },
    execute: async (_input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const rootSessionID = await resolveRootSession(deps.session, tool.sessionID)
      if (!rootSessionID) {
        return resultContent(
          JSON.stringify({
            version: 1,
            state: "unknown",
            rootSessionID: null,
            receipts: [],
            reason: "session identity is unavailable",
            limitations: VERIFICATION_TOOL_LIMITATIONS,
          }),
        )
      }
      try {
        const receipts = await listVerificationReceipts(deps.storage, deps.location, rootSessionID)
        return resultContent(
          JSON.stringify({
            version: 1,
            state: "found",
            rootSessionID,
            receipts: receipts.map((receipt) => ({
              receiptID: receipt.receiptID,
              sessionID: receipt.sessionID,
              agentID: receipt.agentID,
              commandDigest: receipt.commandDigest,
              commandLabel: receipt.commandLabel,
              status: receipt.status,
              exitCode: receipt.exitCode,
              completedAt: receipt.completedAt,
              headSha: receipt.repository.headSha,
            })),
            limitations: VERIFICATION_TOOL_LIMITATIONS,
          }),
        )
      } catch {
        return resultContent(
          JSON.stringify({
            version: 1,
            state: "unknown",
            rootSessionID,
            receipts: [],
            reason: "verification receipt storage is unavailable",
            limitations: VERIFICATION_TOOL_LIMITATIONS,
          }),
        )
      }
    },
  })
}

async function resolveRootSession(session: SessionLike | undefined, sessionID: string): Promise<string | undefined> {
  if (!session) return sessionID
  let current = sessionID
  for (let depth = 0; depth < 32; depth += 1) {
    let value: unknown
    try {
      value = await session.get({ sessionID: current })
    } catch {
      return undefined
    }
    if (!value || typeof value !== "object") return undefined
    const parentID = (value as { parentID?: unknown }).parentID
    if (typeof parentID !== "string" || parentID.length === 0) return current
    current = parentID
  }
  return undefined
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) throw new Error("verification receipt lookup is available only to the orchestrator")
}

function resultContent(content: string): ToolResult {
  return { content }
}

const verificationGetInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const
