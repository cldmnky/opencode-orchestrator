/**
 * N5 bounded retry policy - pure decision + default-off hook observation.
 *
 * The pinned host exposes `session.hook("retry")` with a physical `attempt`
 * number (the initial request is 1, so the first retry is 2), the classified
 * session error (`provider.rate-limit`, `provider.internal`,
 * `provider.transport`, `provider.unknown`, ...), and a mutable host-proposed
 * decision. This module NEVER registers anything by itself: `plugin.ts`
 * registers the hook only when `retry.mode: "bounded"` is configured, and the
 * default (`"off"`) leaves every existing behavior byte-identical.
 *
 * The policy only ever narrows what the host proposes:
 *   - a host `retry: false` is final and is never changed to `true`;
 *   - only positively-classified transient classes (`rate-limited`,
 *     `provider-internal`) keep a host-proposed retry;
 *   - `transport` and `unknown` are ambiguous: the hook cannot verify that a
 *     request was not already accepted/rejected, and it cannot establish the
 *     class, so it never retries them blindly;
 *   - `terminal` (auth, quota, content-filter, invalid-request, unsupported,
 *     no-route, aborted, invalid-output, and anything unrecognized by the host
 *     contract) is never retried;
 *   - a valid finite delay above `max_delay_ms` is capped DOWN only (never
 *     raised), and malformed delays (`NaN`, infinity, negative) are left
 *     untouched so the host falls back to its computed delay;
 *   - per-session bursts are bounded: more than
 *     `RETRY_BURST_MAX_ATTEMPTS` hook observations inside
 *     `RETRY_BURST_WINDOW_MS` veto the retry (`veto-burst`).
 *
 * The built-in maximum attempt count remains a hard host limit. Attempts are
 * recorded only as bounded trace metadata (`retryTraceSchema`): counts, fixed
 * enum values, and timestamps - never prompts, transcripts, error text, or
 * credentials. Recording failures are swallowed after a bounded warning and
 * can never break a model request.
 */
import type { OrchestratorOptions } from "../../core/config.js"
import { RUNTIME_PLUGIN_ID } from "../../core/package-identity.js"
import {
  RETRY_ACTIONS,
  RETRY_CLASSES,
  newRetryTrace,
  parseRetryTrace,
  recordRetryAction,
  retryTraceStorageKey,
  type RetryAction,
  type RetryClass,
  type RetryTrace,
} from "./trace.js"
import { stableProjectID, withSessionLock, type LocationLike, type StorageLike } from "../goal/state.js"

export { RETRY_ACTIONS, RETRY_CLASSES }
export type { RetryAction, RetryClass, RetryTrace }

/** Bounded per-session burst window: attempts older than this do not count. */
export const RETRY_BURST_WINDOW_MS = 60_000
/** Maximum hook-observed attempts per session inside one burst window. */
export const RETRY_BURST_MAX_ATTEMPTS = 6
/** Absolute ceiling for any delay the policy applies (the host's own retry-after ceiling). */
export const RETRY_HARD_MAX_DELAY_MS = 900_000
/** Fallback cap for a malformed `maxDelayMs` input (the config default). */
export const RETRY_DEFAULT_MAX_DELAY_MS = 30_000

export type RetryDecision = { retry: false } | { retry: true; delay: number }

export type RetryErrorLike = {
  type: string
  status?: number
}

/** The subset of the pinned `SessionRetry` hook event the policy depends on. */
export type RetryHookEventLike = {
  sessionID: string
  agent: string
  model: { providerID: string; id: string; variant?: string }
  error: RetryErrorLike
  attempt: number
  decision: RetryDecision
}

export type RetryPolicyInput = {
  error: RetryErrorLike
  attempt: number
  decision: RetryDecision
  /** Current time; injected for deterministic tests. */
  now: number
  /** Prior hook-observation timestamps for this session (bounded, oldest first). */
  window: readonly number[]
  maxDelayMs: number
}

export type RetryPolicyResult = {
  /** The decision the hook should apply; for `keep` it is the input decision. */
  decision: RetryDecision
  class: RetryClass
  action: RetryAction
  /** Updated bounded burst window (oldest first). */
  window: number[]
}

/** Whether the N5 policy must be wired at all (default-off). */
export function retryPolicyEnabled(options: OrchestratorOptions): boolean {
  return options.retry.mode === "bounded"
}

/**
 * Deterministic, bounded class map. The host contract's error `type` is the
 * only classification the retry hook exposes; anything not positively
 * classified transient is refused rather than retried blindly.
 */
export function classifyRetryError(error: RetryErrorLike): RetryClass {
  switch (error.type) {
    case "provider.rate-limit":
      return "rate-limited"
    case "provider.internal":
      return "provider-internal"
    case "provider.transport":
      return "transport"
    case "provider.unknown":
      return "unknown"
    default:
      return "terminal"
  }
}

/**
 * Pure bounded decision. Never converts `retry: false` into a retry, only
 * caps valid delays downward, leaves malformed delays for the host fallback,
 * vetoes ambiguous classes, and vetoes bursts.
 */
export function decideRetry(input: RetryPolicyInput): RetryPolicyResult {
  const errorClass = classifyRetryError(input.error)
  const window = boundedWindow(input.window, input.now)
  const attemptsInWindow = window.length
  const nextWindow = [...window, input.now].slice(-RETRY_BURST_MAX_ATTEMPTS)

  // Terminal decision: final, never resurrected.
  if (!input.decision.retry) {
    return { decision: { retry: false }, class: errorClass, action: "host-terminal", window: nextWindow }
  }

  // Bounded burst gate: never let a retry storm through.
  if (attemptsInWindow >= RETRY_BURST_MAX_ATTEMPTS) {
    return { decision: { retry: false }, class: errorClass, action: "veto-burst", window: nextWindow }
  }

  // Only positively-classified transient classes keep a host-proposed retry.
  if (errorClass !== "rate-limited" && errorClass !== "provider-internal") {
    return { decision: { retry: false }, class: errorClass, action: "veto-class", window: nextWindow }
  }

  const delay = input.decision.delay
  // Malformed delays are left untouched: the host falls back to its computed
  // delay (documented host behavior for NaN, infinity, and negative values).
  if (!Number.isFinite(delay) || delay < 0) {
    return { decision: { retry: true, delay }, class: errorClass, action: "keep", window: nextWindow }
  }

  const cap = boundedDelayCap(input.maxDelayMs)
  if (delay > cap) {
    return { decision: { retry: true, delay: cap }, class: errorClass, action: "cap-delay", window: nextWindow }
  }
  return { decision: { retry: true, delay }, class: errorClass, action: "keep", window: nextWindow }
}

export type RetryPolicyRuntime = {
  /** Observe one host retry-hook event; never throws, never breaks the request. */
  observe(event: unknown): Promise<void>
  /** Current bounded retry trace for a session (memory, or the durable snapshot). */
  trace(sessionID: string): Promise<RetryTrace | undefined>
}

export type RetryPolicyDeps = {
  options: OrchestratorOptions
  storage: StorageLike
  location: LocationLike
  /** Injected for deterministic tests. */
  now?: () => number
}

/**
 * Stateful wrapper around the pure policy: per-session burst windows and
 * bounded retry trace records. No hook is registered here; the caller owns the
 * registration and its disposal.
 */
export function createRetryPolicy(deps: RetryPolicyDeps): RetryPolicyRuntime {
  const windows = new Map<string, number[]>()
  const traces = new Map<string, RetryTrace>()
  const now = deps.now ?? (() => Date.now())

  return { observe, trace }

  async function observe(event: unknown): Promise<void> {
    try {
      const parsed = asRetryEvent(event)
      if (!parsed) return
      // Orchestrator sessions only: delegated worker sessions are never
      // touched by the N5 policy.
      if (parsed.agent !== deps.options.orchestrator) return

      const observedAt = now()
      const result = decideRetry({
        error: parsed.error,
        attempt: parsed.attempt,
        decision: parsed.decision,
        now: observedAt,
        window: windows.get(parsed.sessionID) ?? [],
        maxDelayMs: deps.options.retry.max_delay_ms,
      })
      windows.set(parsed.sessionID, result.window)

      // Apply only real changes; `keep` intentionally leaves the host
      // decision object (including a malformed delay) untouched.
      if (result.action === "cap-delay" && result.decision.retry) {
        parsed.decision = { retry: true, delay: result.decision.delay }
      } else if (result.action === "veto-class" || result.action === "veto-burst") {
        parsed.decision = { retry: false }
      }

      await recordObserved(parsed.sessionID, result.class, result.action, parsed.attempt, observedAt)
    } catch (error) {
      // Observation must never break a model request.
      console.warn(`${RUNTIME_PLUGIN_ID} retry policy observation failed`, error)
    }
  }

  async function recordObserved(
    sessionID: string,
    errorClass: RetryClass,
    action: RetryAction,
    attempt: number,
    observedAt: number,
  ): Promise<void> {
    const current = traces.get(sessionID) ?? newRetryTrace(sessionID, observedAt)
    const next = recordRetryAction(current, { class: errorClass, action, attempt }, observedAt)
    traces.set(sessionID, next)
    if (deps.options.trace.mode !== "snapshot") return
    try {
      await withSessionLock(deps.location, sessionID, async () => {
        const keyed = await keyedLocation(sessionID)
        await deps.storage.set(retryTraceStorageKey(keyed, sessionID), next)
      })
    } catch (error) {
      // Best-effort durable snapshot, matching the S3 trace semantics.
      console.warn(`${RUNTIME_PLUGIN_ID} retry trace snapshot failed for ${sessionID}`, error)
    }
  }

  async function trace(sessionID: string): Promise<RetryTrace | undefined> {
    const memory = traces.get(sessionID)
    if (memory) return memory
    if (deps.options.trace.mode !== "snapshot") return undefined
    const keyed = await keyedLocation(sessionID)
    return parseRetryTrace(await deps.storage.get(retryTraceStorageKey(keyed, sessionID)))
  }

  async function keyedLocation(sessionID: string): Promise<LocationLike> {
    const projectID = await stableProjectID(deps.storage, deps.location, sessionID)
    return { ...deps.location, project: { id: projectID } }
  }
}

function boundedWindow(window: readonly number[], now: number): number[] {
  return window
    .filter((entry) => Number.isFinite(entry) && now - entry < RETRY_BURST_WINDOW_MS)
    .slice(-RETRY_BURST_MAX_ATTEMPTS)
}

function boundedDelayCap(value: number): number {
  if (!Number.isFinite(value) || value < 0) return RETRY_DEFAULT_MAX_DELAY_MS
  return Math.min(RETRY_HARD_MAX_DELAY_MS, Math.trunc(value))
}

/**
 * Defensive parse of the hook event: unknown shapes are ignored (return
 * undefined) instead of throwing inside a host hook.
 */
function asRetryEvent(value: unknown): (RetryHookEventLike & { decision: RetryDecision }) | undefined {
  if (!value || typeof value !== "object") return undefined
  const event = value as Partial<RetryHookEventLike>
  if (typeof event.sessionID !== "string" || event.sessionID.length === 0) return undefined
  if (typeof event.agent !== "string") return undefined
  if (typeof event.attempt !== "number" || !Number.isFinite(event.attempt) || event.attempt < 1) return undefined
  const error = event.error
  if (!error || typeof error !== "object" || typeof error.type !== "string" || error.type.length === 0) return undefined
  const decision = event.decision
  if (!decision || typeof decision !== "object" || typeof decision.retry !== "boolean") return undefined
  return event as RetryHookEventLike & { decision: RetryDecision }
}
