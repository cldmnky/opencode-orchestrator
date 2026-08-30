import { z } from "zod"

/**
 * D4 — Start-Simple Complexity Gate (pure, advisory classifier).
 *
 * Implements the frozen design artifact `docs/phase-1/d4-gate-table.json`
 * (version 1, `runtimeEnforced: false`): eight dimensions, five decision
 * outcomes, and the precedence order unknown -> high-risk -> shared-state ->
 * multi-step -> trivial -> conservative collect-facts.
 *
 * Semantics inherited from the gate table:
 * - Unknown on ANY dimension returns collect-facts before any other
 *   precedence rule; an unknown high-risk or shared-state dimension is never
 *   treated as "no".
 * - `external_side_effects = true` is the caller's conservative assertion of
 *   a *material* external side effect. A caller unable to establish
 *   materiality must pass `null`/omit the field (which yields collect-facts).
 * - `expected_parallelism_value` never authorizes runtime parallelism; it is
 *   carried as a normalized feature and only informs (never changes) the
 *   multi-step recommendation text.
 *
 * This module is design/advisory only: it enforces nothing at runtime, never
 * delegates, and never changes how a task is executed. Every result carries
 * `advisory: true`.
 */

export const D4_RULES = ["incomplete-facts", "high-risk", "shared-state", "multi-step", "trivial"] as const
export type D4Rule = (typeof D4_RULES)[number]

export const D4_RECOMMENDATIONS = [
  "collect-facts",
  "direct-execution-candidate",
  "orchestrate-candidate",
  "orchestrate-serialized",
  "orchestrate-with-review",
] as const
export type D4Recommendation = (typeof D4_RECOMMENDATIONS)[number]

export const D4_PARALLELISM_VALUES = ["none", "low", "medium", "high"] as const
export type D4ParallelismValue = (typeof D4_PARALLELISM_VALUES)[number]

/** The eight frozen dimension IDs from d4-gate-table.json. */
export const D4_DIMENSIONS = [
  "independent_subtasks",
  "dependent_stages",
  "files_modules",
  "independent_review",
  "external_side_effects",
  "shared_mutable_state",
  "security_compliance_risk",
  "expected_parallelism_value",
] as const
export type D4DimensionId = (typeof D4_DIMENSIONS)[number]

const nonnegativeCount = z.number().int().nonnegative()

/**
 * Strict input schema for the eight frozen dimensions.
 *
 * Every dimension is optional/nullable: a missing (`undefined`) or `null`
 * value means the fact is unknown and forces collect-facts. Anything else
 * that does not match the declared type — negative/fractional/non-numeric
 * counts, unknown fields, invalid enums, wrong types — is rejected by this
 * schema and never treated as "unknown".
 */
export const D4InputSchema = z
  .object({
    independent_subtasks: nonnegativeCount.optional().nullable(),
    dependent_stages: nonnegativeCount.optional().nullable(),
    files_modules: nonnegativeCount.optional().nullable(),
    independent_review: z.boolean().optional().nullable(),
    external_side_effects: z.boolean().optional().nullable(),
    shared_mutable_state: z.boolean().optional().nullable(),
    security_compliance_risk: z.boolean().optional().nullable(),
    expected_parallelism_value: z.enum(D4_PARALLELISM_VALUES).optional().nullable(),
  })
  .strict()

export type D4Input = z.infer<typeof D4InputSchema>

/** Dimension values after normalization; `null` exactly when the fact was missing/null. */
export type D4NormalizedFeatures = {
  independent_subtasks: number | null
  dependent_stages: number | null
  files_modules: number | null
  independent_review: boolean | null
  external_side_effects: boolean | null
  shared_mutable_state: boolean | null
  security_compliance_risk: boolean | null
  expected_parallelism_value: D4ParallelismValue | null
}

export type D4ClassificationResult = {
  /** Frozen artifact version (d4-gate-table.json version 1). */
  version: 1
  /** One of the five decision outcomes from d4-gate-table.json. */
  recommendation: D4Recommendation
  /**
   * The precedence label that fired. `incomplete-facts` covers both missing
   * facts (non-empty `unknownDimensions`) and the conservative ambiguity
   * fallback (empty `unknownDimensions`).
   */
  rule: D4Rule
  /** Dimension IDs that were missing/null and forced collect-facts; empty for full classifications. */
  unknownDimensions: D4DimensionId[]
  /** Normalized dimension values (`null` = unknown). */
  features: D4NormalizedFeatures
  /** Human-readable rationale for the recommendation. */
  basis: string
  /** Advisory only: nothing returned here is runtime-enforced. */
  advisory: true
}

/** Builds the normalized features record for a parsed input. */
function normalize(input: D4Input): D4NormalizedFeatures {
  return {
    independent_subtasks: input.independent_subtasks ?? null,
    dependent_stages: input.dependent_stages ?? null,
    files_modules: input.files_modules ?? null,
    independent_review: input.independent_review ?? null,
    external_side_effects: input.external_side_effects ?? null,
    shared_mutable_state: input.shared_mutable_state ?? null,
    security_compliance_risk: input.security_compliance_risk ?? null,
    expected_parallelism_value: input.expected_parallelism_value ?? null,
  }
}

function classifyParsed(input: D4Input): D4ClassificationResult {
  const features = normalize(input)
  const unknownDimensions = D4_DIMENSIONS.filter((dimension) => features[dimension] === null)

  // Precedence 0: any unknown dimension -> collect-facts, before any other rule.
  if (unknownDimensions.length > 0) {
    return {
      version: 1,
      recommendation: "collect-facts",
      rule: "incomplete-facts",
      unknownDimensions,
      features,
      basis: `Cannot classify: ${unknownDimensions.length} of 8 dimensions unknown (${unknownDimensions.join(", ")}). Facts must be collected before classification.`,
      advisory: true,
    }
  }

  const security = features.security_compliance_risk === true
  const sideEffects = features.external_side_effects === true

  // Precedence 1: high-risk wins over shared-state, multi-step, and trivial.
  if (security || sideEffects) {
    const signals: string[] = []
    if (security) signals.push("security_compliance_risk")
    if (sideEffects) signals.push("external_side_effects=true (caller's conservative assertion of a material external side effect)")
    return {
      version: 1,
      recommendation: "orchestrate-with-review",
      rule: "high-risk",
      unknownDimensions: [],
      features,
      basis: `High-risk signal (${signals.join(" and ")}): orchestrate and require an independent reviewer pass before reporting completion.`,
      advisory: true,
    }
  }

  // Precedence 2: shared mutable state -> orchestrate-serialized.
  if (features.shared_mutable_state === true) {
    return {
      version: 1,
      recommendation: "orchestrate-serialized",
      rule: "shared-state",
      unknownDimensions: [],
      features,
      basis: "Shared mutable state detected (shared_mutable_state=true): serialize implementation across overlapping writable scopes; prompt-level rules do not enforce filesystem isolation.",
      advisory: true,
    }
  }

  // Precedence 3: multi-step (stages or subtasks or files breadth) -> orchestrate-candidate.
  const stages = features.dependent_stages ?? 0
  const subtasks = features.independent_subtasks ?? 0
  const files = features.files_modules ?? 0
  if (stages > 1 || subtasks > 1 || files > 2) {
    const triggers: string[] = []
    if (stages > 1) triggers.push(`dependent_stages=${stages} (>1)`)
    if (subtasks > 1) triggers.push(`independent_subtasks=${subtasks} (>1)`)
    if (files > 2) triggers.push(`files_modules=${files} (>2)`)
    let basis = `Multi-step task (${triggers.join(", ")}): orchestration is a candidate because coordination buys decomposition and a maker-checker review.`
    if (features.expected_parallelism_value === "medium" || features.expected_parallelism_value === "high") {
      basis += " Expected parallelism value is medium/high, but this classifier never authorizes runtime parallelism."
    }
    return {
      version: 1,
      recommendation: "orchestrate-candidate",
      rule: "multi-step",
      unknownDimensions: [],
      features,
      basis,
      advisory: true,
    }
  }

  // Precedence 4: trivial single-file change -> direct-execution-candidate.
  if (
    files <= 1 &&
    features.independent_review === false &&
    features.external_side_effects === false &&
    features.shared_mutable_state === false &&
    features.security_compliance_risk === false
  ) {
    return {
      version: 1,
      recommendation: "direct-execution-candidate",
      rule: "trivial",
      unknownDimensions: [],
      features,
      basis: "Trivial change: at most one file, no review obligation, no external side effects, no shared mutable state, no security/compliance risk. Direct execution candidate (README default for single-file trivial edits).",
      advisory: true,
    }
  }

  // Precedence 5: no rule fired cleanly -> conservative collect-facts.
  return {
    version: 1,
    recommendation: "collect-facts",
    rule: "incomplete-facts",
    unknownDimensions: [],
    features,
    basis: "All eight dimensions are known, but no precedence rule fired cleanly (ambiguous classification); conservatively collect facts rather than guess a label.",
    advisory: true,
  }
}

/**
 * Classifies a task's complexity facts into an advisory recommendation.
 *
 * - `undefined`/`null` top-level input (no facts provided at all) and empty
 *   objects classify as collect-facts with every dimension unknown.
 * - Any other input must satisfy {@link D4InputSchema}; invalid structured
 *   input (negative/fractional counts, unknown fields, invalid enums, wrong
 *   types, non-object values) throws instead of being treated as unknown.
 */
export function classifyTaskComplexity(input: unknown): D4ClassificationResult {
  const parsed = D4InputSchema.safeParse(input ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    throw new Error(`Invalid D4 complexity input: ${detail}`)
  }
  return classifyParsed(parsed.data)
}