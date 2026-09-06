/**
 * Peer-orchestrator discovery tool (`orchestrator_peer_list`).
 *
 * Read-only metadata query over durable goal records of the *same stable
 * project*: the caller's stable project identity is resolved through the
 * session anchor (exactly like goal/run/halt keying), and `storage.scan` is
 * bounded to the `goal/v1/<project>/` prefix — records keyed under any other
 * project are never read, and no transcript, prompt, file, credential, or
 * full objective is ever returned.
 *
 * Output discipline:
 * - metadata only: sessionID, status, a redacted + length-truncated
 *   objective hint, createdAt, updatedAt; never completionEvidence or any
 *   other record field;
 * - known-pattern redaction (the shared redactor) before truncation;
 * - deterministic ordering by sessionID (ascending), independent of the
 *   storage backend's scan order;
 * - bounded results (clamped to [1, 20], default 10), bounded scan work,
 *   and an opaque `after` cursor (last returned peer sessionID) for stable
 *   pages under append-only storage (strictly-greater filter -> no overlap);
 * - malformed records and foreign keys are skipped and counted, never
 *   fatal;
 * - `complete: false` whenever scan is unavailable or the bounded scan cap
 *   is hit: the tool never claims live completeness.
 *
 * The tool is orchestrator-only via the shared `orchestrator_peer`
 * permission action plus the runtime agent check, and it mutates nothing.
 */
import type { OrchestratorOptions } from "../../core/config.js"
import { PEER_TOOL_PERMISSION } from "../../core/permissions.js"
import {
  goalProjectPrefix,
  goalSessionIDFromKey,
  parseGoalRecord,
  stableProjectID,
  type GoalRecord,
  type GoalStatus,
  type LocationLike,
  type StorageLike,
} from "../goal/state.js"
import { redactKnownPatterns } from "../process/redact.js"
import type { Info as ToolInfo } from "@opencode-ai/plugin/promise/tool"

type ToolDraftLike = {
  add(tool: ToolInfo<any, undefined>): void
}

type ToolResult = { content: string }

export const PEER_RESULT_LIMIT_DEFAULT = 10
export const PEER_RESULT_LIMIT_MAX = 20
/** Hard cap on scanned entries so a hostile or degenerate store cannot cause unbounded work. */
export const PEER_SCAN_ENTRY_CAP = 2_000
const PEER_SCAN_PAGE_SIZE = 100
const PEER_OBJECTIVE_HINT_LENGTH = 120

export const PEER_QUERY_LIMITATIONS = [
  "metadata only: redacted and truncated objective hints; never full objectives, transcripts, prompts, files, or credentials",
  "same stable project only: goal records keyed under other projects are never read",
  "no live completeness guarantee: sessions without a readable goal record (or with a malformed one) do not appear",
  "read-only: this query never mutates storage, Git, or GitHub",
]

export type PeerSummary = {
  sessionID: string
  status: GoalStatus
  /** Known-pattern-redacted, whitespace-collapsed, length-truncated hint. */
  objectiveHint: string
  createdAt: number
  updatedAt: number
}

export type PeerQueryInput = {
  selfSessionID: string
  limit?: number
  /** Resume cursor: only peers with sessionID strictly greater than this. */
  after?: string
  includeSelf?: boolean
}

export type PeerQueryResult = {
  version: 1
  projectID: string
  peers: PeerSummary[]
  /** Cursor for the next page (last returned peer sessionID) when more may exist. */
  next?: string
  /** False when scan is unavailable or the bounded scan cap was hit. */
  complete: boolean
  /** Malformed or out-of-shape scan entries skipped while collecting. */
  skipped: number
  limitations: readonly string[]
}

export function addPeerTools(draft: ToolDraftLike, deps: { storage: StorageLike; location: LocationLike; options: OrchestratorOptions }): void {
  draft.add({
    name: "peer_list",
    description:
      "List bounded, redacted, truncated goal metadata for other orchestrator sessions in the same stable project. Excludes the current session unless includeSelf is true. Metadata only; never live-complete and never returns objectives, transcripts, files, or credentials. Orchestrator-only.",
    input: peerListInput,
    options: { namespace: "orchestrator", permission: PEER_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const result = await queryPeerGoals(deps.storage, deps.location, {
        selfSessionID: tool.sessionID,
        limit: numberField(input, "limit"),
        after: stringField(input, "after"),
        includeSelf: booleanField(input, "includeSelf"),
      })
      return resultContent(JSON.stringify(result))
    },
  })
}

/**
 * Executes the bounded same-project peer query. Exported separately so the
 * query can be tested and reused without going through the tool draft.
 */
export async function queryPeerGoals(
  storage: StorageLike,
  location: LocationLike,
  input: PeerQueryInput,
): Promise<PeerQueryResult> {
  const projectID = await stableProjectID(storage, location, input.selfSessionID)
  const resultLimit = normalizeLimit(input.limit)
  const cursor = input.after?.trim() ?? ""
  const includeSelf = input.includeSelf === true
  const prefix = goalProjectPrefix(projectID)

  if (!storage.scan) {
    return {
      version: 1,
      projectID,
      peers: [],
      complete: false,
      skipped: 0,
      limitations: [...PEER_QUERY_LIMITATIONS, "storage.scan is unavailable in this storage backend; no peer records could be read"],
    }
  }

  const candidates: PeerSummary[] = []
  const seen = new Set<string>()
  let skipped = 0
  let scanned = 0
  let capped = false
  let afterKey: string | undefined

  scanLoop: for (;;) {
    const page = await storage.scan({ prefix, after: afterKey, limit: PEER_SCAN_PAGE_SIZE })
    for (const entry of page.entries) {
      scanned += 1
      if (scanned > PEER_SCAN_ENTRY_CAP) {
        capped = true
        break scanLoop
      }
      const sessionID = goalSessionIDFromKey(entry.key, projectID)
      const record = parseGoalRecord(entry.value)
      if (!sessionID || !record) {
        skipped += 1
        continue
      }
      if (seen.has(sessionID)) continue
      seen.add(sessionID)
      // Resume cursor: strictly-greater comparison keeps pages disjoint even
      // though every page rescans from the prefix.
      if (cursor.length > 0 && sessionID <= cursor) continue
      if (!includeSelf && sessionID === input.selfSessionID) continue
      candidates.push(summarize(sessionID, record))
    }
    if (capped || !page.next) break
    afterKey = page.next
  }

  // Deterministic ordering regardless of backend scan order.
  candidates.sort((a, b) => (a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : 0))
  const peers = candidates.slice(0, resultLimit)
  const complete = !capped
  const next = candidates.length > resultLimit ? peers[peers.length - 1]?.sessionID : undefined
  return { version: 1, projectID, peers, ...(next !== undefined ? { next } : {}), complete, skipped, limitations: PEER_QUERY_LIMITATIONS }
}

function summarize(sessionID: string, record: GoalRecord): PeerSummary {
  return {
    sessionID,
    status: record.status,
    objectiveHint: objectiveHint(record.objective),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Known-pattern redaction first, then whitespace collapse and truncation to
 * a fixed hint length (with a trailing ellipsis). The hint is the only
 * objective-derived text that ever leaves the query.
 */
function objectiveHint(objective: string): string {
  const collapsed = redactKnownPatterns(objective).replace(/\s+/g, " ").trim()
  if (collapsed.length <= PEER_OBJECTIVE_HINT_LENGTH) return collapsed
  return `${collapsed.slice(0, PEER_OBJECTIVE_HINT_LENGTH)}…`
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return PEER_RESULT_LIMIT_DEFAULT
  return Math.min(Math.floor(value), PEER_RESULT_LIMIT_MAX)
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) {
    throw new Error("peer discovery tools are available only to the orchestrator")
  }
}

function numberField(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== "object") return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringField(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return ""
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "string" ? value.trim() : ""
}

function booleanField(input: unknown, key: string): boolean {
  if (!input || typeof input !== "object") return false
  return (input as Record<string, unknown>)[key] === true
}

function resultContent(content: string): ToolResult {
  return { content }
}

const peerListInput = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: PEER_RESULT_LIMIT_MAX },
    after: { type: "string", minLength: 1, maxLength: 512 },
    includeSelf: { type: "boolean" },
  },
  additionalProperties: false,
} as const