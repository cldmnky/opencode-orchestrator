import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ADAPTER_LEVEL_REQUIRED_CHECKS,
  ARTIFACT_KINDS,
  ARTIFACT_URL_REF_PATTERN,
  ASSUMPTION_STATUSES,
  D2_HANDOFF_SCHEMA,
  D2_LIMITS,
  D2_PROSE_HEADINGS,
  D2_REQUIRED_KEYS,
  D2_REVIEW_STATES,
  D2_STATUSES,
  D2HandoffValidationError,
  EVIDENCE_REF_PATTERN,
  RELATIVE_REPO_PATH_PATTERN,
  RISK_SEVERITIES,
  VERIFICATION_STATUSES,
  isSafeEvidenceRef,
  isSafeRelativeRepoPath,
  parseD2Handoff,
  renderD2Handoff,
  validateD2Handoff,
  validateD2Semantics,
  type D2Handoff,
} from "../../src/core/contracts.js"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))

function loadJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), "utf8"))
}

// docs schema fixture (design artifact, read-only)
const schemaDoc = loadJson("docs/phase-1/d2-handoff.schema.json") as Record<string, unknown>
function doc(segments: string[]): any {
  let value: unknown = schemaDoc
  for (const segment of segments) {
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

const example = loadJson("docs/phase-1/d2-handoff.example.json") as Record<string, unknown>
function sampleExample(): Record<string, unknown> {
  return structuredClone(example) as Record<string, unknown>
}

function minimalHandoff(): D2Handoff {
  return {
    version: 1,
    taskId: "test-minimal",
    status: "completed",
    outcome: "did the thing",
    facts: [],
    assumptions: [],
    filesRead: [],
    filesChanged: [],
    verification: [],
    risks: [],
    followUp: "do the next thing",
    artifactRefs: [],
    reviewState: "not-requested",
  }
}

function topLevelHeadings(rendered: string): string[] {
  return rendered
    .split("\n")
    .filter((line) => /^[A-Z][A-Za-z-]*:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")))
}

describe("schema parity with docs/phase-1/d2-handoff.schema.json", () => {
  test("required keys, version const and strictness match the docs schema", () => {
    expect([...D2_REQUIRED_KEYS]).toEqual(doc(["required"]))
    expect(Object.keys(D2_HANDOFF_SCHEMA.shape)).toEqual([...D2_REQUIRED_KEYS])
    expect(D2_REQUIRED_KEYS).toHaveLength(13)
    expect(doc(["additionalProperties"])).toBe(false)
    expect(doc(["properties", "version", "const"])).toBe(1)
  })

  test("every object definition and the envelope reject unknown fields", () => {
    expect(doc(["additionalProperties"])).toBe(false)
    for (const def of ["fact", "assumption", "fileRef", "verificationEntry", "risk", "artifactRef"]) {
      expect(doc(["$defs", def, "additionalProperties"])).toBe(false)
    }
  })

  test("pattern constants are verbatim the docs schema regexes", () => {
    expect(RELATIVE_REPO_PATH_PATTERN).toBe(doc(["$defs", "relativeRepoPath", "pattern"]))
    expect(EVIDENCE_REF_PATTERN).toBe(doc(["$defs", "evidenceRef", "pattern"]))
    expect(ARTIFACT_URL_REF_PATTERN).toBe(doc(["$defs", "artifactRef", "allOf", "1", "then", "properties", "reference", "pattern"]))
  })

  test("length limits match the docs schema minLength/maxLength", () => {
    const check = (defSegments: string[], limits: { min: number; max: number }) => {
      expect(doc([...defSegments, "minLength"])).toBe(limits.min)
      expect(doc([...defSegments, "maxLength"])).toBe(limits.max)
    }
    check(["$defs", "relativeRepoPath"], D2_LIMITS.relativeRepoPath)
    check(["$defs", "evidenceRef"], D2_LIMITS.evidenceRef)
    check(["properties", "taskId"], D2_LIMITS.taskId)
    check(["properties", "outcome"], D2_LIMITS.outcome)
    check(["properties", "followUp"], D2_LIMITS.followUp)
    check(["$defs", "fact", "properties", "statement"], D2_LIMITS.statement)
    check(["$defs", "fileRef", "properties", "scope"], D2_LIMITS.fileScope)
    check(["$defs", "verificationEntry", "properties", "command"], D2_LIMITS.verificationCommand)
    check(["$defs", "verificationEntry", "properties", "result"], D2_LIMITS.verificationResult)
    check(["$defs", "artifactRef", "properties", "reference"], D2_LIMITS.artifactReference)
    check(["$defs", "artifactRef", "properties", "description"], D2_LIMITS.artifactDescription)
  })

  test("enums match the docs schema", () => {
    expect(doc(["properties", "status", "enum"])).toEqual(D2_STATUSES)
    expect(doc(["properties", "reviewState", "enum"])).toEqual(D2_REVIEW_STATES)
    expect(doc(["$defs", "assumption", "properties", "status", "enum"])).toEqual(ASSUMPTION_STATUSES)
    expect(doc(["$defs", "verificationEntry", "properties", "status", "enum"])).toEqual(VERIFICATION_STATUSES)
    expect(doc(["$defs", "risk", "properties", "severity", "enum"])).toEqual(RISK_SEVERITIES)
    expect(doc(["$defs", "artifactRef", "properties", "kind", "enum"])).toEqual(ARTIFACT_KINDS)
  })
})

describe("the illustrative example", () => {
  test("parses and validates structurally", () => {
    const parsed = parseD2Handoff(example)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.handoff.version).toBe(1)
    expect(parsed.handoff.reviewState).toBe("not-requested")
    expect(Object.keys(parsed.handoff)).toEqual([...D2_REQUIRED_KEYS])
  })

  test("validateD2Handoff returns the typed handoff for valid input", () => {
    const handoff = validateD2Handoff(example)
    expect(handoff.taskId).toBe("issue-8-d2-handoff-schema-draft")
    expect(handoff.facts.every((fact) => fact.evidence.length >= 1)).toBe(true)
  })

  test("has no semantic errors", () => {
    const handoff = validateD2Handoff(example)
    const checks = validateD2Semantics(handoff)
    expect(checks.filter((check) => check.level === "error")).toEqual([])
  })

  test("renders to exactly the five prose headings", () => {
    const parsed = parseD2Handoff(example)
    if (!parsed.ok) return
    const rendered = renderD2Handoff(parsed.handoff)
    expect(topLevelHeadings(rendered)).toEqual([...D2_PROSE_HEADINGS])
  })

  test("rendered example keeps read/changed, scopes, command/status/result, severity, followUp", () => {
    const parsed = parseD2Handoff(example)
    if (!parsed.ok) return
    const rendered = renderD2Handoff(parsed.handoff)
    const filesLine = rendered.split("\n")[1]
    expect(filesLine).toStartWith("Files: read ")
    expect(filesLine).toContain("; changed ")
    expect(filesLine).toContain("src/core/policy.ts (Confirmed HANDOFF_FORMAT fields")
    expect(filesLine).toContain("docs/phase-1/d2-handoff.schema.json (Written:")
    expect(rendered).toContain("- pass JSON.parse on schema and example: Both documents parse as valid JSON without errors.")
    expect(rendered).toContain("- not-run bun run typecheck && bun test && bun run build:")
    expect(rendered).toContain("- medium: additionalProperties=false on the envelope")
    expect(rendered).toContain("- low: The kind-dependent artifactRef path/URL patterns")
    const followUp = rendered.split("\n").at(-1)
    expect(followUp).toStartWith("Follow-up: Completed by issue #10 (current tree):")
    expect(followUp).toContain("the orchestrator_handoff_validate tool")
    expect(followUp).toContain("never emitted or consumed by a real orchestrated child hook")
    expect(rendered).toContain("src/core/contracts.ts")
  })

  test("exposes the required adapter-level credential/transcript checks without performing them here", () => {
    expect(ADAPTER_LEVEL_REQUIRED_CHECKS.map((check) => check.id)).toEqual(["no-credentials", "no-raw-transcripts"])
    expect(ADAPTER_LEVEL_REQUIRED_CHECKS[0].description).toContain("tokens")
    expect(ADAPTER_LEVEL_REQUIRED_CHECKS[1].description).toContain("redactor")
  })
})

describe("negative structural mutations of the example", () => {
  const mutationCases: Array<[string, (copy: Record<string, any>) => void]> = [
    ["version bumped to 2", (c) => void (c.version = 2)],
    ["version as string", (c) => void (c.version = "1")],
    ["extra top-level field", (c) => void (c.extraTopLevel = true)],
    ["extra nested field in a fileRef", (c) => void (c.filesRead[0].extraNested = 1)],
    ["extra field in an artifactRef", (c) => void (c.artifactRefs[0].extra = "x")],
    ["absolute path", (c) => void (c.filesRead[0].path = "/etc/passwd")],
    ["parent traversal", (c) => void (c.filesRead[0].path = "../outside")],
    ["single-dot segment", (c) => void (c.filesRead[0].path = "src/./x.ts")],
    ["double-dot segment", (c) => void (c.filesRead[0].path = "src/../x.ts")],
    ["http artifact URL", (c) => void (c.artifactRefs[3].reference = "http://example.com/artifact")],
    ["file kind with https reference", (c) => void (c.artifactRefs[0].reference = "https://example.com/artifact")],
    ["url kind with relative reference", (c) => void (c.artifactRefs[3].reference = "docs/phase-1/d2-handoff.md")],
    ["fact with empty evidence", (c) => void (c.facts[0].evidence = [])],
    ["invalid envelope status", (c) => void (c.status = "done")],
    ["invalid reviewState", (c) => void (c.reviewState = "rejected")],
    ["missing required field followUp", (c) => void delete c.followUp],
    ["empty taskId", (c) => void (c.taskId = "")],
    ["overlong outcome", (c) => void (c.outcome = "x".repeat(8001))],
    ["http evidence ref inside a fact", (c) => void (c.facts[0].evidence[0] = "http://example.com/x")],
    ["path with quote", (c) => void (c.filesRead[0].path = 'src/a"b.ts')],
    ["path with control character", (c) => void (c.filesRead[0].path = "src/a\nb.ts")],
    ["verification entry missing result", (c) => void delete c.verification[0].result],
    ["assumption missing status", (c) => void delete c.assumptions[0].status],
    ["empty followUp", (c) => void (c.followUp = "")],
    ["empty evidence ref", (c) => void (c.facts[0].evidence.push(""))],
  ]

  test.each(mutationCases)("rejects: %s", (_name, mutate) => {
    const copy = sampleExample()
    mutate(copy)
    const parsed = parseD2Handoff(copy)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues.length).toBeGreaterThan(0)
    for (const issue of parsed.issues) {
      expect(issue.path.startsWith("$")).toBe(true)
      expect(issue.code.length).toBeGreaterThan(0)
      expect(issue.message.length).toBeGreaterThan(0)
    }
    expect(() => validateD2Handoff(copy)).toThrow(D2HandoffValidationError)
  })

  test("unknown-field issues point at the exact offending key", () => {
    const copy = sampleExample()
    copy.extraTopLevel = true
    const parsed = parseD2Handoff(copy)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues.some((issue) => issue.path === "$.extraTopLevel")).toBe(true)

    const nested = sampleExample()
    ;(nested.filesRead as Array<Record<string, unknown>>)[0].extraNested = 1
    const nestedParsed = parseD2Handoff(nested)
    expect(nestedParsed.ok).toBe(false)
    if (nestedParsed.ok) return
    expect(nestedParsed.issues.some((issue) => issue.path === "$.filesRead[0].extraNested")).toBe(true)
  })

  test("issue order and content are deterministic", () => {
    const copy = sampleExample()
    ;(copy.facts as Array<Record<string, unknown>>)[0].evidence = []
    copy.status = "done"
    ;(copy.filesRead as Array<Record<string, unknown>>)[0].path = "/etc/passwd"
    const parsedA = parseD2Handoff(copy)
    const parsedB = parseD2Handoff(structuredClone(copy))
    expect(parsedA.ok).toBe(false)
    if (parsedA.ok || parsedB.ok) return
    expect(parsedA.issues).toEqual(parsedB.issues)
    expect([...parsedA.issues].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual(parsedA.issues)
  })
})

describe("path and evidence safety helpers", () => {
  test("isSafeRelativeRepoPath accepts repo-shaped relative paths", () => {
    for (const path of [
      "src/core/policy.ts",
      "docs/phase-1",
      "opencode.example.jsonc",
      "dir with space/file.ts",
      "src/deep/nested/file.name.txt",
    ]) {
      expect(isSafeRelativeRepoPath(path)).toBe(true)
    }
  })

  test("isSafeRelativeRepoPath rejects absolute, traversal, scheme, quote and control paths", () => {
    for (const path of ["/etc/passwd", "../outside", "a/../b", "http://x/y", "file://x", "a\"b", "a\nb", "a\tb", "a\u0000b", ""]) {
      expect(isSafeRelativeRepoPath(path)).toBe(false)
    }
  })

  test("isSafeEvidenceRef accepts relative paths, anchors and https URLs", () => {
    for (const ref of [
      "src/core/policy.ts",
      "src/core/policy.ts#L19-25",
      "docs/phase-1",
      "https://json-schema.org/draft/2020-12/schema",
    ]) {
      expect(isSafeEvidenceRef(ref)).toBe(true)
    }
  })

  test("isSafeEvidenceRef rejects http, absolute, traversal and whitespace-with-https forms", () => {
    for (const ref of ["http://x/y", "/abs", "a/../b", "https://x y", "a\nb", "a\"b", ""]) {
      expect(isSafeEvidenceRef(ref)).toBe(false)
    }
  })
})

describe("semantic validation", () => {
  test("flags non-Unverified assumptions with empty evidence", () => {
    const copy = sampleExample()
    ;(copy.assumptions as Array<Record<string, unknown>>)[0].evidence = []
    const checks = validateD2Semantics(validateD2Handoff(copy))
    const assumptionChecks = checks.filter((check) => check.id === "assumption-evidence" && check.level === "error")
    expect(assumptionChecks).toHaveLength(1)
    expect(assumptionChecks[0].path).toBe("$.assumptions[0]")
    expect(assumptionChecks[0].message).toContain("Not supported")
  })

  test("Verified also requires evidence; Unverified may honestly be empty", () => {
    const copy = sampleExample()
    const assumptions = copy.assumptions as Array<Record<string, unknown>>
    assumptions[1].evidence = []
    const checks = validateD2Semantics(validateD2Handoff(copy))
    expect(checks.some((check) => check.id === "assumption-evidence" && check.path === "$.assumptions[1]")).toBe(true)

    const unverified = minimalHandoff()
    unverified.assumptions = [{ id: "u1", statement: "assumed", status: "Unverified", evidence: [] }]
    expect(validateD2Semantics(unverified).some((check) => check.id === "assumption-evidence")).toBe(false)
  })

  test("reviewState is not treated as reviewer proof", () => {
    const copy = sampleExample()
    copy.reviewState = "approved"
    const checks = validateD2Semantics(validateD2Handoff(copy))
    const reviewWarnings = checks.filter((check) => check.id === "review-state-self-declared")
    expect(reviewWarnings).toHaveLength(1)
    expect(reviewWarnings[0].level).toBe("warning")
    expect(reviewWarnings[0].message).toContain("not reviewer proof")
  })

  test("warns when a declared pass has no evidence reference", () => {
    const copy = sampleExample()
    const verification = copy.verification as Array<Record<string, unknown>>
    delete verification[1].evidence
    const checks = validateD2Semantics(validateD2Handoff(copy))
    expect(checks.some((check) => check.id === "pass-without-evidence" && check.path === "$.verification[1]")).toBe(true)
  })

  test("warns when a declared pass carries an explicitly empty evidence array", () => {
    // Regression: `[]` is a present-but-empty evidence claim and must be
    // treated like a missing one so a bare declared pass is never trusted.
    const copy = sampleExample()
    const verification = copy.verification as Array<Record<string, unknown>>
    verification[1].evidence = []
    const checks = validateD2Semantics(validateD2Handoff(copy))
    const warnings = checks.filter((check) => check.id === "pass-without-evidence" && check.path === "$.verification[1]")
    expect(warnings).toHaveLength(1)
    expect(warnings[0].level).toBe("warning")
    expect(warnings[0].message).toContain("missing or empty")
  })

  test("semantic checks are deterministic", () => {
    const handoff = validateD2Handoff(example)
    const a = validateD2Semantics(handoff)
    const b = validateD2Semantics(handoff)
    expect(a).toEqual(b)
  })
})

describe("renderer", () => {
  test("renders a minimal envelope to an exact five-heading prose block", () => {
    expect(renderD2Handoff(minimalHandoff())).toBe(
      [
        "Outcome: did the thing",
        "Files: read (none); changed (none)",
        "Verification:",
        "Risks:",
        "Follow-up: do the next thing",
      ].join("\n"),
    )
  })

  test("preserves read/changed distinction with per-file scope", () => {
    const handoff = minimalHandoff()
    handoff.filesRead = [{ path: "src/a.ts", scope: "read for a" }]
    handoff.filesChanged = [
      { path: "src/b.ts", scope: "added b" },
      { path: "docs/note.md", scope: "documented b" },
    ]
    const rendered = renderD2Handoff(handoff)
    expect(rendered).toContain("Files: read src/a.ts (read for a); changed src/b.ts (added b), docs/note.md (documented b)")
  })

  test("keeps command, status and result per verification entry", () => {
    const handoff = minimalHandoff()
    handoff.verification = [
      { command: "bun test", status: "pass", result: "all passed" },
      { command: "bun run build", status: "not-run", result: "skipped: docs-only change" },
    ]
    const rendered = renderD2Handoff(handoff)
    expect(rendered).toContain("- pass bun test: all passed")
    expect(rendered).toContain("- not-run bun run build: skipped: docs-only change")
  })

  test("keeps risk severity", () => {
    const handoff = minimalHandoff()
    handoff.risks = [
      { severity: "critical", statement: "data loss" },
      { severity: "low", statement: "cosmetic" },
    ]
    const rendered = renderD2Handoff(handoff)
    expect(rendered).toContain("- critical: data loss")
    expect(rendered).toContain("- low: cosmetic")
  })

  test("the five headings are the only top-level headings", () => {
    const handoff = minimalHandoff()
    handoff.outcome = "No extra headings, even with colons in text."
    expect(topLevelHeadings(renderD2Handoff(handoff))).toEqual(["Outcome", "Files", "Verification", "Risks", "Follow-up"])
  })
})
