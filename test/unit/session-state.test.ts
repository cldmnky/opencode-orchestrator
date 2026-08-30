import { describe, expect, test } from "bun:test"
import { parseOptions, type OrchestratorOptions } from "../../src/core/config.js"
import {
  GH_TOOL_PERMISSION,
  OBSERVABILITY_TOOL_PERMISSION,
  ORCHESTRATION_TOOL_PERMISSION,
  WORKTREE_TOOL_PERMISSION,
  orchestratorOnlyPermissionRule,
  orchestratorOnlyPermissionRules,
} from "../../src/core/permissions.js"
import {
  inferOriginProjectID,
  moveSessionAnchor,
  newSessionAnchor,
  newWorktree,
  readSessionAnchor,
  readWorktree,
  sessionAnchorStorageKey,
  type SessionAnchor,
  type StorageLike,
  worktreeStorageKey,
  writeSessionAnchor,
  writeWorktree,
} from "../../src/opencode-v2/session/state.js"

function memStorage(initial?: Record<string, unknown>): StorageLike & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>(Object.entries(initial ?? {}))
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  }
}

function anchor(
  overrides: Partial<SessionAnchor> = {},
  now = 1000,
): SessionAnchor {
  return {
    version: 1,
    sessionID: "session-1",
    originProjectID: "origin",
    originDirectory: "/origin/dir",
    currentProjectID: "origin",
    currentDirectory: "/origin/dir",
    updatedAt: now,
    ...overrides,
  }
}

describe("configuration feature policy", () => {
  test("github and worktree default to disabled with no mutations and no root", () => {
    const options: OrchestratorOptions = parseOptions({})
    expect(options.github).toEqual({ enabled: false, allow_mutations: false })
    expect(options.worktree).toEqual({ enabled: false, allow_mutations: false, root: null })
  })

  test("accepts opt-in feature config and preserves fields", () => {
    const options = parseOptions({
      github: { enabled: true, allow_mutations: true },
      worktree: { enabled: true, allow_mutations: true, root: "/srv/worktrees" },
      max_parallel: 5,
    })
    expect(options.github).toEqual({ enabled: true, allow_mutations: true })
    expect(options.worktree).toEqual({ enabled: true, allow_mutations: true, root: "/srv/worktrees" })
    expect(options.max_parallel).toBe(5)
  })

  test("partial config fills defaults per feature", () => {
    const options = parseOptions({ github: { enabled: true }, worktree: { root: "/wt" } })
    expect(options.github).toEqual({ enabled: true, allow_mutations: false })
    expect(options.worktree).toEqual({ enabled: false, allow_mutations: false, root: "/wt" })
  })

  test("accepts an explicit null root", () => {
    const options = parseOptions({ worktree: { root: null } })
    expect(options.worktree.root).toBe(null)
  })

  test("rejects a non-null invalid worktree root", () => {
    for (const root of ["relative/path", "./wt", "C:\\wt", "wt", 42, true, "/with\0nul"]) {
      expect(() => parseOptions({ worktree: { root } }), `root=${String(root)}`).toThrow()
    }
  })
})

describe("permission constants", () => {
  test("exports goal-style orchestrator-only actions for gh/worktree/validation without dead cd actions", () => {
    expect(GH_TOOL_PERMISSION).toBe("orchestrator_gh")
    expect(WORKTREE_TOOL_PERMISSION).toBe("orchestrator_worktree")
    expect(ORCHESTRATION_TOOL_PERMISSION).toBe("orchestrator_validation")
    expect(OBSERVABILITY_TOOL_PERMISSION).toBe("orchestrator_observability")
  })

  test("builds an orchestrator-only deny rule over the whole feature family incl. orchestration validation and observability", () => {
    const rule = orchestratorOnlyPermissionRule("deny")
    expect(rule.resource).toBe("*")
    expect(rule.effect).toBe("deny")
    for (const action of [
      GH_TOOL_PERMISSION,
      WORKTREE_TOOL_PERMISSION,
      ORCHESTRATION_TOOL_PERMISSION,
      OBSERVABILITY_TOOL_PERMISSION,
    ]) {
      expect(rule.action).toContain(action)
    }
    // The legacy /cd and session-move actions are no longer emitted.
    expect(rule.action).not.toContain("orchestrator_cd")
    expect(rule.action).not.toContain("orchestrator_session_move")
  })

  test("each family has its own permission rule in the modern rules helper", () => {
    const rules = orchestratorOnlyPermissionRules("deny")
    expect(rules.map((rule) => rule.action)).toEqual([
      GH_TOOL_PERMISSION,
      WORKTREE_TOOL_PERMISSION,
      ORCHESTRATION_TOOL_PERMISSION,
      OBSERVABILITY_TOOL_PERMISSION,
    ])
  })
})

describe("session anchors", () => {
  test("uses stable project-anchored keys for anchors and origin-anchored keys for worktrees", () => {
    expect(sessionAnchorStorageKey("proj/one", "sess/1")).toBe(`session/v1/proj%2Fone/sess%2F1`)
    expect(worktreeStorageKey("proj/one", "sess/1")).toBe(`worktree/v1/proj%2Fone/sess%2F1`)
  })

  test("writes and reads back a strict anchor under the current project key", async () => {
    const storage = memStorage()
    const record = anchor()
    const written = await writeSessionAnchor(storage, record, 2000)
    expect(written.updatedAt).toBe(2000)
    expect(storage.values.has(`session/v1/origin/session-1`)).toBe(true)

    const read = await readSessionAnchor(storage, "origin", "session-1")
    expect(read?.originProjectID).toBe("origin")
    expect(read?.currentProjectID).toBe("origin")
    expect(read?.sessionID).toBe("session-1")
  })

  test("move preserves the stable origin and rekeys to the new project", async () => {
    const storage = memStorage()
    await writeSessionAnchor(storage, anchor(), 1000)

    const moved = await moveSessionAnchor(storage, "origin", "session-1", {
      projectID: "next",
      directory: "/next/dir",
      workspaceID: "ws-9",
    })
    expect(moved?.originProjectID).toBe("origin")
    expect(moved?.originDirectory).toBe("/origin/dir")
    expect(moved?.currentProjectID).toBe("next")
    expect(moved?.currentDirectory).toBe("/next/dir")
    expect(moved?.workspaceID).toBe("ws-9")
    expect(moved?.status).toBe("moved")

    expect(storage.values.has(`session/v1/origin/session-1`)).toBe(false)
    expect(storage.values.has(`session/v1/next/session-1`)).toBe(true)

    const reread = await readSessionAnchor(storage, "next", "session-1")
    expect(reread?.originProjectID).toBe("origin")
    expect(reread?.currentProjectID).toBe("next")
  })

  test("move without an existing anchor returns undefined and writes nothing", async () => {
    const storage = memStorage()
    const moved = await moveSessionAnchor(storage, "nowhere", "ghost", {
      projectID: "next",
      directory: "/next",
    })
    expect(moved).toBeUndefined()
    expect(storage.values.size).toBe(0)
  })

  test("rewriting an anchor at its current key keeps the origin (project-key preservation)", async () => {
    const storage = memStorage()
    const first = await writeSessionAnchor(storage, anchor({ originProjectID: "origin" }), 1000)
    const second = await writeSessionAnchor(storage, { ...first, currentDirectory: "/changed" }, 2000)
    expect(second.originProjectID).toBe("origin")
    expect(second.currentDirectory).toBe("/changed")
    const read = await readSessionAnchor(storage, "origin", "session-1")
    expect(read?.originProjectID).toBe("origin")
  })

  test("ignores malformed anchor records instead of guessing", async () => {
    const storage = memStorage({
      [`session/v1/origin/session-1`]: { version: 1, sessionID: "session-1", notAField: true },
    })
    expect(await readSessionAnchor(storage, "origin", "session-1")).toBeUndefined()
  })

  test("migrates a pre-origin record by inferring the origin only when unique", async () => {
    const legacy = {
      sessionID: "session-1",
      currentProjectID: "only",
      currentDirectory: "/only/dir",
      updatedAt: 42,
    }
    const storage = memStorage({ [`session/v1/only/session-1`]: legacy })

    const migrated = await readSessionAnchor(storage, "only", "session-1", {
      candidates: ["only"],
    })
    expect(migrated?.originProjectID).toBe("only")
    expect(migrated?.originDirectory).toBe("/only/dir")
    expect(migrated?.version).toBe(1)

    // Same record with ambiguous candidates must NOT be migrated.
    const ambiguous = memStorage({ [`session/v1/only/session-1`]: legacy })
    expect(
      await readSessionAnchor(ambiguous, "only", "session-1", { candidates: ["only", "other"] }),
    ).toBeUndefined()
  })

  test("inferOriginProjectID returns the current project only when it is unique", () => {
    expect(inferOriginProjectID("p", ["p"])).toBe("p")
    expect(inferOriginProjectID("p", ["p", "q"])).toBeUndefined()
    expect(inferOriginProjectID("p", [])).toBeUndefined()
    expect(inferOriginProjectID("p", ["q"])).toBeUndefined()
  })
})

describe("worktree records", () => {
  test("writes and reads a strict worktree record under the origin-anchored key", async () => {
    const storage = memStorage()
    const record = newWorktree(
      {
        owner: "session-1",
        sessionID: "session-1",
        originProjectID: "origin",
        repositoryRoot: "/repo",
        directory: "/repo/.worktrees/feature",
        branch: "feature/x",
        base: "main",
      },
      1000,
    )
    expect(record.status).toBe("pending")

    const written = await writeWorktree(storage, record, 2000)
    expect(written.updatedAt).toBe(2000)
    expect(storage.values.has(`worktree/v1/origin/session-1`)).toBe(true)

    const read = await readWorktree(storage, "origin", "session-1")
    expect(read?.owner).toBe("session-1")
    expect(read?.branch).toBe("feature/x")
    expect(read?.base).toBe("main")
    expect(read?.originProjectID).toBe("origin")
  })

  test("worktree stays locatable from the origin project after a session move", async () => {
    const storage = memStorage()
    const record = newWorktree(
      {
        owner: "session-1",
        sessionID: "session-1",
        originProjectID: "origin",
        repositoryRoot: "/repo",
        directory: "/repo/.worktrees/feature",
        branch: "feature/x",
        base: "main",
      },
      1000,
    )
    await writeWorktree(storage, record, 1000)
    await writeSessionAnchor(storage, anchor(), 1000)
    await moveSessionAnchor(storage, "origin", "session-1", { projectID: "next", directory: "/next" })

    // The tree is still found under the origin project key despite the move.
    const read = await readWorktree(storage, "origin", "session-1")
    expect(read?.sessionID).toBe("session-1")
    expect(read?.originProjectID).toBe("origin")
  })

  test("ignores malformed worktree records", async () => {
    const storage = memStorage({ [`worktree/v1/origin/session-1`]: { version: 1, owner: "x" } })
    expect(await readWorktree(storage, "origin", "session-1")).toBeUndefined()
  })
})