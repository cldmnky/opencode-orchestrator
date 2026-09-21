import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { PEER_TOOL_PERMISSION } from "../../src/core/permissions.js"
import {
  goalStorageKey,
  newGoal,
  type GoalRecord,
  type StorageLike,
} from "../../src/opencode-v2/goal/state.js"
import {
  reviewStorageKey,
  transitionReviewV1,
  type ReviewV1Record,
} from "../../src/opencode-v2/observability/review.js"
import { newWorktree, worktreeStorageKey } from "../../src/opencode-v2/worktree/state.js"
import {
  addPeerTools,
  querySessionStatus,
  querySessionStatuses,
  SESSION_STATUS_LIMITATIONS,
} from "../../src/opencode-v2/peers/tools.js"

const location = { directory: "/workspace", project: { id: "project" } }
const options = parseOptions({})

type ToolLike = {
  name: string
  options?: { namespace?: string; permission?: string }
  execute(input: unknown, tool: { sessionID: string; agent: string }): Promise<{ content: string }>
}

describe("session status query", () => {
  test("single mode returns the goal/worktree/review summary with limited metadata fields", async () => {
    const storage = memStorage([
      [goalStorageKey(location, "peer-a"), goal("peer-a", "fix the bug", 1)],
      [
        worktreeStorageKey("project", "peer-a"),
        newWorktree(
          {
            owner: "peer-a",
            sessionID: "peer-a",
            originProjectID: "project",
            repoRoot: "/srv/repo",
            dir: "/srv/trees/peer-a",
            branch: "feat/API_KEY=sk_test_12345abc",
            base: "main",
          },
          1,
        ),
      ],
      [reviewStorageKey({ project: { id: "project" } }, "peer-a"), reviewRecord(1)],
    ])

    const result = await querySessionStatus(storage, location, { selfSessionID: "self", sessionID: "peer-a" })

    expect(result.version).toBe(1)
    expect(result.projectID).toBe("project")
    expect(result.limitations).toEqual(SESSION_STATUS_LIMITATIONS)
    expect(result.summary?.sessionID).toBe("peer-a")
    expect(Object.keys(result.summary!).sort()).toEqual(["goal", "review", "sessionID", "worktree"])
    expect(result.summary?.goal).toEqual({ status: "active", objectiveHint: "fix the bug" })
    expect(result.summary?.worktree?.status).toBe("pending")
    // The worktree join exposes exactly three metadata fields: no repoRoot,
    // base, owner, or sync receipt (with its SHAs) can leak out.
    expect(Object.keys(result.summary!.worktree!).sort()).toEqual(["branch", "dir", "status"])
    expect(result.summary?.worktree?.branch).toContain("API_KEY: [redacted]")
    expect(result.summary?.worktree?.branch).not.toContain("sk_test_12345abc")
    // The review join exposes only a bounded status: legacy V1 state is
    // deliberately reported as unproven, never as publication proof.
    expect(result.summary?.review).toEqual({ state: "legacy-unproven" })
    expect(Object.keys(result.summary!.review!)).toEqual(["state"])
    expect(JSON.stringify(result)).not.toContain("sk_test_12345abc")
    expect(JSON.stringify(result)).not.toContain("completionEvidence")
  })

  test("single mode returns a null summary when the goal record is missing, malformed, or foreign", async () => {
    const storage = memStorage([
      // A goal that exists only under another project must not be readable.
      [goalStorageKey({ ...location, project: { id: "other" } }, "peer-x"), goal("peer-x", "other project", 1)],
      // A malformed goal record under the correct project key parses to nothing.
      [goalStorageKey(location, "peer-bad"), { version: 1, sessionID: "peer-bad" }],
    ])

    const foreign = await querySessionStatus(storage, location, { selfSessionID: "self", sessionID: "peer-x" })
    expect(foreign.projectID).toBe("project")
    expect(foreign.summary).toBeNull()

    const malformed = await querySessionStatus(storage, location, { selfSessionID: "self", sessionID: "peer-bad" })
    expect(malformed.summary).toBeNull()
  })

  test("list mode reads the same stable project only, orders deterministically, and skips malformed entries", async () => {
    const storage = memStorage([
      [goalStorageKey({ ...location, project: { id: "other" } }, "zz-other"), goal("zz-other", "other project objective", 1)],
      [goalStorageKey(location, "self"), goal("self", "mine", 1)],
      [goalStorageKey(location, "peer-c"), goal("peer-c", "third", 3)],
      [goalStorageKey(location, "peer-a"), goal("peer-a", "first", 1)],
      // Malformed value under a well-formed key.
      [goalStorageKey(location, "peer-bad"), { version: 1, sessionID: "peer-bad" }],
      // Well-formed goal value under a malformed (extra-segment) key.
      [`${goalStorageKey(location, "peer-key")}/extra`, goal("peer-key", "wrong key", 1)],
    ])

    const result = await querySessionStatuses(storage, location, { selfSessionID: "self" })

    expect(result.version).toBe(1)
    expect(result.projectID).toBe("project")
    expect(result.sessions.map((session) => session.sessionID)).toEqual(["peer-a", "peer-c"])
    expect(result.complete).toBe(true)
    expect(result.skipped).toBe(2)
    expect(JSON.stringify(result)).not.toContain("other project objective")
    expect(JSON.stringify(result)).not.toContain("wrong key")
    for (const session of result.sessions) {
      expect(Object.keys(session).sort()).toEqual(["goal", "review", "sessionID", "worktree"])
    }
  })

  test("list mode redacts secrets and truncates hints, branch names, and worktree paths", async () => {
    const secret = "rotate the API_KEY=sk_test_12345abc now"
    const longObjective = `objective ${"x".repeat(300)}`
    const longBranch = `branch ${"y".repeat(300)}`
    const longDir = `/private/var/folders/4v/4wfn31mx309csltn4hym9nvm0000gn/T/opencode/${"d".repeat(300)}/peer-a`
    const storage = memStorage([
      [goalStorageKey(location, "peer-secret"), goal("peer-secret", secret, 1)],
      [goalStorageKey(location, "peer-long"), goal("peer-long", longObjective, 1)],
      [
        worktreeStorageKey("project", "peer-long"),
        newWorktree(
          {
            owner: "peer-long",
            sessionID: "peer-long",
            originProjectID: "project",
            repoRoot: "/srv/repo",
            dir: longDir,
            branch: longBranch,
            base: "main",
          },
          1,
        ),
      ],
    ])

    const result = await querySessionStatuses(storage, location, { selfSessionID: "self" })
    const text = JSON.stringify(result)
    expect(text).not.toContain("sk_test_12345abc")
    expect(text).not.toContain("x".repeat(200))
    expect(text).not.toContain("y".repeat(200))

    const secretSession = result.sessions.find((session) => session.sessionID === "peer-secret")
    expect(secretSession?.goal?.objectiveHint).toContain("API_KEY: [redacted]")

    const longSession = result.sessions.find((session) => session.sessionID === "peer-long")
    expect(longSession?.goal?.objectiveHint.length).toBeLessThanOrEqual(121)
    expect(longSession?.goal?.objectiveHint.endsWith("…")).toBe(true)
    // Branch names are head-truncated like objective hints...
    expect(longSession?.worktree?.branch.length).toBeLessThanOrEqual(121)
    expect(longSession?.worktree?.branch.endsWith("…")).toBe(true)
    // ...while worktree paths keep the identifying tail.
    expect(longSession?.worktree?.dir.length).toBeLessThanOrEqual(240)
    expect(longSession?.worktree?.dir.startsWith("…")).toBe(true)
    expect(longSession?.worktree?.dir.endsWith("/peer-a")).toBe(true)
  })

  test("worktree and review joins are null when records are missing or malformed", async () => {
    const storage = memStorage([
      [goalStorageKey(location, "peer-goal"), goal("peer-goal", "goal only", 1)],
      [goalStorageKey(location, "peer-foreign"), goal("peer-foreign", "foreign joins", 1)],
      // Malformed worktree and review records under well-formed keys.
      [worktreeStorageKey("project", "peer-goal"), { version: 1, sessionID: "peer-goal" }],
      [reviewStorageKey({ project: { id: "project" } }, "peer-goal"), { version: 1, taskId: "task" }],
      // A worktree record keyed under another project is never joined.
      [
        worktreeStorageKey("other", "peer-foreign"),
        newWorktree(
          {
            owner: "peer-foreign",
            sessionID: "peer-foreign",
            originProjectID: "other",
            repoRoot: "/srv/repo",
            dir: "/srv/trees/peer-foreign",
            branch: "feat/x",
            base: "main",
          },
          1,
        ),
      ],
    ])

    const result = await querySessionStatuses(storage, location, { selfSessionID: "self" })

    const goalOnly = result.sessions.find((session) => session.sessionID === "peer-goal")
    expect(goalOnly?.goal).toEqual({ status: "active", objectiveHint: "goal only" })
    expect(goalOnly?.worktree).toBeNull()
    expect(goalOnly?.review).toBeNull()

    const foreign = result.sessions.find((session) => session.sessionID === "peer-foreign")
    expect(foreign?.worktree).toBeNull()
    expect(foreign?.review).toBeNull()
  })

  test("list mode clamps the limit to [1, 20] with a 10 default", async () => {
    const storage = memStorage()
    const ids = Array.from({ length: 25 }, (_, index) => `peer-${String(index).padStart(2, "0")}`)
    for (const id of ids) storage.values.set(goalStorageKey(location, id), goal(id, `objective ${id}`, 1))

    const byDefault = await querySessionStatuses(storage, location, { selfSessionID: "self" })
    expect(byDefault.sessions).toHaveLength(10)

    const clamped = await querySessionStatuses(storage, location, { selfSessionID: "self", limit: 999 })
    expect(clamped.sessions.map((session) => session.sessionID)).toEqual(ids.slice(0, 20))
    expect(clamped.sessions.map((session) => session.goal?.objectiveHint)).toEqual(ids.slice(0, 20).map((id) => `objective ${id}`))
  })

  test("list mode pages deterministically with strictly-greater after cursors", async () => {
    const storage = memStorage()
    for (const id of ["p1", "p2", "p3", "p4", "p5"]) storage.values.set(goalStorageKey(location, id), goal(id, `objective ${id}`, 1))

    const first = await querySessionStatuses(storage, location, { selfSessionID: "self", limit: 2 })
    expect(first.sessions.map((session) => session.sessionID)).toEqual(["p1", "p2"])
    expect(first.next).toBe("p2")
    expect(first.complete).toBe(true)

    const second = await querySessionStatuses(storage, location, { selfSessionID: "self", limit: 2, after: first.next })
    expect(second.sessions.map((session) => session.sessionID)).toEqual(["p3", "p4"])
    expect(second.next).toBe("p4")

    const third = await querySessionStatuses(storage, location, { selfSessionID: "self", limit: 2, after: second.next })
    expect(third.sessions.map((session) => session.sessionID)).toEqual(["p5"])
    expect(third.next).toBeUndefined()
  })

  test("hits the bounded scan cap and reports complete:false without failing", async () => {
    const storage = memStorage()
    const ids = Array.from({ length: 2_001 }, (_, index) => `peer-${String(index).padStart(4, "0")}`)
    for (const id of ids) storage.values.set(goalStorageKey(location, id), goal(id, `objective ${id}`, 1))

    const result = await querySessionStatuses(storage, location, { selfSessionID: "self" })

    expect(result.complete).toBe(false)
    expect(result.sessions.map((session) => session.sessionID)).toEqual(ids.slice(0, 10))
    expect(result.next).toBe(result.sessions[result.sessions.length - 1]?.sessionID)
    // Only the returned slice is joined, and joins hit missing records.
    for (const session of result.sessions) {
      expect(session.worktree).toBeNull()
      expect(session.review).toBeNull()
    }
    expect(result.limitations.join(" ")).toContain("no live completeness guarantee")
    // The tool never surfaces transcript-like content from the join path.
    expect(JSON.stringify(result)).not.toContain("completionEvidence")
  })

  test("returns an empty bounded result when scan is unavailable, without claiming completeness", async () => {
    const storage: StorageLike = {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    }
    const result = await querySessionStatuses(storage, location, { selfSessionID: "self" })
    expect(result.sessions).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.skipped).toBe(0)
    expect(result.limitations.join(" ")).toContain("storage.scan is unavailable")
  })
})

describe("session status tools", () => {
  test("rejects non-orchestrator agents", async () => {
    const { tools } = collectPeerTools()
    await expect(tools.get("status")!.execute({ mode: "list" }, toolContext("session-1", "explore"))).rejects.toThrow(
      /only to the orchestrator/,
    )
  })

  test("executes single and list queries through the tool without mutating storage", async () => {
    const storage = memStorage([
      [goalStorageKey(location, "peer-a"), goal("peer-a", "first", 1)],
      [goalStorageKey(location, "self"), goal("self", "mine", 1)],
    ])
    const { tools } = collectPeerTools(storage)
    const before = JSON.stringify([...storage.values.entries()].sort())

    const single = await tools.get("status")!.execute({ mode: "single", sessionID: "peer-a" }, toolContext("self", "orchestrator"))
    const parsedSingle = JSON.parse(single.content) as { summary: { sessionID: string } | null }
    expect(parsedSingle.summary?.sessionID).toBe("peer-a")

    const list = await tools.get("status")!.execute({ mode: "list", limit: 10 }, toolContext("self", "orchestrator"))
    const parsedList = JSON.parse(list.content) as { sessions: Array<{ sessionID: string }>; complete: boolean }
    expect(parsedList.sessions.map((session) => session.sessionID)).toEqual(["peer-a"])
    expect(parsedList.complete).toBe(true)

    expect([...tools.keys()]).toEqual(["status"])
    expect(tools.get("status")!.options?.namespace).toBe("orchestrator")
    expect(tools.get("status")!.options?.permission).toBe(PEER_TOOL_PERMISSION)
    expect(JSON.stringify([...storage.values.entries()].sort())).toBe(before)
  })
})

function toolContext(sessionID: string, agent: string): { sessionID: string; agent: string } {
  return { sessionID, agent }
}

function collectPeerTools(storage?: StorageLike & { values: Map<string, unknown> }): {
  tools: Map<string, ToolLike>
  storage: StorageLike & { values: Map<string, unknown> }
} {
  const tools = new Map<string, ToolLike>()
  const store = storage ?? memStorage()
  addPeerTools(
    {
      add(tool) {
        tools.set(tool.name, tool as ToolLike)
      },
    },
    { storage: store, location, options },
  )
  return { tools, storage: store }
}

function goal(sessionID: string, objective: string, now: number): GoalRecord {
  return newGoal(sessionID, objective, now)
}

function reviewRecord(now = 1): ReviewV1Record {
  const transition = transitionReviewV1({
    record: undefined,
    signal: {
      action: "start",
      taskId: "task-1",
      runId: "run-1",
      maker: "maker-1",
      checker: "checker-1",
      admissionState: "review-pending",
    },
    maxRounds: 3,
    now,
  })
  return transition.record!
}

/** In-memory storage with a deterministic mocked scan over sorted keys. */
function memStorage(entries: Array<[string, unknown]> = []): StorageLike & { values: Map<string, unknown> } {
  const values = new Map(entries)
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    scan: async ({ prefix, after, limit }) => {
      const matches = [...values.keys()].sort().filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      const page = matches.slice(0, limit)
      const next = matches.length > page.length ? page[page.length - 1] : undefined
      return { entries: page.map((key) => ({ key, value: values.get(key) })), ...(next !== undefined ? { next } : {}) }
    },
  }
}
