import { z } from "zod"
import {
  D4_DIMENSIONS,
  D4InputSchema,
  type D4ClassificationResult,
  type D4Recommendation,
  type D4Rule,
  classifyTaskComplexity,
} from "./d4.js"

/**
 * D4 v2 — additive coherence signal (pure, advisory classifier).
 *
 * Phase 3 adds a separate, versioned surface on top of the frozen D4 v1
 * classifier (`src/core/d4.ts`). The v1 module is imported and called
 * read-only: its schema, precedence, corpus, and results are never modified,
 * re-exported with different behavior, or shadowed. `classifyTaskComplexity`
 * remains the single v1 authority and its output is embedded verbatim under
 * `v1` in every v2 result.
 *
 * - Input: the same eight structured dimensions as v1 (same strictness and
 *   unknown/null handling) plus one explicit coherence question. The v1
 *   dimensions alone cannot answer it, so the caller must state the coherence
 *   answer (`coupled-outcome`, `independent`, `overlap`, or `unknown`) — a
 *   missing/`null` answer is unknown.
 * - Output: additive slice metadata (`cohesive-slice | parallel-candidate |
 *   serialized`) derived deterministically from the coherence answer, plus
 *   v1's unchanged eight-dimension classification.
 * - Fail closed: an unknown coherence answer, or any unknown v1 dimension,
 *   yields a collect-facts-compatible result (`recommendation:
 *   "collect-facts"`, `rule: "incomplete-facts"`, `sliceMetadata: null`)
 *   instead of guessing a slice label. Unknown coupling is never emitted as a
 *   parallel candidate; a contradictory `independent` answer with
 *   `shared_mutable_state=true` serializes.
 *
 * This surface is advisory only: nothing here enforces, schedules, delegates,
 * persists, gates publication, or changes D2 v1. Every result carries
 * `advisory: true`, and the D2 flow-through question is named and answered in
 * every result (`d2FlowThrough`): the v2 signal adds or changes no D2 handoff
 * field, `reviewState` value, or handoff-validation behavior.
 */

/** The explicit coherence question the v2 input answers. */
export const D4V2_COHERENCE_QUESTION =
  "Would the candidate slice's files change together for one coupled outcome (cohesive slice), are they genuinely independent (parallel candidate), or do they overlap / is the coupling unknown (serialize)?" as const

/** Strict v2 coherence answers; `unknown` behaves exactly like a missing/null answer. */
export const D4V2_COHERENCE_VALUES = ["coupled-outcome", "independent", "overlap", "unknown"] as const
export type D4V2CoherenceValue = (typeof D4V2_COHERENCE_VALUES)[number]

/** Additive slice-metadata kinds emitted by the v2 coherence signal. */
export const D4V2_SLICE_METADATA_KINDS = ["cohesive-slice", "parallel-candidate", "serialized"] as const
export type D4V2SliceMetadataKind = (typeof D4V2_SLICE_METADATA_KINDS)[number]

/** v2 fact IDs: the eight frozen v1 dimensions plus the explicit coherence fact. */
export const D4V2_FACT_IDS = [...D4_DIMENSIONS, "coherence"] as const
export type D4V2FactId = (typeof D4V2_FACT_IDS)[number]

/**
 * Strict v2 input schema: the eight frozen v1 dimensions (same strictness and
 * missing/null handling) plus `coherence`. Unknown fields, invalid coherence
 * answers, and wrong types are rejected by this schema, never treated as
 * unknown.
 */
export const D4V2InputSchema = D4InputSchema.extend({
  coherence: z.enum(D4V2_COHERENCE_VALUES).optional().nullable(),
}).strict()

export type D4V2Input = z.infer<typeof D4V2InputSchema>

/** Deterministic slice metadata for a complete coherence answer. */
export type D4V2SliceMetadata = {
  /** Deterministic slice shape for the answer. */
  kind: D4V2SliceMetadataKind
  /** Why that shape is recommended. */
  reason: string
}

/** The D2 flow-through question, named upfront (Phase 3 requirement). */
export const D4V2_D2_FLOW_THROUGH_QUESTION =
  "Does the additive D4 v2 coherence signal add or change any D2 v1 handoff field, reviewState value, or handoff-validation behavior?" as const

/** The deterministic answer: D2 v1 stays frozen and untouched. */
export const D4V2_D2_FLOW_THROUGH_ANSWER =
  "No. D2 v1 stays frozen: the v2 signal adds no D2 field, never replaces or writes reviewState, and never changes handoff validation; slice metadata is advisory coordination guidance only." as const

export type D4V2Result = {
  /** Additive v2 version marker (v1 results stay `version: 1`). */
  version: 2
  /** The coherence answer as provided; `null` when it was omitted or null (unknown). */
  coherence: D4V2CoherenceValue | null
  /** Additive slice metadata; `null` whenever any required fact is unknown (fail closed). */
  sliceMetadata: D4V2SliceMetadata | null
  /** v2 recommendation: v1's unchanged recommendation when every required fact is known; `collect-facts` when any required fact is unknown. */
  recommendation: D4Recommendation
  /** v2 rule: v1's unchanged rule when every required fact is known; `incomplete-facts` when any required fact is unknown. */
  rule: D4Rule
  /** Facts that were missing/unknown: v1 dimension IDs and/or `coherence`; empty only when every required fact is known. */
  missingFacts: D4V2FactId[]
  /** The unchanged D4 v1 classification for the eight dimensions, embedded verbatim for audit. */
  v1: D4ClassificationResult
  /** Deterministic human-readable rationale for the v2 outcome. */
  basis: string
  /** D2 flow-through question, named upfront and answered deterministically. */
  d2FlowThrough: {
    question: string
    answer: string
  }
  /** Advisory only: nothing returned here is runtime-enforced. */
  advisory: true
}

/** True only for the three classified answers; `null` and `unknown` are unknown. */
function isKnownCoherence(
  coherence: D4V2CoherenceValue | null,
): coherence is Exclude<D4V2CoherenceValue, "unknown"> {
  return coherence !== null && coherence !== "unknown"
}

/**
 * Deterministic mapping from a complete, non-unknown coherence answer to slice
 * metadata. The single cross-check is fail-closed: an `independent` answer
 * with v1 `shared_mutable_state=true` is contradictory input and serializes
 * instead of being emitted as a parallel candidate.
 */
function sliceMetadataFor(
  coherence: Exclude<D4V2CoherenceValue, "unknown">,
  v1: D4ClassificationResult,
): D4V2SliceMetadata {
  if (coherence === "coupled-outcome") {
    return {
      kind: "cohesive-slice",
      reason:
        "Coupled outcome: keep the code, tests, wiring, and requested docs that must change together under one owner in a single slice; split only at a verified boundary.",
    }
  }
  if (coherence === "independent") {
    if (v1.features.shared_mutable_state === true) {
      return {
        kind: "serialized",
        reason:
          "Conflicting facts: coherence=independent but shared_mutable_state=true; overlapping mutable state is serialized, never parallelized (overlap and unknown coupling fail closed).",
      }
    }
    return {
      kind: "parallel-candidate",
      reason:
        "Independent slices: a parallel candidate only after the parent verifies exact disjoint write scopes from repository facts; prompt-level scopes are coordination units, not filesystem isolation, and unknown coupling still serializes.",
    }
  }
  return {
    kind: "serialized",
    reason:
      "Overlapping coupling: resolve overlap by sequencing or serialization with integrated parent verification — never by concurrent overlapping writes.",
  }
}

function classifyParsed(input: D4V2Input): D4V2Result {
  const coherence = input.coherence ?? null
  // Strip the additive coherence field before handing the eight v1 dimensions
  // to the unchanged v1 classifier (its strict schema rejects unknown fields).
  const { coherence: _coherence, ...v1Input } = input
  const v1 = classifyTaskComplexity(v1Input)

  const d2FlowThrough = {
    question: D4V2_D2_FLOW_THROUGH_QUESTION,
    answer: D4V2_D2_FLOW_THROUGH_ANSWER,
  }

  // Fail closed: any unknown required fact yields the collect-facts-compatible
  // shape and never a guessed slice label.
  if (v1.unknownDimensions.length > 0 || !isKnownCoherence(coherence)) {
    const missingParts: string[] = []
    if (v1.unknownDimensions.length > 0) {
      missingParts.push(
        `${v1.unknownDimensions.length} of 8 v1 dimensions unknown (${v1.unknownDimensions.join(", ")})`,
      )
    }
    if (!isKnownCoherence(coherence)) missingParts.push("the explicit coherence answer is unknown")

    const missingFacts: D4V2FactId[] = [...v1.unknownDimensions]
    if (!isKnownCoherence(coherence)) missingFacts.push("coherence")

    return {
      version: 2,
      coherence,
      sliceMetadata: null,
      recommendation: "collect-facts",
      rule: "incomplete-facts",
      missingFacts,
      v1,
      basis: [
        `Cannot emit slice metadata: ${missingParts.join(" and ")}.`,
        "Collect the missing facts before emitting slice metadata; unknown coupling fails closed and serializes.",
        `v1 classification over the eight dimensions: ${v1.rule} -> ${v1.recommendation}.`,
      ].join(" "),
      d2FlowThrough,
      advisory: true,
    }
  }

  // Complete facts: every v1 dimension is known and the coherence answer is
  // one of the three classified answers.
  const metadata = sliceMetadataFor(coherence, v1)
  return {
    version: 2,
    coherence,
    sliceMetadata: metadata,
    recommendation: v1.recommendation,
    rule: v1.rule,
    missingFacts: [],
    v1,
    basis: `${v1.basis} Coherence answer: ${coherence}. ${metadata.reason}`,
    d2FlowThrough,
    advisory: true,
  }
}

/**
 * Classifies a task's eight v1 complexity facts plus the explicit coherence
 * answer into advisory slice metadata.
 *
 * - `undefined`/`null` top-level input (no facts provided at all) and empty
 *   objects classify as collect-facts-compatible with every fact missing.
 * - Any other input must satisfy {@link D4V2InputSchema}; invalid structured
 *   input (negative/fractional counts, unknown fields, invalid enums, wrong
 *   types, non-object values) throws instead of being treated as unknown.
 * - Deterministic: identical inputs always produce deeply equal results.
 */
export function classifyTaskComplexityV2(input: unknown): D4V2Result {
  const parsed = D4V2InputSchema.safeParse(input ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    throw new Error(`Invalid D4 v2 coherence input: ${detail}`)
  }
  return classifyParsed(parsed.data)
}
