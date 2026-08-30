/**
 * D2 versioned structured handoff — strict runtime contract.
 *
 * Mirrors docs/phase-1/d2-handoff.schema.json (Draft 2020-12, version 1) as
 * callable/pure primitives: strict Zod schemas, a deterministic structural
 * parse with issue paths, a separate semantic validation, path/evidence safety
 * helpers, and a five-heading prose renderer.
 *
 * These primitives are wired through optional tool invocation
 * (orchestrator_handoff_validate) since the serialized runtime landed, but
 * they are NOT automatic gates: no worker output is routed through them by a
 * plugin hook, the orchestrator must call the tool explicitly, and neither
 * this module nor its callers may claim an enforced completion gate. Rendering
 * structured -> prose is supported; prose -> structured is not.
 *
 * Credential/raw-transcript scanning is intentionally NOT performed here
 * (that would duplicate process/redaction logic); see
 * ADAPTER_LEVEL_REQUIRED_CHECKS for the checks adapters must run and the
 * redaction check the validation tool performs before any result is returned.
 */
import { z } from "zod"

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export const D2_STATUSES = ["in-progress", "blocked", "completed", "failed"] as const
export type D2Status = (typeof D2_STATUSES)[number]

export const D2_REVIEW_STATES = ["not-requested", "pending", "approved", "changes-requested", "blocked"] as const
export type D2ReviewState = (typeof D2_REVIEW_STATES)[number]

export const ASSUMPTION_STATUSES = ["Verified", "Partially verified", "Unverified", "Not supported"] as const
export type AssumptionStatus = (typeof ASSUMPTION_STATUSES)[number]

export const VERIFICATION_STATUSES = ["not-run", "blocked", "fail", "pass"] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export const RISK_SEVERITIES = ["low", "medium", "high", "critical"] as const
export type RiskSeverity = (typeof RISK_SEVERITIES)[number]

export const ARTIFACT_KINDS = ["file", "url"] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/* ------------------------------------------------------------------ */
/* Length limits (schema parity: `minLength`/`maxLength`)              */
/* ------------------------------------------------------------------ */

export const D2_LIMITS = {
  taskId: { min: 1, max: 128 },
  outcome: { min: 1, max: 8000 },
  followUp: { min: 1, max: 4000 },
  relativeRepoPath: { min: 1, max: 1024 },
  evidenceRef: { min: 1, max: 2048 },
  statement: { min: 1, max: 2000 },
  assumptionId: { min: 1, max: 128 },
  fileScope: { min: 1, max: 2000 },
  verificationCommand: { min: 1, max: 500 },
  verificationResult: { min: 1, max: 4000 },
  artifactReference: { min: 1, max: 2048 },
  artifactDescription: { min: 1, max: 2000 },
} as const

/* ------------------------------------------------------------------ */
/* Patterns (verbatim regex sources from the docs schema $defs)        */
/* ------------------------------------------------------------------ */

/** Relative repository path: no leading `/`, no `.`/`..` segments, no `://` scheme, no quotes/control chars; spaces and dots allowed. */
export const RELATIVE_REPO_PATH_PATTERN = String.raw`^(?!.*://)(?!/)(?!.*(?:^|/)\.\.?(?:/|$))[^"'\x00-\x1f]+$`

/** Evidence reference: relative repo path with optional `#anchor`, or an https URL; any `://` string must be https. */
export const EVIDENCE_REF_PATTERN = String.raw`^(?:https://[^\s"'\x00-\x1f]+|(?!/)(?!.*://)(?!.*(?:^|/)\.\.?(?:/|$))[^"'\x00-\x1f#]+(?:#[^\s"'\x00-\x1f]*)?)$`

/** artifactRef kind=url reference: https only, no whitespace/quotes/control chars. */
export const ARTIFACT_URL_REF_PATTERN = String.raw`^https://[^\s"'\x00-\x1f]+$`

/* ------------------------------------------------------------------ */
/* $defs schemas                                                       */
/* ------------------------------------------------------------------ */

export const RELATIVE_REPO_PATH_SCHEMA = z
  .string()
  .min(D2_LIMITS.relativeRepoPath.min)
  .max(D2_LIMITS.relativeRepoPath.max)
  .regex(new RegExp(RELATIVE_REPO_PATH_PATTERN))

export const EVIDENCE_REF_SCHEMA = z
  .string()
  .min(D2_LIMITS.evidenceRef.min)
  .max(D2_LIMITS.evidenceRef.max)
  .regex(new RegExp(EVIDENCE_REF_PATTERN))

export const FACT_SCHEMA = z
  .object({
    statement: z.string().min(D2_LIMITS.statement.min).max(D2_LIMITS.statement.max),
    // minItems: 1 — every fact needs at least one evidence reference.
    evidence: z.array(EVIDENCE_REF_SCHEMA).min(1),
  })
  .strict()

export const ASSUMPTION_SCHEMA = z
  .object({
    id: z.string().min(D2_LIMITS.assumptionId.min).max(D2_LIMITS.assumptionId.max),
    statement: z.string().min(D2_LIMITS.statement.min).max(D2_LIMITS.statement.max),
    status: z.enum(ASSUMPTION_STATUSES),
    // Structurally allowed empty so Unverified can be honest; semantic
    // validation (validateD2Semantics) requires evidence for other statuses.
    evidence: z.array(EVIDENCE_REF_SCHEMA),
  })
  .strict()

export const FILE_REF_SCHEMA = z
  .object({
    path: RELATIVE_REPO_PATH_SCHEMA,
    scope: z.string().min(D2_LIMITS.fileScope.min).max(D2_LIMITS.fileScope.max),
  })
  .strict()

export const VERIFICATION_ENTRY_SCHEMA = z
  .object({
    command: z.string().min(D2_LIMITS.verificationCommand.min).max(D2_LIMITS.verificationCommand.max),
    status: z.enum(VERIFICATION_STATUSES),
    result: z.string().min(D2_LIMITS.verificationResult.min).max(D2_LIMITS.verificationResult.max),
    evidence: z.array(EVIDENCE_REF_SCHEMA).optional(),
  })
  .strict()

export const RISK_SCHEMA = z
  .object({
    severity: z.enum(RISK_SEVERITIES),
    statement: z.string().min(D2_LIMITS.statement.min).max(D2_LIMITS.statement.max),
  })
  .strict()

export const ARTIFACT_FILE_REF_SCHEMA = z
  .object({
    kind: z.literal("file"),
    // kind=file: reference must be a relative repository path.
    reference: RELATIVE_REPO_PATH_SCHEMA,
    description: z.string().min(D2_LIMITS.artifactDescription.min).max(D2_LIMITS.artifactDescription.max),
  })
  .strict()

export const ARTIFACT_URL_REF_SCHEMA = z
  .object({
    kind: z.literal("url"),
    // kind=url: reference must be an https URL.
    reference: z
      .string()
      .min(D2_LIMITS.artifactReference.min)
      .max(D2_LIMITS.artifactReference.max)
      .regex(new RegExp(ARTIFACT_URL_REF_PATTERN)),
    description: z.string().min(D2_LIMITS.artifactDescription.min).max(D2_LIMITS.artifactDescription.max),
  })
  .strict()

/** Kind-dependent artifact reference validation (schema `allOf`/`if`/`then`). */
export const ARTIFACT_REF_SCHEMA = z.discriminatedUnion("kind", [ARTIFACT_FILE_REF_SCHEMA, ARTIFACT_URL_REF_SCHEMA])

/* ------------------------------------------------------------------ */
/* Envelope schema                                                     */
/* ------------------------------------------------------------------ */

export const D2_REQUIRED_KEYS = [
  "version",
  "taskId",
  "status",
  "outcome",
  "facts",
  "assumptions",
  "filesRead",
  "filesChanged",
  "verification",
  "risks",
  "followUp",
  "artifactRefs",
  "reviewState",
] as const

export const D2_HANDOFF_SCHEMA = z
  .object({
    version: z.literal(1),
    taskId: z.string().min(D2_LIMITS.taskId.min).max(D2_LIMITS.taskId.max),
    status: z.enum(D2_STATUSES),
    outcome: z.string().min(D2_LIMITS.outcome.min).max(D2_LIMITS.outcome.max),
    facts: z.array(FACT_SCHEMA),
    assumptions: z.array(ASSUMPTION_SCHEMA),
    filesRead: z.array(FILE_REF_SCHEMA),
    filesChanged: z.array(FILE_REF_SCHEMA),
    verification: z.array(VERIFICATION_ENTRY_SCHEMA),
    risks: z.array(RISK_SCHEMA),
    followUp: z.string().min(D2_LIMITS.followUp.min).max(D2_LIMITS.followUp.max),
    artifactRefs: z.array(ARTIFACT_REF_SCHEMA),
    reviewState: z.enum(D2_REVIEW_STATES),
  })
  .strict()

export type D2Handoff = z.infer<typeof D2_HANDOFF_SCHEMA>
export type Fact = z.infer<typeof FACT_SCHEMA>
export type Assumption = z.infer<typeof ASSUMPTION_SCHEMA>
export type FileRef = z.infer<typeof FILE_REF_SCHEMA>
export type VerificationEntry = z.infer<typeof VERIFICATION_ENTRY_SCHEMA>
export type Risk = z.infer<typeof RISK_SCHEMA>
export type ArtifactRef = z.infer<typeof ARTIFACT_REF_SCHEMA>

/* ------------------------------------------------------------------ */
/* Safety helpers                                                      */
/* ------------------------------------------------------------------ */

export function isSafeRelativeRepoPath(value: string): boolean {
  return RELATIVE_REPO_PATH_SCHEMA.safeParse(value).success
}

export function isSafeEvidenceRef(value: string): boolean {
  return EVIDENCE_REF_SCHEMA.safeParse(value).success
}

/* ------------------------------------------------------------------ */
/* Deterministic structural parse                                      */
/* ------------------------------------------------------------------ */

export interface HandoffIssue {
  /** Deterministic identity path, e.g. `$.assumptions[1].evidence[0]`. */
  path: string
  /** Zod issue code (deterministic for a given input). */
  code: string
  /** Deterministic message. */
  message: string
}

export type D2ParseResult = { ok: true; handoff: D2Handoff } | { ok: false; issues: HandoffIssue[] }

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let formatted = "$"
  for (const segment of path) {
    formatted += typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`
  }
  return formatted
}

function toHandoffIssues(error: z.ZodError): HandoffIssue[] {
  const issues: HandoffIssue[] = []
  for (const issue of error.issues) {
    const basePath = formatIssuePath(issue.path)
    const keys = "keys" in issue && Array.isArray(issue.keys) ? issue.keys : undefined
    if (issue.code === "unrecognized_keys" && keys && keys.length > 0) {
      // One deterministic issue per unknown key so paths identify the field.
      for (const key of keys) {
        issues.push({
          path: `${basePath}.${String(key)}`,
          code: issue.code,
          message: `Unrecognized key: ${String(key)}`,
        })
      }
    } else {
      issues.push({ path: basePath, code: issue.code, message: issue.message })
    }
  }
  issues.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    if (a.message !== b.message) return a.message < b.message ? -1 : 1
    return 0
  })
  return issues
}

/** Structural parse: strict (unknown fields fail at every object depth), deterministic issue order. */
export function parseD2Handoff(input: unknown): D2ParseResult {
  const result = D2_HANDOFF_SCHEMA.safeParse(input)
  if (result.success) return { ok: true, handoff: result.data }
  return { ok: false, issues: toHandoffIssues(result.error) }
}

export class D2HandoffValidationError extends Error {
  readonly issues: HandoffIssue[]
  constructor(issues: HandoffIssue[]) {
    super(`D2 handoff structural validation failed with ${issues.length} issue(s)`)
    this.name = "D2HandoffValidationError"
    this.issues = issues
  }
}

/** Structural validation that throws D2HandoffValidationError on failure. */
export function validateD2Handoff(input: unknown): D2Handoff {
  const parsed = parseD2Handoff(input)
  if (!parsed.ok) throw new D2HandoffValidationError(parsed.issues)
  return parsed.handoff
}

/* ------------------------------------------------------------------ */
/* Semantic validation (separate from structural parsing)              */
/* ------------------------------------------------------------------ */

export interface D2SemanticCheck {
  /** Stable check id, e.g. `assumption-evidence`. */
  id: string
  level: "error" | "warning" | "info"
  /** Identity path of the offending field, or null for envelope-wide checks. */
  path: string | null
  /** Deterministic message. */
  message: string
}

/**
 * Semantic validation over an already-structurally-valid handoff. Returns
 * deterministic check objects; it does not gate anything and does not trust a
 * self-declared `reviewState` as reviewer proof.
 *
 * This performs NO credential/raw-transcript scanning; adapters must run the
 * checks in ADAPTER_LEVEL_REQUIRED_CHECKS before admission.
 */
export function validateD2Semantics(handoff: D2Handoff): D2SemanticCheck[] {
  const checks: D2SemanticCheck[] = []
  handoff.assumptions.forEach((assumption, index) => {
    if (assumption.status !== "Unverified" && assumption.evidence.length === 0) {
      checks.push({
        id: "assumption-evidence",
        level: "error",
        path: `$.assumptions[${index}]`,
        message: `assumption status ${assumption.status} requires at least one evidence reference; empty evidence is honest only for Unverified`,
      })
    }
  })
  if (handoff.reviewState !== "not-requested") {
    checks.push({
      id: "review-state-self-declared",
      level: "warning",
      path: "$.reviewState",
      message:
        "reviewState is a self-declared workflow label, not reviewer proof; admission tracks review separately and never trusts this field as approval",
    })
  }
  handoff.verification.forEach((entry, index) => {
    if (entry.status === "pass" && (!entry.evidence || entry.evidence.length === 0)) {
      checks.push({
        id: "pass-without-evidence",
        level: "warning",
        path: `$.verification[${index}]`,
        message:
          "declared pass carries no evidence reference (missing or empty); admission must re-derive the result rather than trust the declared pass",
      })
    }
  })
  return checks
}

/**
 * Required adapter-level checks that this core module deliberately does NOT
 * perform (no process/redaction duplication): they scan envelope strings for
 * credentials and route process output through the redactor. Marked here so
 * callers cannot mistake structural+semantic validity for admission safety.
 */
export const ADAPTER_LEVEL_REQUIRED_CHECKS = [
  {
    id: "no-credentials",
    description:
      "Scan all envelope strings (outcome, result, scope, statements, evidence refs, artifact descriptions) for raw tokens, authorization headers, environment secrets, and OAuth credentials before admission.",
  },
  {
    id: "no-raw-transcripts",
    description:
      "Pass process output referenced as evidence through the adapter-level redactor (src/opencode-v2/process/redact.ts); raw tool stderr/stdout transcripts are not admissible evidence.",
  },
] as const

/* ------------------------------------------------------------------ */
/* Five-heading prose rendering                                        */
/* ------------------------------------------------------------------ */

export const D2_PROSE_HEADINGS = ["Outcome", "Files", "Verification", "Risks", "Follow-up"] as const

function renderFileRefs(entries: ReadonlyArray<FileRef>): string {
  if (entries.length === 0) return "(none)"
  return entries.map((entry) => `${entry.path} (${entry.scope})`).join(", ")
}

/**
 * Renders a structurally-valid handoff to the five-field prose format,
 * preserving exactly the headings Outcome, Files, Verification, Risks,
 * Follow-up. Files keep the read/changed distinction and per-file scope;
 * verification entries keep command/status/result; risks keep severity.
 * Rendering is one-way: prose -> structured is not supported.
 */
export function renderD2Handoff(handoff: D2Handoff): string {
  const lines: string[] = [
    `Outcome: ${handoff.outcome}`,
    `Files: read ${renderFileRefs(handoff.filesRead)}; changed ${renderFileRefs(handoff.filesChanged)}`,
    "Verification:",
  ]
  for (const entry of handoff.verification) {
    lines.push(`  - ${entry.status} ${entry.command}: ${entry.result}`)
  }
  lines.push("Risks:")
  for (const risk of handoff.risks) {
    lines.push(`  - ${risk.severity}: ${risk.statement}`)
  }
  lines.push(`Follow-up: ${handoff.followUp}`)
  return lines.join("\n")
}