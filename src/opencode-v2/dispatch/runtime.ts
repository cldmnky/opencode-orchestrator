import type { OrchestratorOptions } from "../../core/config.js"

const SUBAGENT_TOOL = "subagent"
const MAX_SESSION_DEPTH = 32
const MAX_ACTIVE_CALLS = 1024
const MAX_ROOT_SESSIONS = 1024

export type DispatchSession = {
  get(input: { sessionID: string }): Promise<unknown>
}

export type DispatchTool = {
  hook(
    name: "execute.before" | "execute.after",
    callback: (event: unknown) => Promise<void> | void,
  ): Promise<{ dispose(): Promise<void> }>
}

export type DispatchAdmissionDeps = {
  options: OrchestratorOptions
  session: DispatchSession
  tool: DispatchTool
}

type DispatchEvent = {
  id: string
  tool: string
  sessionID: string
  agent: string
  messageID: string
  input: unknown
}

type ActiveDispatch = {
  rootSessionID: string
  targetAgentID: string
  startedAt: number
}

/**
 * Enforces the configured-role subagent ceiling within this plugin process.
 *
 * The host's native tool hook is the admission boundary: throwing from the
 * before hook prevents child creation, while the after hook releases the
 * call. This is deliberately not a scheduler, a cross-process limit, or a
 * filesystem isolation boundary. Background subagent work is bounded at the
 * native dispatch-call boundary because OpenCode 2.0.14 reports that call as
 * completed once the child has been launched.
 */
export async function startDispatchAdmission(
  deps: DispatchAdmissionDeps,
): Promise<{ dispose(): Promise<void> }> {
  const configuredAgents = new Set([deps.options.orchestrator, ...Object.values(deps.options.roles)])
  const activeByRoot = new Map<string, Map<string, ActiveDispatch>>()
  const calls = new Map<string, ActiveDispatch>()
  const locks = new Map<string, Promise<void>>()
  const registrations: Array<{ dispose(): Promise<void> }> = []
  let disposed = false
  try {
    registrations.push(await deps.tool.hook("execute.before", (value) => observeBefore(value)))
    registrations.push(await deps.tool.hook("execute.after", (value) => observeAfter(value)))
  } catch (error) {
    for (const registration of [...registrations].reverse()) await registration.dispose()
    throw error
  }

  return {
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      activeByRoot.clear()
      calls.clear()
      locks.clear()
      for (const registration of [...registrations].reverse()) await registration.dispose()
    },
  }

  async function observeBefore(value: unknown): Promise<void> {
    if (disposed) throw new Error("subagent dispatch refused: dispatch admission is shutting down; retry after the plugin reloads")
    const event = parseEvent(value)
    if (!event || event.tool !== SUBAGENT_TOOL) return
    if (!configuredAgents.has(event.agent)) return
    const targetAgentID = parseTargetAgent(event.input)
    if (!targetAgentID || !configuredAgents.has(targetAgentID)) return

    const rootSessionID = await resolveRootSession(event.sessionID)
    if (!rootSessionID) {
      throw new Error(
        "subagent dispatch refused: the plugin could not resolve the configured session's parent chain; this protects the process-local concurrency ceiling. Retry after the session is readable.",
      )
    }

    await withRootLock(rootSessionID, async () => {
      if (calls.has(event.id)) {
        throw new Error("subagent dispatch refused: duplicate native call identity is not safe to admit")
      }
      if (calls.size >= MAX_ACTIVE_CALLS) {
        throw new Error(
          "subagent dispatch refused: the process-local admission table is full; consume native completion delivery and retry later instead of polling",
        )
      }
      if (!activeByRoot.has(rootSessionID) && activeByRoot.size >= MAX_ROOT_SESSIONS) {
        throw new Error(
          "subagent dispatch refused: the process-local root-session table is full; consume native completion delivery and retry later instead of polling",
        )
      }
      if (disposed) {
        throw new Error("subagent dispatch refused: dispatch admission is shutting down; retry after the plugin reloads")
      }
      const active = activeByRoot.get(rootSessionID) ?? new Map<string, ActiveDispatch>()
      if (active.size >= deps.options.max_parallel) {
        throw new Error(
          `subagent dispatch refused: ${active.size} configured-role dispatches are active for this root session and max_parallel=${deps.options.max_parallel}; consume native completion delivery and retry later, do not poll`,
        )
      }
      const admitted: ActiveDispatch = { rootSessionID, targetAgentID, startedAt: Date.now() }
      active.set(event.id, admitted)
      activeByRoot.set(rootSessionID, active)
      calls.set(event.id, admitted)
    })
  }

  function observeAfter(value: unknown): void {
    const event = parseEvent(value)
    if (!event || event.tool !== SUBAGENT_TOOL) return
    const admitted = calls.get(event.id)
    if (!admitted) return
    calls.delete(event.id)
    const active = activeByRoot.get(admitted.rootSessionID)
    if (!active) return
    active.delete(event.id)
    if (active.size === 0) activeByRoot.delete(admitted.rootSessionID)
  }

  async function resolveRootSession(sessionID: string): Promise<string | undefined> {
    let current = sessionID
    const visited = new Set<string>()
    for (let depth = 0; depth < MAX_SESSION_DEPTH; depth += 1) {
      if (visited.has(current)) return undefined
      visited.add(current)
      let info: { parentID?: string } | undefined
      try {
        info = unwrapSession(await deps.session.get({ sessionID: current }))
      } catch {
        return undefined
      }
      if (!info) return undefined
      if (!info.parentID) return current
      current = info.parentID
    }
    return undefined
  }

  async function withRootLock<T>(rootSessionID: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(rootSessionID) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const chain = previous.then(() => gate)
    locks.set(rootSessionID, chain)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (locks.get(rootSessionID) === chain) locks.delete(rootSessionID)
    }
  }
}

function parseEvent(value: unknown): DispatchEvent | undefined {
  if (!value || typeof value !== "object") return undefined
  const event = value as Record<string, unknown>
  if (
    typeof event.id !== "string" ||
    typeof event.tool !== "string" ||
    typeof event.sessionID !== "string" ||
    typeof event.agent !== "string" ||
    typeof event.messageID !== "string"
  ) {
    return undefined
  }
  return {
    id: event.id,
    tool: event.tool,
    sessionID: event.sessionID,
    agent: event.agent,
    messageID: event.messageID,
    input: event.input,
  }
}

function parseTargetAgent(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const agent = (input as { agent?: unknown }).agent
  return typeof agent === "string" && agent.length > 0 ? agent : undefined
}

function unwrapSession(value: unknown): { parentID?: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const data = (value as { data?: unknown }).data
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : value
  if (!source || typeof source !== "object") return undefined
  const parentID = (source as { parentID?: unknown }).parentID
  return typeof parentID === "string" && parentID.length > 0 ? { parentID } : {}
}

export const DISPATCH_ADMISSION_LIMITS = {
  maxSessionDepth: MAX_SESSION_DEPTH,
  maxActiveCalls: MAX_ACTIVE_CALLS,
  maxRootSessions: MAX_ROOT_SESSIONS,
} as const
