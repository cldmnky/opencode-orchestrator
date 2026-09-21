import { createHash } from "node:crypto"
import { verificationCommandDigest, verificationCommandLabel, verificationReceiptID, VERIFICATION_TOOL_NAME } from "../../core/verification.js"
import type { OrchestratorOptions } from "../../core/config.js"
import { gitRevParse } from "../worktree/git.js"
import type { ProcessRunner } from "../process/runner.js"
import { withSessionLock, type LocationLike, type StorageLike } from "../goal/state.js"
import { redact } from "../process/redact.js"
import {
  VERIFICATION_MAX_RECEIPTS_PER_SESSION,
  activeBoardVerificationReceiptIDs,
  evictVerificationReceipts,
  writeVerificationReceipt,
  type VerificationReceiptV1,
} from "./state.js"

export type VerificationSession = {
  get(input: { sessionID: string }): Promise<unknown>
}

export type VerificationTool = {
  hook(
    name: "execute.before" | "execute.after",
    callback: (event: unknown) => Promise<void> | void,
  ): Promise<{ dispose(): Promise<void> }>
}

export type VerificationRuntimeDeps = {
  options: OrchestratorOptions
  storage: StorageLike
  location: LocationLike
  session: VerificationSession
  tool: VerificationTool
  runner: ProcessRunner
  redact?: (value: string) => string
}

type PendingShell = {
  callID: string
  rootSessionID: string
  sessionID: string
  agentID: string
  messageID: string
  command: string
  commandDigest: string
  commandLabel: string
  directory: string
  startedAt: number
}

const MAX_PENDING = 512
const MAX_SESSION_DEPTH = 32

/**
 * Observes only the pinned native `shell` tool. The runtime never executes
 * the command itself; host permission evaluation remains the execution
 * authority. Unknown hook shapes, identity resolution, or Git state fail
 * closed and produce no receipt.
 */
export async function startVerificationRuntime(deps: VerificationRuntimeDeps): Promise<{ dispose(): Promise<void> }> {
  const pending = new Map<string, PendingShell>()
  const registrations: Array<{ dispose(): Promise<void> }> = []
  const redactCommand = deps.redact ?? redact

  registrations.push(await deps.tool.hook("execute.before", (event) => observeBefore(event)))
  registrations.push(await deps.tool.hook("execute.after", (event) => observeAfter(event)))

  return {
    async dispose(): Promise<void> {
      pending.clear()
      for (const registration of [...registrations].reverse()) await registration.dispose()
    },
  }

  async function observeBefore(value: unknown): Promise<void> {
    const event = parseBefore(value)
    if (!event || event.tool !== VERIFICATION_TOOL_NAME) return
    const command = parseCommand(event.input)
    if (!command) return
    let commandDigest: string | undefined
    let commandLabel: string | undefined
    try {
      commandDigest = verificationCommandDigest(command)
      commandLabel = verificationCommandLabel(command, redactCommand)
    } catch {
      return
    }
    if (!commandDigest || !commandLabel) return
    const identity = await resolveIdentity(event.sessionID)
    if (!identity) return
    if (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value
      if (typeof oldest === "string") pending.delete(oldest)
    }
    pending.set(event.id, {
      callID: event.id,
      rootSessionID: identity.rootSessionID,
      sessionID: event.sessionID,
      agentID: event.agent,
      messageID: event.messageID,
      command,
      commandDigest,
      commandLabel,
      directory: identity.directory,
      startedAt: Date.now(),
    })
  }

  async function observeAfter(value: unknown): Promise<void> {
    const event = parseAfter(value)
    if (!event || event.tool !== VERIFICATION_TOOL_NAME) return
    const started = pending.get(event.id)
    pending.delete(event.id)
    if (!started || event.sessionID !== started.sessionID || event.agent !== started.agentID || event.messageID !== started.messageID) return
    if (event.status !== "completed") return
    const exit = parseExit(event.result)
    if (exit === undefined) return
    const identity = await resolveIdentity(event.sessionID)
    if (!identity || identity.rootSessionID !== started.rootSessionID || identity.directory !== started.directory) return
    const repository = await readRepository(identity.directory)
    if (!repository) return
    const completedAt = Date.now()
    const receipt: VerificationReceiptV1 = {
      version: 1,
      receiptID: verificationReceiptID({
        rootSessionID: started.rootSessionID,
        sessionID: started.sessionID,
        callID: started.callID,
        commandDigest: started.commandDigest,
      }),
      rootSessionID: started.rootSessionID,
      sessionID: started.sessionID,
      agentID: started.agentID,
      messageID: started.messageID,
      commandDigest: started.commandDigest,
      commandLabel: started.commandLabel,
      status: exit === 0 ? "pass" : "fail",
      exitCode: exit,
      startedAt: started.startedAt,
      completedAt,
      repository,
    }
    try {
      await withSessionLock(deps.location, started.rootSessionID, async () => {
        await writeVerificationReceipt(deps.storage, deps.location, receipt)
        // The scan-backed eviction policy is bounded and deterministic. Existing
        // board records that cannot be inspected cause retention rather than
        // deletion, and active validation references are protected.
        const protectedReceiptIDs = await activeBoardVerificationReceiptIDs(deps.storage, deps.location, started.rootSessionID)
        await evictVerificationReceipts(deps.storage, deps.location, started.rootSessionID, protectedReceiptIDs)
      })
    } catch {
      // Observation is never allowed to turn a completed host tool call into a
      // failed shell operation. A missing write is an unknown receipt.
    }
  }

  async function resolveIdentity(sessionID: string): Promise<{ rootSessionID: string; directory: string } | undefined> {
    let current = sessionID
    let directory: string | undefined
    for (let depth = 0; depth < MAX_SESSION_DEPTH; depth += 1) {
      let info: { parentID?: string; directory: string } | undefined
      try {
        info = unwrapSession(await deps.session.get({ sessionID: current }))
      } catch {
        return undefined
      }
      if (!info) return undefined
      directory ??= info.directory
      if (!info.parentID) return { rootSessionID: current, directory }
      current = info.parentID
    }
    return undefined
  }

  async function readRepository(directory: string): Promise<{ rootDigest: string; headSha: string } | undefined> {
    try {
      const root = await gitRevParse({ runner: deps.runner }, directory, "--show-toplevel")
      const headSha = await gitRevParse({ runner: deps.runner }, directory, "HEAD")
      if (!root || !headSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) return undefined
      return { rootDigest: createHash("sha256").update(root, "utf8").digest("hex"), headSha }
    } catch {
      return undefined
    }
  }
}

function parseBefore(value: unknown): { id: string; tool: string; sessionID: string; agent: string; messageID: string; input: unknown } | undefined {
  if (!value || typeof value !== "object") return undefined
  const event = value as Record<string, unknown>
  if (typeof event.id !== "string" || typeof event.tool !== "string" || typeof event.sessionID !== "string") return undefined
  if (typeof event.agent !== "string" || typeof event.messageID !== "string") return undefined
  return { id: event.id, tool: event.tool, sessionID: event.sessionID, agent: event.agent, messageID: event.messageID, input: event.input }
}

function parseAfter(value: unknown): {
  id: string
  tool: string
  sessionID: string
  agent: string
  messageID: string
  status: "completed" | "error"
  result?: unknown
} | undefined {
  if (!value || typeof value !== "object") return undefined
  const event = value as Record<string, unknown>
  if (typeof event.id !== "string" || typeof event.tool !== "string" || typeof event.sessionID !== "string") return undefined
  if (typeof event.agent !== "string" || typeof event.messageID !== "string") return undefined
  if (event.status !== "completed" && event.status !== "error") return undefined
  return {
    id: event.id,
    tool: event.tool,
    sessionID: event.sessionID,
    agent: event.agent,
    messageID: event.messageID,
    status: event.status,
    ...(event.result !== undefined ? { result: event.result } : {}),
  }
}

function parseCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const command = (input as { command?: unknown }).command
  return typeof command === "string" ? command : undefined
}

function parseExit(result: unknown): number | undefined {
  if (!result || typeof result !== "object") return undefined
  const value = result as { output?: unknown; metadata?: unknown }
  const output = value.output && typeof value.output === "object" ? (value.output as { exit?: unknown }) : undefined
  const metadata = value.metadata && typeof value.metadata === "object" ? (value.metadata as { exit?: unknown }) : undefined
  if (typeof output?.exit !== "number" || !Number.isInteger(output.exit) || output.exit < 0) return undefined
  if (typeof metadata?.exit !== "number" || metadata.exit !== output.exit) return undefined
  return output.exit
}

function unwrapSession(value: unknown): { parentID?: string; directory: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const data = (value as { data?: unknown }).data
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : value
  if (!source || typeof source !== "object") return undefined
  const location = (source as { location?: unknown }).location
  if (!location || typeof location !== "object") return undefined
  const directory = (location as { directory?: unknown }).directory
  if (typeof directory !== "string" || directory.length === 0) return undefined
  const parentID = (source as { parentID?: unknown }).parentID
  return { directory, ...(typeof parentID === "string" && parentID.length > 0 ? { parentID } : {}) }
}

export const VERIFICATION_RUNTIME_LIMITS = { maxPending: MAX_PENDING, maxReceiptsPerSession: VERIFICATION_MAX_RECEIPTS_PER_SESSION } as const
