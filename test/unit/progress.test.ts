import { describe, expect, test } from "bun:test"
import { evaluateBudget } from "../../src/opencode-v2/observability/budget.js"
import { newTraceSummary } from "../../src/opencode-v2/observability/trace.js"
import { startReviewV2 } from "../../src/opencode-v2/observability/review-v2.js"
import { createLeadBoardV2, leadBoardV2StorageKey } from "../../src/opencode-v2/orchestration/lead-board-v2.js"
import { goalStorageKey } from "../../src/opencode-v2/goal/state.js"
import { gatesStorageKey } from "../../src/opencode-v2/gates/state.js"
import { publishStorageKey } from "../../src/opencode-v2/publish/state.js"
import { reviewV2StorageKey } from "../../src/opencode-v2/observability/review-v2.js"
import {
  parseProgressInput,
  parseProgressView,
  progressRpcDefinition,
  unavailableProgressView,
} from "../../src/opencode-v2/progress/rpc.js"
import { buildProgressView } from "../../src/opencode-v2/progress/status.js"
import { formatProgressDetail } from "../../src/tui/progress.js"
import { parseOptions } from "../../src/core/config.js"
import { worktreeStorageKey } from "../../src/opencode-v2/worktree/state.js"

describe("Phase 9 progress RPC", () => {
  test("defines one read-only get method and validates the bounded input", () => {
    expect(progressRpcDefinition.id).toBe("opencode-orchestrator.progress")
    expect(Object.keys(progressRpcDefinition.methods)).toEqual(["get"])
    expect(progressRpcDefinition.events).toEqual({})
    expect(parseProgressInput({ sessionID: "session" })).toEqual({ sessionID: "session" })
    expect(parseProgressInput({ sessionID: "" })).toBeUndefined()
    expect(parseProgressInput({ sessionID: "x".repeat(513) })).toBeUndefined()
    expect(parseProgressInput({ sessionID: "session", storage: "read this" })).toEqual({ sessionID: "session" })
  })

  test("joins bounded goal, board, review, budget, worktree, publication, and gate metadata", async () => {
    const sessionID = "session"
    const projectID = "project"
    const location = { directory: "/workspace", project: { id: projectID } }
    const values = new Map<string, unknown>()
    const storage = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => void values.set(key, value),
      remove: async (key: string) => void values.delete(key),
    }
    values.set(goalStorageKey(location, sessionID), {
      version: 1,
      sessionID,
      objective: `Ship password=secret ${"objective ".repeat(30)}`,
      status: "active",
      createdAt: 100,
      updatedAt: 200,
      continuationCount: 0,
    })
    const board = createLeadBoardV2({ projectID, leadSessionID: sessionID, goalGeneration: 100, objective: "Ship feature", now: 100 })
    board.tasks[0] = { ...board.tasks[0]!, status: "reserved", owner: { ...board.tasks[0]!.owner, role: "implementer" } }
    values.set(leadBoardV2StorageKey(location, sessionID), board)
    values.set(
      reviewV2StorageKey(location, sessionID),
      startReviewV2({
        taskId: "root",
        runId: "run",
        leadSessionID: sessionID,
        expectedReviewerAgentID: "reviewer",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        maxRounds: 2,
        now: 300,
      }).record,
    )
    values.set(worktreeStorageKey(projectID, sessionID), {
      version: 1,
      owner: sessionID,
      sessionID,
      originProjectID: projectID,
      repoRoot: "/workspace",
      dir: "/workspace/.worktrees/feature",
      branch: "feature/password=secret",
      base: "main",
      status: "ready",
      createdAt: 100,
      updatedAt: 200,
    })
    values.set(publishStorageKey(projectID), {
      version: 1,
      projectID,
      enabled: true,
      capabilities: ["push", "merge"],
      updatedAt: 200,
      updatedBy: sessionID,
    })
    values.set(gatesStorageKey(sessionID), { version: 1, sessionID, disabled: ["merge"], updatedAt: 200 })

    const options = parseOptions({
      worktree: { enabled: true },
      publish: { enabled: true },
      budget: { mode: "advisory", max_steps: 10 },
    })
    const trace = { ...newTraceSummary(sessionID, "memory", 100), steps: 2 }
    const view = await buildProgressView({
      storage,
      location,
      options,
      observability: {
        summary: async () => trace,
        evaluation: async () => evaluateBudget({ observed: { steps: trace.steps }, limits: options.budget, mode: options.budget.mode }),
      },
    }, sessionID)

    expect(view.complete).toBe(true)
    expect(view.goal?.objectiveHint).not.toContain("secret")
    expect(view.goal?.objectiveHint.length).toBeLessThanOrEqual(120)
    expect(view.board.status).toBe("active")
    expect(view.board.counts.reserved).toBe(1)
    expect(view.reservedTask).toMatchObject({ status: "reserved", role: "implementer" })
    expect(view.review).toEqual({ state: "pending", round: 1 })
    expect(view.budget).toMatchObject({ verdict: "within", coverage: "complete" })
    expect(view.worktree).toEqual({ status: "ready", branch: "feature/password: [redacted]" })
    expect(view.publication).toMatchObject({ durableEnabled: true, configEnabled: true })
    expect(view.gates.statuses.find((status) => status.gate === "merge")).toMatchObject({ enabled: false, sessionDisabled: true })
    expect(JSON.stringify(view)).not.toContain("/workspace/.worktrees")
    expect(JSON.stringify(view)).not.toContain("objective ".repeat(10))
  })

  test("marks missing state and missing budget coverage as incomplete instead of guessing completion", async () => {
    const values = new Map<string, unknown>()
    const location = { directory: "/workspace", project: { id: "project" } }
    const options = parseOptions({ budget: { mode: "advisory", max_tokens: 10 }, worktree: { enabled: true } })
    const view = await buildProgressView(
      {
        storage: {
          get: async (key: string) => values.get(key),
          set: async () => {},
          remove: async () => {},
        },
        location,
        options,
      },
      "missing-session",
    )
    expect(view.complete).toBe(false)
    expect(view.goal).toBeNull()
    expect(view.board.status).toBe("missing")
    expect(view.budget).toMatchObject({ verdict: "unknown", coverage: "unknown" })
    expect(view.limitations.join(" ")).toContain("not initialized")
  })

  test("rejects oversized or malformed RPC output and preserves explicit unknown state", () => {
    const unavailable = unavailableProgressView("session", "old server")
    expect(parseProgressView(unavailable)).toEqual(unavailable)
    expect(parseProgressView({ ...unavailable, goal: { status: "active", objectiveHint: "" } })).toBeUndefined()
    expect(
      parseProgressView({
        ...unavailable,
        board: {
          ...unavailable.board,
          tasks: [{ title: "x".repeat(97), status: "planned", role: "lead" }],
        },
      }),
    ).toBeUndefined()
  })

  test("formats bounded detail without adding mutation affordances or raw state", () => {
    const view = unavailableProgressView("session", "unknown state")
    const detail = formatProgressDetail(view)
    expect(detail).toContain("Completeness: incomplete / unknown")
    expect(detail).toContain("Limitations:")
    expect(detail).not.toContain("session")
  })
})
