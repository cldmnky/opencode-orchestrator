import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  D4_DIMENSIONS,
  D4InputSchema,
  type D4ParallelismValue,
  type D4Recommendation,
  classifyTaskComplexity,
} from "../../src/core/d4.js"
import {
  D4V2_COHERENCE_QUESTION,
  D4V2_COHERENCE_VALUES,
  D4V2_D2_FLOW_THROUGH_ANSWER,
  D4V2_D2_FLOW_THROUGH_QUESTION,
  D4V2_FACT_IDS,
  D4V2_SLICE_METADATA_KINDS,
  D4V2InputSchema,
  classifyTaskComplexityV2,
} from "../../src/core/d4v2.js"

// ---------------------------------------------------------------------------
// Fixtures: the frozen D4 v1 corpus is read at test runtime so this suite
// proves the additive v2 surface leaves v1 conformance untouched.
// ---------------------------------------------------------------------------

const corpusPath = fileURLToPath(new URL("../../docs/phase-1/d4-task-corpus.json", import.meta.url))

type CorpusFeatures = {
  independent_subtasks: number
  dependent_stages: number
  files_modules: number
  independent_review: boolean
  external_side_effects: boolean
  shared_mutable_state: boolean
  security_compliance_risk: boolean
  expected_parallelism_value: D4ParallelismValue
}

type CorpusCase = {
  caseId: string
  label: string
  features: CorpusFeatures
  referenceRecommendation: D4Recommendation
  referenceBasis: string
}

type TaskCorpus = {
  labelsOverview: { trivial: number; "multi-step": number; "shared-state": number; "high-risk": number; total: number }
  cases: CorpusCase[]
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as TaskCorpus

// Fully-known v1 baseline facts (matches d4-case-001, the trivial case).
const fullInput: CorpusFeatures = {
  independent_subtasks: 0,
  dependent_stages: 0,
  files_modules: 1,
  independent_review: false,
  external_side_effects: false,
  shared_mutable_state: false,
  security_compliance_risk: false,
  expected_parallelism_value: "none",
}

const V1_RESULT_KEYS = ["advisory", "basis", "features", "recommendation", "rule", "unknownDimensions", "version"].sort()

describe("D4 v1 stays frozen while the additive v2 surface is loaded", () => {
  test("the v1 schema and dimensions are unchanged and still reject the v2 coherence field", () => {
    expect(Object.keys(D4InputSchema.shape).sort()).toEqual([...D4_DIMENSIONS].sort())
    expect("coherence" in D4InputSchema.shape).toBe(false)
    expect(() => classifyTaskComplexity({ ...fullInput, coherence: "independent" })).toThrow(
      /Invalid D4 complexity input/,
    )
  })

  test("v1 corpus conformance and the documented case-006 mismatch are unchanged", () => {
    expect(corpus.cases).toHaveLength(12)
    const mismatches = corpus.cases
      .filter((c) => classifyTaskComplexity(c.features).recommendation !== c.referenceRecommendation)
      .map((c) => c.caseId)
    expect(mismatches).toEqual(["d4-case-006"])
    const case006 = corpus.cases.find((c) => c.caseId === "d4-case-006")
    expect(case006).toBeDefined()
    if (case006) {
      expect(classifyTaskComplexity(case006.features).recommendation).toBe("orchestrate-serialized")
    }
  })

  test("v1 results keep exactly the frozen version-1 shape with no v2 fields", () => {
    const result = classifyTaskComplexity(fullInput)
    expect(result.version).toBe(1)
    expect(Object.keys(result).sort()).toEqual(V1_RESULT_KEYS)
    expect("coherence" in result).toBe(false)
    expect("sliceMetadata" in result).toBe(false)
    expect("missingFacts" in result).toBe(false)
    expect(result).toEqual(classifyTaskComplexity(fullInput))
  })

  test("the v2 input schema is an independent strict copy: v1 keys plus coherence", () => {
    const v1Keys = Object.keys(D4InputSchema.shape).sort()
    const v2Keys = Object.keys(D4V2InputSchema.shape).sort()
    expect(v2Keys).toEqual([...v1Keys, "coherence"].sort())
    expect(Object.keys(D4V2InputSchema.shape).length).toBe(v1Keys.length + 1)
    expect(D4V2InputSchema.shape).not.toBe(D4InputSchema.shape)
    // The full v2 fact set is the eight frozen dimensions plus the coherence question.
    expect([...D4V2_FACT_IDS]).toEqual([...D4_DIMENSIONS, "coherence"])
  })
})

describe("D4 v2 input schema strictness", () => {
  test("accepts every declared coherence answer, an explicit null, and omission", () => {
    for (const value of D4V2_COHERENCE_VALUES) {
      expect(D4V2InputSchema.safeParse({ ...fullInput, coherence: value }).success).toBe(true)
    }
    expect(D4V2InputSchema.safeParse({ ...fullInput, coherence: null }).success).toBe(true)
    expect(D4V2InputSchema.safeParse({ ...fullInput }).success).toBe(true)
  })

  test("rejects an invalid coherence answer instead of treating it as unknown", () => {
    for (const invalid of ["maybe", "coupled_outcome", "Independent", true, 1, ["independent"], { answer: "independent" }]) {
      expect(() => classifyTaskComplexityV2({ ...fullInput, coherence: invalid })).toThrow(
        /Invalid D4 v2 coherence input/,
      )
    }
  })

  test("rejects unknown fields, bad v1 dimensions, and non-object input", () => {
    expect(() => classifyTaskComplexityV2({ ...fullInput, coherence: "independent", blast_radius: "material" })).toThrow(
      /Invalid D4 v2 coherence input/,
    )
    expect(() => classifyTaskComplexityV2({ ...fullInput, coherence: "independent", files_modules: -1 })).toThrow(
      /Invalid D4 v2 coherence input/,
    )
    expect(() => classifyTaskComplexityV2({ ...fullInput, coherence: "independent", dependent_stages: 1.5 })).toThrow(
      /Invalid D4 v2 coherence input/,
    )
    expect(() =>
      classifyTaskComplexityV2({ ...fullInput, coherence: "independent", expected_parallelism_value: "extreme" }),
    ).toThrow(/Invalid D4 v2 coherence input/)
    for (const invalid of ["trivial", 42, true, ["a"], [fullInput]]) {
      expect(() => classifyTaskComplexityV2(invalid)).toThrow(/Invalid D4 v2 coherence input/)
    }
  })
})

describe("D4 v2 deterministic slice metadata", () => {
  test("coupled-outcome maps to cohesive-slice and carries the unchanged v1 classification", () => {
    const result = classifyTaskComplexityV2({ ...fullInput, coherence: "coupled-outcome" })
    expect(result.version).toBe(2)
    expect(result.coherence).toBe("coupled-outcome")
    expect(result.sliceMetadata?.kind).toBe("cohesive-slice")
    expect(result.sliceMetadata?.reason).toContain("one owner")
    expect(result.recommendation).toBe(classifyTaskComplexity(fullInput).recommendation)
    expect(result.rule).toBe(classifyTaskComplexity(fullInput).rule)
    expect(result.missingFacts).toEqual([])
    expect(result.v1).toEqual(classifyTaskComplexity(fullInput))
    expect(result.advisory).toBe(true)
  })

  test("independent maps to parallel-candidate only with no shared mutable state", () => {
    const result = classifyTaskComplexityV2({ ...fullInput, coherence: "independent" })
    expect(result.sliceMetadata?.kind).toBe("parallel-candidate")
    expect(result.sliceMetadata?.reason).toContain("disjoint write scopes")
    expect(result.missingFacts).toEqual([])
    expect(result.recommendation).toBe(classifyTaskComplexity(fullInput).recommendation)
  })

  test("overlap maps to serialized", () => {
    const result = classifyTaskComplexityV2({ ...fullInput, coherence: "overlap" })
    expect(result.sliceMetadata?.kind).toBe("serialized")
    expect(result.sliceMetadata?.reason).toContain("sequencing or serialization")
    expect(result.missingFacts).toEqual([])
  })

  test("independent + shared_mutable_state=true fails closed to serialized", () => {
    const conflicting = { ...fullInput, shared_mutable_state: true }
    const result = classifyTaskComplexityV2({ ...conflicting, coherence: "independent" })
    expect(result.sliceMetadata?.kind).toBe("serialized")
    expect(result.sliceMetadata?.reason).toContain("Conflicting facts")
    expect(result.recommendation).toBe("orchestrate-serialized")
    expect(result.rule).toBe("shared-state")
    expect(result.v1).toEqual(classifyTaskComplexity(conflicting))
  })

  test("the emitted slice metadata is always one of the three declared kinds", () => {
    for (const coherence of ["coupled-outcome", "independent", "overlap"] as const) {
      const kind = classifyTaskComplexityV2({ ...fullInput, coherence }).sliceMetadata?.kind
      expect(D4V2_SLICE_METADATA_KINDS).toContain(kind!)
    }
  })

  test("classification is deterministic for identical input", () => {
    for (const input of [
      { ...fullInput, coherence: "coupled-outcome" },
      { ...fullInput, coherence: "independent" },
      { ...fullInput, coherence: "overlap" },
      { ...fullInput },
      { ...fullInput, coherence: "unknown" },
      { ...fullInput, coherence: "independent", shared_mutable_state: true },
      { coherence: "overlap" },
    ]) {
      expect(classifyTaskComplexityV2(input)).toEqual(classifyTaskComplexityV2(input))
    }
  })
})

describe("D4 v2 fail-closed facts", () => {
  test("missing/null/unknown coherence yields the collect-facts-compatible path with no slice metadata", () => {
    for (const input of [fullInput, { ...fullInput, coherence: null }, { ...fullInput, coherence: "unknown" }]) {
      const result = classifyTaskComplexityV2(input)
      expect(result.sliceMetadata).toBeNull()
      expect(result.recommendation).toBe("collect-facts")
      expect(result.rule).toBe("incomplete-facts")
      expect(result.missingFacts).toEqual(["coherence"])
      expect(result.basis.toLowerCase()).toContain("collect")
      expect(result.basis.toLowerCase()).toContain("slice metadata")
      // The unchanged v1 classification is still embedded for audit.
      expect(result.v1).toEqual(classifyTaskComplexity(fullInput))
    }
  })

  test("an unknown v1 dimension fails closed even when the coherence answer is known", () => {
    const result = classifyTaskComplexityV2({ ...fullInput, files_modules: null, coherence: "independent" })
    expect(result.sliceMetadata).toBeNull()
    expect(result.recommendation).toBe("collect-facts")
    expect(result.rule).toBe("incomplete-facts")
    expect(result.missingFacts).toEqual(["files_modules"])
    expect(result.coherence).toBe("independent")
  })

  test("absent input (undefined/null/{}) reports every v2 fact missing", () => {
    for (const input of [undefined, null, {}]) {
      const result = classifyTaskComplexityV2(input)
      expect(result.sliceMetadata).toBeNull()
      expect(result.recommendation).toBe("collect-facts")
      expect(result.rule).toBe("incomplete-facts")
      expect(result.missingFacts).toEqual([...D4V2_FACT_IDS])
      expect(result.v1.recommendation).toBe("collect-facts")
      expect(result.v1.unknownDimensions).toEqual([...D4_DIMENSIONS])
    }
  })

  test("unknown coherence overrides any otherwise-complete high-risk or shared-state facts", () => {
    const highRisk = classifyTaskComplexityV2({
      ...fullInput,
      security_compliance_risk: true,
      coherence: null,
    })
    expect(highRisk.recommendation).toBe("collect-facts")
    expect(highRisk.sliceMetadata).toBeNull()
    expect(highRisk.v1.recommendation).toBe("orchestrate-with-review")
    expect(highRisk.missingFacts).toEqual(["coherence"])
  })
})

describe("D4 v2 D2 flow-through and advisory boundary", () => {
  test("every result names the D2 flow-through question and answers it deterministically", () => {
    for (const input of [
      { ...fullInput, coherence: "independent" },
      { ...fullInput },
      { ...fullInput, coherence: "overlap", shared_mutable_state: true },
    ]) {
      const result = classifyTaskComplexityV2(input)
      expect(result.d2FlowThrough.question).toBe(D4V2_D2_FLOW_THROUGH_QUESTION)
      expect(result.d2FlowThrough.answer).toBe(D4V2_D2_FLOW_THROUGH_ANSWER)
      expect(result.d2FlowThrough.answer).toContain("D2 v1 stays frozen")
      expect(result.d2FlowThrough.answer).toContain("never changes handoff validation")
      expect(result.advisory).toBe(true)
      expect(result.version).toBe(2)
    }
    // The question itself is the explicit coherence question, not prose inference.
    expect(D4V2_COHERENCE_QUESTION).toContain("coupled outcome")
    expect(D4V2_COHERENCE_QUESTION).toContain("independent")
    expect(D4V2_COHERENCE_QUESTION).toContain("unknown")
  })

  test("the v2 surface makes no isolation, scheduling, or enforcement claim", () => {
    const serialized = JSON.stringify(classifyTaskComplexityV2({ ...fullInput, coherence: "independent" }))
    expect(serialized).not.toMatch(/scheduler|semaphore|runtime enforc/i)
    expect(serialized).not.toContain("guarantee")
  })
})
