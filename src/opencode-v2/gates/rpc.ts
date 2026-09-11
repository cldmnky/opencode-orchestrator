import { SESSION_GATES, type GateStatus, type SessionGate } from "./state.js"

/**
 * Portable RPC contract for the per-session gate picker.
 *
 * The TUI plugin is a separate plugin instance from the server plugin and must
 * not read server storage directly, so the server registers this read/toggle
 * surface and the TUI calls it through the connected client. The contract is a
 * plain portable definition (JSON-schema input/output) shared by both sides.
 *
 * Both methods are user-mediated surfaces: the model reaches gate state only
 * through the read-only `orchestrator_gates_get` tool and cannot mutate a
 * session's narrowing record. The TUI picker and `/gates` are the only writers.
 */

export const GATES_RPC_ID = "opencode-orchestrator.gates"

export const gatesRpcDefinition = {
  id: GATES_RPC_ID,
  methods: {
    get: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1 },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
    set: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1 },
          gate: { type: "string", enum: [...SESSION_GATES] },
          disabled: { type: "boolean" },
        },
        required: ["sessionID", "gate", "disabled"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const

export type GatesView = {
  sessionID: string
  gates: GateStatus[]
  /** Present when a set was refused (ceiling off) or when nothing changed. */
  message?: string
}

/**
 * Strict structural parse of the RPC view. The TUI receives `unknown` (the
 * output schema is permissive by design), so every rendered field is validated
 * here instead of being trusted.
 */
export function parseGatesView(value: unknown): GatesView | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as { sessionID?: unknown; gates?: unknown; message?: unknown }
  if (typeof record.sessionID !== "string" || !Array.isArray(record.gates)) return undefined
  const gates: GateStatus[] = []
  for (const item of record.gates) {
    const status = parseGateStatus(item)
    if (!status) return undefined
    gates.push(status)
  }
  return {
    sessionID: record.sessionID,
    gates,
    ...(typeof record.message === "string" && record.message.length > 0 ? { message: record.message } : {}),
  }
}

function parseGateStatus(value: unknown): GateStatus | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const gate = record.gate
  if (typeof gate !== "string" || !(SESSION_GATES as readonly string[]).includes(gate)) return undefined
  if (
    typeof record.enabled !== "boolean" ||
    typeof record.ceiling !== "boolean" ||
    typeof record.sessionDisabled !== "boolean" ||
    (record.ceilingSource !== "project" && record.ceilingSource !== "config")
  ) {
    return undefined
  }
  return {
    gate: gate as SessionGate,
    enabled: record.enabled,
    ceiling: record.ceiling,
    ceilingSource: record.ceilingSource,
    sessionDisabled: record.sessionDisabled,
    ...(typeof record.ceilingReason === "string" ? { ceilingReason: record.ceilingReason } : {}),
    ...(typeof record.projectID === "string" ? { projectID: record.projectID } : {}),
  }
}

/** Lenient server-side parse of the `get` method input. */
export function parseGatesGetInput(value: unknown): { sessionID: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const sessionID = (value as { sessionID?: unknown }).sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined
  return { sessionID }
}

/** Lenient server-side parse of the `set` method input. */
export function parseGatesSetInput(
  value: unknown,
): { sessionID: string; gate: SessionGate; disabled: boolean } | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as { sessionID?: unknown; gate?: unknown; disabled?: unknown }
  if (typeof record.sessionID !== "string" || record.sessionID.length === 0) return undefined
  if (typeof record.gate !== "string" || !(SESSION_GATES as readonly string[]).includes(record.gate)) return undefined
  if (typeof record.disabled !== "boolean") return undefined
  return { sessionID: record.sessionID, gate: record.gate as SessionGate, disabled: record.disabled }
}
