import { isAbsolute, relative, resolve } from "node:path"
import { z } from "zod"
import {
  isSafeRelativeRepoPath,
  parseD2Handoff,
  renderD2Handoff,
  validateD2Semantics,
  type D2Handoff,
} from "../../core/contracts.js"
import type { AdmissionState } from "../../core/admission.js"
import { redact as defaultRedact } from "../process/redact.js"

/**
 * Serialized D2 handoff validation (orchestrator_handoff_validate).
 *
 * A deterministic, fail-closed validator for the version-1 D2 envelope against
 * a task contract. Two levels:
 *
 * - `worker` repeats the seven worker checks (C1 structure, C2 task/status,
 *   C3 write-scope containment, C4 required commands, C5 file artifacts,
 *   C6 semantics, C7 redaction) and maps the verdict to worker-failed /
 *   blocked-unknown / worker-passed.
 * - `orchestrator` independently repeats the worker checks, then adds the
 *   honest parent checks (O2 VCS comparison, O3 required-command re-run
 *   limitation, O4 local evidence file existence, O5 foreign-file attribution,
 *   O6-O9 typed-authority unavailability) and maps the verdict to
 *   orchestrator-failed / blocked-unknown / review-pending / admitted.
 *
 * The validator is callable/advisory at the plugin level: no hook routes
 * worker output through it automatically and nothing here enforces a
 * completion gate. It never runs a shell, never persists state, and never
 * accepts typed EvidenceRecord input in this version.
 *
 * All filesystem/VCS access is injected (`sessionLocation`, `vcsStatus`,
 * `pathExists`, `realpath`) so unit tests are deterministic; the plugin wiring
 * supplies defaults built on context.session/context.vcs and node fs. Containment
 * is canonical (realpath) so symlink escape is rejected.
 *
 * The invoking session's ID is an explicit `validateHandoff` argument and flows
 * only into `deps.sessionLocation(sessionID)`; no session content is echoed or
 * logged by this module.
 */

export const HANDOFF_LEVELS = ["worker", "orchestrator"] as const
export type HandoffValidationLevel = (typeof HANDOFF_LEVELS)[number]

export type HandoffCheckVerdict = "pass" | "fail" | "blocked-unknown"

export type HandoffCheck = {
  /** Stable check id, e.g. `c1-structure`, `o2-vcs`. */
  id: string
  verdict: HandoffCheckVerdict
  /** Deterministic detail; never echoes credential-shaped input. */
  detail: string
}

export const HANDOFF_CONTRACT_SCHEMA = z
  .object({
    taskId: z.string().min(1).max(128),
    writeScope: z.array(z.string().min(1).max(2000)),
    requiredCommands: z.array(z.string().min(1).max(500)),
    reviewRequired: z.boolean(),
  })
  .strict()

export type HandoffContract = z.infer<typeof HANDOFF_CONTRACT_SCHEMA>

export const HANDOFF_VALIDATION_INPUT_SCHEMA = z
  .object({
    level: z.enum(HANDOFF_LEVELS),
    handoff: z.unknown(),
    contract: HANDOFF_CONTRACT_SCHEMA,
  })
  .strict()

export type HandoffValidationInput = z.infer<typeof HANDOFF_VALIDATION_INPUT_SCHEMA>

export type HandoffValidationResult = {
  version: 1
  level: HandoffValidationLevel
  verdict: HandoffCheckVerdict
  checks: HandoffCheck[]
  /**
   * Deterministic admission state the caller may feed to
   * `admission_transition`: worker-failed/blocked-unknown/worker-passed at
   * worker level; orchestrator-failed/blocked-unknown/review-pending/admitted
   * at orchestrator level.
   */
  admissionState: AdmissionState
  /** Five-field prose (Outcome/Files/Verification/Risks/Follow-up) only when the structural parse succeeds. */
  prose?: string
  /** Honest boundaries of what this validator could and could not prove. */
  limitations: string[]
}

export type SessionLocation = { directory: string; workspaceID?: string }

export type VcsObservedFile = { file: string }

export type ValidationDeps = {
  /** Resolve the session's current post-move location; `undefined` when unavailable. */
  sessionLocation: (sessionID: string) => Promise<SessionLocation | undefined>
  /** Observed changed files in a directory; `undefined` means VCS status is unavailable. */
  vcsStatus: (directory: string, workspaceID: string | undefined) => Promise<ReadonlyArray<VcsObservedFile> | undefined>
  /** True when the absolute path exists (file or directory). */
  pathExists: (absolutePath: string) => Promise<boolean>
  /** Canonicalize an absolute path (realpath, nearest-existing-ancestor fallback); `undefined` when unresolvable. */
  realpath: (directory: string) => Promise<string | undefined>
  /** Redaction function for C7; defaults to the shared credential redactor. */
  redactFn?: (text: string) => string
}

export const HANDOFF_CHECK_IDS = {
  c1Structure: "c1-structure",
  c2Status: "c2-status",
  c3Scope: "c3-scope",
  c4Commands: "c4-commands",
  c5Artifacts: "c5-artifacts",
  c6Semantics: "c6-semantics",
  c7Redaction: "c7-redaction",
  o2Vcs: "o2-vcs",
  o3Rerun: "o3-rerun",
  o4EvidenceFiles: "o4-evidence-files",
  o5Foreign: "o5-foreign",
  o6Authority: "o6-authority",
} as const

/* ------------------------------------------------------------------ */
/* Deterministic helpers                                               */
/* ------------------------------------------------------------------ */

export function aggregateHandoffVerdict(checks: readonly HandoffCheck[]): HandoffCheckVerdict {
  let verdict: HandoffCheckVerdict = "pass"
  for (const check of checks) {
    if (check.verdict === "fail") return "fail"
    if (check.verdict === "blocked-unknown") verdict = "blocked-unknown"
  }
  return verdict
}

/** Normalize a scope/path for matching: POSIX separators, no trailing slashes. */
function normalizeScope(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "")
}

/** Deterministic scope matcher: equality or descendant (`scope` matches `scope` or `scope/...`). */
function isWithinScope(scope: string, path: string): boolean {
  const scopeNormalized = normalizeScope(scope)
  const pathNormalized = normalizeScope(path)
  return pathNormalized === scopeNormalized || pathNormalized.startsWith(`${scopeNormalized}/`)
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function pass(id: string, detail: string): HandoffCheck {
  return { id, verdict: "pass", detail }
}

function fail(id: string, detail: string): HandoffCheck {
  return { id, verdict: "fail", detail }
}

function blocked(id: string, detail: string): HandoffCheck {
  return { id, verdict: "blocked-unknown", detail }
}

function maxVerdict(a: HandoffCheckVerdict, b: HandoffCheckVerdict): HandoffCheckVerdict {
  if (a === "fail" || b === "fail") return "fail"
  if (a === "blocked-unknown" || b === "blocked-unknown") return "blocked-unknown"
  return "pass"
}

/** Collect every non-URL evidence reference across facts, assumptions, and verification entries. */
function collectEvidenceRefs(handoff: D2Handoff): string[] {
  const refs: string[] = []
  for (const fact of handoff.facts) refs.push(...fact.evidence)
  for (const assumption of handoff.assumptions) {
    if (assumption.status !== "Unverified") refs.push(...assumption.evidence)
  }
  for (const entry of handoff.verification) {
    if (entry.evidence) refs.push(...entry.evidence)
  }
  return refs
}

function isLocalEvidenceRef(reference: string): boolean {
  return !reference.startsWith("https://")
}

/** Strip an optional `#anchor` suffix from a local file evidence ref. */
function stripAnchor(reference: string): string {
  const hash = reference.indexOf("#")
  return hash === -1 ? reference : reference.slice(0, hash)
}

/**
 * Canonical containment: both the root and the candidate are realpath-resolved
 * (the reinjected resolver uses nearest-existing-ancestor semantics, so a
 * nonexistent file inside the project stays contained), and the candidate must
 * not escape the root. Returns the canonical candidate when contained.
 */
async function containedCanonical(
  deps: ValidationDeps,
  root: string,
  candidate: string,
): Promise<string | undefined> {
  const canonicalRoot = await deps.realpath(root)
  if (!canonicalRoot) return undefined
  const lexical = relative(root, resolve(root, candidate))
  if (lexical === ".." || lexical.startsWith(`..${separator()}`) || isAbsolute(lexical)) return undefined
  const canonicalTarget = await deps.realpath(resolve(root, candidate))
  if (!canonicalTarget) return undefined
  const remainder = relative(canonicalRoot, canonicalTarget)
  if (remainder === ".." || remainder.startsWith(`..${separator()}`) || isAbsolute(remainder)) return undefined
  return canonicalTarget
}

function separator(): string {
  return resolve(".").includes("\\") ? "\\" : "/"
}

function mapAdmission(level: HandoffValidationLevel, verdict: HandoffCheckVerdict, reviewRequired: boolean): AdmissionState {
  if (level === "worker") {
    if (verdict === "fail") return "worker-failed"
    if (verdict === "blocked-unknown") return "blocked-unknown"
    return "worker-passed"
  }
  if (verdict === "fail") return "orchestrator-failed"
  if (verdict === "blocked-unknown") return "blocked-unknown"
  return reviewRequired ? "review-pending" : "admitted"
}

/* ------------------------------------------------------------------ */
/* Worker checks (C1-C7)                                               */
/* ------------------------------------------------------------------ */

function checkStructure(handoff: unknown): { check: HandoffCheck; parsed?: D2Handoff } {
  const parsed = parseD2Handoff(handoff)
  if (!parsed.ok) {
    return {
      check: fail(
        HANDOFF_CHECK_IDS.c1Structure,
        `handoff failed strict D2 structural validation with ${parsed.issues.length} issue(s); fix the envelope fields and retry`,
      ),
    }
  }
  return { check: pass(HANDOFF_CHECK_IDS.c1Structure, "handoff matches the strict D2 structure (version 1, required fields, enums, patterns)"), parsed: parsed.handoff }
}

function checkStatus(handoff: D2Handoff, contract: HandoffContract): HandoffCheck {
  if (handoff.taskId !== contract.taskId) {
    return fail(HANDOFF_CHECK_IDS.c2Status, "taskId does not match the contract")
  }
  if (handoff.status === "failed") {
    return fail(HANDOFF_CHECK_IDS.c2Status, "handoff status is failed: the receipt is not downstream-ready")
  }
  if (handoff.status === "blocked") {
    return blocked(HANDOFF_CHECK_IDS.c2Status, "handoff status is blocked: downstream use requires the blocker to be resolved first")
  }
  if (handoff.status === "in-progress") {
    return blocked(HANDOFF_CHECK_IDS.c2Status, "handoff status is in-progress: the receipt is not downstream-ready")
  }
  return pass(HANDOFF_CHECK_IDS.c2Status, "taskId matches the contract and status is completed")
}

function checkScope(handoff: D2Handoff, contract: HandoffContract): HandoffCheck {
  const scopes = dedupe(contract.writeScope.map(normalizeScope))
  const changed = dedupe(handoff.filesChanged.map((entry) => entry.path))
  if (!scopes.every(isSafeRelativeRepoPath)) {
    return fail(HANDOFF_CHECK_IDS.c3Scope, "the contract write scope contains an unsafe path entry")
  }
  if (!changed.every(isSafeRelativeRepoPath)) {
    return fail(HANDOFF_CHECK_IDS.c3Scope, "filesChanged contains an unsafe path entry")
  }
  if (scopes.length === 0) {
    if (changed.length === 0) {
      return pass(HANDOFF_CHECK_IDS.c3Scope, "no write scope in the contract and no changed files declared")
    }
    return fail(HANDOFF_CHECK_IDS.c3Scope, "filesChanged is non-empty but the contract write scope is empty")
  }
  const outside = changed.filter((path) => !scopes.some((scope) => isWithinScope(scope, path)))
  if (outside.length > 0) {
    return fail(HANDOFF_CHECK_IDS.c3Scope, "at least one changed file is outside the declared write scope")
  }
  return pass(HANDOFF_CHECK_IDS.c3Scope, "every changed file is inside the declared write scope")
}

function checkCommands(handoff: D2Handoff, contract: HandoffContract): HandoffCheck {
  const required = dedupe(contract.requiredCommands)
  if (required.length === 0) {
    return pass(HANDOFF_CHECK_IDS.c4Commands, "the contract declares no required commands")
  }
  let verdict: HandoffCheckVerdict = "pass"
  let detail = "every required command exists with passing evidence"
  for (const command of required) {
    const entries = handoff.verification.filter((entry) => entry.command === command)
    if (entries.length === 0) {
      verdict = maxVerdict(verdict, "fail")
      detail = `required command is missing from verification: ${command}`
      continue
    }
    let commandVerdict: HandoffCheckVerdict = "pass"
    let commandDetail = ""
    for (const entry of entries) {
      if (entry.status === "fail") {
        commandVerdict = maxVerdict(commandVerdict, "fail")
        commandDetail = `required command failed: ${command}`
      } else if (entry.status === "blocked" || entry.status === "not-run") {
        commandVerdict = maxVerdict(commandVerdict, "blocked-unknown")
        commandDetail = `required command is blocked or not-run: ${command}`
      } else if (entry.status === "pass" && (!entry.evidence || entry.evidence.length === 0)) {
        commandVerdict = maxVerdict(commandVerdict, "blocked-unknown")
        commandDetail = `required command passed without evidence (missing or empty): ${command}`
      }
    }
    if (commandVerdict !== "pass") {
      verdict = maxVerdict(verdict, commandVerdict)
      detail = commandDetail
    }
  }
  if (verdict === "fail") return fail(HANDOFF_CHECK_IDS.c4Commands, detail)
  if (verdict === "blocked-unknown") return blocked(HANDOFF_CHECK_IDS.c4Commands, detail)
  return pass(HANDOFF_CHECK_IDS.c4Commands, detail)
}

async function checkArtifacts(
  handoff: D2Handoff,
  deps: ValidationDeps,
  session: SessionLocation | undefined,
): Promise<HandoffCheck> {
  const fileRefs = handoff.artifactRefs.filter((artifact) => artifact.kind === "file")
  if (fileRefs.length === 0) {
    return pass(HANDOFF_CHECK_IDS.c5Artifacts, "no file artifact refs to check")
  }
  if (!session) {
    return blocked(HANDOFF_CHECK_IDS.c5Artifacts, "the current session directory is unavailable; file artifact refs could not be resolved")
  }
  for (const artifact of fileRefs) {
    if (!isSafeRelativeRepoPath(artifact.reference)) {
      return fail(HANDOFF_CHECK_IDS.c5Artifacts, "a file artifact reference is not a safe relative repo path")
    }
    const contained = await containedCanonical(deps, session.directory, artifact.reference)
    if (!contained) {
      return fail(HANDOFF_CHECK_IDS.c5Artifacts, "a file artifact reference escapes the current session project")
    }
    if (!(await deps.pathExists(contained))) {
      return fail(HANDOFF_CHECK_IDS.c5Artifacts, "a file artifact reference does not exist")
    }
  }
  return pass(HANDOFF_CHECK_IDS.c5Artifacts, "every file artifact reference resolves inside the session project and exists")
}

function checkSemantics(handoff: D2Handoff): HandoffCheck {
  const semantics = validateD2Semantics(handoff)
  const errors = semantics.filter((check) => check.level === "error")
  if (errors.length > 0) {
    return fail(HANDOFF_CHECK_IDS.c6Semantics, `semantic validation found ${errors.length} error(s)`)
  }
  return pass(
    HANDOFF_CHECK_IDS.c6Semantics,
    "no semantic errors; reviewState remains a self-declared label and is never treated as reviewer proof",
  )
}

function checkRedaction(handoff: unknown, deps: ValidationDeps): HandoffCheck {
  const redactor = deps.redactFn ?? defaultRedact
  const serialized = handoff === undefined ? "undefined" : JSON.stringify(handoff)
  const redacted = redactor(serialized)
  if (redacted !== serialized) {
    return fail(
      HANDOFF_CHECK_IDS.c7Redaction,
      "the serialized handoff contains credential-shaped content and is rejected; re-run the worker with redacted text",
    )
  }
  return pass(HANDOFF_CHECK_IDS.c7Redaction, "the serialized handoff is unchanged by credential redaction")
}

/* ------------------------------------------------------------------ */
/* Orchestrator checks (O2-O6)                                         */
/* ------------------------------------------------------------------ */

function checkVcsMatch(
  handoff: D2Handoff,
  contract: HandoffContract,
  observed: ReadonlyArray<VcsObservedFile> | undefined,
  session: SessionLocation | undefined,
): HandoffCheck {
  if (!session) {
    return blocked(HANDOFF_CHECK_IDS.o2Vcs, "the current session directory is unavailable; declared changed files could not be compared against VCS state")
  }
  if (!observed) {
    return blocked(HANDOFF_CHECK_IDS.o2Vcs, "VCS status is unavailable in the current session; declared changed files could not be independently confirmed")
  }
  const scopes = dedupe(contract.writeScope.map(normalizeScope))
  const observedFiles = dedupe(observed.map((status) => normalizeScope(status.file)).filter(Boolean))
  const declared = dedupe(handoff.filesChanged.map((entry) => normalizeScope(entry.path)))
  const missing = declared.filter((path) => !observedFiles.includes(path))
  if (missing.length > 0) {
    return fail(HANDOFF_CHECK_IDS.o2Vcs, "declared changed files were not observed in the current VCS status")
  }
  const inScopeObserved = observedFiles.filter((path) => scopes.some((scope) => isWithinScope(scope, path)))
  const extra = inScopeObserved.filter((path) => !declared.includes(path))
  if (extra.length > 0) {
    return fail(HANDOFF_CHECK_IDS.o2Vcs, "observed changed files inside the write scope were not declared")
  }
  return pass(HANDOFF_CHECK_IDS.o2Vcs, "declared changed files match the observed VCS state within the write scope")
}

function checkRerun(contract: HandoffContract): HandoffCheck {
  if (contract.requiredCommands.length === 0) {
    return pass(HANDOFF_CHECK_IDS.o3Rerun, "the contract declares no required commands to re-run")
  }
  return blocked(
    HANDOFF_CHECK_IDS.o3Rerun,
    "the pinned V2 API cannot re-run the required commands here; the parent must independently re-run them with its own tools before downstream use, and worker-declared passes are never upgraded",
  )
}

async function checkEvidenceFiles(
  handoff: D2Handoff,
  deps: ValidationDeps,
  session: SessionLocation | undefined,
): Promise<HandoffCheck> {
  const localRefs = dedupe(
    collectEvidenceRefs(handoff)
      .filter(isLocalEvidenceRef)
      .map(stripAnchor)
      .filter(Boolean),
  )
  const fileArtifacts = dedupe(handoff.artifactRefs.filter((artifact) => artifact.kind === "file").map((artifact) => artifact.reference))
  const refs = dedupe([...localRefs, ...fileArtifacts])
  if (refs.length === 0) {
    return pass(HANDOFF_CHECK_IDS.o4EvidenceFiles, "no local file evidence refs or file artifacts to check")
  }
  if (!session) {
    return blocked(HANDOFF_CHECK_IDS.o4EvidenceFiles, "the current session directory is unavailable; local evidence file refs could not be resolved")
  }
  for (const reference of refs) {
    if (!isSafeRelativeRepoPath(reference)) {
      return fail(HANDOFF_CHECK_IDS.o4EvidenceFiles, "a local evidence file ref is not a safe relative repo path")
    }
    const contained = await containedCanonical(deps, session.directory, reference)
    if (!contained) {
      return fail(HANDOFF_CHECK_IDS.o4EvidenceFiles, "a local evidence file ref escapes the current session project")
    }
    if (!(await deps.pathExists(contained))) {
      return fail(HANDOFF_CHECK_IDS.o4EvidenceFiles, "a local evidence file ref does not exist")
    }
  }
  return pass(HANDOFF_CHECK_IDS.o4EvidenceFiles, "every local evidence file ref resolves inside the session project and exists")
}

function checkForeignFiles(
  contract: HandoffContract,
  observed: ReadonlyArray<VcsObservedFile> | undefined,
  session: SessionLocation | undefined,
): HandoffCheck {
  if (!session) {
    return blocked(HANDOFF_CHECK_IDS.o5Foreign, "the current session directory is unavailable; foreign changed files could not be attributed")
  }
  if (!observed) {
    return blocked(HANDOFF_CHECK_IDS.o5Foreign, "VCS status is unavailable; cross-task receipt attribution could not be checked")
  }
  const scopes = dedupe(contract.writeScope.map(normalizeScope))
  const observedFiles = dedupe(observed.map((status) => normalizeScope(status.file)).filter(Boolean))
  const foreign = observedFiles.filter((path) => !scopes.some((scope) => isWithinScope(scope, path)))
  if (foreign.length > 0) {
    return blocked(
      HANDOFF_CHECK_IDS.o5Foreign,
      "observed changed files outside the declared write scope cannot be attributed to this receipt; cross-task dependency/receipt attribution is unavailable",
    )
  }
  return pass(HANDOFF_CHECK_IDS.o5Foreign, "no observed changed files outside the receipt's write scope; validation covers a single receipt only")
}

function checkAuthority(handoff: D2Handoff, evidenceFilesVerdict: HandoffCheckVerdict): HandoffCheck {
  const refs = collectEvidenceRefs(handoff)
  if (refs.length === 0) {
    return pass(HANDOFF_CHECK_IDS.o6Authority, "the receipt makes no fact/evidence/verification evidence claims to authenticate")
  }
  const urlRefs = refs.filter((reference) => !isLocalEvidenceRef(reference))
  if (urlRefs.length > 0) {
    return blocked(
      HANDOFF_CHECK_IDS.o6Authority,
      "evidence claims reference URLs whose authority/freshness cannot be authenticated from D2 string refs; typed EvidenceRecord input is not accepted in this version",
    )
  }
  if (evidenceFilesVerdict !== "pass") {
    return blocked(
      HANDOFF_CHECK_IDS.o6Authority,
      "local evidence file refs could not all be confirmed; authority for those claims is unknown and caller-supplied marker text is never treated as proof",
    )
  }
  return pass(HANDOFF_CHECK_IDS.o6Authority, "evidence claims reference only local static file refs whose existence was confirmed")
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Validates a handoff against a task contract at the requested level.
 *
 * Input is strict (`level`, `handoff`, `contract`); malformed envelope input
 * yields a deterministic fail result with a worker/orchestrator-appropriate
 * admission state. Verdict precedence is fail > blocked-unknown > pass.
 * Output is versioned and deterministic for a fixed input + injected deps.
 *
 * The invoking session's ID is passed explicitly so `deps.sessionLocation`
 * resolves the current post-move location for the right session. Only the
 * session ID flows through here: resolved session *content* is never echoed in
 * check details, prose, or limitations, and never logged by this module.
 */
export async function validateHandoff(
  input: unknown,
  deps: ValidationDeps,
  sessionID: string,
): Promise<HandoffValidationResult> {
  const parsedInput = HANDOFF_VALIDATION_INPUT_SCHEMA.safeParse(input)
  if (!parsedInput.success) {
    const level: HandoffValidationLevel =
      input !== null && typeof input === "object" && (input as { level?: unknown }).level === "orchestrator" ? "orchestrator" : "worker"
    return {
      version: 1,
      level,
      verdict: "fail",
      checks: [
        {
          id: "input-strict",
          verdict: "fail",
          detail: "invalid validation input: level must be worker or orchestrator and contract must be a strict object",
        },
      ],
      admissionState: mapAdmission(level, "fail", false),
      limitations: ["the validation envelope itself was rejected; no handoff checks ran"],
    }
  }

  const { level, handoff, contract } = parsedInput.data
  const checks: HandoffCheck[] = []
  const limitations: string[] = [
    "raw-transcript authenticity cannot be detected generically from D2 content; a passing result never proves a worker's transcript was honest",
    "evidence line anchors are not range-checked in this version",
  ]

  const structure = checkStructure(handoff)
  checks.push(structure.check)
  if (!structure.parsed) {
    checks.push(checkRedaction(handoff, deps))
    const verdict = aggregateHandoffVerdict(checks)
    return { version: 1, level, verdict, checks, admissionState: mapAdmission(level, verdict, contract.reviewRequired), limitations }
  }
  const d2 = structure.parsed

  checks.push(checkStatus(d2, contract))
  checks.push(checkScope(d2, contract))
  checks.push(checkCommands(d2, contract))

  const session = await deps.sessionLocation(sessionID)
  checks.push(await checkArtifacts(d2, deps, session))
  checks.push(checkSemantics(d2))
  checks.push(checkRedaction(handoff, deps))

  // Prose is echoed only when the serialized handoff survived credential
  // redaction unchanged; otherwise the credential-bearing text would leak.
  const redactionVerdict = checks.find((check) => check.id === HANDOFF_CHECK_IDS.c7Redaction)?.verdict
  const prose = redactionVerdict === "pass" ? renderD2Handoff(d2) : undefined

  let verdict: HandoffCheckVerdict
  let admissionState: AdmissionState
  let observed: ReadonlyArray<VcsObservedFile> | undefined

  if (level === "worker") {
    verdict = aggregateHandoffVerdict(checks)
    admissionState = mapAdmission(level, verdict, contract.reviewRequired)
    return { version: 1, level, verdict, checks, admissionState, ...(prose !== undefined ? { prose } : {}), limitations }
  }

  // Orchestrator level: independent repeat of the worker checks above plus the
  // honest parent checks below. VCS is read once and shared by O2 and O5.
  observed = session ? await deps.vcsStatus(session.directory, session.workspaceID) : undefined
  checks.push(checkVcsMatch(d2, contract, observed, session))
  checks.push(checkRerun(contract))
  const evidenceFilesCheck = await checkEvidenceFiles(d2, deps, session)
  checks.push(evidenceFilesCheck)
  checks.push(checkForeignFiles(contract, observed, session))
  checks.push(checkAuthority(d2, evidenceFilesCheck.verdict))

  if (contract.requiredCommands.length > 0) {
    limitations.push("the parent must independently re-run the required commands with its own tools; this validator cannot run them")
  }
  limitations.push(
    "cross-task dependency/receipt attribution is unavailable; validation covers only this single receipt",
  )
  limitations.push(
    "typed EvidenceRecord input is not accepted in this version; caller-supplied marker text (e.g. EVIDENCE_LIVE in a string) is never treated as proof, and local file ref freshness is not verified",
  )

  verdict = aggregateHandoffVerdict(checks)
  admissionState = mapAdmission(level, verdict, contract.reviewRequired)
  return { version: 1, level, verdict, checks, admissionState, ...(prose !== undefined ? { prose } : {}), limitations }
}