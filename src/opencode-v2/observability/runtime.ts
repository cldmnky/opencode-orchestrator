/**
 * S3/V1 observability runtime - hooks, events, bounded summaries, dispatch gate.
 *
 * Started only when `trace.mode !== "off"`, `budget.mode === "stop-between-steps"`,
 * or `review.mode === "bounded"`. Uses only pinned V2 surfaces: tool
 * `execute.before`/`execute.after` hooks and typed `event.subscribe` events.
 * The pinned Promise SessionDomain excludes session.stats; no separate HTTP
 * client is built. Usage aggregate events (`session.usage.updated`) are treated
 * as SNAPSHOTS (replace, never add) so nothing is double counted; incremental
 * `session.usage.recorded` events are deliberately ignored. Missing event
 * coverage is unknown/partial, never zero. Runtime event/hook failures are
 * caught and logged and NEVER break orchestration. Cleanup aborts and awaits
 * event consumption and disposes every hook registration.
 *
 * Tool call IDs live only in the in-memory pending map to pair before/after;
 * nothing persisted ever carries them. Persistence (snapshot mode) writes one
 * bounded current record per session under a versioned stable project/session
 * key, serialized through the existing process-local withSessionLock; there is
 * no CAS or cross-process guarantee.
 */
import type { OrchestratorOptions } from "../../core/config.js"
import { evaluateBudget, type BudgetEvaluation, type BudgetObservation } from "./budget.js"
import {
  TRACE_MAX_PENDING_CALLS,
  applyToolCallEnd,
  applyToolCallOutcome,
  applyToolCallStart,
  newTraceSummary,
  parseTraceSummary,
  recordRetry,
  recordStep,
  recordUsageSnapshot,
  traceStorageKey,
  usageTokensTotal,
  type TraceSummary,
  type UsageSnapshotInput,
} from "./trace.js"
import { parseReviewRecord, reviewStorageKey, type ReviewV1Record } from "./review.js"
import {
  stableProjectID,
  withSessionLock,
  type LocationLike,
  type StorageLike,
} from "../goal/state.js"

export type ObservabilityDeps = {
  options: OrchestratorOptions
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
  }
  tool: {
    hook(
      name: "execute.before" | "execute.after",
      callback: (input: unknown) => Promise<void> | void,
    ): Promise<{ dispose(): Promise<void> }>
  }
  storage: StorageLike
  location: LocationLike
}

export type DispatchCheck = "auto" | "command"

export type DispatchDecision = {
  allow: boolean
  reason?: string
  evaluation: BudgetEvaluation
  reviewBreaker?: string
}

export type DispatchGate = {
  allowDispatch(sessionID: string, check: DispatchCheck): Promise<DispatchDecision>
}

export type ObservabilityRuntime = {
  dispose(): Promise<void>
  gate: DispatchGate
  summary(sessionID: string): Promise<TraceSummary | undefined>
  evaluation(sessionID: string): Promise<BudgetEvaluation>
}

type PendingCall = { sessionID: string; startedAt: number }

type UsageUpdatedEvent = {
  id?: string
  created?: number
  type: string
  data: { sessionID?: unknown; cost?: unknown; tokens?: unknown }
  location?: { directory?: string; workspaceID?: string }
}

type SessionScopedEvent = {
  id?: string
  created?: number
  type: string
  data: { sessionID?: unknown }
  location?: { directory?: string; workspaceID?: string }
}

export function shouldStartObservability(options: OrchestratorOptions): boolean {
  return options.trace.mode !== "off" || options.budget.mode === "stop-between-steps" || options.review.mode === "bounded"
}

export async function startObservability(deps: ObservabilityDeps): Promise<ObservabilityRuntime> {
  const controller = new AbortController()
  const iterable = deps.event.subscribe({ signal: controller.signal })
  const iterator = iterable[Symbol.asyncIterator]()
  const summaryBySession = new Map<string, TraceSummary>()
  const pendingByID = new Map<string, PendingCall>()
  const lastEvent = new Map<string, string>()
  const hookRegistrations: Array<{ dispose(): Promise<void> }> = []
  let finished!: Promise<void>

  hookRegistrations.push(
    await deps.tool.hook("execute.before", (event) => {
      void observeBefore(event).catch((error) => console.warn("opencode-orchestrator execute.before observation failed", error))
    }),
  )
  hookRegistrations.push(
    await deps.tool.hook("execute.after", (event) => {
      void observeAfter(event).catch((error) => console.warn("opencode-orchestrator execute.after observation failed", error))
    }),
  )

  finished = consumeEvents().catch((error) => {
    if (!controller.signal.aborted) console.warn("opencode-orchestrator observability event stream stopped", error)
  })

  function matchesLocation(eventLocation: SessionScopedEvent["location"]): boolean {
    if (!eventLocation) return true
    if (eventLocation.workspaceID !== undefined) {
      return deps.location.workspaceID === eventLocation.workspaceID
    }
    return eventLocation.directory === deps.location.directory
  }

  const gate: DispatchGate = {
    async allowDispatch(sessionID: string, check: DispatchCheck): Promise<DispatchDecision> {
      let reviewBreaker: string | undefined
      if (deps.options.review.mode === "bounded" && check === "auto") {
        const record = await readCurrentReviewRecord(sessionID)
        if (record && (record.state === "blocked" || record.state === "tripped")) {
          reviewBreaker = `review circuit is open: ${record.state} for task ${record.taskId} (run ${record.runId}); a human decision is required`
        }
      }
      const evaluationResult = await evaluation(sessionID)
      const budgetBlocked = deps.options.budget.mode === "stop-between-steps" && evaluationResult.verdict === "exceeded"
      if (reviewBreaker || budgetBlocked) {
        return {
          allow: false,
          evaluation: evaluationResult,
          reviewBreaker,
          reason: [reviewBreaker, budgetBlocked ? budgetReason(evaluationResult) : undefined].filter(Boolean).join("; "),
        }
      }
      return { allow: true, evaluation: evaluationResult, reviewBreaker }
    },
  }

  return {
    dispose,
    gate,
    summary,
    evaluation,
  }

  async function dispose(): Promise<void> {
    controller.abort()
    await iterator.return?.()
    await finished
    for (const registration of hookRegistrations) await registration.dispose()
  }

  async function summary(sessionID: string): Promise<TraceSummary | undefined> {
    const memory = summaryBySession.get(sessionID)
    if (memory) return memory
    if (deps.options.trace.mode === "snapshot") {
      const keyed = await keyedLocation(sessionID)
      const value = await deps.storage.get(traceStorageKey(keyed, sessionID))
      return parseTraceSummary(value)
    }
    return undefined
  }

  async function evaluation(sessionID: string): Promise<BudgetEvaluation> {
    const current = await summary(sessionID)
    return evaluateBudget({ observed: budgetObservation(current), limits: deps.options.budget, mode: deps.options.budget.mode })
  }

  async function observeBefore(event: unknown): Promise<void> {
    const before = asBeforeEvent(event)
    if (!before) return
    const sessionID = before.sessionID
    if (typeof sessionID !== "string") return
    const now = Date.now()
    bump(sessionID, (summary) => applyToolCallStart(summary, now))
    if (pendingByID.size >= TRACE_MAX_PENDING_CALLS) {
      // The cap evicts the oldest tracked start. The dropped-unmatched counter
      // belongs to the EVICTED call's session (its start is the one that will
      // never be paired), never to the session whose new call triggered the
      // eviction.
      const oldestID = pendingByID.keys().next().value
      if (oldestID !== undefined) {
        const evicted = pendingByID.get(oldestID)
        pendingByID.delete(oldestID)
        if (evicted) {
          // The evicted start will never be paired: pending drops for the
          // evicted session and the dropped-unmatched counter records it.
          bump(evicted.sessionID, (summary) => ({
            ...applyToolCallEnd(summary, now),
            droppedUnmatched: summary.droppedUnmatched + 1,
          }))
          await persistSnapshot(evicted.sessionID)
        }
      }
    }
    pendingByID.set(before.id, { sessionID, startedAt: now })
    await persistSnapshot(sessionID)
  }

  async function observeAfter(event: unknown): Promise<void> {
    const after = asAfterEvent(event)
    if (!after) return
    const sessionID = after.sessionID
    if (typeof sessionID !== "string") return
    const now = Date.now()
    const paired = pendingByID.get(after.id)
    if (paired) {
      pendingByID.delete(after.id)
      bump(sessionID, (summary) => applyToolCallEnd(summary, now))
      bump(sessionID, (summary) =>
        applyToolCallOutcome(summary, { tool: after.tool, failed: after.status === "error", durationMs: Math.max(0, now - paired.startedAt) }, now),
      )
    } else {
      // The before start was dropped or missed (subscription gap): record the
      // outcome metadata without a duration rather than fabricating anything.
      bump(sessionID, (summary) => applyToolCallOutcome(summary, { tool: after.tool, failed: after.status === "error" }, now))
    }
    await persistSnapshot(sessionID)
  }

  async function consumeEvents(): Promise<void> {
    while (!controller.signal.aborted) {
      const next = await iterator.next()
      if (next.done) return
      if (controller.signal.aborted) return
      await handleEvent(next.value)
    }
  }

  async function handleEvent(event: unknown): Promise<void> {
    const scoped = asSessionScopedEvent(event)
    if (!scoped) return
    if (!matchesLocation(scoped.location)) return
    const sessionID = scoped.data.sessionID
    if (typeof sessionID !== "string") return
    const marker = scoped.id ?? `${scoped.type}:${sessionID}:${scoped.created ?? ""}`
    if (lastEvent.get(sessionID) === marker) return
    lastEvent.set(sessionID, marker)

    try {
      if (scoped.type === "session.deleted") {
        await onSessionDeleted(sessionID)
        return
      }
      if (scoped.type === "session.usage.updated") {
        await onUsageUpdated(scoped as UsageUpdatedEvent, sessionID)
        return
      }
      if (scoped.type === "session.step.started") {
        const now = Date.now()
        bump(sessionID, (current) => recordStep(current, now))
        await persistSnapshot(sessionID)
        return
      }
      if (scoped.type === "session.retry.scheduled") {
        const now = Date.now()
        bump(sessionID, (current) => recordRetry(current, now))
        await persistSnapshot(sessionID)
        return
      }
    } catch (error) {
      // Event observation must never break orchestration.
      console.warn(`opencode-orchestrator observability event ignored for ${sessionID}`, error)
    }
  }

  async function onUsageUpdated(event: UsageUpdatedEvent, sessionID: string): Promise<void> {
    const usage = parseUsageSnapshot(event.data)
    if (!usage) return
    const now = Date.now()
    bump(sessionID, (current) => recordUsageSnapshot(current, usage, now))
    await persistSnapshot(sessionID)
  }

  async function onSessionDeleted(sessionID: string): Promise<void> {
    summaryBySession.delete(sessionID)
    for (const [callID, call] of pendingByID) {
      if (call.sessionID === sessionID) pendingByID.delete(callID)
    }
    lastEvent.delete(sessionID)
    if (deps.options.trace.mode === "snapshot") {
      await withSessionLock(deps.location, sessionID, async () => {
        const keyed = await keyedLocation(sessionID)
        await deps.storage.remove(traceStorageKey(keyed, sessionID))
      })
    }
  }

  function bump(sessionID: string, update: (summary: TraceSummary) => TraceSummary): void {
    const now = Date.now()
    const current = summaryBySession.get(sessionID) ?? newTraceSummary(sessionID, deps.options.trace.mode, now)
    summaryBySession.set(sessionID, { ...update(current), updatedAt: now })
  }

  async function persistSnapshot(sessionID: string): Promise<void> {
    if (deps.options.trace.mode !== "snapshot") return
    await withSessionLock(deps.location, sessionID, async () => {
      const summary = summaryBySession.get(sessionID)
      if (!summary) return
      const keyed = await keyedLocation(sessionID)
      await deps.storage.set(traceStorageKey(keyed, sessionID), summary)
    })
  }

  async function readCurrentReviewRecord(sessionID: string): Promise<ReviewV1Record | undefined> {
    const keyed = await keyedLocation(sessionID)
    const value = await deps.storage.get(reviewStorageKey(keyed, sessionID))
    return parseReviewRecord(value)
  }

  async function keyedLocation(sessionID: string): Promise<LocationLike> {
    const projectID = await stableProjectID(deps.storage, deps.location, sessionID)
    return { ...deps.location, project: { id: projectID } }
  }
}

/**
 * Builds the shared dispatch gate. The budget half reads observations from the
 * runtime (when active); the review breaker half always reads the durable
 * current review record (when bounded). Lock-free reads keep this callable
 * from inside a withSessionLock region (e.g. goal continuation reservation).
 */
export function createDispatchGate(input: {
  options: OrchestratorOptions
  storage: StorageLike
  location: LocationLike
  runtime?: ObservabilityRuntime
}): DispatchGate {
  return {
    async allowDispatch(sessionID: string, check: DispatchCheck): Promise<DispatchDecision> {
      let reviewBreaker: string | undefined
      if (input.options.review.mode === "bounded" && check === "auto") {
        const keyed = await stableKeyedLocation(input.storage, input.location, sessionID)
        const record = parseReviewRecord(await input.storage.get(reviewStorageKey(keyed, sessionID)))
        if (record && (record.state === "blocked" || record.state === "tripped")) {
          reviewBreaker = `review circuit is open: ${record.state} for task ${record.taskId} (run ${record.runId}); a human decision is required`
        }
      }
      const evaluationResult = input.runtime
        ? await input.runtime.evaluation(sessionID)
        : evaluateBudget({ observed: {}, limits: input.options.budget, mode: input.options.budget.mode })
      const budgetBlocked = input.options.budget.mode === "stop-between-steps" && evaluationResult.verdict === "exceeded"
      if (reviewBreaker || budgetBlocked) {
        return {
          allow: false,
          evaluation: evaluationResult,
          reviewBreaker,
          reason: [reviewBreaker, budgetBlocked ? budgetReason(evaluationResult) : undefined].filter(Boolean).join("; "),
        }
      }
      return { allow: true, evaluation: evaluationResult, reviewBreaker }
    },
  }
}

export async function readReviewRecord(storage: StorageLike, location: LocationLike, sessionID: string): Promise<ReviewV1Record | undefined> {
  const keyed = await stableKeyedLocation(storage, location, sessionID)
  return parseReviewRecord(await storage.get(reviewStorageKey(keyed, sessionID)))
}

/** Lock-free review record write; callers must serialize via withSessionLock. */
export async function setReviewRecord(storage: StorageLike, location: LocationLike, sessionID: string, record: ReviewV1Record): Promise<void> {
  const keyed = await stableKeyedLocation(storage, location, sessionID)
  await storage.set(reviewStorageKey(keyed, sessionID), record)
}

/** Write a review record under the existing process-local session lock. */
export async function writeReviewRecord(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  record: ReviewV1Record,
): Promise<void> {
  await withSessionLock(location, sessionID, async () => {
    await setReviewRecord(storage, location, sessionID, record)
  })
}

async function stableKeyedLocation(storage: StorageLike, location: LocationLike, sessionID: string): Promise<LocationLike> {
  const projectID = await stableProjectID(storage, location, sessionID)
  return { ...location, project: { id: projectID } }
}

function budgetObservation(summary: TraceSummary | undefined): BudgetObservation {
  if (!summary) return {}
  return {
    steps: summary.steps,
    tokens: summary.usage ? usageTokensTotal(summary.usage) : undefined,
    costUsd: summary.usage?.costUsd,
    retries: summary.retries,
    startedAt: summary.firstAt,
  }
}

function budgetReason(evaluation: BudgetEvaluation): string {
  const parts = evaluation.limits.map((detail) => {
    if (detail.status === "exceeded") {
      return detail.reason ?? `limit ${detail.limit} exceeded (observed ${detail.observed}, configured ${detail.configured})`
    }
    if (detail.status === "unknown") {
      return `limit ${detail.limit} is unknown: ${detail.reason ?? "no observation"}`
    }
    return `limit ${detail.limit} within (observed ${detail.observed})`
  })
  return `budget ${evaluation.verdict}: ${parts.join("; ") || "no limits configured"}`
}

function parseUsageSnapshot(data: UsageUpdatedEvent["data"]): UsageSnapshotInput | undefined {
  if (!data || typeof data !== "object") return undefined
  const source = data as { cost?: unknown; tokens?: unknown }
  const tokens = source.tokens
  if (!tokens || typeof tokens !== "object") return undefined
  const tokenRecord = tokens as {
    input?: unknown
    output?: unknown
    reasoning?: unknown
    cache?: unknown
  }
  const cache = tokenRecord.cache
  const cacheRecord = cache && typeof cache === "object" ? (cache as { read?: unknown; write?: unknown }) : undefined
  if (typeof source.cost !== "number" || !Number.isFinite(source.cost) || source.cost < 0) return undefined
  const input = tokenRecord.input
  const output = tokenRecord.output
  const reasoning = tokenRecord.reasoning
  const cacheRead = cacheRecord?.read
  const cacheWrite = cacheRecord?.write
  for (const value of [input, output, reasoning, cacheRead, cacheWrite]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  }
  return {
    costUsd: source.cost,
    tokensInput: input as number,
    tokensOutput: output as number,
    tokensReasoning: reasoning as number,
    tokensCacheRead: cacheRead as number,
    tokensCacheWrite: cacheWrite as number,
    observedAt: Date.now(),
  }
}

type BeforeEventLike = { id?: unknown; sessionID?: unknown; tool?: unknown; status?: unknown }
type AfterEventLike = { id?: unknown; sessionID?: unknown; tool?: unknown; status?: unknown }

function asBeforeEvent(value: unknown): { id: string; sessionID: unknown } | undefined {
  if (!value || typeof value !== "object") return undefined
  const event = value as BeforeEventLike
  if (typeof event.id !== "string") return undefined
  return { id: event.id, sessionID: event.sessionID }
}

function asAfterEvent(value: unknown): { id: string; sessionID: unknown; tool: string; status: "completed" | "error" } | undefined {
  if (!value || typeof value !== "object") return undefined
  const event = value as AfterEventLike
  if (typeof event.id !== "string") return undefined
  if (event.status !== "completed" && event.status !== "error") return undefined
  return { id: event.id, sessionID: event.sessionID, tool: typeof event.tool === "string" ? event.tool : "", status: event.status }
}

function asSessionScopedEvent(value: unknown): SessionScopedEvent | undefined {
  if (!value || typeof value !== "object") return undefined
  const event = value as Partial<SessionScopedEvent>
  if (typeof event.type !== "string") return undefined
  if (!event.data || typeof event.data !== "object" || !("sessionID" in event.data)) return undefined
  return event as SessionScopedEvent
}