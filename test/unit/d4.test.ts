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

// ---------------------------------------------------------------------------
// Corpus fixture: read the frozen design artifact at test runtime so the
// conformance suite always tracks the checked-in JSON (not a copy).
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
  labelsOverview: {
    trivial: number
    "multi-step": number
    "shared-state": number
    "high-risk": number
    total: number
  }
  cases: CorpusCase[]
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as TaskCorpus

const caseById = new Map(corpus.cases.map((c) => [c.caseId, c]))

// Fully-known baseline facts (matches d4-case-001, the trivial case).
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

const countDimensions = ["independent_subtasks", "dependent_stages", "files_modules"] as const

describe("D4 input schema strictness", () => {
  test("exposes exactly the eight frozen dimensions", () => {
    expect(Object.keys(D4InputSchema.shape).sort()).toEqual([...D4_DIMENSIONS].sort())
  })

  test("rejects negative counts", () => {
    for (const field of countDimensions) {
      expect(() => classifyTaskComplexity({ ...fullInput, [field]: -1 })).toThrow(/Invalid D4 complexity input/)
    }
  })

  test("rejects fractional counts", () => {
    for (const field of countDimensions) {
      expect(() => classifyTaskComplexity({ ...fullInput, [field]: 0.5 })).toThrow(/Invalid D4 complexity input/)
    }
  })

  test("rejects non-numeric counts", () => {
    for (const field of countDimensions) {
      expect(() => classifyTaskComplexity({ ...fullInput, [field]: "2" })).toThrow(/Invalid D4 complexity input/)
    }
  })

  test("rejects unknown fields instead of treating them as unknown", () => {
    expect(() => classifyTaskComplexity({ ...fullInput, blast_radius: "material" })).toThrow(/Invalid D4 complexity input/)
    expect(() => classifyTaskComplexity({ ...fullInput, surprise: true })).toThrow(/Invalid D4 complexity input/)
  })

  test("rejects an invalid expected_parallelism_value enum", () => {
    expect(() => classifyTaskComplexity({ ...fullInput, expected_parallelism_value: "extreme" })).toThrow(
      /Invalid D4 complexity input/,
    )
    expect(() => classifyTaskComplexity({ ...fullInput, expected_parallelism_value: 2 })).toThrow(
      /Invalid D4 complexity input/,
    )
  })

  test("rejects wrong types for boolean dimensions", () => {
    for (const field of ["independent_review", "external_side_effects", "shared_mutable_state", "security_compliance_risk"] as const) {
      expect(() => classifyTaskComplexity({ ...fullInput, [field]: "yes" })).toThrow(/Invalid D4 complexity input/)
      expect(() => classifyTaskComplexity({ ...fullInput, [field]: 1 })).toThrow(/Invalid D4 complexity input/)
    }
  })

  test("rejects non-object top-level input", () => {
    for (const invalid of ["trivial", 42, true, ["a"], [fullInput]]) {
      expect(() => classifyTaskComplexity(invalid)).toThrow(/Invalid D4 complexity input/)
    }
  })
})

describe("missing and null facts", () => {
  test("absent input (undefined/null/{}) yields collect-facts with all eight dimensions unknown", () => {
    for (const input of [undefined, null, {}]) {
      const result = classifyTaskComplexity(input)
      expect(result.recommendation).toBe("collect-facts")
      expect(result.rule).toBe("incomplete-facts")
      expect(result.unknownDimensions).toEqual([...D4_DIMENSIONS])
      expect(result.features).toEqual({
        independent_subtasks: null,
        dependent_stages: null,
        files_modules: null,
        independent_review: null,
        external_side_effects: null,
        shared_mutable_state: null,
        security_compliance_risk: null,
        expected_parallelism_value: null,
      })
      expect(result.advisory).toBe(true)
      expect(result.version).toBe(1)
    }
  })

  test("an omitted dimension overrides high-risk, shared-state, and multi-step signals", () => {
    const { expected_parallelism_value: _omitted, ...withoutParallelism } = {
      ...fullInput,
      security_compliance_risk: true,
      shared_mutable_state: true,
      dependent_stages: 5,
      files_modules: 9,
    }
    const result = classifyTaskComplexity(withoutParallelism)
    expect(result.recommendation).toBe("collect-facts")
    expect(result.rule).toBe("incomplete-facts")
    expect(result.unknownDimensions).toEqual(["expected_parallelism_value"])
  })

  test("an explicit null on an otherwise-trivial input yields collect-facts", () => {
    const result = classifyTaskComplexity({ ...fullInput, files_modules: null })
    expect(result.recommendation).toBe("collect-facts")
    expect(result.rule).toBe("incomplete-facts")
    expect(result.unknownDimensions).toEqual(["files_modules"])
    expect(result.features.files_modules).toBeNull()
  })

  test("explicit undefined on a field counts as unknown", () => {
    const result = classifyTaskComplexity({ ...fullInput, external_side_effects: undefined })
    expect(result.recommendation).toBe("collect-facts")
    expect(result.unknownDimensions).toEqual(["external_side_effects"])
  })
})

describe("precedence", () => {
  test("high-risk wins over shared-state and multi-step", () => {
    const result = classifyTaskComplexity({
      ...fullInput,
      security_compliance_risk: true,
      shared_mutable_state: true,
      dependent_stages: 3,
      files_modules: 5,
    })
    expect(result.recommendation).toBe("orchestrate-with-review")
    expect(result.rule).toBe("high-risk")
    expect(result.unknownDimensions).toEqual([])
  })

  test("external_side_effects alone counts as high-risk (caller's conservative assertion of materiality)", () => {
    const result = classifyTaskComplexity({ ...fullInput, external_side_effects: true })
    expect(result.recommendation).toBe("orchestrate-with-review")
    expect(result.rule).toBe("high-risk")
  })

  test("shared mutable state wins over multi-step", () => {
    const result = classifyTaskComplexity({
      ...fullInput,
      shared_mutable_state: true,
      dependent_stages: 3,
      files_modules: 5,
    })
    expect(result.recommendation).toBe("orchestrate-serialized")
    expect(result.rule).toBe("shared-state")
  })

  test("multi-step fires from dependent_stages > 1", () => {
    const result = classifyTaskComplexity({ ...fullInput, dependent_stages: 2 })
    expect(result.recommendation).toBe("orchestrate-candidate")
    expect(result.rule).toBe("multi-step")
  })

  test("multi-step fires from independent_subtasks > 1", () => {
    const result = classifyTaskComplexity({ ...fullInput, independent_subtasks: 2 })
    expect(result.recommendation).toBe("orchestrate-candidate")
    expect(result.rule).toBe("multi-step")
  })

  test("multi-step fires from files_modules > 2", () => {
    const result = classifyTaskComplexity({ ...fullInput, files_modules: 3 })
    expect(result.recommendation).toBe("orchestrate-candidate")
    expect(result.rule).toBe("multi-step")
  })

  test("trivial single-file change yields direct-execution-candidate", () => {
    const result = classifyTaskComplexity(fullInput)
    expect(result.recommendation).toBe("direct-execution-candidate")
    expect(result.rule).toBe("trivial")
    expect(result.unknownDimensions).toEqual([])
    expect(result.advisory).toBe(true)
  })

  test("expected_parallelism_value never changes the recommendation", () => {
    expect(classifyTaskComplexity({ ...fullInput, expected_parallelism_value: "high" }).recommendation).toBe(
      "direct-execution-candidate",
    )
    const multi = classifyTaskComplexity({ ...fullInput, dependent_stages: 2 })
    for (const value of ["none", "low", "medium", "high"] as const) {
      expect(classifyTaskComplexity({ ...fullInput, dependent_stages: 2, expected_parallelism_value: value }).recommendation).toBe(
        multi.recommendation,
      )
    }
  })

  test("ambiguous facts fall back conservatively to collect-facts", () => {
    // files_modules = 2 satisfies neither trivial (<=1) nor multi-step (>2),
    // so no rule fires cleanly with complete facts.
    const result = classifyTaskComplexity({ ...fullInput, files_modules: 2 })
    expect(result.recommendation).toBe("collect-facts")
    expect(result.rule).toBe("incomplete-facts")
    expect(result.unknownDimensions).toEqual([])
    expect(result.basis.toLowerCase()).toContain("ambigu")
    expect(result.basis.toLowerCase()).toContain("collect facts")
  })

  test("a review obligation blocks trivial classification", () => {
    const result = classifyTaskComplexity({ ...fullInput, independent_review: true })
    expect(result.recommendation).toBe("collect-facts")
    expect(result.rule).toBe("incomplete-facts")
    expect(result.unknownDimensions).toEqual([])
    expect(result.basis.toLowerCase()).toContain("ambigu")
  })

  test("classification is deterministic", () => {
    for (const input of [
      fullInput,
      { ...fullInput, security_compliance_risk: true },
      { ...fullInput, shared_mutable_state: true },
      { ...fullInput, dependent_stages: 4 },
      { ...fullInput, files_modules: 2 },
      { ...fullInput, external_side_effects: undefined },
    ]) {
      expect(classifyTaskComplexity(input)).toEqual(classifyTaskComplexity(input))
    }
  })
})

describe("corpus conformance (docs/phase-1/d4-task-corpus.json)", () => {
  test("corpus contains 12 cases matching the frozen labels overview", () => {
    expect(corpus.cases).toHaveLength(12)
    expect(corpus.labelsOverview.total).toBe(12)
    expect(corpus.labelsOverview.trivial).toBe(3)
    expect(corpus.labelsOverview["multi-step"]).toBe(3)
    expect(corpus.labelsOverview["shared-state"]).toBe(3)
    expect(corpus.labelsOverview["high-risk"]).toBe(3)
  })

  test("every corpus case classifies with a well-formed result", () => {
    for (const c of corpus.cases) {
      const result = classifyTaskComplexity(c.features)
      expect(result.version).toBe(1)
      expect(result.advisory).toBe(true)
      expect(result.unknownDimensions).toEqual([])
      expect(result.basis.length).toBeGreaterThan(0)
      expect(["collect-facts", "direct-execution-candidate", "orchestrate-candidate", "orchestrate-serialized", "orchestrate-with-review"]).toContain(
        result.recommendation,
      )
      expect(["incomplete-facts", "high-risk", "shared-state", "multi-step", "trivial"]).toContain(result.rule)
    }
  })

  test("the 11 non-006 cases match referenceRecommendation and round-trip features", () => {
    const matching = corpus.cases.filter((c) => c.caseId !== "d4-case-006")
    expect(matching).toHaveLength(11)
    for (const c of matching) {
      const result = classifyTaskComplexity(c.features)
      expect(result.recommendation).toBe(c.referenceRecommendation)
      expect(result.features).toEqual(c.features)
    }
  })

  test("case 006 is the intentional classifier/reference mismatch", () => {
    const c = caseById.get("d4-case-006")
    expect(c).toBeDefined()
    if (!c) return

    // shared_mutable_state=true forces precedence rule 2 regardless of the
    // multi-step label hypothesis.
    const result = classifyTaskComplexity(c.features)
    expect(result.recommendation).toBe("orchestrate-serialized")
    expect(result.rule).toBe("shared-state")

    // The corpus documents the mismatch explicitly: the label is multi-step
    // with referenceRecommendation orchestrate-candidate, and the reference
    // basis states the deterministic gate predicts orchestrate-serialized.
    expect(c.label).toBe("multi-step")
    expect(c.referenceRecommendation).toBe("orchestrate-candidate")
    expect(c.referenceBasis).toContain("orchestrate-serialized")
    expect(c.referenceBasis).toContain("mismatch")

    // Guard the invariant behind the mismatch: the classifier must NOT match
    // the reference for this case, and must match it for every other case.
    expect(result.recommendation).not.toBe(c.referenceRecommendation)
  })

  test("every other corpus case matches its referenceRecommendation", () => {
    const non006 = corpus.cases.filter((c) => c.caseId !== "d4-case-006")
    expect(non006.every((c) => classifyTaskComplexity(c.features).recommendation === c.referenceRecommendation)).toBe(true)
  })
})