/**
 * V2 admission-state vocabulary — stateless transition machine.
 *
 * Mirrors docs/phase-1/v2-validation-checklist.md §7 (eight states, allowed
 * transitions, terminal/blocked semantics) as a pure primitive. It is
 * intentionally STATELESS: callers own the current state and persist
 * transitions. It is wired through optional tool invocation
 * (orchestrator_admission_transition) since the serialized runtime landed, but
 * it is NOT a gate: no plugin hook consumes these transitions automatically,
 * the orchestrator must call the tool explicitly, there is no completion gate,
 * and D2's `reviewState` (src/core/contracts.ts) is a separate axis that this
 * module never reads — a self-declared `approved` reviewState is never treated
 * as approval by this machine.
 *
 * Deterministic result: version 1, accepted, from, to (when accepted),
 * reason, requiresHuman, replacementReceipt.
 */
import { z } from "zod"

export const ADMISSION_STATES = [
  "candidate",
  "worker-failed",
  "worker-passed",
  "orchestrator-failed",
  "blocked-unknown",
  "review-pending",
  "review-rejected",
  "admitted",
] as const
export type AdmissionState = (typeof ADMISSION_STATES)[number]

export const ADMISSION_ACTIONS = [
  "worker-fail",
  "worker-pass",
  "worker-block",
  "orchestrator-fail",
  "orchestrator-block",
  "orchestrator-pass",
  "review-approve",
  "review-reject",
  "review-block",
  "new-receipt",
] as const
export type AdmissionAction = (typeof ADMISSION_ACTIONS)[number]

export const ADMISSION_STATE_SCHEMA = z.enum(ADMISSION_STATES)
export const ADMISSION_ACTION_SCHEMA = z.enum(ADMISSION_ACTIONS)

const REASON_SCHEMA = z.string().min(1).max(2000)

/**
 * Signal schema: a discriminated union on `action`. `orchestrator-pass`
 * requires `reviewRequired` (a task-class/config property, NOT the envelope's
 * reviewState); `new-receipt` may carry `humanDecision`, which is mandatory
 * for leaving `blocked-unknown`.
 */
export const ADMISSION_SIGNAL_SCHEMA = z.discriminatedUnion("action", [
  z.object({ action: z.literal("worker-fail"), reason: REASON_SCHEMA.optional() }).strict(),
  z.object({ action: z.literal("worker-pass"), reason: REASON_SCHEMA.optional() }).strict(),
  z.object({ action: z.literal("worker-block"), reason: REASON_SCHEMA.optional() }).strict(),
  z.object({ action: z.literal("orchestrator-fail"), reason: REASON_SCHEMA.optional() }).strict(),
  z.object({ action: z.literal("orchestrator-block"), reason: REASON_SCHEMA.optional() }).strict(),
  z.object({ action: z.literal("orchestrator-pass"), reason: REASON_SCHEMA.optional(), reviewRequired: z.boolean() }).strict(),
  z.object({ action: z.literal("review-approve"), reason: REASON_SCHEMA.optional() }).strict(),
  z.object({ action: z.literal("review-reject"), reason: REASON_SCHEMA.optional() }).strict(),
  z.object({ action: z.literal("review-block"), reason: REASON_SCHEMA.optional() }).strict(),
  z.object({ action: z.literal("new-receipt"), reason: REASON_SCHEMA.optional(), humanDecision: z.boolean().optional() }).strict(),
])
export type AdmissionSignal = z.infer<typeof ADMISSION_SIGNAL_SCHEMA>

export const ADMISSION_INPUT_SCHEMA = z
  .object({
    /** The receipt's current admission state (callers persist it). */
    from: ADMISSION_STATE_SCHEMA,
    signal: ADMISSION_SIGNAL_SCHEMA,
  })
  .strict()
export type AdmissionInput = z.infer<typeof ADMISSION_INPUT_SCHEMA>

export interface AdmissionTransitionResult {
  version: 1
  accepted: boolean
  from: AdmissionState
  to?: AdmissionState
  /** Deterministic explanation of the decision. */
  reason: string
  /** True when the machine must stop and ask the user before progress. */
  requiresHuman: boolean
  /** True when this transition supersedes the current receipt with a new one. */
  replacementReceipt: boolean
}

interface ResolvedTransition {
  accepted: boolean
  to?: AdmissionState
  reason: string
  requiresHuman: boolean
  replacementReceipt: boolean
}

function accept(to: AdmissionState, reason: string, requiresHuman = false, replacementReceipt = false): ResolvedTransition {
  return { accepted: true, to, reason, requiresHuman, replacementReceipt }
}

function reject(reason: string, requiresHuman = false): ResolvedTransition {
  return { accepted: false, reason, requiresHuman, replacementReceipt: false }
}

function resolveTransition(from: AdmissionState, signal: AdmissionSignal): ResolvedTransition {
  const action = signal.action

  // admitted is terminal: nothing further happens to this receipt.
  if (from === "admitted") {
    return reject("admitted is terminal: the receipt is consumed exactly as validated and accepts no further transitions")
  }

  // blocked-unknown never auto-advances: only an explicit human decision
  // (new-receipt with humanDecision=true) may start a rework round.
  if (from === "blocked-unknown") {
    if (signal.action === "new-receipt" && signal.humanDecision === true) {
      return accept(
        "candidate",
        "Human decision recorded: blocked-unknown only leaves via an explicit human decision; the task re-enters as a new candidate receipt",
        false,
        true,
      )
    }
    return reject(
      signal.action === "new-receipt"
        ? "blocked-unknown never auto-advances: a new receipt from blocked-unknown requires an explicit humanDecision=true signal"
        : `blocked-unknown never auto-advances: ${signal.action} is not an explicit human decision (only new-receipt with humanDecision=true is accepted)`,
      true,
    )
  }

  switch (from) {
    case "candidate": {
      if (action === "worker-fail") {
        return accept("worker-failed", "Level 1 found a hard failure (schema, scope, artifacts, credentials, honest status)")
      }
      if (action === "worker-pass") {
        return accept("worker-passed", "Level 1 passed; the receipt is not yet independently re-verified")
      }
      if (action === "worker-block") {
        return accept("blocked-unknown", "Level 1 hit evidence it cannot obtain and never guesses; stop and ask the user", true)
      }
      return reject(`candidate accepts only worker-level verdicts (worker-fail, worker-pass, worker-block); received ${action}`)
    }
    case "worker-passed": {
      if (action === "orchestrator-fail") {
        return accept("orchestrator-failed", "Level 2 found a hard failure or rejected evidence")
      }
      if (action === "orchestrator-block") {
        return accept("blocked-unknown", "Level 2 needs evidence that is missing, stale, or unknown in the current session; stop and ask the user", true)
      }
      if (action === "orchestrator-pass") {
        return signal.reviewRequired
          ? accept("review-pending", "Levels 1–2 passed and review is required; the reviewer has not yet ruled")
          : accept("admitted", "Levels 1–2 passed and review is not required; the receipt is admitted for downstream consumption")
      }
      return reject(`worker-passed accepts only orchestrator-level verdicts (orchestrator-fail, orchestrator-block, orchestrator-pass); received ${action}`)
    }
    case "review-pending": {
      if (action === "review-approve") return accept("admitted", "Reviewer approved (J1–J5 pass)")
      if (action === "review-reject") return accept("review-rejected", "Reviewer rejected or requested changes (J1–J5 fail)")
      if (action === "review-block") {
        return accept("blocked-unknown", "Reviewer is unavailable or blocked on unknown evidence; stop and ask the user", true)
      }
      return reject(`review-pending accepts only reviewer verdicts (review-approve, review-reject, review-block); received ${action}`)
    }
    case "worker-failed":
    case "orchestrator-failed":
    case "review-rejected": {
      if (action === "new-receipt") {
        return accept(
          "candidate",
          `Rework: ${from} is terminal for the current receipt only, not for the task; the task re-enters with a new receipt (same taskId)`,
          false,
          true,
        )
      }
      return reject(`terminal state ${from} accepts only an explicit new-receipt (rework) signal; received ${action}`)
    }
    default: {
      // Unreachable for schema-valid input; defensive for untyped callers.
      return reject("unknown admission state")
    }
  }
}

/**
 * Computes the deterministic transition for one (from, signal) pair. The
 * machine never probes the filesystem, never evaluates evidence, and never
 * consults the D2 envelope: it only applies the documented state semantics.
 */
export function transitionAdmission(input: AdmissionInput): AdmissionTransitionResult {
  const { from, signal } = input
  const resolved = resolveTransition(from, signal)
  return {
    version: 1,
    accepted: resolved.accepted,
    from,
    ...(resolved.to ? { to: resolved.to } : {}),
    reason: resolved.reason,
    requiresHuman: resolved.requiresHuman,
    replacementReceipt: resolved.replacementReceipt,
  }
}