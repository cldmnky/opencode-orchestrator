/**
 * S3 observability runtime plus V2 review dispatch state - hooks, events,
 * bounded summaries, and dispatch gate.
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
 * no CAS or cross-process guarantee. Snapshot writes are COALESCED: an event
 * marks the session dirty and one bounded flush writes the latest summary, so
 * a burst of tool calls costs one write per session per interval instead of two
 * writes per call. Budget-enforcing sessions are retained in memory until
 * deletion: a bounded cache cannot discard decision-critical counters without
 * an authoritative durable replacement in memory/off trace modes.
 */
import type { OrchestratorOptions } from "../../core/config.js"
import { BoundedMap } from "../bounded-map.js"
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
import { parseReviewV2Record, readReviewV2Record, reviewV2StorageKey, type ReviewV2Record } from "./review-v2.js"
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

/**
 * Snapshot trace writes are coalesced over this window. When a stop-between-
 * steps budget is enabled the in-memory summary remains authoritative during
 * this window; after a crash, persisted counts may lag by one window. A burst
 * costs one write per session instead of two per call on the same session lock
 * the board uses.
 */
export const TRACE_FLUSH_INTERVAL_MS = 250

/** Target cache size for disposable trace summaries; protected entries may exceed it. */
export const TRACE_MAX_SESSIONS = 512
/** Retained event-dedup markers before the oldest is dropped. */
export const TRACE_MAX_EVENT_MARKERS = 1024

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
  // Only clean snapshot summaries or non-budget memory summaries may be
  // evicted. A pending write or enforced-budget summary is not disposable.
  const pendingByID = new Map<string, PendingCall>()
  const pendingBySession = new Map<string, Set<string>>()
  const dirtyTraceSessions = new Set<string>()
  const summaryBySession = new BoundedMap<string, TraceSummary>(TRACE_MAX_SESSIONS, (sessionID) =>
    !pendingBySession.has(sessionID) && !dirtyTraceSessions.has(sessionID) && deps.options.budget.mode !== "stop-between-steps",
  )
  // In enforcing mode an evicted marker could replay an older usage snapshot
  // (and lower observed cost/tokens). Keep markers until session deletion.
  const lastEvent = new BoundedMap<string, string>(TRACE_MAX_EVENT_MARKERS, () => deps.options.budget.mode !== "stop-between-steps")
  const hydration = new Map<string, Promise<void>>()
  const snapshotVersions = new Map<string, number>()
  const hookRegistrations: Array<{ dispose(): Promise<void> }> = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let activeFlush: Promise<void> | undefined
  let disposing = false
  let finished!: Promise<void>

  hookRegistrations.push(
    await deps.tool.hook("execute.before", (event) => {
      return observeBefore(event).catch((error) => console.warn("opencode-orchestrator execute.before observation failed", error))
    }),
  )
  hookRegistrations.push(
    await deps.tool.hook("execute.after", (event) => {
      return observeAfter(event).catch((error) => console.warn("opencode-orchestrator execute.after observation failed", error))
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
        const record = await readCurrentReviewStatus(sessionID)
        if (record && (record.state === "blocked" || record.state === "tripped")) {
          reviewBreaker = reviewBreakerReason(record)
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
    disposing = true
    controller.abort()
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    await iterator.return?.()
    await finished
    for (const registration of hookRegistrations) await registration.dispose()
    // A timer may already have taken ownership of the dirty set; join that
    // write before returning, then persist any updates made during it.
    await activeFlush
    await flushDirtyTraces()
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
    await bump(sessionID, (summary) => applyToolCallStart(summary, now))
    if (pendingByID.size >= TRACE_MAX_PENDING_CALLS) {
      // The cap evicts the oldest tracked start. The dropped-unmatched counter
      // belongs to the EVICTED call's session (its start is the one that will
      // never be paired), never to the session whose new call triggered the
      // eviction.
      const oldestID = pendingByID.keys().next().value
      if (oldestID !== undefined) {
        const evicted = untrackPending(oldestID)
        if (evicted) {
          // The evicted start will never be paired: pending drops for the
          // evicted session and the dropped-unmatched counter records it.
          await bump(evicted.sessionID, (summary) => ({
            ...applyToolCallEnd(summary, now),
            droppedUnmatched: summary.droppedUnmatched + 1,
          }))
          markTraceDirty(evicted.sessionID)
        }
      }
    }
    trackPending(before.id, { sessionID, startedAt: now })
    markTraceDirty(sessionID)
  }

  async function observeAfter(event: unknown): Promise<void> {
    const after = asAfterEvent(event)
    if (!after) return
    const sessionID = after.sessionID
    if (typeof sessionID !== "string") return
    const now = Date.now()
    const paired = untrackPending(after.id)
    if (paired) {
      await bump(sessionID, (summary) => applyToolCallEnd(summary, now))
      await bump(sessionID, (summary) =>
        applyToolCallOutcome(summary, { tool: after.tool, failed: after.status === "error", durationMs: Math.max(0, now - paired.startedAt) }, now),
      )
    } else {
      // The before start was dropped or missed (subscription gap): record the
      // outcome metadata without a duration rather than fabricating anything.
      await bump(sessionID, (summary) => applyToolCallOutcome(summary, { tool: after.tool, failed: after.status === "error" }, now))
    }
    markTraceDirty(sessionID)
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
        await bump(sessionID, (current) => recordStep(current, now))
        markTraceDirty(sessionID)
        return
      }
      if (scoped.type === "session.retry.scheduled") {
        const now = Date.now()
        await bump(sessionID, (current) => recordRetry(current, now))
        markTraceDirty(sessionID)
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
    await bump(sessionID, (current) => recordUsageSnapshot(current, usage, now))
    markTraceDirty(sessionID)
  }

  async function onSessionDeleted(sessionID: string): Promise<void> {
    summaryBySession.delete(sessionID)
    hydration.delete(sessionID)
    snapshotVersions.delete(sessionID)
    untrackSessionPending(sessionID)
    lastEvent.delete(sessionID)
    // Drop any queued write for this session first: the summary is already
    // gone, so a late flush is a no-op instead of resurrecting the record.
    dirtyTraceSessions.delete(sessionID)
    if (deps.options.trace.mode === "snapshot") {
      await withSessionLock(deps.location, sessionID, async () => {
        const keyed = await keyedLocation(sessionID)
        await deps.storage.remove(traceStorageKey(keyed, sessionID))
      })
    }
  }

  /* ------------------------------------------------------------------ */
  /* Pending-call index and coalesced snapshot writes                    */
  /* ------------------------------------------------------------------ */

  function trackPending(callID: string, call: PendingCall): void {
    pendingByID.set(callID, call)
    let ids = pendingBySession.get(call.sessionID)
    if (!ids) {
      ids = new Set()
      pendingBySession.set(call.sessionID, ids)
    }
    ids.add(callID)
  }

  function untrackPending(callID: string): PendingCall | undefined {
    const call = pendingByID.get(callID)
    if (!call) return undefined
    pendingByID.delete(callID)
    const ids = pendingBySession.get(call.sessionID)
    if (ids) {
      ids.delete(callID)
      if (ids.size === 0) pendingBySession.delete(call.sessionID)
    }
    return call
  }

  /** O(this session's in-flight calls) instead of O(all pending calls). */
  function untrackSessionPending(sessionID: string): void {
    const ids = pendingBySession.get(sessionID)
    if (!ids) return
    for (const callID of ids) pendingByID.delete(callID)
    pendingBySession.delete(sessionID)
  }

  /**
   * Mark the session's persisted summary stale. One bounded flush later writes
   * the latest summary, so a burst of tool calls coalesces into a single write
   * instead of one write per event on the shared session lock.
   */
  function markTraceDirty(sessionID: string): void {
    if (deps.options.trace.mode !== "snapshot") return
    dirtyTraceSessions.add(sessionID)
    scheduleFlush()
  }

  function scheduleFlush(): void {
    if (flushTimer !== undefined || disposing) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void flushDirtyTraces()
    }, TRACE_FLUSH_INTERVAL_MS)
    if (typeof (flushTimer as { unref?: () => void }).unref === "function") (flushTimer as { unref: () => void }).unref()
  }

  async function flushDirtyTraces(): Promise<void> {
    if (activeFlush) {
      await activeFlush
      if (!disposing && dirtyTraceSessions.size > 0) markTraceDirty([...dirtyTraceSessions][0]!)
      return
    }
    if (dirtyTraceSessions.size === 0) return
    const pending = [...dirtyTraceSessions]
    const versionsAtStart = new Map(pending.map((sessionID) => [sessionID, snapshotVersions.get(sessionID)]))
    const flushing = (async () => {
      for (const sessionID of pending) {
        try {
          await persistSnapshot(sessionID)
          // A newer bump may have happened during the storage write. Persist
          // again next window rather than losing that update on eviction.
          if (snapshotVersions.get(sessionID) === versionsAtStart.get(sessionID)) {
            dirtyTraceSessions.delete(sessionID)
            snapshotVersions.delete(sessionID)
          }
        } catch (error) {
          console.warn(`opencode-orchestrator trace snapshot write failed for ${sessionID}`, error)
        }
      }
    })()
    activeFlush = flushing
    await flushing.finally(() => { if (activeFlush === flushing) activeFlush = undefined })
    if (!disposing && dirtyTraceSessions.size > 0) scheduleFlush()
  }

  async function bump(sessionID: string, update: (summary: TraceSummary) => TraceSummary): Promise<void> {
    // Protect a missing snapshot while it is being hydrated: if every old
    // entry is dirty, an unprotected insertion could evict itself before bump.
    if (deps.options.trace.mode === "snapshot") dirtyTraceSessions.add(sessionID)
    await ensureSummary(sessionID)
    const now = Date.now()
    const current = summaryBySession.get(sessionID) ?? newTraceSummary(sessionID, deps.options.trace.mode, now)
    // Protect from eviction before insertion. A flush will release protection.
    markTraceDirty(sessionID)
    snapshotVersions.set(sessionID, (snapshotVersions.get(sessionID) ?? 0) + 1)
    summaryBySession.set(sessionID, { ...update(current), updatedAt: now })
  }

  async function ensureSummary(sessionID: string): Promise<void> {
    if (summaryBySession.has(sessionID) || deps.options.trace.mode !== "snapshot") return
    let pending = hydration.get(sessionID)
    if (!pending) {
      pending = (async () => {
        const keyed = await keyedLocation(sessionID)
        const stored = parseTraceSummary(await deps.storage.get(traceStorageKey(keyed, sessionID)))
        if (stored?.sessionID === sessionID && !summaryBySession.has(sessionID)) summaryBySession.set(sessionID, stored)
      })()
      hydration.set(sessionID, pending)
      void pending.finally(() => { if (hydration.get(sessionID) === pending) hydration.delete(sessionID) }).catch(() => undefined)
    }
    await pending
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

  async function readCurrentReviewStatus(sessionID: string): Promise<{ state: string; taskId: string; runId: string } | undefined> {
    const keyed = await keyedLocation(sessionID)
    const v2 = parseReviewV2Record(await deps.storage.get(reviewV2StorageKey(keyed, sessionID)))
    if (v2) return v2
    const v1 = parseReviewRecord(await deps.storage.get(reviewStorageKey(keyed, sessionID)))
    return v1
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
        const record =
          parseReviewV2Record(await input.storage.get(reviewV2StorageKey(keyed, sessionID))) ??
          parseReviewRecord(await input.storage.get(reviewStorageKey(keyed, sessionID)))
        if (record && (record.state === "blocked" || record.state === "tripped")) {
          reviewBreaker = reviewBreakerReason(record)
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

/** Read only the provenance-bound V2 record; V1 is deliberately not upgraded. */
export async function readReviewRecordV2(storage: StorageLike, location: LocationLike, sessionID: string): Promise<ReviewV2Record | undefined> {
  return readReviewV2Record(storage, location, sessionID)
}

/** Lock-free review record write; callers must serialize via withSessionLock. */
export async function setReviewRecord(storage: StorageLike, location: LocationLike, sessionID: string, record: ReviewV1Record): Promise<void> {
  const keyed = await stableKeyedLocation(storage, location, sessionID)
  await storage.set(reviewStorageKey(keyed, sessionID), record)
}

/** Lock-free V2 write; callers must serialize through withSessionLock. */
export async function setReviewRecordV2(storage: StorageLike, location: LocationLike, sessionID: string, record: ReviewV2Record): Promise<void> {
  const keyed = await stableKeyedLocation(storage, location, sessionID)
  await storage.set(reviewV2StorageKey(keyed, sessionID), record)
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

function reviewBreakerReason(record: { state: string; taskId: string; runId: string }): string {
  return `review circuit is open: ${record.state} for task ${record.taskId} (run ${record.runId}); automatic dispatch stays closed until an operator inspects and archives/resets the session review state via opencode-orchestrator.state. A new goal alone does not clear the session-keyed review record`
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
