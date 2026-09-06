import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { PUBLISH_TOOL_PERMISSION } from "../../src/core/permissions.js"
import { addPublishTools } from "../../src/opencode-v2/publish/tools.js"
import {
  PUBLISH_CAPABILITIES,
  isPublishCapabilityAuthorized,
  publicationStatus,
  publishStorageKey,
  readPublishRecord,
  setPublicationEnabled,
  type LocationLike,
  type PublishRecord,
  type StorageLike,
} from "../../src/opencode-v2/publish/state.js"

const location = { directory: "/workspace", project: { id: "project" } }

type ToolLike = {
  name: string
  options?: { namespace?: string; permission?: string }
  execute(input: unknown, tool: { sessionID: string; agent: string }): Promise<{ content: string }>
}

describe("publish state", () => {
  test("keys are project-scoped and versioned", () => {
    expect(publishStorageKey("project")).toBe("publish/v1/project")
    expect(publishStorageKey("proj/one")).toBe("publish/v1/proj%2Fone")
    expect(publishStorageKey("project")).not.toBe(publishStorageKey("other"))
  })

  test("absent records read as undefined and never invent authorization", async () => {
    const storage = memStorage()
    expect(await readPublishRecord(storage, "project")).toBeUndefined()
    expect(await isPublishCapabilityAuthorized(storage, location, "session-1", "push")).toEqual({
      projectID: "project",
      authorized: false,
    })
  })

  test("enable writes the canonical capability set; disable empties it", async () => {
    const storage = memStorage()
    const enabled = await setPublicationEnabled(storage, location, "session-1", true, 1000)
    expect(enabled.changed).toBe(true)
    expect(enabled.record).toEqual({
      version: 1,
      projectID: "project",
      enabled: true,
      capabilities: [...PUBLISH_CAPABILITIES],
      updatedAt: 1000,
      updatedBy: "session-1",
    })
    expect(storage.values.get(publishStorageKey("project"))).toEqual(enabled.record)

    const disabled = await setPublicationEnabled(storage, location, "session-1", false, 2000)
    expect(disabled.changed).toBe(true)
    expect(disabled.record.enabled).toBe(false)
    expect(disabled.record.capabilities).toEqual([])
    expect((storage.values.get(publishStorageKey("project")) as PublishRecord).updatedAt).toBe(2000)
  })

  test("enable and disable are idempotent and never rewrite an unchanged record", async () => {
    const storage = memStorage()
    await setPublicationEnabled(storage, location, "session-1", true, 1000)
    const again = await setPublicationEnabled(storage, location, "session-9", true, 9999)
    expect(again.changed).toBe(false)
    expect(again.record.updatedBy).toBe("session-1")
    expect((storage.values.get(publishStorageKey("project")) as PublishRecord).updatedAt).toBe(1000)

    await setPublicationEnabled(storage, location, "session-1", false, 1000)
    const disabledAgain = await setPublicationEnabled(storage, location, "session-1", false, 9999)
    expect(disabledAgain.changed).toBe(false)
  })

  test("ignores malformed records instead of guessing and overwrites them on the next toggle", async () => {
    const storage = memStorage(new Map([[publishStorageKey("project"), { version: 1, enabled: true }]]))
    expect(await readPublishRecord(storage, "project")).toBeUndefined()
    expect(await isPublishCapabilityAuthorized(storage, location, "session-1", "push")).toEqual({
      projectID: "project",
      authorized: false,
    })

    const toggled = await setPublicationEnabled(storage, location, "session-1", true, 42)
    expect(toggled.changed).toBe(true)
    expect((storage.values.get(publishStorageKey("project")) as PublishRecord).capabilities).toEqual([...PUBLISH_CAPABILITIES])
  })

  test("authorization stays keyed to the stable origin project across a session move", async () => {
    // A session whose durable anchor records a different origin keeps the
    // publication policy under the origin project, never the current one.
    const sessionID = "moved-session"
    const anchorKey = `session/v1/project/${sessionID}`
    const storage = memStorage(
      new Map([
        [anchorKey, {
          version: 1,
          sessionID,
          originProjectID: "origin",
          originDirectory: "/origin",
          currentProjectID: "project",
          currentDirectory: "/workspace",
          updatedAt: 1,
        }],
      ]),
    )

    const toggled = await setPublicationEnabled(storage, location, sessionID, true, 1000)
    expect(toggled.record.projectID).toBe("origin")
    expect(storage.values.has(publishStorageKey("origin"))).toBe(true)
    expect(storage.values.has(publishStorageKey("project"))).toBe(false)

    const checked = await isPublishCapabilityAuthorized(storage, location, sessionID, "push")
    expect(checked).toEqual({ projectID: "origin", authorized: true })
    // The same capability is NOT authorized under the current project key.
    expect(await isPublishCapabilityAuthorized(storage, { ...location, project: { id: "other" } }, sessionID, "push")).toEqual({
      projectID: "other",
      authorized: false,
    })
  })

  test("isPublishCapabilityAuthorized grants exactly the recorded capabilities per project", async () => {
    const storage = memStorage()
    await setPublicationEnabled(storage, location, "session-1", true, 1000)
    for (const capability of PUBLISH_CAPABILITIES) {
      expect((await isPublishCapabilityAuthorized(storage, location, "session-1", capability)).authorized).toBe(true)
    }
    // A record under another project cannot authorize a session in this one.
    const other = memStorage(new Map([[publishStorageKey("other-project"), {
      version: 1,
      projectID: "other-project",
      enabled: true,
      capabilities: [...PUBLISH_CAPABILITIES],
      updatedAt: 1,
      updatedBy: "session-x",
    }]]))
    expect(await isPublishCapabilityAuthorized(other, location, "session-1", "push")).toEqual({
      projectID: "project",
      authorized: false,
    })
  })

  test("publicationStatus reports durable policy, config switch, and static gates", async () => {
    const options = parseOptions({
      publish: { enabled: true },
      github: { enabled: true, allow_mutations: false },
      worktree: { enabled: true, allow_mutations: true },
    })
    const absent = await publicationStatus(memStorage(), location, "session-1", options)
    expect(absent.version).toBe(1)
    expect(absent.projectID).toBe("project")
    expect(absent.durable).toEqual({ enabled: false, capabilities: [] })
    expect(absent.config).toEqual({ enabled: true })
    expect(absent.staticGates).toEqual({
      githubEnabled: true,
      githubAllowMutations: false,
      worktreeEnabled: true,
      worktreeAllowMutations: true,
    })

    const storage = memStorage()
    await setPublicationEnabled(storage, location, "session-1", true, 500)
    const enabled = await publicationStatus(storage, location, "session-1", options)
    expect(enabled.durable.enabled).toBe(true)
    expect(enabled.durable.capabilities).toEqual([...PUBLISH_CAPABILITIES])
    expect(enabled.durable.updatedBy).toBe("session-1")
    expect(enabled.durable.updatedAt).toBe(500)
  })
})

describe("publish tools", () => {
  test("registers publish_policy_get with the shared publish permission action", () => {
    const { tools } = collectPublishTools()
    expect([...tools.keys()]).toEqual(["publish_policy_get"])
    const tool = tools.get("publish_policy_get")!
    expect(tool.options?.namespace).toBe("orchestrator")
    expect(tool.options?.permission).toBe(PUBLISH_TOOL_PERMISSION)
  })

  test("gates the policy tool to the orchestrator agent", async () => {
    const { tools } = collectPublishTools()
    await expect(tools.get("publish_policy_get")!.execute({}, toolContext("session-1", "explore"))).rejects.toThrow(
      /only to the orchestrator/,
    )
  })

  test("returns the durable policy, config switch, static gates, and limitations without mutating storage", async () => {
    const storage = memStorage()
    const { tools, values } = collectPublishTools(storage.values)
    await setPublicationEnabled(storage, location, "session-1", true, 1000)

    const output = await tools.get("publish_policy_get")!.execute({}, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as Record<string, unknown>
    expect(parsed.version).toBe(1)
    expect((parsed.projectID as string)).toBe("project")
    expect((parsed.durable as { enabled: boolean }).enabled).toBe(true)
    expect(parsed.config).toEqual({ enabled: true })
    expect((parsed.staticGates as { githubEnabled: boolean }).githubEnabled).toBe(false)
    expect((parsed.limitations as string[]).join(" ")).toContain("not caller authentication")
    expect((parsed.limitations as string[]).join(" ")).toContain("never authorizes issue creation or PR merge")

    // Read-only: no storage keys changed or added by the call.
    expect(values.size).toBe(1)
    expect(values.has(publishStorageKey("project"))).toBe(true)
  })
})

function toolContext(sessionID: string, agent: string): { sessionID: string; agent: string } {
  return { sessionID, agent }
}

function collectPublishTools(
  values = new Map<string, unknown>(),
): { tools: Map<string, ToolLike>; values: Map<string, unknown> } {
  const tools = new Map<string, ToolLike>()
  addPublishTools(
    {
      add(tool) {
        tools.set(tool.name, tool as ToolLike)
      },
    },
    {
      storage: memStorage(values),
      location,
      options: parseOptions({ publish: { enabled: true } }),
    },
  )
  return { tools, values }
}

function memStorage(values = new Map<string, unknown>()): StorageLike & { values: Map<string, unknown> } {
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  }
}