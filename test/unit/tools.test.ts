import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { GOAL_TOOL_PERMISSION, PEER_TOOL_PERMISSION, PUBLISH_TOOL_PERMISSION } from "../../src/core/permissions.js"
import { addGoalTools } from "../../src/opencode-v2/goal/tools.js"
import { addPeerTools } from "../../src/opencode-v2/peers/tools.js"
import { addPublishTools } from "../../src/opencode-v2/publish/tools.js"
import {
  goalStorageKey,
  newGoal,
  stopStorageKey,
  type GoalRecord,
  type StorageLike,
} from "../../src/opencode-v2/goal/state.js"

const location = { directory: "/workspace", project: { id: "project" } }
const options = parseOptions({})

type ToolLike = {
  name: string
  options?: { namespace?: string; permission?: string }
  execute(input: unknown, tool: { sessionID: string; agent: string }): Promise<{ content: string }>
}

describe("goal tools", () => {
  test("all goal tools declare the shared permission action", () => {
    const { tools } = collectTools()
    const toolList = [...tools.values()]
    expect(toolList.map((tool: ToolLike) => tool.name)).toEqual(["goal_get", "goal_set", "goal_update"])
    for (const tool of toolList) {
      expect(tool.options?.namespace).toBe("orchestrator")
      expect(tool.options?.permission).toBe(GOAL_TOOL_PERMISSION)
    }
  })

  test("goal_get returns the active goal for the orchestrator", async () => {
    const sessionID = "get-session"
    const { tools, values } = collectTools()
    values.set(goalStorageKey(location, sessionID), newGoal(sessionID, "ship the change", 1))

    const output = await tools.get("goal_get")!.execute({}, toolContext(sessionID, "orchestrator"))

    const goal = JSON.parse(output.content) as GoalRecord
    expect(goal.objective).toBe("ship the change")
    expect(goal.status).toBe("active")
  })

  test("goal_get is gated to the orchestrator like set and update", async () => {
    const { tools } = collectTools()
    const worker = toolContext("get-session", "explore")
    await expect(tools.get("goal_get")!.execute({}, worker)).rejects.toThrow(/only to the orchestrator/)
    await expect(tools.get("goal_set")!.execute({ objective: "x" }, worker)).rejects.toThrow(/only to the orchestrator/)
    await expect(tools.get("goal_update")!.execute({ status: "paused" }, worker)).rejects.toThrow(/only to the orchestrator/)
  })

  test("goal_set creates the goal and clears the halt flag", async () => {
    const sessionID = "set-session"
    const { tools, values } = collectTools()
    const stopKey = stopStorageKey(location, sessionID)
    values.set(stopKey, { version: 1, sessionID, stoppedAt: 1 })

    const output = await tools.get("goal_set")!.execute({ objective: "  ship the change  " }, toolContext(sessionID, "orchestrator"))

    const goal = JSON.parse(output.content) as GoalRecord
    expect(goal.objective).toBe("ship the change")
    expect(goal.status).toBe("active")
    expect(goal.sessionID).toBe(sessionID)
    expect(values.has(stopKey)).toBe(false)
  })

  test("goal_set rejects an empty objective", async () => {
    const { tools } = collectTools()
    const output = await tools.get("goal_set")!.execute({ objective: "   " }, toolContext("set-session", "orchestrator"))
    expect(output.content).toBe("objective must be a non-empty string")
  })

  test("goal_update pauses, resumes, and completes only with evidence", async () => {
    const sessionID = "update-session"
    const { tools, values } = collectTools()
    const key = goalStorageKey(location, sessionID)
    values.set(key, newGoal(sessionID, "ship the change", 1))

    const paused = await tools.get("goal_update")!.execute({ status: "paused" }, toolContext(sessionID, "orchestrator"))
    expect((JSON.parse(paused.content) as GoalRecord).status).toBe("paused")
    expect((JSON.parse(paused.content) as GoalRecord).completionEvidence).toBeUndefined()

    const tooShort = await tools
      .get("goal_update")!
      .execute({ status: "complete", evidence: "short" }, toolContext(sessionID, "orchestrator"))
    expect(tooShort.content).toBe("completion requires at least eight characters of evidence")

    const complete = await tools
      .get("goal_update")!
      .execute({ status: "complete", evidence: "verified by tests" }, toolContext(sessionID, "orchestrator"))
    const completed = JSON.parse(complete.content) as GoalRecord
    expect(completed.status).toBe("complete")
    expect(completed.completionEvidence).toBe("verified by tests")
    expect(completed.completedAt).toBeTypeOf("number")

    // Resuming clears the completion timestamps and the halt flag.
    const stopKey = stopStorageKey(location, sessionID)
    values.set(stopKey, { version: 1, sessionID, stoppedAt: 1 })
    const resumed = await tools.get("goal_update")!.execute({ status: "active" }, toolContext(sessionID, "orchestrator"))
    const active = JSON.parse(resumed.content) as GoalRecord
    expect(active.status).toBe("active")
    expect(active.completedAt).toBeUndefined()
    expect(active.completionEvidence).toBeUndefined()
    expect(values.has(stopKey)).toBe(false)
  })

  test("goal_update reports when no goal exists", async () => {
    const { tools } = collectTools()
    const output = await tools.get("goal_update")!.execute({ status: "paused" }, toolContext("missing-session", "orchestrator"))
    expect(output.content).toBe("No active orchestration goal.")
  })

  test("goal_set and goal_update serialize through the session lock", async () => {
    const sessionID = "lock-session"
    const values = new Map<string, unknown>()
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { tools } = collectTools(
      values,
      async (key, value) => {
        if (key === goalStorageKey(location, sessionID)) {
          markEntered()
          await gate
        }
        values.set(key, value)
      },
    )

    // goal_set blocks inside storage.set while holding the session lock.
    const setPromise = tools.get("goal_set")!.execute({ objective: "finish the work" }, toolContext(sessionID, "orchestrator"))
    await entered
    // goal_update must wait on the same lock; without it this would observe
    // the missing goal and answer "No active orchestration goal."
    const updatePromise = tools.get("goal_update")!.execute({ status: "paused" }, toolContext(sessionID, "orchestrator"))
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()

    const [setResult, updateResult] = await Promise.all([setPromise, updatePromise])
    const setGoal = JSON.parse(setResult.content) as GoalRecord
    expect(setGoal.objective).toBe("finish the work")
    const updated = JSON.parse(updateResult.content) as GoalRecord
    expect(updated.status).toBe("paused")
    expect(updated.objective).toBe("finish the work")
    expect(updated.continuationCount).toBe(0)
  })

  test("goal tools stay keyed to the stable origin project across a session move", async () => {
    // A session whose durable anchor records a different origin keeps its
    // goal/run/halt state under the origin project, not the current one, so a
    // session move never orphans the goal.
    const sessionID = "moved-session"
    const anchorKey = `session/v1/project/${sessionID}`
    const { tools, values } = collectTools(
      new Map<string, unknown>([
        [anchorKey, {
          version: 1,
          sessionID,
          originProjectID: "origin",
          originDirectory: "/origin",
          currentProjectID: "project",
          currentDirectory: "/workspace",
          updatedAt: 1,
        }],
        [goalStorageKey({ ...location, project: { id: "origin" } }, sessionID), newGoal(sessionID, "ship the change", 1)],
      ]),
    )

    const read = await tools.get("goal_get")!.execute({}, toolContext(sessionID, "orchestrator"))
    const goal = JSON.parse(read.content) as GoalRecord
    expect(goal.objective).toBe("ship the change")

    // goal_set writes under the origin project key, not the current one.
    await tools.get("goal_set")!.execute({ objective: "replaced" }, toolContext(sessionID, "orchestrator"))
    expect(values.has(goalStorageKey({ ...location, project: { id: "origin" } }, sessionID))).toBe(true)
    expect(values.has(goalStorageKey(location, sessionID))).toBe(false)

    // goal_update operates on the origin-keyed record.
    const updated = await tools
      .get("goal_update")!
      .execute({ status: "complete", evidence: "verified by tests" }, toolContext(sessionID, "orchestrator"))
    expect((JSON.parse(updated.content) as GoalRecord).status).toBe("complete")
    expect((JSON.parse(updated.content) as GoalRecord).completionEvidence).toBe("verified by tests")
  })
})

describe("publish and peer tools", () => {
  test("registers publish_policy_get and peer tools with their exact permission actions", () => {
    const publishTools = collectPublishTools().tools
    expect([...publishTools.keys()]).toEqual(["publish_policy_get"])
    for (const tool of publishTools.values()) {
      expect(tool.options?.namespace).toBe("orchestrator")
      expect(tool.options?.permission).toBe(PUBLISH_TOOL_PERMISSION)
    }

    const peerTools = collectPeerTools().tools
    expect([...peerTools.keys()]).toEqual(["peer_list", "session_status"])
    for (const tool of peerTools.values()) {
      expect(tool.options?.namespace).toBe("orchestrator")
      expect(tool.options?.permission).toBe(PEER_TOOL_PERMISSION)
    }
  })

  test("both families are gated to the orchestrator agent at runtime", async () => {
    const publishTools = collectPublishTools().tools
    const peerTools = collectPeerTools().tools
    const worker = toolContext("session-1", "explore")
    await expect(publishTools.get("publish_policy_get")!.execute({}, worker)).rejects.toThrow(/only to the orchestrator/)
    await expect(peerTools.get("peer_list")!.execute({}, worker)).rejects.toThrow(/only to the orchestrator/)
  })

  test("peer_list returns bounded same-project metadata through the tool", async () => {
    const values = new Map<string, unknown>([
      [goalStorageKey(location, "peer-a"), newGoal("peer-a", "first objective", 1)],
      [goalStorageKey(location, "peer-b"), newGoal("peer-b", `secret token=ghp_ABCDEFGHIJKLMNOPQRST1234567890 here`, 2)],
      [goalStorageKey(location, "session-1"), newGoal("session-1", "my own objective", 3)],
    ])
    const { tools } = collectPeerTools(values, scanable(values))

    const output = await tools.get("peer_list")!.execute({ limit: 10 }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as { peers: Array<{ sessionID: string; objectiveHint: string }>; complete: boolean }
    expect(parsed.peers.map((peer) => peer.sessionID)).toEqual(["peer-a", "peer-b"])
    expect(parsed.complete).toBe(true)
    expect(parsed.peers.find((peer) => peer.sessionID === "peer-b")?.objectiveHint).toContain("[redacted]")
    expect(output.content).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST1234567890")
  })
})

function collectPublishTools(values = new Map<string, unknown>()): { tools: Map<string, ToolLike> } {
  const tools = new Map<string, ToolLike>()
  addPublishTools(
    {
      add(tool) {
        tools.set(tool.name, tool as ToolLike)
      },
    },
    {
      storage: storageLike(values),
      location,
      options: parseOptions({ publish: { enabled: true } }),
    },
  )
  return { tools }
}

function collectPeerTools(
  values = new Map<string, unknown>(),
  scan?: NonNullable<StorageLike["scan"]>,
): { tools: Map<string, ToolLike> } {
  const tools = new Map<string, ToolLike>()
  addPeerTools(
    {
      add(tool) {
        tools.set(tool.name, tool as ToolLike)
      },
    },
    {
      storage: storageLike(values, scan),
      location,
      options: parseOptions({}),
    },
  )
  return { tools }
}

function storageLike(
  values: Map<string, unknown>,
  scan?: NonNullable<StorageLike["scan"]>,
): StorageLike {
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    ...(scan !== undefined ? { scan } : {}),
  }
}

function scanable(values: Map<string, unknown>): NonNullable<StorageLike["scan"]> {
  return async ({ prefix, after, limit }) => {
    const matches = [...values.keys()].sort().filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
    const page = matches.slice(0, limit)
    const next = matches.length > page.length ? page[page.length - 1] : undefined
    return { entries: page.map((key) => ({ key, value: values.get(key) })), ...(next !== undefined ? { next } : {}) }
  }
}

function toolContext(sessionID: string, agent: string): { sessionID: string; agent: string } {
  return { sessionID, agent }
}

function collectTools(
  values = new Map<string, unknown>(),
  setOverride?: (key: string, value: unknown) => Promise<void>,
): { tools: Map<string, ToolLike>; values: Map<string, unknown> } {
  const tools = new Map<string, ToolLike>()
  addGoalTools(
    {
      add(tool) {
        tools.set(tool.name, tool as ToolLike)
      },
    },
    {
      get: async (key) => values.get(key),
      set: async (key, value) => {
        if (setOverride) await setOverride(key, value)
        else values.set(key, value)
      },
      remove: async (key) => void values.delete(key),
    },
    location,
    options,
  )
  return { tools, values }
}