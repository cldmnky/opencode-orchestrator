import { describe, expect, test } from "bun:test"
import {
  filterOrchestratorSessions,
  formatRow,
  liveStatus,
  type CachedSessionSummary,
  type SessionLike,
} from "../../src/tui/sidebar.js"

describe("filterOrchestratorSessions", () => {
  test("keeps only sessions running the orchestrator agent, preserving order, without mutating the input", () => {
    const sessions: SessionLike[] = [
      { id: "a", agent: "orchestrator", title: "goal" },
      { id: "b", agent: "explore" },
      { id: "c", agent: "orchestrator" },
      { id: "d" },
    ]
    const before = JSON.stringify(sessions)

    const filtered = filterOrchestratorSessions(sessions, "orchestrator")

    expect(filtered.map((session) => session.id)).toEqual(["a", "c"])
    expect(JSON.stringify(sessions)).toBe(before)
    expect(filterOrchestratorSessions([], "orchestrator")).toEqual([])
    expect(filterOrchestratorSessions(sessions, "implementer")).toEqual([])
  })
})

describe("liveStatus", () => {
  test("prefers busy tabs, passes through native statuses, and preserves unknown states without guessing", () => {
    const statuses = new Map<string, "idle" | "running">([
      ["s-busy", "running"],
      ["s-running", "running"],
      ["s-idle", "idle"],
    ])
    const busy = new Set(["s-busy"])
    const statusesBefore = [...statuses.entries()]
    const busyBefore = [...busy]

    expect(liveStatus("s-busy", statuses, busy)).toBe("busy")
    expect(liveStatus("s-running", statuses, busy)).toBe("running")
    expect(liveStatus("s-idle", statuses, busy)).toBe("idle")
    expect(liveStatus("s-missing", statuses, busy)).toBe("unknown")

    // An out-of-band status value is preserved as unknown rather than mapped
    // onto a guessed state.
    const widened = new Map<string, string>([["s-paused", "paused"]])
    expect(liveStatus("s-paused", widened as ReadonlyMap<string, "idle" | "running">, busy)).toBe("unknown")
    expect(liveStatus("s-idle", statuses, new Set(["s-idle"]))).toBe("busy")

    // The helper never mutates its inputs.
    expect([...statuses.entries()]).toEqual(statusesBefore)
    expect([...busy]).toEqual(busyBefore)
  })
})

describe("formatRow", () => {
  test("renders a deterministic row from plain data without mutating its input", () => {
    const summary: CachedSessionSummary = {
      sessionID: "session",
      goal: { status: "active", objectiveHint: "hint" },
      worktree: { status: "ready", branch: "feat/x" },
      review: { state: "approved" },
    }
    const input = { sessionID: "session", status: "running" as const, cost: 12.5, title: "  Fix the bug  ", summary }
    const before = JSON.stringify(input)

    expect(formatRow(input)).toBe("[running] Fix the bug (session) $12.50 goal:active tree:ready@feat/x review:approved")
    expect(JSON.stringify(input)).toBe(before)
  })

  test("falls back to (untitled), unknown status, and $0.00 for missing data", () => {
    expect(formatRow({ sessionID: "s", status: "unknown", cost: 0 })).toBe("[unknown] (untitled) (s) $0.00")
    expect(formatRow({ sessionID: "s", status: "unknown", cost: Number.NaN })).toBe("[unknown] (untitled) (s) $0.00")
    expect(formatRow({ sessionID: "s", status: "unknown", cost: Number.POSITIVE_INFINITY })).toBe("[unknown] (untitled) (s) $0.00")
  })

  test("includes only the summary joins that are present", () => {
    const worktreeOnly: CachedSessionSummary = {
      sessionID: "s",
      goal: null,
      worktree: { status: "dirty", branch: "feat" },
      review: null,
    }
    expect(formatRow({ sessionID: "s", status: "busy", cost: 1, summary: worktreeOnly })).toBe(
      "[busy] (untitled) (s) $1.00 tree:dirty@feat",
    )

    const goalOnly: CachedSessionSummary = {
      sessionID: "s",
      goal: { status: "paused", objectiveHint: "hint" },
      worktree: null,
      review: null,
    }
    expect(formatRow({ sessionID: "s", status: "idle", cost: 2, title: "  T  ", summary: goalOnly })).toBe(
      "[idle] T (s) $2.00 goal:paused",
    )
  })
})