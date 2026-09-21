import { createHash } from "node:crypto"

/** The native V2 shell tool name measured by the pinned contract suite. */
export const VERIFICATION_TOOL_NAME = "shell"
export const VERIFICATION_COMMAND_MAX_LENGTH = 500
export const VERIFICATION_LABEL_MAX_LENGTH = 256
export const VERIFICATION_DIGEST_PATTERN = /^[0-9a-f]{64}$/
/** Receipts older than one day are diagnostic only and cannot satisfy a contract. */
export const VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Canonical command identity. The command text is intentionally not
 * whitespace-collapsed because whitespace can change shell semantics. Only
 * line endings and outer whitespace are normalized.
 */
export function canonicalVerificationCommand(command: string, tool = VERIFICATION_TOOL_NAME): string | undefined {
  if (typeof command !== "string") return undefined
  const normalized = command.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()
  if (normalized.length === 0 || normalized.length > VERIFICATION_COMMAND_MAX_LENGTH) return undefined
  return JSON.stringify({ tool, command: normalized })
}

export function verificationCommandDigest(command: string, tool = VERIFICATION_TOOL_NAME): string | undefined {
  const canonical = canonicalVerificationCommand(command, tool)
  return canonical === undefined ? undefined : createHash("sha256").update(canonical, "utf8").digest("hex")
}

export function verificationReceiptID(input: {
  rootSessionID: string
  sessionID: string
  callID: string
  commandDigest: string
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
}

/** Diagnostic-only command label: bounded and whitespace-collapsed. */
export function verificationCommandLabel(command: string, redact: (value: string) => string): string | undefined {
  const canonical = canonicalVerificationCommand(command)
  if (canonical === undefined) return undefined
  const redacted = redact(command).replace(/\s+/g, " ").trim()
  if (redacted.length === 0) return undefined
  return redacted.length <= VERIFICATION_LABEL_MAX_LENGTH
    ? redacted
    : `${redacted.slice(0, VERIFICATION_LABEL_MAX_LENGTH - 1)}…`
}

export type VerificationReceiptCandidate = {
  receiptID: string
  rootSessionID: string
  sessionID: string
  agentID: string
  commandDigest: string
  status: "pass" | "fail"
  completedAt: number
  headSha: string
}

export type VerificationMatchResult =
  | { ok: true; matched: VerificationReceiptCandidate[] }
  | { ok: false; reason: string }

/**
 * Pure matching for lead validation. Every required command needs a distinct
 * caller-selected receipt whose identity, actor, status, revision, and age
 * match the lead context.
 */
export function matchVerificationReceipts(input: {
  requiredCommands: readonly string[]
  receiptIDs: readonly string[]
  receipts: readonly VerificationReceiptCandidate[]
  rootSessionID: string
  orchestratorAgentID: string
  revision: string
  minimumCompletedAt?: number
  now?: number
  maxAgeMs?: number
}): VerificationMatchResult {
  const required = [...new Set(input.requiredCommands)]
  if (required.length === 0) return { ok: true, matched: [] }
  if (input.receiptIDs.length < required.length) return { ok: false, reason: "every required command needs a receipt ID" }
  const now = input.now ?? Date.now()
  const maxAgeMs = input.maxAgeMs ?? VERIFICATION_MAX_AGE_MS
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return { ok: false, reason: "verification freshness parameters are invalid" }
  }

  const selected = new Set<string>()
  const matched: VerificationReceiptCandidate[] = []
  for (const command of required) {
    const digest = verificationCommandDigest(command)
    if (!digest) return { ok: false, reason: "a required command is empty or exceeds the canonical command bound" }
    const candidate = input.receipts.find(
      (receipt) =>
        input.receiptIDs.includes(receipt.receiptID) &&
        !selected.has(receipt.receiptID) &&
        receipt.commandDigest === digest,
    )
    if (!candidate) return { ok: false, reason: `no receipt matches required command: ${command}` }
    if (candidate.rootSessionID !== input.rootSessionID) return { ok: false, reason: "a verification receipt belongs to another root session" }
    if (candidate.sessionID !== input.rootSessionID) return { ok: false, reason: "a verification receipt was captured in a child session" }
    if (candidate.agentID !== input.orchestratorAgentID) return { ok: false, reason: "a verification receipt was not captured by the configured orchestrator agent" }
    if (candidate.status !== "pass" || candidate.headSha !== input.revision) return { ok: false, reason: "a verification receipt is failed or revision-mismatched" }
    if (input.minimumCompletedAt !== undefined && candidate.completedAt < input.minimumCompletedAt) {
      return { ok: false, reason: "a verification receipt predates the task validation lifecycle" }
    }
    if (candidate.completedAt > now || now - candidate.completedAt > maxAgeMs) {
      return { ok: false, reason: "a verification receipt is outside the freshness bound" }
    }
    selected.add(candidate.receiptID)
    matched.push(candidate)
  }
  return { ok: true, matched }
}
