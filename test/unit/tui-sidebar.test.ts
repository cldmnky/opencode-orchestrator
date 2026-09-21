import { describe, expect, test } from "bun:test"
import {
  cleanRowTitle,
  filterOrchestratorSessions,
  formatRow,
  liveStatus,
  MAX_ROW_TITLE_LENGTH,
  sidebarMetaParts,
  statusLabel,
  statusMarker,
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
    const input = { status: "running" as const, cost: 12.5, title: "  Fix the bug  ", summary }
    const before = JSON.stringify(input)

    expect(formatRow(input)).toBe("[running] Fix the bug $12.50 goal:active tree:ready@feat/x review:approved")
    expect(JSON.stringify(input)).toBe(before)
  })

  test("falls back to (untitled), unknown status, and $0.00 for missing data", () => {
    expect(formatRow({ status: "unknown", cost: 0 })).toBe("[unknown] (untitled) $0.00")
    expect(formatRow({ status: "unknown", cost: Number.NaN })).toBe("[unknown] (untitled) $0.00")
    expect(formatRow({ status: "unknown", cost: Number.POSITIVE_INFINITY })).toBe("[unknown] (untitled) $0.00")
  })

  test("includes only the summary joins that are present", () => {
    const worktreeOnly: CachedSessionSummary = {
      sessionID: "s",
      goal: null,
      worktree: { status: "dirty", branch: "feat" },
      review: null,
    }
    expect(formatRow({ status: "busy", cost: 1, summary: worktreeOnly })).toBe("[busy] (untitled) $1.00 tree:dirty@feat")

    const goalOnly: CachedSessionSummary = {
      sessionID: "s",
      goal: { status: "paused", objectiveHint: "hint" },
      worktree: null,
      review: null,
    }
    expect(formatRow({ status: "idle", cost: 2, title: "  T  ", summary: goalOnly })).toBe("[idle] T $2.00 goal:paused")
  })

  test("never exposes the raw session id in the row", () => {
    const row = formatRow({ status: "running", cost: 0.93, title: "Material UI SPA Redesign" })
    expect(row).toBe("[running] Material UI SPA Redesign $0.93")
    expect(row).not.toContain("ses_")
  })
})

describe("cleanRowTitle", () => {
  test("collapses internal whitespace and newlines so rows stay single-line", () => {
    expect(cleanRowTitle("Fix   the\tbug\nnow")).toBe("Fix the bug now")
    expect(cleanRowTitle("  Fix   the\tbug  ")).toBe("Fix the bug")
    expect(cleanRowTitle(undefined)).toBe("(untitled)")
    expect(cleanRowTitle("   ")).toBe("(untitled)")
  })

  test("truncates titles longer than MAX_ROW_TITLE_LENGTH with an ellipsis", () => {
    const long = `Implement xsto catalog bootstrap plan fully and completely`
    expect(long.length).toBeGreaterThan(MAX_ROW_TITLE_LENGTH)
    const cleaned = cleanRowTitle(long)
    expect(cleaned).toBe(`${long.slice(0, MAX_ROW_TITLE_LENGTH - 1)}…`)
    expect(cleaned).not.toContain("\n")
    expect(cleanRowTitle("a".repeat(MAX_ROW_TITLE_LENGTH))).toBe("a".repeat(MAX_ROW_TITLE_LENGTH))
  })
})

describe("sidebarMetaParts", () => {
  test("turns progress into short primary and secondary display lines", () => {
    const summary: CachedSessionSummary = {
      sessionID: "session",
      goal: { status: "active", objectiveHint: "hint" },
      worktree: { status: "ready", branch: "feat/x" },
      review: { state: "approved" },
      board: {
        status: "active",
        total: 4,
        completed: 2,
        counts: {} as NonNullable<CachedSessionSummary["board"]>["counts"],
        tasks: [],
      },
      complete: false,
    }

    expect(sidebarMetaParts({ cost: 12.5, summary })).toEqual({
      primary: "tasks 2/4 · goal active · $12.50",
      secondary: "review approved · tree ready · incomplete",
    })
  })

  test("makes missing progress explicit instead of presenting zeroes as state", () => {
    const summary: CachedSessionSummary = {
      sessionID: "session",
      goal: null,
      worktree: null,
      review: null,
      board: {
        status: "unavailable",
        total: 0,
        completed: 0,
        counts: {} as NonNullable<CachedSessionSummary["board"]>["counts"],
        tasks: [],
      },
    }

    expect(sidebarMetaParts({ cost: Number.NaN, summary })).toEqual({ primary: "progress unavailable · $0.00" })
    expect(sidebarMetaParts({ cost: 0 })).toEqual({ primary: "progress unknown · $0.00" })
  })
})

describe("status presentation", () => {
  test("uses distinct compact markers and readable labels", () => {
    expect(statusMarker("busy")).toBe("●")
    expect(statusMarker("running")).toBe("●")
    expect(statusMarker("idle")).toBe("○")
    expect(statusMarker("unknown")).toBe("?")
    expect(statusLabel("running")).toBe("RUNNING")
    expect(statusLabel("unknown")).toBe("UNKNOWN")
  })
})
