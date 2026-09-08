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
export type ReviewSummaryState = "pending" | "approved" | "changes-requested" | "blocked" | "tripped"

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

/** Formats one deterministic, human-readable sidebar row. */
export function formatRow(input: {
  sessionID: string
  status: LiveStatus
  cost: number
  title?: string
  summary?: CachedSessionSummary
}): string {
  const parts = [
    `[${input.status}]`,
    input.title?.trim() ? input.title.trim() : "(untitled)",
    `(${input.sessionID})`,
    `$${Number.isFinite(input.cost) ? input.cost.toFixed(2) : "0.00"}`,
  ]
  if (input.summary?.goal) parts.push(`goal:${input.summary.goal.status}`)
  if (input.summary?.worktree) parts.push(`tree:${input.summary.worktree.status}@${input.summary.worktree.branch}`)
  if (input.summary?.review) parts.push(`review:${input.summary.review.state}`)
  return parts.join(" ")
}

export type SidebarSessionsProps = {
  sessions: readonly SessionLike[]
  statuses: ReadonlyMap<string, SessionStatus>
  costs: ReadonlyMap<string, number>
  tabs: readonly TabLike[]
  /** Optional cached durable summaries; never read from server storage here. */
  summaries?: readonly CachedSessionSummary[]
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
    <box flexDirection="column">
      <text>Orchestrator sessions</text>
      <For each={props.sessions}>
        {(session) => {
          const summary = props.summaries?.find((candidate) => candidate.sessionID === session.id)
          return (
            <text>
              {formatRow({
                sessionID: session.id,
                title: session.title,
                status: liveStatus(session.id, props.statuses, busySessionIDs),
                cost: props.costs.get(session.id) ?? 0,
                summary,
              })}
            </text>
          )
        }}
      </For>
    </box>
  )
}