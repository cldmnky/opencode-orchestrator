/**
 * S3 versioned bounded trace summaries - metadata only.
 *
 * Records are version-1 bounded metadata summaries described by strict schemas:
 * counts, timestamps, per-tool aggregates, and the latest usage snapshot. They
 * NEVER contain prompts, transcripts, tool input/output, shell output,
 * result/error text, raw credentials, or arbitrary payloads. Tool call IDs are
 * held only in memory (never persisted) to pair execute.before/after; the
 * persisted records carry no IDs. Collections are bounded: per-session tool
 * entries are capped (additional tools fold into an `other` bucket) and the
 * in-memory pending map is capped (overflowing starts are dropped and counted,
 * never fabricated). Usage aggregate events are snapshots that REPLACE the
 * stored values; they are never added together, so no double counting occurs,
 * and missing coverage is simply absent (unknown), never zero.
 */
import { z } from "zod"
import type { TraceMode } from "../../core/config.js"

export const TRACE_RECORD_VERSION = 1
/** Maximum per-session tool metadata entries before folding into `other`. */
export const TRACE_MAX_TOOL_ENTRIES = 32
/** Maximum in-memory pending tool-call pairs before dropping starts. */
export const TRACE_MAX_PENDING_CALLS = 1024
/** Bounded aggregation bucket name for tools beyond the per-session cap. */
export const TRACE_OTHER_TOOL = "other"

export const traceToolUsageSchema = z
  .object({
    name: z.string().min(1).max(256),
    count: z.number().int().positive(),
    failed: z.number().int().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
  })
  .strict()
export type TraceToolUsage = z.infer<typeof traceToolUsageSchema>

export const usageSnapshotSchema = z
  .object({
    costUsd: z.number().finite().nonnegative(),
    tokensInput: z.number().finite().nonnegative(),
    tokensOutput: z.number().finite().nonnegative(),
    tokensReasoning: z.number().finite().nonnegative(),
    tokensCacheRead: z.number().finite().nonnegative(),
    tokensCacheWrite: z.number().finite().nonnegative(),
    observedAt: z.number().finite(),
  })
  .strict()
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>

export const traceSummarySchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1),
    mode: z.enum(["off", "memory", "snapshot"]),
    /** Currently in-flight tool calls (paired before without after yet). */
    pending: z.number().int().nonnegative(),
    completedCalls: z.number().int().nonnegative(),
    failedCalls: z.number().int().nonnegative(),
    /** execute.after events whose before start was not tracked (dropped or missed). */
    droppedUnmatched: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    firstAt: z.number().finite(),
    lastAt: z.number().finite(),
    updatedAt: z.number().finite(),
    tools: z.array(traceToolUsageSchema),
    usage: usageSnapshotSchema.optional(),
  })
  .strict()
export type TraceSummary = z.infer<typeof traceSummarySchema>

export type UsageSnapshotInput = {
  costUsd: number
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  tokensCacheRead: number
  tokensCacheWrite: number
  observedAt: number
}

export function newTraceSummary(sessionID: string, mode: TraceMode, now = Date.now()): TraceSummary {
  return {
    version: TRACE_RECORD_VERSION,
    sessionID,
    mode,
    pending: 0,
    completedCalls: 0,
    failedCalls: 0,
    droppedUnmatched: 0,
    steps: 0,
    retries: 0,
    firstAt: now,
    lastAt: now,
    updatedAt: now,
    tools: [],
  }
}

/** A tool call started: pending increases and first/last activity move. */
export function applyToolCallStart(summary: TraceSummary, now: number): TraceSummary {
  return {
    ...summary,
    pending: summary.pending + 1,
    firstAt: summary.firstAt ?? now,
    lastAt: now,
  }
}

/** A tracked tool call ended: pending decreases (floored at zero). */
export function applyToolCallEnd(summary: TraceSummary, now: number): TraceSummary {
  return {
    ...summary,
    pending: Math.max(0, summary.pending - 1),
    lastAt: now,
  }
}

/** One resolved tool call outcome (bounded aggregate; no IDs, no payloads). */
export function applyToolCallOutcome(
  summary: TraceSummary,
  input: { tool: string; failed: boolean; durationMs?: number },
  now: number,
): TraceSummary {
  const name = input.tool || "unknown"
  const tools = bumpToolUsage(summary.tools, name, input.failed, input.durationMs)
  return {
    ...summary,
    completedCalls: summary.completedCalls + (input.failed ? 0 : 1),
    failedCalls: summary.failedCalls + (input.failed ? 1 : 0),
    tools,
    lastAt: now,
  }
}

export function recordStep(summary: TraceSummary, now: number): TraceSummary {
  return { ...summary, steps: summary.steps + 1, lastAt: now }
}

export function recordRetry(summary: TraceSummary, now: number): TraceSummary {
  return { ...summary, retries: summary.retries + 1, lastAt: now }
}

/** Replaces (never adds to) the stored usage aggregate with the latest snapshot. */
export function recordUsageSnapshot(summary: TraceSummary, usage: UsageSnapshotInput, now = Date.now()): TraceSummary {
  const snapshot: UsageSnapshot = {
    costUsd: usage.costUsd,
    tokensInput: usage.tokensInput,
    tokensOutput: usage.tokensOutput,
    tokensReasoning: usage.tokensReasoning,
    tokensCacheRead: usage.tokensCacheRead,
    tokensCacheWrite: usage.tokensCacheWrite,
    observedAt: usage.observedAt,
  }
  return { ...summary, usage: snapshot, lastAt: now }
}

/** Total observed model tokens: input + output + reasoning. Cache read/write are recorded as metadata and never added (avoids double counting). */
export function usageTokensTotal(usage: UsageSnapshot): number {
  return usage.tokensInput + usage.tokensOutput + usage.tokensReasoning
}

/** Strict, bounded entry: returns the parsed record or undefined for malformed/unknown data. */
export function parseTraceSummary(value: unknown): TraceSummary | undefined {
  const parsed = traceSummarySchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Storage key for the single bounded current trace record per session. */
export function traceStorageKey(location: { project: { id: string } }, sessionID: string): string {
  return `trace/v1/${segment(location.project.id)}/${segment(sessionID)}`
}

function bumpToolUsage(
  tools: readonly TraceToolUsage[],
  name: string,
  failed: boolean,
  durationMs: number | undefined,
): TraceToolUsage[] {
  const target = name.length > 0 ? name : TRACE_OTHER_TOOL
  const existingIndex = tools.findIndex((entry) => entry.name === target)
  if (existingIndex >= 0) {
    const entry = tools[existingIndex]
    const next = tools.map((current, index) =>
      index === existingIndex
        ? {
            name: target,
            count: current.count + 1,
            failed: current.failed + (failed ? 1 : 0),
            durationMs: current.durationMs + (durationMs ?? 0),
          }
        : current,
    )
    return next
  }
  if (tools.length < TRACE_MAX_TOOL_ENTRIES) {
    return [
      ...tools,
      { name: target, count: 1, failed: failed ? 1 : 0, durationMs: durationMs ?? 0 },
    ]
  }
  // Fold into the bounded `other` bucket when the per-session cap is reached.
  const otherIndex = tools.findIndex((entry) => entry.name === TRACE_OTHER_TOOL)
  if (otherIndex >= 0) {
    return tools.map((current, index) =>
      index === otherIndex
        ? {
            name: TRACE_OTHER_TOOL,
            count: current.count + 1,
            failed: current.failed + (failed ? 1 : 0),
            durationMs: current.durationMs + (durationMs ?? 0),
          }
        : current,
    )
  }
  return [...tools, { name: TRACE_OTHER_TOOL, count: 1, failed: failed ? 1 : 0, durationMs: durationMs ?? 0 }]
}

function segment(value: string): string {
  return encodeURIComponent(value)
}