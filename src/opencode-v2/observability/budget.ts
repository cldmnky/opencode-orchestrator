/**
 * S3 deterministic budget evaluation - pure, stateless, metadata-only.
 *
 * `evaluateBudget` returns a deterministic `within | exceeded | unknown`
 * verdict for one observation against the configured nullable limits. Unknown
 * observations are reported as `unknown` (missing coverage is NEVER reported
 * as zero); for `stop-between-steps` checks unknown token/cost coverage fails
 * closed (it is folded to `exceeded` with the reason recorded) so a dispatch
 * cannot proceed on unprovable usage. Advisory mode never blocks and leaves
 * unknown as `unknown`.
 */
import type { BudgetLimits, BudgetMode } from "../../core/config.js"

export const BUDGET_LIMIT_NAMES = [
  "max_steps",
  "max_tokens",
  "max_cost_usd",
  "max_wall_clock_ms",
  "max_retries",
] as const
export type BudgetLimitName = (typeof BUDGET_LIMIT_NAMES)[number]

export type BudgetObservation = {
  /** Completed/observed step count for the run/session. */
  steps?: number
  /** Total model tokens observed (input + output + reasoning) from a usage snapshot. */
  tokens?: number
  /** Total cost in USD observed from a usage snapshot. */
  costUsd?: number
  /** Observed retry count. */
  retries?: number
  /** Run/session start time (epoch ms) for the wall-clock limit. */
  startedAt?: number
  /** Reference clock; defaults to Date.now(). Injected for deterministic tests. */
  now?: number
}

export type BudgetLimitStatus = "within" | "exceeded" | "unknown"

export type BudgetDetail = {
  limit: BudgetLimitName
  /** The configured limit value (present whenever the limit was configured). */
  configured?: number
  /** The observed value when one existed. */
  observed?: number
  status: BudgetLimitStatus
  reason?: string
}

export type BudgetVerdict = "within" | "exceeded" | "unknown"

export type BudgetEvaluation = {
  version: 1
  mode: BudgetMode
  verdict: BudgetVerdict
  limits: BudgetDetail[]
}

/** The limit names actually configured (non-null) on a budget options block. */
export function configuredBudgetLimits(limits: BudgetLimits): BudgetLimitName[] {
  return BUDGET_LIMIT_NAMES.filter((name) => limits[name] !== undefined && limits[name] !== null)
}

export function evaluateBudget(input: {
  observed: BudgetObservation
  limits: BudgetLimits
  mode: BudgetMode
}): BudgetEvaluation {
  const now = input.observed.now ?? Date.now()
  const limits = input.limits
  const details: BudgetDetail[] = []

  if (limits.max_steps != null) {
    details.push(evaluateCountLimit("max_steps", limits.max_steps, input.observed.steps, "step"))
  }
  if (limits.max_tokens != null) {
    details.push(evaluateUsageLimit("max_tokens", limits.max_tokens, input.observed.tokens, "token", input.mode))
  }
  if (limits.max_cost_usd != null) {
    details.push(evaluateUsageLimit("max_cost_usd", limits.max_cost_usd, input.observed.costUsd, "cost", input.mode))
  }
  if (limits.max_wall_clock_ms != null) {
    if (input.observed.startedAt === undefined) {
      details.push({
        limit: "max_wall_clock_ms",
        configured: limits.max_wall_clock_ms,
        status: "unknown",
        reason: "no run start observation; wall-clock elapsed cannot be computed and is unknown, never zero",
      })
    } else {
      const elapsed = Math.max(0, now - input.observed.startedAt)
      details.push({
        limit: "max_wall_clock_ms",
        configured: limits.max_wall_clock_ms,
        observed: elapsed,
        status: elapsed > limits.max_wall_clock_ms ? "exceeded" : "within",
      })
    }
  }
  if (limits.max_retries != null) {
    details.push(evaluateCountLimit("max_retries", limits.max_retries, input.observed.retries, "retry"))
  }

  const verdict: BudgetVerdict = details.some((detail) => detail.status === "exceeded")
    ? "exceeded"
    : details.some((detail) => detail.status === "unknown")
      ? "unknown"
      : "within"

  return { version: 1, mode: input.mode, verdict, limits: details }
}

function evaluateCountLimit(limit: BudgetLimitName, configured: number, observed: number | undefined, label: string): BudgetDetail {
  if (observed === undefined) {
    return {
      limit,
      configured,
      status: "unknown",
      reason: `no ${label} observation for this session; missing coverage is unknown, never zero`,
    }
  }
  return {
    limit,
    configured,
    observed,
    status: observed > configured ? "exceeded" : "within",
  }
}

/**
 * Token/cost limits: an absent observation is `unknown`, and for
 * `stop-between-steps` checks that unknown folds to `exceeded` (fail closed)
 * so a new dispatch cannot ride on unprovable usage.
 */
function evaluateUsageLimit(
  limit: BudgetLimitName,
  configured: number,
  observed: number | undefined,
  label: string,
  mode: BudgetMode,
): BudgetDetail {
  if (observed === undefined) {
    const reason = `no ${label} usage snapshot observed for this session; missing coverage is unknown, never zero`
    if (mode === "stop-between-steps") {
      return {
        limit,
        configured,
        status: "exceeded",
        reason: `${reason}; stop-between-steps fails closed on unknown ${label} coverage`,
      }
    }
    return { limit, configured, status: "unknown", reason }
  }
  return {
    limit,
    configured,
    observed,
    status: observed > configured ? "exceeded" : "within",
  }
}