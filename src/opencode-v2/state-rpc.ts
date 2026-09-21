import {
  STATE_FAMILIES,
  archiveSessionState,
  exportSessionState,
  resetSessionState,
  validateSessionState,
  type StateFamily,
  type RecoveryStorage,
} from "./state-recovery.js"

export const STATE_RPC_ID = "opencode-orchestrator.state"

export const stateRpcDefinition = {
  id: STATE_RPC_ID,
  methods: {
    export: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1, maxLength: 512 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
    validate: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1, maxLength: 512 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
    archive: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1, maxLength: 512 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
    reset: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1, maxLength: 512 },
          family: { type: "string", enum: [...STATE_FAMILIES] },
          confirm: { type: "boolean" },
        },
        required: ["sessionID", "family", "confirm"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const

export type StateRpcHandlers = {
  export(input: unknown): Promise<unknown>
  validate(input: unknown): Promise<unknown>
  archive(input: unknown): Promise<unknown>
  reset(input: unknown): Promise<unknown>
}

export function createStateRpcHandlers(storage: RecoveryStorage): StateRpcHandlers {
  return {
    export: async (input) => exportSessionState(storage, parseSessionInput(input)),
    validate: async (input) => validateSessionState(storage, parseSessionInput(input)),
    archive: async (input) => archiveSessionState(storage, parseSessionInput(input)),
    reset: async (input) => {
      const parsed = parseResetInput(input)
      return resetSessionState(storage, parsed.sessionID, parsed.family, parsed.confirm)
    },
  }
}

function parseSessionInput(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("sessionID is required")
  const sessionID = (value as { sessionID?: unknown }).sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0 || sessionID.length > 512) throw new Error("sessionID is required")
  return sessionID
}

function parseResetInput(value: unknown): { sessionID: string; family: StateFamily; confirm: boolean } {
  const sessionID = parseSessionInput(value)
  const record = value as { family?: unknown; confirm?: unknown }
  if (typeof record.family !== "string" || !(STATE_FAMILIES as readonly string[]).includes(record.family)) throw new Error("state reset requires an explicit family")
  if (record.confirm !== true) throw new Error("state reset requires explicit confirmation")
  return { sessionID, family: record.family as StateFamily, confirm: true }
}
