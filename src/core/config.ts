import { z } from "zod"
import { DEFAULT_ROLES, type RoleName } from "./roles.js"
import { RUNTIME_PLUGIN_ID } from "./package-identity.js"

export const COMMAND_NAMES = [
  "orchestrate",
  "goal",
  "restructure",
  "run-plan",
  "halt",
  "handover",
  "polish",
  "stress-plan",
] as const

/**
 * S3 trace mode: `off` (default, no tracing), `memory` (bounded in-memory
 * metadata summaries only, never persisted), or `snapshot` (memory plus one
 * bounded current metadata record per session). Every mode never stores
 * prompts, transcripts, tool input/output, or arbitrary payloads.
 */
export const TRACE_MODES = ["off", "memory", "snapshot"] as const
export type TraceMode = (typeof TRACE_MODES)[number]

/**
 * S3 budget mode: `advisory` (default, never blocks) or `stop-between-steps`
 * (checked before plugin-owned next dispatches). Limits are nullable strict
 * finite values; an explicit null (or omission) means "no limit".
 */
export const BUDGET_MODES = ["advisory", "stop-between-steps"] as const
export type BudgetMode = (typeof BUDGET_MODES)[number]

/**
 * V1 review mode: `prompt` (default, unchanged prompt-only behavior) or
 * `bounded` (adds the explicit maker-checker review tools and the terminal
 * breaker for auto-continuation).
 */
export const REVIEW_MODES = ["prompt", "bounded"] as const
export type ReviewMode = (typeof REVIEW_MODES)[number]

/**
 * Clarify mode: `auto` (default — the orchestrator uses the native ask tool
 * to ask the user a small number of targeted clarifying questions before
 * decomposing an ambiguous task; prompt-level guidance only, never a hard
 * gate) or `off` (previous behavior, no clarification guidance).
 */
export const CLARIFY_MODES = ["auto", "off"] as const
export type ClarifyMode = (typeof CLARIFY_MODES)[number]

const clarifyOptions = z
  .object({
    mode: z.enum(CLARIFY_MODES).default("auto"),
  })
  .strict()
  .default({ mode: "auto" })

const agentId = z.string().trim().min(1)

// Nullable strict finite limits: explicit null or omission means "no limit";
// Infinity/NaN and negative values are rejected outright.
const nullableCountLimit = z.number().int().nonnegative().nullish()
const nullableFiniteLimit = z.number().finite().nonnegative().nullish()

const traceOptions = z
  .object({
    mode: z.enum(TRACE_MODES).default("off"),
  })
  .strict()
  .default({ mode: "off" })

const budgetOptions = z
  .object({
    mode: z.enum(BUDGET_MODES).default("advisory"),
    max_steps: nullableCountLimit,
    max_tokens: nullableFiniteLimit,
    max_cost_usd: nullableFiniteLimit,
    max_wall_clock_ms: nullableFiniteLimit,
    max_retries: nullableCountLimit,
  })
  .strict()
  .default({ mode: "advisory" })

const reviewOptions = z
  .object({
    mode: z.enum(REVIEW_MODES).default("prompt"),
    max_rounds: z.number().int().min(1).max(8).default(2),
  })
  .strict()
  .default({ mode: "prompt", max_rounds: 2 })

/**
 * Validates a worktree root as an absolute POSIX path (or, when nullable,
 * an explicit `null` meaning "no whitelisted roots"). Rejects relative
 * paths, drive letters, and embedded NUL bytes.
 */
const absolutePosixPath = z
  .string()
  .refine((value) => value.startsWith("/") && !/[a-zA-Z]:/.test(value) && !value.includes("\0"), {
    message: "worktree root must be an absolute POSIX path or null",
  })
const roleOptions = z
  .object({
    planning: agentId.default(DEFAULT_ROLES.planning),
    research: agentId.default(DEFAULT_ROLES.research),
    implementation: agentId.default(DEFAULT_ROLES.implementation),
    review: agentId.default(DEFAULT_ROLES.review),
  })
  .strict()

const commandOptions = z
  .object({
    ...(Object.fromEntries(COMMAND_NAMES.map((name) => [name, z.boolean().optional()])) as Record<
      (typeof COMMAND_NAMES)[number],
      z.ZodOptional<z.ZodBoolean>
    >),
    // Legacy `commands.cd` is accepted for backward compatibility with configs
    // written before the /cd slash command was removed, but it is ignored: it
    // never appears in COMMAND_NAMES, command definitions, or registered
    // commands, and session movement is now orchestrated through the
    // orchestrator_worktree_enter tool (and native session moves).
    cd: z.boolean().optional(),
  })
  .strict()

export const OrchestratorOptionsSchema = z
  .object({
    orchestrator: agentId.default("orchestrator"),
    roles: roleOptions.default(DEFAULT_ROLES),
    max_parallel: z.number().int().min(1).max(8).default(4),
    require_review: z.boolean().default(true),
    strict_agents: z.boolean().default(true),
    commands: commandOptions.default({}),
    goal: z
      .object({
        auto_continue: z.boolean().default(true),
        max_continuations: z.number().int().positive().max(1000).default(50),
        cooldown_ms: z.number().int().nonnegative().default(1000),
      })
      .default({ auto_continue: true, max_continuations: 50, cooldown_ms: 1000 }),
    github: z
      .object({
        enabled: z.boolean().default(false),
        allow_mutations: z.boolean().default(false),
      })
      .default({ enabled: false, allow_mutations: false }),
    worktree: z
      .object({
        enabled: z.boolean().default(false),
        allow_mutations: z.boolean().default(false),
        root: absolutePosixPath.nullable().default(null),
      })
      .default({ enabled: false, allow_mutations: false, root: null }),
    trace: traceOptions,
    budget: budgetOptions,
    review: reviewOptions,
    clarify: clarifyOptions,
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Map<string, RoleName>()
    for (const role of Object.keys(value.roles) as RoleName[]) {
      const id = value.roles[role]
      if (id === value.orchestrator) {
        context.addIssue({
          code: "custom",
          path: ["roles", role],
          message: "role agent must not be the orchestrator agent",
        })
      }
      const previous = seen.get(id)
      if (previous) {
        context.addIssue({
          code: "custom",
          path: ["roles", role],
          message: `agent ID is already assigned to role ${previous}`,
        })
      } else {
        seen.set(id, role)
      }
    }
  })

export type OrchestratorOptions = z.infer<typeof OrchestratorOptionsSchema>
export type CommandName = (typeof COMMAND_NAMES)[number]
export type TraceOptions = z.infer<typeof traceOptions>
export type BudgetOptions = z.infer<typeof budgetOptions>
export type BudgetLimits = Pick<
  BudgetOptions,
  "max_steps" | "max_tokens" | "max_cost_usd" | "max_wall_clock_ms" | "max_retries"
>
export type ReviewOptions = z.infer<typeof reviewOptions>
export type ClarifyOptions = z.infer<typeof clarifyOptions>

export function parseOptions(value: unknown): OrchestratorOptions {
  const parsed = OrchestratorOptionsSchema.safeParse(value ?? {})
  if (!parsed.success) {
    throw new Error(`Invalid ${RUNTIME_PLUGIN_ID} options: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`)
  }

  return { ...parsed.data, roles: parsed.data.roles as Record<RoleName, string> }
}

export function isCommandEnabled(options: OrchestratorOptions, name: CommandName): boolean {
  return options.commands[name] !== false
}
