/**
 * Bounded operator diagnostics. This is separate from the user-facing gates
 * RPC so adding live doctor fields cannot change the gates contract consumed by
 * the TUI plugin.
 */
export const DIAGNOSTICS_RPC_ID = "opencode-orchestrator.diagnostics"

export const diagnosticsRpcDefinition = {
  id: DIAGNOSTICS_RPC_ID,
  methods: {
    get: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const
