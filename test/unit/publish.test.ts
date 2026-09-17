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
import {
  PR_CREATE_REPLAY_KIND,
  PR_MERGE_REPLAY_KIND,
  parsePrReplayDescriptor,
  prCreateIdempotencyKey,
  reconcilePrCreate,
  reconcilePrMerge,
  recordPrCreateResult,
  recordPrMergeResult,
  replayStorageKey,
  type PrReconcileRemote,
  type ReconcilePullInfo,
} from "../../src/opencode-v2/publish/reconcile.js"

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
    expect((parsed.limitations as string[]).join(" ")).toContain("never authorizes issue creation")

    // Read-only: no storage keys changed or added by the call.
    expect(values.size).toBe(1)
    expect(values.has(publishStorageKey("project"))).toBe(true)
  })
})

describe("publish replay reconciliation", () => {
  const HEAD = "a".repeat(40)
  const BASE = "b".repeat(40)
  const OTHER = "c".repeat(40)

  function pull(overrides: Partial<ReconcilePullInfo> = {}): ReconcilePullInfo {
    return {
      id: 1,
      number: 7,
      html_url: "https://github.com/o/r/pull/7",
      state: "open",
      merged: false,
      head: { ref: "feat", sha: HEAD },
      base: { ref: "main", sha: BASE },
      draft: true,
      ...overrides,
    }
  }

  function fakeRemote(input: {
    pulls?: ReconcilePullInfo[]
    listFails?: boolean
    view?: ReconcilePullInfo
    viewFails?: boolean
  }): { remote: PrReconcileRemote; listCalls: () => number; viewCalls: () => number } {
    let listCalls = 0
    let viewCalls = 0
    return {
      remote: {
        listOpenPulls: async () => {
          listCalls += 1
          return input.listFails ? undefined : input.pulls ?? []
        },
        viewPull: async () => {
          viewCalls += 1
          return input.viewFails ? undefined : input.view
        },
      },
      listCalls: () => listCalls,
      viewCalls: () => viewCalls,
    }
  }

  function createInput(remote: PrReconcileRemote, values = new Map<string, unknown>()) {
    return {
      input: {
        storage: memStorage(values),
        location,
        sessionID: "session-1",
        remote,
        repository: "o/r",
        headRef: "feat",
        baseRef: "main",
        expectedHeadSHA: HEAD,
        expectedBaseSHA: BASE,
        taskID: "t1",
        now: 100,
      },
      values,
    }
  }

  test("keys are deterministic and descriptors are strict and bounded", () => {
    const first = prCreateIdempotencyKey({ repository: "o/r", headRef: "feat", baseRef: "main", expectedHeadSHA: HEAD })
    expect(first).toBe(prCreateIdempotencyKey({ repository: "o/r", headRef: "feat", baseRef: "main", expectedHeadSHA: HEAD }))
    expect(first).not.toBe(prCreateIdempotencyKey({ repository: "o/r", headRef: "feat", baseRef: "main", expectedHeadSHA: OTHER }))
    expect(replayStorageKey("project", "session-1", PR_CREATE_REPLAY_KIND, first)).toContain("publish-replay/v1/project/session-1/github-pr-create/")
    expect(parsePrReplayDescriptor({ kind: PR_CREATE_REPLAY_KIND })).toBeUndefined()
    expect(
      parsePrReplayDescriptor({
        version: 1,
        kind: PR_CREATE_REPLAY_KIND,
        projectID: "project",
        sessionID: "s",
        taskID: "t1",
        idempotencyKey: "k",
        repository: "o/r",
        headRef: "feat",
        baseRef: "main",
        expectedHeadSHA: "not-a-sha",
        expectedBaseSHA: BASE,
        state: "pending",
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toBeUndefined()
  })

  test("PR create persists a pending descriptor before any mutation and proceeds only after that write", async () => {
    const remote = fakeRemote({})
    const { input, values } = createInput(remote.remote)
    const result = await reconcilePrCreate(input)
    expect(result.status).toBe("proceed")
    const stored = [...values.values()].find((value) => (value as { kind?: string }).kind === PR_CREATE_REPLAY_KIND) as { state: string }
    expect(stored.state).toBe("pending")

    // A descriptor write failure refuses the mutation outright.
    const failing = memStorage()
    failing.set = async () => {
      throw new Error("storage down")
    }
    const failed = await reconcilePrCreate({ ...input, storage: failing })
    expect(failed).toEqual({ status: "failed", reason: "descriptor-persist-failed" })
  })

  test("PR create adopts an exact open-PR match with zero second POST and blocks a wrong revision", async () => {
    const { input, values } = createInput(fakeRemote({}).remote)
    await reconcilePrCreate(input) // persists pending

    const exact = fakeRemote({ pulls: [pull()] })
    const adopted = await reconcilePrCreate({ ...input, remote: exact.remote })
    expect(adopted.status).toBe("adopted")
    if (adopted.status === "adopted") {
      expect(adopted.reason).toBe("open-pr-match")
      expect(adopted.pull.number).toBe(7)
    }
    const stored = [...values.values()].find((value) => (value as { kind?: string }).kind === PR_CREATE_REPLAY_KIND) as { state: string; prNumber?: number }
    expect(stored.state).toBe("adopted")
    expect(stored.prNumber).toBe(7)

    // Adopted descriptor verifies through a fresh view, never a POST.
    const verifiedRemote = fakeRemote({ view: pull() })
    const verified = await reconcilePrCreate({ ...input, remote: verifiedRemote.remote })
    expect(verified.status).toBe("adopted")
    if (verified.status === "adopted") expect(verified.reason).toBe("descriptor-verified")
    expect(verifiedRemote.listCalls()).toBe(0)

    // Same refs, different SHA: blocked, never adopted.
    const { input: wrongInput, values: wrongValues } = createInput(fakeRemote({}).remote)
    await reconcilePrCreate(wrongInput)
    const wrong = await reconcilePrCreate({ ...wrongInput, remote: fakeRemote({ pulls: [pull({ head: { ref: "feat", sha: OTHER } })] }).remote })
    expect(wrong).toEqual(expect.objectContaining({ status: "blocked", reason: "same-refs-different-sha" }))
    expect([...wrongValues.keys()].some((key) => key.includes("github-pr-create"))).toBe(true)
  })

  test("PR create stays ambiguous on absence or an unreadable list and fails closed on incomplete data", async () => {
    const { input } = createInput(fakeRemote({}).remote)
    await reconcilePrCreate(input)
    expect((await reconcilePrCreate({ ...input, remote: fakeRemote({ pulls: [] }).remote })).status).toBe("ambiguous")
    expect((await reconcilePrCreate({ ...input, remote: fakeRemote({ listFails: true }).remote })).status).toBe("ambiguous")
    const incomplete = await reconcilePrCreate({
      ...input,
      remote: fakeRemote({ pulls: [pull({ head: { ref: "feat", sha: undefined as unknown as string } })] }).remote,
    })
    expect(incomplete).toEqual(expect.objectContaining({ status: "blocked", reason: "incomplete-pr-data" }))
    const multiple = await reconcilePrCreate({ ...input, remote: fakeRemote({ pulls: [pull(), pull({ number: 8 })] }).remote })
    expect(multiple).toEqual(expect.objectContaining({ status: "ambiguous", reason: "multiple-matching-prs" }))
  })

  test("PR create records the created result and the lost-response ambiguity", async () => {
    const remote = fakeRemote({})
    const { input, values } = createInput(remote.remote)
    const proceeded = await reconcilePrCreate(input)
    if (proceeded.status !== "proceed") throw new Error("expected proceed")
    await recordPrCreateResult(input.storage, proceeded.descriptor, { status: "created", prNumber: 9, prURL: "https://github.com/o/r/pull/9" })
    let stored = [...values.values()].find((value) => (value as { kind?: string }).kind === PR_CREATE_REPLAY_KIND) as { state: string; prNumber?: number }
    expect(stored.state).toBe("adopted")
    expect(stored.prNumber).toBe(9)

    const { input: lostInput, values: lostValues } = createInput(fakeRemote({}).remote)
    const lostProceeded = await reconcilePrCreate(lostInput)
    if (lostProceeded.status !== "proceed") throw new Error("expected proceed")
    await recordPrCreateResult(lostInput.storage, lostProceeded.descriptor, { status: "lost-response" })
    stored = [...lostValues.values()].find((value) => (value as { kind?: string }).kind === PR_CREATE_REPLAY_KIND) as { state: string }
    expect(stored.state).toBe("ambiguous")
  })

  test("PR merge adopts merged:true with zero second PUT and re-evaluates a still-open exact revision", async () => {
    const remote = fakeRemote({})
    const { input, values } = createInput(remote.remote)
    const mergeInput = {
      storage: input.storage,
      location,
      sessionID: "session-1",
      remote: remote.remote,
      repository: "o/r",
      prNumber: 7,
      expectedHeadSHA: HEAD,
      expectedBaseSHA: BASE,
      taskID: "t1",
      now: 100,
    }
    const proceed = await reconcilePrMerge(mergeInput)
    expect(proceed.status).toBe("proceed")

    const mergedView = fakeRemote({ view: pull({ merged: true, state: "closed" }) })
    const adopted = await reconcilePrMerge({ ...mergeInput, remote: mergedView.remote })
    expect(adopted.status).toBe("adopted")
    if (adopted.status === "adopted") {
      expect(adopted.pull.merged).toBe(true)
      expect(adopted.mergeSHA).toBeUndefined()
    }
    const stored = [...values.values()].find((value) => (value as { kind?: string }).kind === PR_MERGE_REPLAY_KIND) as { state: string }
    expect(stored.state).toBe("merged")

    // A still-open PR at the exact expected revision proceeds to full
    // precondition re-evaluation (explicit lead recovery), never a blind PUT.
    const { input: openInput } = createInput(fakeRemote({ view: pull() }).remote)
    const openMergeInput = { ...mergeInput, storage: openInput.storage, remote: openInput.remote }
    expect((await reconcilePrMerge(openMergeInput)).status).toBe("proceed")
    expect((await reconcilePrMerge(openMergeInput)).status).toBe("proceed")
  })

  test("PR merge blocks moved revisions and unreadable views and records the merged SHA", async () => {
    const { input, values } = createInput(fakeRemote({}).remote)
    const mergeInput = {
      storage: input.storage,
      location,
      sessionID: "session-1",
      remote: input.remote,
      repository: "o/r",
      prNumber: 7,
      expectedHeadSHA: HEAD,
      expectedBaseSHA: BASE,
      taskID: "t1",
      now: 100,
    }
    const proceed = await reconcilePrMerge(mergeInput)
    if (proceed.status !== "proceed") throw new Error("expected proceed")
    expect((await reconcilePrMerge({ ...mergeInput, remote: fakeRemote({ viewFails: true }).remote })).status).toBe("ambiguous")
    expect(
      (await reconcilePrMerge({ ...mergeInput, remote: fakeRemote({ view: pull({ head: { ref: "feat", sha: OTHER } }) }).remote })),
    ).toEqual(expect.objectContaining({ status: "blocked", reason: "head-moved" }))
    expect(
      (await reconcilePrMerge({ ...mergeInput, remote: fakeRemote({ view: pull({ state: "closed" }) }).remote })),
    ).toEqual(expect.objectContaining({ status: "blocked", reason: "not-open" }))

    await recordPrMergeResult(input.storage, proceed.descriptor, { status: "merged", mergeSHA: HEAD })
    const stored = [...values.values()].find((value) => (value as { kind?: string }).kind === PR_MERGE_REPLAY_KIND) as { state: string; mergeSHA?: string }
    expect(stored.state).toBe("merged")
    expect(stored.mergeSHA).toBe(HEAD)
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