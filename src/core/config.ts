import { z } from "zod"
import { DEFAULT_ROLES, type RoleName } from "./roles.js"
import { RUNTIME_PLUGIN_ID } from "./package-identity.js"

export const COMMAND_NAMES = [
  "orchestrate",
  "worker-models",
  "goal",
  "restructure",
  "run-plan",
  "halt",
  "handover",
  "polish",
  "stress-plan",
  "publish",
  "gates",
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

/**
 * Phase A runtime authority mode: `off` (default — no authority hooks are
 * registered, no plugin-created prompt is tagged, and every existing
 * registration and behavior stays byte-identical) or `enforce` (registers the
 * opt-in N1 admission/permission enforcement and N2 child-only containment
 * hooks described in the Phase A roadmap).
 *
 * `enforce` is strictly additive: it only restricts (fail-closed admission of
 * tagged plugin dispatches, deny downgrades for selected plugin-owned
 * permission actions, exact deny rules for configured-role child sessions).
 * It never widens a gate, never installs or clears rules on a parent session,
 * and never claims filesystem, process, worktree, or atomic child isolation.
 */
export const AUTHORITY_MODES = ["off", "enforce"] as const
export type AuthorityMode = (typeof AUTHORITY_MODES)[number]

const authorityOptions = z
  .object({
    mode: z.enum(AUTHORITY_MODES).default("off"),
  })
  .strict()
  .default({ mode: "off" })

/**
 * Phase C generation-hint mode: `off` (default — no generation call is ever
 * made, no hint record is attached, and `handoff_validate` output stays
 * byte-identical) or `advisory` (after the deterministic D2 checks pass, one
 * opt-in sessionless `ctx.generate.text` call produces a bounded advisory
 * hint record).
 *
 * Advisory hints are metadata only: they never change a verdict, an admission
 * state, a gate, a review record, or any other enforcement decision. Prompts
 * are built from deterministic check verdicts only (never transcripts,
 * secrets, paths, URLs, or payloads); output is parsed defensively, redacted
 * with the canonical redactor, and length-capped. `advisory` requires an
 * explicit model reference because the plugin never guesses a model.
 */
export const HINT_MODES = ["off", "advisory"] as const
export type HintMode = (typeof HINT_MODES)[number]

const hintModelReference = z
  .object({
    providerID: z.string().trim().min(1).max(128),
    id: z.string().trim().min(1).max(128),
  })
  .strict()

const hintsOptions = z
  .object({
    mode: z.enum(HINT_MODES).default("off"),
    model: hintModelReference.optional(),
  })
  .strict()
  .default({ mode: "off" })

/**
 * Decomposition strategy: `mvp` (default — the current Phase 1 prompt
 * guidance, unchanged) or `strict` (adds extra prompt-level emphasis on
 * preferring the smallest coherent end-to-end slice). Prompt-preference
 * only: it changes prompt wording, never enforcement — it never disables
 * serialization, scope validation, review, the worktree lifecycle, or the
 * publication preconditions, and it never overrides an explicit user
 * decision.
 */
export const DECOMPOSITION_STRATEGIES = ["mvp", "strict"] as const
export type DecompositionStrategy = (typeof DECOMPOSITION_STRATEGIES)[number]

const decompositionOptions = z
  .object({
    strategy: z.enum(DECOMPOSITION_STRATEGIES).default("mvp"),
  })
  .strict()
  .default({ strategy: "mvp" })

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
 * Publication capability master switch. `enabled` defaults to `false`: the
 * capability family is off until an operator opts in. Enabling this config
 * flag only *permits* the durable project-scoped authorization record
 * (toggled through `/publish enable`) to be written; it never weakens the
 * static `github`/`worktree` gates.
 */
const publishOptions = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict()
  .default({ enabled: false })

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
    publish: publishOptions,
    trace: traceOptions,
    budget: budgetOptions,
    review: reviewOptions,
    clarify: clarifyOptions,
    decomposition: decompositionOptions,
    authority: authorityOptions,
    hints: hintsOptions,
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
    // Explicit model selection is required: the plugin never falls back to a
    // host default model (the sessionless surface was measured only with an
    // explicit model reference).
    if (value.hints.mode === "advisory" && value.hints.model === undefined) {
      context.addIssue({
        code: "custom",
        path: ["hints", "model"],
        message: "hints.model is required when hints.mode is advisory",
      })
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
export type DecompositionOptions = z.infer<typeof decompositionOptions>
export type PublishOptions = z.infer<typeof publishOptions>
export type AuthorityOptions = z.infer<typeof authorityOptions>
export type HintsOptions = z.infer<typeof hintsOptions>

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
