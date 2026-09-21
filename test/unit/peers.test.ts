import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { PEER_TOOL_PERMISSION } from "../../src/core/permissions.js"
import {
  goalStorageKey,
  newGoal,
  type GoalRecord,
  type StorageLike,
} from "../../src/opencode-v2/goal/state.js"
import { addPeerTools, queryPeerGoals } from "../../src/opencode-v2/peers/tools.js"

const location = { directory: "/workspace", project: { id: "project" } }
const options = parseOptions({})

type ToolLike = {
  name: string
  options?: { namespace?: string; permission?: string }
  execute(input: unknown, tool: { sessionID: string; agent: string }): Promise<{ content: string }>
}

describe("peer query", () => {
  test("returns only same-project goal metadata in deterministic sessionID order", async () => {
    const storage = memStorage([
      // Inserted in reverse order: the backend scan order must not matter.
      [goalStorageKey({ ...location, project: { id: "other" } }, "zz-other"), goal("zz-other", "other project objective", 1)],
      [goalStorageKey(location, "peer-c"), goal("peer-c", "third", 3)],
      [goalStorageKey(location, "peer-a"), goal("peer-a", "first", 1)],
      [goalStorageKey(location, "peer-b"), goal("peer-b", "second", 2)],
    ])

    const result = await queryPeerGoals(storage, location, { selfSessionID: "self" })

    expect(result.version).toBe(1)
    expect(result.projectID).toBe("project")
    expect(result.peers.map((peer) => peer.sessionID)).toEqual(["peer-a", "peer-b", "peer-c"])
    expect(result.complete).toBe(true)
    expect(result.skipped).toBe(0)
    expect(JSON.stringify(result.peers)).not.toContain("other project objective")
    for (const peer of result.peers) {
      expect(Object.keys(peer).sort()).toEqual(["createdAt", "objectiveHint", "sessionID", "status", "updatedAt"])
    }
  })

  test("excludes the current session by default and includes it on request", async () => {
    const storage = memStorage([
      [goalStorageKey(location, "self"), goal("self", "my objective", 1)],
      [goalStorageKey(location, "peer-a"), goal("peer-a", "first", 1)],
    ])

    const withoutSelf = await queryPeerGoals(storage, location, { selfSessionID: "self" })
    expect(withoutSelf.peers.map((peer) => peer.sessionID)).toEqual(["peer-a"])

    const withSelf = await queryPeerGoals(storage, location, { selfSessionID: "self", includeSelf: true })
    expect(withSelf.peers.map((peer) => peer.sessionID)).toEqual(["peer-a", "self"])
  })

  test("applies the bounded result limit with deterministic pagination cursors", async () => {
    const values = new Map<string, unknown>()
    for (const id of ["p1", "p2", "p3", "p4", "p5"]) values.set(goalStorageKey(location, id), goal(id, `objective ${id}`, 1))
    const storage = memStorage([...values])

    const first = await queryPeerGoals(storage, location, { selfSessionID: "self", limit: 2 })
    expect(first.peers.map((peer) => peer.sessionID)).toEqual(["p1", "p2"])
    expect(first.next).toBe("p2")
    expect(first.complete).toBe(true)

    // The second page resumes strictly after the previous page's cursor and
    // never overlaps.
    const second = await queryPeerGoals(storage, location, { selfSessionID: "self", limit: 2, after: first.next })
    expect(second.peers.map((peer) => peer.sessionID)).toEqual(["p3", "p4"])
    expect(second.next).toBe("p4")

    const third = await queryPeerGoals(storage, location, { selfSessionID: "self", limit: 2, after: second.next })
    expect(third.peers.map((peer) => peer.sessionID)).toEqual(["p5"])
    expect(third.next).toBeUndefined()
  })

  test("clamps the requested limit to [1, 20] with a 10 default", async () => {
    const storage = memStorage()
    for (const id of ["a", "b", "c"]) storage.values.set(goalStorageKey(location, id), goal(id, `objective ${id}`, 1))

    expect((await queryPeerGoals(storage, location, { selfSessionID: "self" })).peers).toHaveLength(3)
    expect((await queryPeerGoals(storage, location, { selfSessionID: "self", limit: 0 })).peers).toHaveLength(3)
    expect((await queryPeerGoals(storage, location, { selfSessionID: "self", limit: -4 })).peers).toHaveLength(3)
    expect((await queryPeerGoals(storage, location, { selfSessionID: "self", limit: 999 })).peers).toHaveLength(3)

    const many = memStorage()
    const ids = Array.from({ length: 25 }, (_, index) => `peer-${String(index).padStart(2, "0")}`)
    for (const id of ids) many.values.set(goalStorageKey(location, id), goal(id, `objective ${id}`, 1))
    expect((await queryPeerGoals(many, location, { selfSessionID: "self", limit: 999 })).peers).toHaveLength(20)
  })

  test("redacts known secret patterns and truncates long objectives to the hint length", async () => {
    const secret = "rotate the API_KEY=sk_test_12345abc now"
    const long = `objective ${"x".repeat(300)}`
    const storage = memStorage([
      [goalStorageKey(location, "peer-secret"), goal("peer-secret", secret, 1)],
      [goalStorageKey(location, "peer-long"), goal("peer-long", long, 1)],
    ])

    const result = await queryPeerGoals(storage, location, { selfSessionID: "self" })
    const secretHint = result.peers.find((peer) => peer.sessionID === "peer-secret")!.objectiveHint
    expect(secretHint).toContain("API_KEY: [redacted]")
    expect(secretHint).not.toContain("sk_test_12345abc")
    expect(result.peers.map((peer) => peer.objectiveHint).join("|")).not.toContain("sk_test_12345abc")

    const longHint = result.peers.find((peer) => peer.sessionID === "peer-long")!.objectiveHint
    expect(longHint.length).toBeLessThanOrEqual(121)
    expect(longHint.endsWith("…")).toBe(true)
    expect(result.peers.map((peer) => peer.objectiveHint).join("|")).not.toContain("x".repeat(200))
  })

  test("skips malformed records and foreign keys, counting them, without failing", async () => {
    const storage = memStorage([
      [goalStorageKey(location, "peer-ok"), goal("peer-ok", "fine", 1)],
      // Malformed value under a well-formed key.
      [goalStorageKey(location, "peer-bad-value"), { version: 1, sessionID: "peer-bad-value" }],
      // Well-formed goal value under a malformed key (extra segment).
      [`${goalStorageKey(location, "peer-bad-key")}/extra`, goal("peer-bad-key", "wrong key", 1)],
      // A session-index-style record under the goal prefix.
      [goalStorageKey(location, "peer-index"), { version: 1, objective: 42 }],
    ])

    const result = await queryPeerGoals(storage, location, { selfSessionID: "self" })
    expect(result.peers.map((peer) => peer.sessionID)).toEqual(["peer-ok"])
    expect(result.skipped).toBe(3)
    expect(result.complete).toBe(true)
    // Malformed records never surface their content.
    expect(JSON.stringify(result)).not.toContain("wrong key")
  })

  test("returns an empty bounded result when scan is unavailable, without claiming completeness", async () => {
    const storage: StorageLike = {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    }
    const result = await queryPeerGoals(storage, location, { selfSessionID: "self" })
    expect(result.peers).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.skipped).toBe(0)
    expect(result.limitations.join(" ")).toContain("storage.scan is unavailable")
  })

  test("pagination applies to the post-filter, post-sort candidate list", async () => {
    // Records for sessions that the cursor already passed are excluded before
    // slicing, so pages stay disjoint even with the self filter in play.
    const storage = memStorage([
      [goalStorageKey(location, "self"), goal("self", "mine", 1)],
      [goalStorageKey(location, "peer-a"), goal("peer-a", "first", 1)],
      [goalStorageKey(location, "peer-b"), goal("peer-b", "second", 1)],
      [goalStorageKey(location, "peer-c"), goal("peer-c", "third", 1)],
    ])

    const first = await queryPeerGoals(storage, location, { selfSessionID: "self", limit: 2 })
    expect(first.peers.map((peer) => peer.sessionID)).toEqual(["peer-a", "peer-b"])
    expect(first.next).toBe("peer-b")

    const second = await queryPeerGoals(storage, location, { selfSessionID: "self", limit: 2, after: "peer-b", includeSelf: true })
    expect(second.peers.map((peer) => peer.sessionID)).toEqual(["peer-c", "self"])
  })

  test("never returns transcripts-like fields and stays metadata-only", async () => {
    const storage = memStorage([
      [goalStorageKey(location, "peer-full"), {
        ...goal("peer-full", "objective with secrets", 1),
        completionEvidence: "verified: token=ghp_SUPERSECRETTOKEN1234567890",
      }],
    ])

    const result = await queryPeerGoals(storage, location, { selfSessionID: "self" })
    // Peer entries expose exactly the five metadata fields; no record field
    // beyond them (completionEvidence, transcripts, prompts, credentials)
    // can appear in a peer entry.
    const entryText = JSON.stringify(result.peers)
    expect(entryText).not.toContain("completionEvidence")
    expect(entryText).not.toContain("ghp_SUPERSECRETTOKEN1234567890")
    expect(Object.keys(result.peers[0]!).sort()).toEqual(["createdAt", "objectiveHint", "sessionID", "status", "updatedAt"])
  })
})

describe("peer tools", () => {
  test("registers the unified status tool with the shared peer permission action", () => {
    const { tools } = collectPeerTools()
    expect([...tools.keys()]).toEqual(["status"])
    const tool = tools.get("status")!
    expect(tool.options?.namespace).toBe("orchestrator")
    expect(tool.options?.permission).toBe(PEER_TOOL_PERMISSION)
  })

  test("gates the peer query to the orchestrator agent", async () => {
    const { tools } = collectPeerTools()
    await expect(tools.get("status")!.execute({ mode: "list" }, toolContext("session-1", "explore"))).rejects.toThrow(
      /only to the orchestrator/,
    )
  })

  test("executes a bounded list query through the tool and never mutates storage", async () => {
    const storage = memStorage([
      [goalStorageKey(location, "peer-a"), goal("peer-a", "first", 1)],
      [goalStorageKey(location, "self"), goal("self", "mine", 1)],
    ])
    const countBefore = storage.values.size
    const { tools } = collectPeerTools(storage)

    const output = await tools.get("status")!.execute({ mode: "list", limit: 10 }, toolContext("self", "orchestrator"))
    const parsed = JSON.parse(output.content) as { sessions: Array<{ sessionID: string }>; complete: boolean }
    expect(parsed.sessions.map((session) => session.sessionID)).toEqual(["peer-a"])
    expect(parsed.complete).toBe(true)
    expect(storage.values.size).toBe(countBefore)

    // The tool honors the includeSelf flag and the after cursor.
    const withSelf = await tools.get("status")!.execute({ mode: "list", includeSelf: true }, toolContext("self", "orchestrator"))
    expect((JSON.parse(withSelf.content) as { sessions: Array<{ sessionID: string }> }).sessions.map((session) => session.sessionID)).toEqual([
      "peer-a",
      "self",
    ])
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
