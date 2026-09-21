/**
 * Read-only `sidebar.content` contribution: a live list of orchestrator
 * sessions.
 *
 * The component is deliberately pure: it receives everything it renders
 * (sessions, statuses, costs, tabs, and optional cached durable summaries)
 * through props, and it never touches git, GitHub, server storage, commands,
 * prompts, tab focus, navigation, or mutations. The TUI wiring in
 * `src/tui.ts` feeds it reactive client-cache data only.
 */
import { For } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import type {
  ProgressBoardSummary,
  ProgressBudgetSummary,
  ProgressGateSummary,
  ProgressPublicationSummary,
} from "../opencode-v2/progress/rpc.js"

/** Minimal structural view of a session; the SDK's SessionInfo satisfies it. */
export type SessionLike = {
  id: string
  agent?: string
  title?: string
}

/** Minimal structural view of a session tab; `context.ui.tabs.list()` satisfies it. */
export type TabLike = {
  sessionID: string
  busy: boolean
}

/** Native session status, as reported by `context.data.session.status()`. */
export type SessionStatus = "idle" | "running"

/** Live status shown per row: tab-busy wins, then the native status, else unknown. */
export type LiveStatus = "idle" | "running" | "busy" | "unknown"

export type GoalSummaryStatus = "active" | "paused" | "complete"
export type WorktreeSummaryStatus = "pending" | "ready" | "moved" | "dirty" | "orphaned" | "cleanup-failed"
export type ReviewSummaryState = "pending" | "approved" | "changes-requested" | "blocked" | "tripped" | "legacy-unproven"

/**
 * Local cached summary of durable orchestrator state for one session.
 *
 * The shape structurally mirrors the server's durable summary records (goal
 * record, worktree record, review record) but is defined here on purpose:
 * the TUI never reads server storage directly, and callers hand in cached
 * snapshots as plain props.
 */
export type CachedSessionSummary = {
  sessionID: string
  goal: { status: GoalSummaryStatus; objectiveHint: string } | null
  worktree: { status: WorktreeSummaryStatus; branch: string } | null
  review: { state: ReviewSummaryState } | null
  /** Optional fields populated by the Phase 9 progress RPC. */
  board?: ProgressBoardSummary
  budget?: ProgressBudgetSummary
  publication?: ProgressPublicationSummary
  gates?: ProgressGateSummary
  complete?: boolean
  limitations?: readonly string[]
}

/** Keeps only sessions running the orchestrator agent. */
export function filterOrchestratorSessions(sessions: readonly SessionLike[], orchestratorAgent: string): SessionLike[] {
  return sessions.filter((session) => session.agent === orchestratorAgent)
}

/**
 * Derives the live status for one session: a busy tab wins, then the native
 * session status; anything else (missing session, unknown state) is
 * preserved as "unknown" rather than guessed.
 */
export function liveStatus(
  sessionID: string,
  statuses: ReadonlyMap<string, SessionStatus>,
  busySessionIDs: ReadonlySet<string>,
): LiveStatus {
  if (busySessionIDs.has(sessionID)) return "busy"
  const status = statuses.get(sessionID)
  return status === "running" || status === "idle" ? status : "unknown"
}

/** Sidebar titles are collapsed and truncated to keep the card header stable. */
export const MAX_ROW_TITLE_LENGTH = 40
export const MAX_ROW_BRANCH_LENGTH = 20

/** Collapses whitespace, falls back to `(untitled)`, and truncates long titles. */
export function cleanRowTitle(title?: string): string {
  const collapsed = title?.replace(/\s+/g, " ").trim() ?? ""
  if (!collapsed) return "(untitled)"
  return collapsed.length > MAX_ROW_TITLE_LENGTH ? `${collapsed.slice(0, MAX_ROW_TITLE_LENGTH - 1)}…` : collapsed
}

/** Theme colors for the sidebar rows; mirrors the host's semantic text tokens. */
export type SidebarTheme = {
  readonly text: RGBA
  readonly subdued: RGBA
  readonly running: RGBA
}

/** Decomposed row content: status and title render in accent colors, metadata dimmed. */
export type RowParts = {
  readonly status: LiveStatus
  readonly title: string
  readonly meta: string
}

/** Human-readable metadata lines used by the visual sidebar card. */
export type SidebarMetaParts = {
  readonly primary: string
  readonly secondary?: string
}

/** Splits a row into styled parts; `formatRow` joins them for plain-text use. */
export function rowParts(input: {
  status: LiveStatus
  cost: number
  title?: string
  summary?: CachedSessionSummary
}): RowParts {
  const meta = [`$${Number.isFinite(input.cost) ? input.cost.toFixed(2) : "0.00"}`]
  if (input.summary?.goal) meta.push(`goal:${input.summary.goal.status}`)
  if (input.summary?.worktree) meta.push(`tree:${input.summary.worktree.status}@${compactRowLabel(input.summary.worktree.branch, MAX_ROW_BRANCH_LENGTH)}`)
  if (input.summary?.review) meta.push(`review:${input.summary.review.state}`)
  if (input.summary?.board) meta.push(`board:${input.summary.board.completed}/${input.summary.board.total}`)
  if (input.summary?.complete === false) meta.push("incomplete")
  return { status: input.status, title: cleanRowTitle(input.title), meta: meta.join(" ") }
}

function compactRowLabel(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim()
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, maxLength - 1)}…`
}

/** Formats the bounded summary as two short, scannable metadata lines. */
export function sidebarMetaParts(input: {
  cost: number
  summary?: CachedSessionSummary
}): SidebarMetaParts {
  const primary: string[] = []
  const secondary: string[] = []

  const board = input.summary?.board
  if (!board) {
    primary.push("progress unknown")
  } else if (board.status === "unavailable") {
    primary.push("progress unavailable")
  } else if (board.status === "missing") {
    primary.push("not started")
  } else if (board.total > 0) {
    primary.push(`tasks ${board.completed}/${board.total}`)
  } else {
    primary.push(`board ${board.status}`)
  }

  if (input.summary?.goal) primary.push(`goal ${input.summary.goal.status}`)
  primary.push(formatCost(input.cost))

  if (input.summary?.review) secondary.push(`review ${input.summary.review.state}`)
  if (input.summary?.worktree) secondary.push(`tree ${input.summary.worktree.status}`)
  if (input.summary?.budget?.verdict === "exceeded") secondary.push("budget exceeded")
  if (input.summary?.complete === false && board?.status !== "unavailable" && board?.status !== "missing") secondary.push("incomplete")

  return {
    primary: primary.join(" · "),
    ...(secondary.length > 0 ? { secondary: secondary.join(" · ") } : {}),
  }
}

function formatCost(cost: number): string {
  return `$${Number.isFinite(cost) ? cost.toFixed(2) : "0.00"}`
}

/** Returns a compact status marker that remains readable in monochrome terminals. */
export function statusMarker(status: LiveStatus): string {
  switch (status) {
    case "busy":
    case "running":
      return "●"
    case "idle":
      return "○"
    case "unknown":
      return "?"
  }
}

export function statusLabel(status: LiveStatus): string {
  return status.toUpperCase()
}

/** Formats one deterministic, human-readable sidebar row (always single-line). */
export function formatRow(input: {
  status: LiveStatus
  cost: number
  title?: string
  summary?: CachedSessionSummary
}): string {
  const parts = rowParts(input)
  return `[${parts.status}] ${parts.title} ${parts.meta}`
}

export type SidebarSessionsProps = {
  sessions: readonly SessionLike[]
  statuses: ReadonlyMap<string, SessionStatus>
  costs: ReadonlyMap<string, number>
  tabs: readonly TabLike[]
  /** Optional cached durable summaries; never read from server storage here. */
  summaries?: readonly CachedSessionSummary[]
  /** Optional host theme colors; rows fall back to unstyled text without it. */
  theme?: SidebarTheme
}

/**
 * Builds the sidebar element from plain data. Kept in this `.tsx` module so
 * callers (including `src/tui.ts`, a `.ts` file) never need JSX syntax:
 * they read the reactive client caches and pass the values in as props.
 */
export function renderSidebar(props: SidebarSessionsProps): JSX.Element {
  return <SidebarSessions {...props} />
}

/** Renders the orchestrator session list for the `sidebar.content` slot. */
export function SidebarSessions(props: SidebarSessionsProps): JSX.Element {
  const busySessionIDs = new Set(props.tabs.filter((tab) => tab.busy).map((tab) => tab.sessionID))
  return (
    <box flexDirection="column" paddingTop={1}>
      <text wrapMode="none" truncate>
        <span style={{ fg: props.theme?.text }}>Orchestrator</span>
        <span style={{ fg: props.theme?.subdued }}> · {props.sessions.length} {props.sessions.length === 1 ? "session" : "sessions"}</span>
      </text>
      <For each={props.sessions}>
        {(session) => {
          const summary = props.summaries?.find((candidate) => candidate.sessionID === session.id)
          const status = liveStatus(session.id, props.statuses, busySessionIDs)
          const cost = props.costs.get(session.id) ?? 0
          const parts = rowParts({
            title: session.title,
            status,
            cost,
            summary,
          })
          const meta = sidebarMetaParts({ cost, summary })
          const active = status === "running" || status === "busy"
          return (
            <box flexDirection="column" paddingLeft={1} paddingTop={1}>
              <text wrapMode="none" truncate>
                <span style={{ fg: active ? props.theme?.running : props.theme?.subdued }}>{statusMarker(status)} {statusLabel(status)}</span>
                <span style={{ fg: props.theme?.text }}>  {parts.title}</span>
              </text>
              <text wrapMode="none" truncate>
                <span style={{ fg: props.theme?.subdued }}>  {meta.primary}</span>
              </text>
              {meta.secondary ? (
                <text wrapMode="none" truncate>
                  <span style={{ fg: props.theme?.subdued }}>  {meta.secondary}</span>
                </text>
              ) : null}
            </box>
          )
        }}
      </For>
      {props.sessions.length === 0 ? <text fg={props.theme?.subdued}>No orchestrator sessions</text> : null}
    </box>
  )
}
