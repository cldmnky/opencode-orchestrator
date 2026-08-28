import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { parseOptions } from "../../src/core/config.js"
import type { CommandInvocationLike } from "../../src/opencode-v2/commands/index.js"
import { runCommand } from "../../src/opencode-v2/commands/runtime.js"
import { goalStorageKey, stableProjectID } from "../../src/opencode-v2/goal/state.js"
import { moveSessionToDirectory, validateTarget, type MoveSessionDeps } from "../../src/opencode-v2/session/move.js"
import {
  newSessionAnchor,
  sessionAnchorStorageKey,
  type SessionAnchor,
} from "../../src/opencode-v2/session/state.js"
import {
  newWorktree,
  sessionIndexStorageKey,
  worktreeStorageKey,
  type SessionIndexRecord,
  type WorktreeRecord,
} from "../../src/opencode-v2/worktree/state.js"

type SessionState = {
  id: string
  projectID: string
  directory: string
  workspaceID?: string
}

function memStorage(initial: Map<string, unknown> = new Map()): {
  values: Map<string, unknown>
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
} {
  const values = initial
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  }
}

// Fake session that records every move and advances its own location, so the
// helper's re-read verification observes the moved session. The shape mirrors
// the real Session.Info (`id`, `projectID`, `location`). By default the
// project ID is preserved across moves (a /cd within the same repository
// keeps the project); tests pass `projectIDFor` to simulate moving outside
// the project, which is what the real server derives from the new directory.
function sessionFixture(
  initial: SessionState,
  projectIDFor?: (directory: string) => string,
): {
  state: () => SessionState
  moves: Array<Record<string, unknown>>
  get(input: { sessionID: string }): Promise<{ id: string; projectID: string; location: { directory: string; workspaceID?: string } }>
  move(input: Record<string, unknown>): Promise<void>
} {
  let current = { ...initial }
  const moves: Array<Record<string, unknown>> = []
  return {
    state: () => current,
    moves,
    get: async () => ({
      id: current.id,
      projectID: current.projectID,
      location: {
        directory: current.directory,
        ...(typeof current.workspaceID === "string" ? { workspaceID: current.workspaceID } : {}),
      },
    }),
    move: async (input) => {
      moves.push(input)
      const directory = String(input.directory)
      current = {
        id: initial.id,
        projectID: projectIDFor ? projectIDFor(directory) : current.projectID,
        directory,
        workspaceID: typeof input.workspaceID === "string" ? input.workspaceID : initial.workspaceID,
      }
    },
  }
}

function buildDeps(
  session: MoveSessionDeps["session"],
  storage: MoveSessionDeps["storage"],
  directory: string,
  projectID = "origin",
): MoveSessionDeps {
  return { session, storage, location: { directory, project: { id: projectID } } }
}

describe("session move helper", () => {
  test("preserves session ID and history, passes delivery, and updates durable state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-move-"))
    mkdirSync(join(directory, "app"))
    const storage = memStorage()
    const session = sessionFixture({
      id: "s1",
      projectID: "origin",
      directory,
      workspaceID: "ws-1",
    })

    const outcome = await moveSessionToDirectory(buildDeps(session, storage, directory), {
      sessionID: "s1",
      target: "app",
      delivery: "queue",
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Identity and history: the same session ID survives; `session.move` was
    // told where to go with the workspace carried over and the delivery kept.
    expect(outcome.session.id).toBe("s1")
    expect(session.moves).toEqual([
      { sessionID: "s1", directory: resolve(directory, "app"), workspaceID: "ws-1", delivery: "queue" },
    ])

    // Durable state: a fresh anchor is written at (preserved) current project
    // with the origin preserved, the worktree session index advances, and any
    // tracked worktree owned by the session is marked moved. The move stays
    // in the same project (a /cd within the same repository), so the anchor
    // key is unchanged and the record is updated in place.
    const anchor = storage.values.get(sessionAnchorStorageKey("origin", "s1")) as SessionAnchor | undefined
    expect(anchor?.originProjectID).toBe("origin")
    expect(anchor?.originDirectory).toBe(directory)
    expect(anchor?.currentProjectID).toBe("origin")
    expect(anchor?.currentDirectory).toBe(resolve(directory, "app"))
    expect(anchor?.workspaceID).toBe("ws-1")
    // A freshly written anchor (no prior record) stays "active", matching the
    // event-sync backstop; an *existing* anchor is marked "moved".
    expect(anchor?.status).toBe("active")
    const index = storage.values.get(sessionIndexStorageKey("s1")) as SessionIndexRecord | undefined
    expect(index?.projectID).toBe("origin")
    expect(index?.originProjectID).toBe("origin")

    // Goal/run/halt keys stay keyed to the stable origin project.
    expect(goalStorageKey({ directory, project: { id: "origin" } }, "s1")).toBe(`goal/v1/origin/s1`)
    expect(await stableProjectID(storage, { directory, project: { id: "origin" } }, "s1")).toBe("origin")
  })

  test("relocates an existing anchor preserving the origin and marks the worktree moved", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-move-"))
    mkdirSync(join(directory, "app"))
    const storage = memStorage()
    storage.values.set(
      sessionAnchorStorageKey("current", "s1"),
      newSessionAnchor({
        sessionID: "s1",
        originProjectID: "origin",
        originDirectory: "/origin/dir",
        currentProjectID: "current",
        currentDirectory: directory,
      }),
    )
    storage.values.set(sessionIndexStorageKey("s1"), {
      version: 1,
      sessionID: "s1",
      projectID: "current",
      originProjectID: "origin",
      directory,
      updatedAt: 1,
    })
    storage.values.set(
      worktreeStorageKey("origin", "s1"),
      newWorktree(
        {
          owner: "s1",
          sessionID: "s1",
          originProjectID: "origin",
          repoRoot: "/repo",
          dir: "/srv/worktrees/feature",
          branch: "feature",
          base: "main",
        },
        1,
      ),
    )

    const session = sessionFixture({ id: "s1", projectID: "current", directory }, () => "next-project")
    const outcome = await moveSessionToDirectory(buildDeps(session, storage, directory), {
      sessionID: "s1",
      target: "app",
      delivery: "queue",
    })

    expect(outcome.ok).toBe(true)
    // Old key removed, new key carries the stable origin, status moved.
    expect(storage.values.has(sessionAnchorStorageKey("current", "s1"))).toBe(false)
    const anchor = storage.values.get(sessionAnchorStorageKey("next-project", "s1")) as SessionAnchor | undefined
    expect(anchor?.originProjectID).toBe("origin")
    expect(anchor?.originDirectory).toBe("/origin/dir")
    expect(anchor?.status).toBe("moved")
    const worktree = storage.values.get(worktreeStorageKey("origin", "s1")) as WorktreeRecord | undefined
    expect(worktree?.status).toBe("moved")
  })

  test("rewrites the anchor in place when the move stays in the same project", async () => {
    // A /cd within the same repository keeps the project ID; the anchor must
    // be updated at its existing key (not set-then-removed like a relocation).
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-move-"))
    mkdirSync(join(directory, "app"))
    const storage = memStorage()
    storage.values.set(
      sessionAnchorStorageKey("origin", "s1"),
      newSessionAnchor({
        sessionID: "s1",
        originProjectID: "origin",
        originDirectory: directory,
        currentProjectID: "origin",
        currentDirectory: directory,
      }),
    )
    const session = sessionFixture({ id: "s1", projectID: "origin", directory })

    const outcome = await moveSessionToDirectory(buildDeps(session, storage, directory), {
      sessionID: "s1",
      target: "app",
    })

    expect(outcome.ok).toBe(true)
    const anchor = storage.values.get(sessionAnchorStorageKey("origin", "s1")) as SessionAnchor | undefined
    expect(anchor?.sessionID).toBe("s1")
    expect(anchor?.originProjectID).toBe("origin")
    expect(anchor?.currentProjectID).toBe("origin")
    expect(anchor?.currentDirectory).toBe(resolve(directory, "app"))
    expect(anchor?.status).toBe("moved")
  })

  test("rejects NUL bytes, flags, and shell metacharacters", () => {
    expect(validateTarget("a\0b")).toMatch(/NUL/)
    expect(validateTarget("")).toMatch(/empty/)
    expect(validateTarget("-flag")).toMatch(/flag/)
    for (const bad of ["a;b", "a&b", "a|b", "a<b", "a>b", "a$(x)", "a`x`", "a'b", "a\"b", "a(b)", "a{b}", "a*b", "a?b", "a#b", "a!b", "a\\b", "a\nb"]) {
      expect(validateTarget(bad), `target=${bad}`).toMatch(/shell metacharacter/)
    }
    expect(validateTarget("normal/path with spaces")).toBeUndefined()
  })

  test("rejects a target that does not exist or is not a directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-move-"))
    const file = join(directory, "file.txt")
    writeFileSync(file, "x")
    const storage = memStorage()
    const session = sessionFixture({ id: "s1", projectID: "origin", directory })

    const missing = await moveSessionToDirectory(buildDeps(session, storage, directory), {
      sessionID: "s1",
      target: "does-not-exist",
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toContain("does not exist")

    const notDir = await moveSessionToDirectory(buildDeps(session, storage, directory), {
      sessionID: "s1",
      target: "file.txt",
    })
    expect(notDir.ok).toBe(false)
    if (!notDir.ok) expect(notDir.reason).toContain("not a directory")
    expect(session.moves).toHaveLength(0)
  })

  test("surfaces session.move failures with redacted messages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-move-"))
    mkdirSync(join(directory, "app"))
    const session = sessionFixture({ id: "s1", projectID: "origin", directory })
    const failing: MoveSessionDeps["session"] = {
      get: session.get,
      move: async () => {
        throw new Error("boom client_secret=leaked-value")
      },
    }
    const outcome = await moveSessionToDirectory(buildDeps(failing, memStorage(), directory), {
      sessionID: "s1",
      target: "app",
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain("session move failed")
      expect(outcome.reason).not.toContain("leaked-value")
      // The keyed secret value must be redacted even though the key stays.
      expect(outcome.reason).toMatch(/client_secret=\[redacted\]/)
    }
  })

  test("verifies the re-read session matches the target before touching durable state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-move-"))
    mkdirSync(join(directory, "app"))
    const storage = memStorage()
    // The fake responds to `get` with a location that never matches the move.
    const session = sessionFixture({ id: "s1", projectID: "origin", directory })
    // The first read (before) reports the real location; every later read
    // reports a directory that never matches the move target, so the
    // post-move verification fails before any durable state is written.
    let reads = 0
    const rogue: MoveSessionDeps["session"] = {
      get: async () => {
        reads += 1
        if (reads > 1) return { ...session.state(), location: { directory: "/somewhere-else" } }
        return session.get({ sessionID: "s1" })
      },
      move: session.move,
    }
    const outcome = await moveSessionToDirectory(buildDeps(rogue, storage, directory), {
      sessionID: "s1",
      target: "app",
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("verification failed")
    expect(storage.values.size).toBe(0)
  })
})

describe("cd command", () => {
  test("moves the session through the command handler and reports continuity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-cd-"))
    mkdirSync(join(directory, "app"))
    const fixture = cdFixture({ id: "session", projectID: "origin", directory, workspaceID: "ws-1" })

    await runCommand(fixture.context, parseOptions({}), "cd", invocation("app"), undefined)

    expect(fixture.moves).toEqual([
      { sessionID: "session", directory: resolve(directory, "app"), workspaceID: "ws-1", delivery: "queue" },
    ])
    expect(fixture.statuses[0]).toContain("Session moved to")
    expect(fixture.statuses[0]).toContain("history preserved")
    expect(fixture.statuses[0]).toContain(resolve(directory, "app"))
    expect(fixture.prompts).toHaveLength(0)
    // Durable anchor was written for the moved session (same project for a
    // subdirectory move), preserving the origin.
    const anchor = fixture.values.get(sessionAnchorStorageKey("origin", "session")) as SessionAnchor | undefined
    expect(anchor?.originProjectID).toBe("origin")
    expect(anchor?.currentDirectory).toBe(resolve(directory, "app"))
    // Fresh anchor for a previously untracked session stays "active".
    expect(anchor?.status).toBe("active")
  })

  test("rejects invalid targets without moving and keeps the session location", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-cd-"))
    const fixture = cdFixture({ id: "session", projectID: "origin", directory })

    await runCommand(fixture.context, parseOptions({}), "cd", invocation("-flag"), undefined)
    await runCommand(fixture.context, parseOptions({}), "cd", invocation("missing-dir"), undefined)

    expect(fixture.moves).toHaveLength(0)
    expect(fixture.statuses[0]).toContain("rejected")
    expect(fixture.statuses[0]).toContain("flag")
    expect(fixture.statuses[1]).toContain("rejected")
    expect(fixture.statuses[1]).toContain("does not exist")
    expect(fixture.state.directory).toBe(directory)
  })
})

function invocation(text: string): CommandInvocationLike {
  return { sessionID: "session", prompt: { text }, delivery: "queue" } as CommandInvocationLike
}

function cdFixture(initial: { id: string; projectID: string; directory: string; workspaceID?: string }) {
  const values = new Map<string, unknown>()
  const session = sessionFixture(initial)
  const statuses: string[] = []
  const prompts: Array<Record<string, unknown>> = []
  const context = {
    location: { directory: initial.directory, project: { id: "origin" } },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => void values.set(key, value),
      remove: async (key: string) => void values.delete(key),
    },
    agent: {
      get: async () => ({ model: { id: "model", providerID: "provider" } }),
    },
    session: {
      get: session.get,
      move: session.move,
      context: async () => [],
      prompt: async (input: Record<string, unknown>) => void prompts.push(input),
      synthetic: async (input: { text: string }) => void statuses.push(input.text),
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
    },
    vcs: {
      status: async () => [],
      diff: async () => [],
    },
  } as unknown as Context & { values: Map<string, unknown> }
  return { context, values, statuses, prompts, moves: session.moves, state: session.state() }
}