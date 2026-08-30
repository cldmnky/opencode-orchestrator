import path from "node:path"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { parseOptions, type OrchestratorOptions } from "../../src/core/config.js"
import { WORKTREE_TOOL_PERMISSION } from "../../src/core/permissions.js"
import type { ProcessResult, ProcessRunner } from "../../src/opencode-v2/process/runner.js"
import {
  gitLsRemote,
  gitPush,
  gitRevParse,
  gitStatus,
  gitWorktreeAdd,
  gitWorktreeList,
  gitWorktreeRemove,
  isPathInside,
  isValidBranchName,
  parseWorktreeList,
  resolveRealpath,
  validateWorktreeCreate,
  type WorktreeEntry,
} from "../../src/opencode-v2/worktree/git.js"
import {
  listWorktrees,
  newWorktree,
  readSessionIndex,
  readWorktree,
  sessionIndexStorageKey,
  worktreeStorageKey,
  writeWorktree,
  type SessionIndexRecord,
  type StorageLike,
  type WorktreeRecord,
} from "../../src/opencode-v2/worktree/state.js"
import { addWorktreeTools } from "../../src/opencode-v2/worktree/tools.js"
import { startWorktreeEventSync } from "../../src/opencode-v2/worktree/events.js"
import { sessionAnchorStorageKey, type SessionAnchor } from "../../src/opencode-v2/session/state.js"

const location = { directory: "/workspace", project: { id: "origin" } }

type SymlinkFixture = {
  base: string
  real: string
  link: string
  cleanup(): Promise<void>
}

/**
 * Throwaway temp fixture with a real directory symlink, for the `/tmp` vs
 * `/private/tmp` alias regressions. Returns `undefined` where symlink
 * creation is unavailable (e.g. unprivileged Windows); callers treat that as
 * a skip. Always cleaned via `cleanup()`.
 */
async function createSymlinkFixture(): Promise<SymlinkFixture | undefined> {
  const base = await mkdtemp(path.join(tmpdir(), "worktree-alias-"))
  const real = path.join(base, "real")
  await mkdir(real)
  const link = path.join(base, "link")
  try {
    await symlink(real, link, "dir")
  } catch {
    await rm(base, { recursive: true, force: true })
    return undefined
  }
  return { base, real, link, cleanup: () => rm(base, { recursive: true, force: true }) }
}

type Call = { cmd: string; args: string[]; cwd?: string; timeoutMs?: number }

type ToolLike = {
  name: string
  options?: { namespace?: string; permission?: string }
  execute(input: unknown, tool: { sessionID: string; agent: string }): Promise<{ content: string }>
}

function ok(stdout = "", stderr = ""): ProcessResult {
  return { exitCode: 0, stdout, stderr }
}

function fail(stderr = "git: fatal error"): ProcessResult {
  return { exitCode: 1, stdout: "", stderr }
}

function scriptedGit(
  script: (call: Call, calls: Call[]) => ProcessResult | undefined,
): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = []
  const runner: ProcessRunner = {
    async run(cmd, args, opts) {
      const call: Call = { cmd, args: [...args], cwd: opts?.cwd, timeoutMs: opts?.timeoutMs }
      calls.push(call)
      const handled = script(call, calls)
      if (handled) return handled
      throw new Error(`unexpected git call: ${cmd} ${args.join(" ")}`)
    },
  }
  return { runner, calls }
}

const PORCELAIN = [
  "worktree /repo",
  "HEAD 0123456789abcdef0123456789abcdef01234567",
  "branch refs/heads/main",
  "",
  "worktree /srv/worktrees/feature",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/feature",
  "locked",
  "",
  "worktree /srv/worktrees/detached",
  "HEAD 2222222222222222222222222222222222222222",
  "detached",
  "prunable gitfile",
].join("\n")

const MAIN_ONLY = `worktree /repo\nHEAD 0123456789abcdef0123456789abcdef01234567\nbranch refs/heads/main`

function createSuccessScript(
  directory = "/srv/worktrees/feature",
  repoRoot = "/repo",
  branch = "feature",
  gitDir = "/repo/.git",
): (call: Call, calls: Call[]) => ProcessResult | undefined {
  let listCalls = 0
  let refChecks = 0
  return (call) => {
    switch (call.args[0]) {
      case "rev-parse": {
        const target = call.args[1]
        if (target === "--is-bare-repository") return ok("false")
        if (target === "--git-dir") return ok(gitDir)
        if (target === `refs/heads/${branch}`) {
          refChecks += 1
          return refChecks > 1 ? ok("f1c2dc0abc") : fail("unknown revision")
        }
        return undefined
      }
      case "worktree": {
        if (call.args[1] === "list") {
          listCalls += 1
          if (listCalls === 1) return ok(MAIN_ONLY)
          return ok(`${MAIN_ONLY}\n\nworktree ${directory}\nHEAD f1c2dc0abc\nbranch refs/heads/${branch}`)
        }
        if (call.args[1] === "add") return ok("")
        return undefined
      }
      default:
        return undefined
    }
  }
}

function seedRecord(values: Map<string, unknown>, overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  const record = newWorktree(
    {
      owner: "session-1",
      sessionID: "session-1",
      originProjectID: "origin",
      repoRoot: "/repo",
      dir: "/srv/worktrees/feature",
      branch: "feature",
      base: "main",
    },
    100,
  )
  const finalized: WorktreeRecord = { ...record, status: "ready", ...overrides }
  values.set(worktreeStorageKey("origin", "session-1"), finalized)
  return finalized
}

function memStorage(initial: Map<string, unknown> = new Map()): StorageLike & { values: Map<string, unknown> } {
  const values = initial
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    scan: async ({ prefix }) => {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value }))
      return { entries }
    },
  }
}

function wTreeOptions(overrides: Record<string, unknown> = {}): OrchestratorOptions {
  return parseOptions({ worktree: { enabled: true, allow_mutations: true, root: "/srv/worktrees" }, ...overrides })
}

function collectWorktreeTools(deps: {
  options?: OrchestratorOptions
  values?: Map<string, unknown>
  runner?: ProcessRunner
  pathExists?: (directory: string) => Promise<boolean>
} = {}): { tools: Map<string, ToolLike>; values: Map<string, unknown> } {
  const values = deps.values ?? new Map<string, unknown>()
  const storage = memStorage(values)
  const runner = deps.runner ?? scriptedGit(() => fail()).runner
  const tools = new Map<string, ToolLike>()
  addWorktreeTools(
    {
      add(tool) {
        tools.set(tool.name, tool as ToolLike)
      },
    },
    {
      storage,
      runner,
      location,
      options: deps.options ?? wTreeOptions(),
      pathExists: deps.pathExists,
      secrets: ["supersecret-token"],
    },
  )
  return { tools, values }
}

function toolContext(sessionID: string, agent: string): { sessionID: string; agent: string } {
  return { sessionID, agent }
}

async function waitFor(check: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for worktree condition")
}

function createEventStream(): AsyncIterable<unknown> & { push(value: unknown): void; closed: boolean } {
  const queue: unknown[] = []
  const waiters: Array<(result: IteratorResult<unknown>) => void> = []
  let closed = false
  const iterator = {
    next: () => {
      if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
      if (closed) return Promise.resolve({ done: true, value: undefined })
      return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve))
    },
    return: async () => {
      closed = true
      for (const resolve of waiters.splice(0)) resolve({ done: true, value: undefined })
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator]() {
      return this
    },
    push(value: unknown) {
      if (closed) return
      const resolve = waiters.shift()
      if (resolve) resolve({ done: false, value })
      else queue.push(value)
    },
    get closed() {
      return closed
    },
  }
  return iterator
}

describe("git worktree list porcelain parsing", () => {
  test("parses main, linked, detached, locked, and prunable entries", () => {
    const entries = parseWorktreeList(PORCELAIN)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({
      directory: "/repo",
      head: "0123456789abcdef0123456789abcdef01234567",
      branch: "refs/heads/main",
    })
    expect(entries[1]).toEqual({
      directory: "/srv/worktrees/feature",
      head: "1111111111111111111111111111111111111111",
      branch: "refs/heads/feature",
      locked: true,
    })
    expect(entries[2]).toEqual({
      directory: "/srv/worktrees/detached",
      head: "2222222222222222222222222222222222222222",
      detached: true,
      prunable: true,
    })
    expect(entries[2]?.branch).toBeUndefined()
  })

  test("gitWorktreeList returns the parsed entries", async () => {
    const { runner } = scriptedGit((call) => (call.args[1] === "list" ? ok(PORCELAIN) : undefined))
    const entries = await gitWorktreeList({ runner }, "/repo")
    expect(entries.map((entry) => entry.directory)).toEqual([
      "/repo",
      "/srv/worktrees/feature",
      "/srv/worktrees/detached",
    ])
  })
})

describe("branch and path validation", () => {
  test("accepts normal branch names", () => {
    for (const branch of ["feature", "feat/x", "v1.2.3", "user-branch", "FEATURE_1"]) {
      expect(isValidBranchName(branch), `branch=${branch}`).toBe(true)
    }
  })

  test("rejects invalid branch names", () => {
    for (const branch of [
      "",
      "HEAD",
      "@",
      "has space",
      "-leading",
      ".hidden",
      "a..b",
      "a@{b",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "a.lock",
      "a.",
      "x".repeat(256),
    ]) {
      expect(isValidBranchName(branch), `branch=${branch}`).toBe(false)
    }
  })

  test("pure path containment math", () => {
    expect(isPathInside("/srv/worktrees/feature", "/srv/worktrees")).toBe(true)
    expect(isPathInside("/srv/worktrees", "/srv/worktrees")).toBe(false)
    expect(isPathInside("/srv/worktrees", "/srv/worktrees/feature")).toBe(false)
    expect(isPathInside("/other", "/srv/worktrees")).toBe(false)
  })

  test("validateWorktreeCreate rejects unsafe inputs without running anything", () => {
    const base = { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" }
    expect(validateWorktreeCreate(base)).toEqual({ ok: true })
    const relativeDir = validateWorktreeCreate({ ...base, directory: "relative" })
    if (!relativeDir.ok) expect(relativeDir.reason).toContain("absolute")
    const relativeRoot = validateWorktreeCreate({ ...base, repoRoot: "relative" })
    if (!relativeRoot.ok) expect(relativeRoot.reason).toContain("absolute")
    const badBranch = validateWorktreeCreate({ ...base, branch: "bad..name" })
    if (!badBranch.ok) expect(badBranch.reason).toContain("branch")
    expect(validateWorktreeCreate({ ...base, base: "" }).ok).toBe(false)
    expect(validateWorktreeCreate({ ...base, base: "-main" }).ok).toBe(false)
  })

  test("validateWorktreeCreate rejects directories inside the main checkout", () => {
    const result = validateWorktreeCreate({
      repoRoot: "/repo",
      branch: "feature",
      directory: "/repo/subdir",
      base: "main",
    })
    if (!result.ok) expect(result.reason).toContain("outside the main checkout")
    const equal = validateWorktreeCreate({
      repoRoot: "/repo",
      branch: "feature",
      directory: "/repo",
      base: "main",
    })
    expect(equal.ok).toBe(false)
  })
})

describe("canonical path resolution", () => {
  test("resolveRealpath collapses symlink aliases of the same directory", async () => {
    const fixture = await createSymlinkFixture()
    if (!fixture) return
    try {
      expect(path.join(fixture.link, "tree")).not.toBe(path.join(fixture.real, "tree"))
      const viaLink = await resolveRealpath(path.join(fixture.link, "tree"))
      const viaReal = await resolveRealpath(path.join(fixture.real, "tree"))
      expect(viaLink).toBe(viaReal)
      expect(viaLink).toBe(path.join(await resolveRealpath(fixture.real), "tree"))
    } finally {
      await fixture.cleanup()
    }
  })

  test("resolveRealpath falls back lexically when no ancestor exists", async () => {
    expect(await resolveRealpath("/nonexistent-worktree-root-xyz/aaa/bbb")).toBe(
      "/nonexistent-worktree-root-xyz/aaa/bbb",
    )
    expect(await resolveRealpath("/srv/worktrees/feature")).toBe("/srv/worktrees/feature")
  })
})

describe("gitWorktreeAdd", () => {
  test("creates with -b, -- separator, and base, then verifies via list and rev-parse", async () => {
    const { runner, calls } = scriptedGit(createSuccessScript())
    const result = await gitWorktreeAdd(
      { runner, pathExists: async () => false },
      { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" },
    )
    expect(result.verified).toBe(true)
    expect(result.verification).toEqual({ listed: true, branchResolved: true })

    const addCall = calls.find((call) => call.args[1] === "add")
    expect(addCall?.cwd).toBe("/repo")
    expect(addCall?.args).toEqual(["worktree", "add", "-b", "feature", "--", "/srv/worktrees/feature", "main"])
    const listCalls = calls.filter((call) => call.args[1] === "list")
    expect(listCalls).toHaveLength(2)
  })

  test("rejects a bare repository", async () => {
    const { runner } = scriptedGit((call) =>
      call.args[0] === "rev-parse" && call.args[1] === "--is-bare-repository" ? ok("true") : undefined,
    )
    await expect(
      gitWorktreeAdd({ runner }, { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" }),
    ).rejects.toThrow(/bare/)
  })

  test("rejects a non-repository repoRoot", async () => {
    const { runner } = scriptedGit((call) =>
      call.args[0] === "rev-parse" && call.args[1] === "--is-bare-repository" ? fail("fatal: not a git repository") : undefined,
    )
    await expect(
      gitWorktreeAdd({ runner }, { repoRoot: "/nowhere", branch: "feature", directory: "/srv/worktrees/feature", base: "main" }),
    ).rejects.toThrow(/not a git repository/)
  })

  test("rejects a repoRoot that is itself a linked worktree", async () => {
    const { runner } = scriptedGit((call) => {
      if (call.args[0] !== "rev-parse") return undefined
      if (call.args[1] === "--is-bare-repository") return ok("false")
      if (call.args[1] === "--git-dir") return ok("/repo/.git/worktrees/other")
      return undefined
    })
    await expect(
      gitWorktreeAdd({ runner }, { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" }),
    ).rejects.toThrow(/linked worktree/)
  })

  test("accepts a normal main checkout whose --git-dir is relative (.git)", async () => {
    // Regression: a cwd-bound `git rev-parse --git-dir` on a plain checkout
    // returns `.git`, relative to repoRoot. It must not be resolved against the
    // server process cwd (which would reject every normal checkout as linked).
    const { runner, calls } = scriptedGit(createSuccessScript(undefined, undefined, undefined, ".git"))
    const result = await gitWorktreeAdd(
      { runner, pathExists: async () => false },
      { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" },
    )
    expect(result.verified).toBe(true)
    expect(result.verification).toEqual({ listed: true, branchResolved: true })
    const addCall = calls.find((call) => call.args[1] === "add")
    expect(addCall?.cwd).toBe("/repo")
    expect(addCall?.args).toEqual(["worktree", "add", "-b", "feature", "--", "/srv/worktrees/feature", "main"])
  })

  test("rejects a linked worktree with a relative --git-dir", async () => {
    const { runner } = scriptedGit((call) => {
      if (call.args[0] !== "rev-parse") return undefined
      if (call.args[1] === "--is-bare-repository") return ok("false")
      if (call.args[1] === "--git-dir") return ok(".git/worktrees/other")
      return undefined
    })
    await expect(
      gitWorktreeAdd({ runner }, { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" }),
    ).rejects.toThrow(/linked worktree/)
  })

  test("rejects an existing local branch", async () => {
    const { runner } = scriptedGit((call) => {
      if (call.args[0] !== "rev-parse") return undefined
      if (call.args[1] === "--is-bare-repository") return ok("false")
      if (call.args[1] === "--git-dir") return ok("/repo/.git")
      if (call.args[1] === "refs/heads/feature") return ok("abcdef0")
      return undefined
    })
    await expect(
      gitWorktreeAdd({ runner }, { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" }),
    ).rejects.toThrow(/already exists/)
  })

  test("rejects an existing directory", async () => {
    const { runner } = scriptedGit(createSuccessScript())
    await expect(
      gitWorktreeAdd(
        { runner, pathExists: async () => true },
        { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" },
      ),
    ).rejects.toThrow(/already exists/)
  })

  test("rejects a directory overlapping an existing worktree", async () => {
    const { runner } = scriptedGit((call) => {
      if (call.args[0] === "rev-parse") {
        if (call.args[1] === "--is-bare-repository") return ok("false")
        if (call.args[1] === "--git-dir") return ok("/repo/.git")
        return fail("unknown revision")
      }
      if (call.args[0] === "worktree" && call.args[1] === "list") {
        return ok(`${MAIN_ONLY}\n\nworktree /srv/worktrees/feature\nHEAD 1111\nbranch refs/heads/feature`)
      }
      return undefined
    })
    await expect(
      gitWorktreeAdd(
        { runner, pathExists: async () => false },
        { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" },
      ),
    ).rejects.toThrow(/overlaps an existing worktree/)
  })

  test("fails verification when the entry is missing after add", async () => {
    let listCalls = 0
    let refChecks = 0
    const { runner } = scriptedGit((call) => {
      if (call.args[0] === "rev-parse") {
        if (call.args[1] === "--is-bare-repository") return ok("false")
        if (call.args[1] === "--git-dir") return ok("/repo/.git")
        refChecks += 1
        return refChecks > 1 ? ok("f1c2dc0abc") : fail("unknown revision")
      }
      if (call.args[0] === "worktree" && call.args[1] === "list") {
        listCalls += 1
        return ok(listCalls === 1 ? MAIN_ONLY : MAIN_ONLY)
      }
      if (call.args[0] === "worktree" && call.args[1] === "add") return ok("")
      return undefined
    })
    await expect(
      gitWorktreeAdd({ runner }, { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" }),
    ).rejects.toThrow(/verification/)
  })

  test("rejects invalid branches before any runner call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    for (const branch of ["HEAD", "-bad", "a..b", "has space"]) {
      await expect(
        gitWorktreeAdd({ runner }, { repoRoot: "/repo", branch, directory: "/srv/worktrees/feature", base: "main" }),
      ).rejects.toThrow(/rejected/)
    }
    expect(calls).toBe(0)
  })

  test("throws the redacted add failure immediately on a nonzero exit, skipping verification", async () => {
    const { runner, calls } = scriptedGit((call) => {
      if (call.args[0] === "rev-parse") {
        if (call.args[1] === "--is-bare-repository") return ok("false")
        if (call.args[1] === "--git-dir") return ok("/repo/.git")
        return fail("unknown revision")
      }
      if (call.args[0] === "worktree" && call.args[1] === "list") return ok(MAIN_ONLY)
      if (call.args[0] === "worktree" && call.args[1] === "add") {
        return fail("fatal: access denied for supersecret-token")
      }
      return undefined
    })
    const redact = (text: string): string => text.replaceAll("supersecret-token", "[redacted]")
    await expect(
      gitWorktreeAdd(
        { runner, redact, pathExists: async () => false },
        { repoRoot: "/repo", branch: "feature", directory: "/srv/worktrees/feature", base: "main" },
      ),
    ).rejects.toThrow(
      /worktree create failed: git worktree add exited with code 1: fatal: access denied for \[redacted\]/,
    )
    // Pre-add list ran; post-add list/ref verification must not.
    expect(calls.filter((call) => call.args[1] === "list")).toHaveLength(1)
    expect(
      calls.filter((call) => call.args[0] === "rev-parse" && call.args[1] === "refs/heads/feature"),
    ).toHaveLength(1)
  })

  test("rejects a target that overlaps an existing worktree through a symlink alias", async () => {
    const fixture = await createSymlinkFixture()
    if (!fixture) return
    try {
      const listed = path.join(fixture.real, "tree")
      const directory = path.join(fixture.link, "tree")
      const { runner, calls } = scriptedGit((call) => {
        if (call.args[0] === "rev-parse") {
          if (call.args[1] === "--is-bare-repository") return ok("false")
          if (call.args[1] === "--git-dir") return ok(path.join(fixture.real, ".git"))
          return fail("unknown revision")
        }
        if (call.args[0] === "worktree" && call.args[1] === "list") {
          return ok(`${MAIN_ONLY}\n\nworktree ${listed}\nHEAD 1111\nbranch refs/heads/feature`)
        }
        return undefined
      })
      await expect(
        gitWorktreeAdd(
          { runner, pathExists: async () => false },
          { repoRoot: fixture.real, branch: "feature", directory, base: "main" },
        ),
      ).rejects.toThrow(/overlaps an existing worktree/)
      expect(calls.some((call) => call.args[1] === "add")).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  test("verifies a create whose target is reached through a symlink alias", async () => {
    const fixture = await createSymlinkFixture()
    if (!fixture) return
    try {
      const listed = path.join(fixture.real, "tree")
      const directory = path.join(fixture.link, "tree")
      let listCalls = 0
      let refChecks = 0
      const { runner, calls } = scriptedGit((call) => {
        if (call.args[0] === "rev-parse") {
          if (call.args[1] === "--is-bare-repository") return ok("false")
          if (call.args[1] === "--git-dir") return ok(path.join(fixture.real, ".git"))
          refChecks += 1
          return refChecks > 1 ? ok("f1c2dc0abc") : fail("unknown revision")
        }
        if (call.args[0] === "worktree" && call.args[1] === "list") {
          listCalls += 1
          if (listCalls === 1) return ok(MAIN_ONLY)
          return ok(`${MAIN_ONLY}\n\nworktree ${listed}\nHEAD f1c2dc0abc\nbranch refs/heads/feature`)
        }
        if (call.args[0] === "worktree" && call.args[1] === "add") return ok("")
        return undefined
      })
      const result = await gitWorktreeAdd(
        { runner, pathExists: async () => false },
        { repoRoot: fixture.real, branch: "feature", directory, base: "main" },
      )
      expect(result.verified).toBe(true)
      expect(result.verification).toEqual({ listed: true, branchResolved: true })
      const addCall = calls.find((call) => call.args[1] === "add")
      expect(addCall?.args).toEqual(["worktree", "add", "-b", "feature", "--", directory, "main"])
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("git helpers", () => {
  test("gitStatus returns porcelain output", async () => {
    const { runner } = scriptedGit((call) =>
      call.args[0] === "status" ? ok(" M README.md\n?? untracked.txt") : undefined,
    )
    expect(await gitStatus({ runner }, "/srv/worktrees/feature")).toBe(" M README.md\n?? untracked.txt")
  })

  test("gitRevParse returns undefined on non-zero exit", async () => {
    const { runner } = scriptedGit((call) => (call.args[0] === "rev-parse" ? fail("unknown revision") : undefined))
    expect(await gitRevParse({ runner }, "/repo", "refs/heads/missing")).toBeUndefined()
  })

  test("gitPush builds --set-upstream args", async () => {
    const { runner, calls } = scriptedGit((call) => (call.args[0] === "push" ? ok("") : undefined))
    const result = await gitPush({ runner }, { repoRoot: "/repo", branch: "feature", remote: "origin" })
    expect(result.exitCode).toBe(0)
    expect(calls[0]?.args).toEqual(["push", "--set-upstream", "origin", "feature"])
    expect(calls[0]?.cwd).toBe("/repo")
  })

  test("gitLsRemote returns ref lines", async () => {
    const { runner } = scriptedGit((call) =>
      call.args[0] === "ls-remote" ? ok("f1c2dc0\trefs/heads/feature") : undefined,
    )
    const refs = await gitLsRemote({ runner }, { repoRoot: "/repo", remote: "origin", ref: "refs/heads/feature" })
    expect(refs).toContain("refs/heads/feature")
  })

  test("gitWorktreeRemove builds plain and force args", async () => {
    const { runner, calls } = scriptedGit((call) => (call.args[0] === "worktree" && call.args[1] === "remove" ? ok("") : undefined))
    await gitWorktreeRemove({ runner }, { repoRoot: "/repo", directory: "/srv/worktrees/feature" })
    expect(calls[0]?.args).toEqual(["worktree", "remove", "/srv/worktrees/feature"])
    await gitWorktreeRemove({ runner }, { repoRoot: "/repo", directory: "/srv/worktrees/feature", force: true })
    expect(calls[1]?.args).toEqual(["worktree", "remove", "--force", "/srv/worktrees/feature"])
  })
})

describe("worktree durable state", () => {
  test("uses a worktree/v2 key namespace distinct from stage-1 session state", () => {
    expect(worktreeStorageKey("proj/one", "sess/1")).toBe(`worktree/v2/proj%2Fone/sess%2F1`)
    expect(worktreeStorageKey("proj/one", "sess/1")).not.toBe(`worktree/v1/proj%2Fone/sess%2F1`)
    expect(sessionIndexStorageKey("sess/1")).toBe(`worktree/v2/sessions/sess%2F1`)
  })

  test("writes and reads back a strict worktree record", async () => {
    const storage = memStorage()
    const record = seedRecord(storage.values)
    const written = await writeWorktree(storage, { ...record, status: "ready" }, 2000)
    expect(written.updatedAt).toBe(2000)
    const read = await readWorktree(storage, "origin", "session-1")
    expect(read?.dir).toBe("/srv/worktrees/feature")
    expect(read?.branch).toBe("feature")
    expect(read?.status).toBe("ready")
  })

  test("ignores malformed worktree records and session indexes", async () => {
    const storage = memStorage(
      new Map([
        [worktreeStorageKey("origin", "session-1"), { version: 1, owner: "x" }],
        [sessionIndexStorageKey("session-1"), { version: 1 }],
      ]),
    )
    expect(await readWorktree(storage, "origin", "session-1")).toBeUndefined()
    expect(await readSessionIndex(storage, "session-1")).toBeUndefined()
  })

  test("listWorktrees scans records and skips session indexes", async () => {
    const storage = memStorage()
    seedRecord(storage.values)
    const index: SessionIndexRecord = {
      version: 1,
      sessionID: "session-9",
      projectID: "origin",
      originProjectID: "origin",
      directory: "/workspace",
      updatedAt: 1,
    }
    await storage.set(sessionIndexStorageKey("session-9"), index)
    const records = await listWorktrees(storage)
    expect(records).toHaveLength(1)
    expect(records[0]?.sessionID).toBe("session-1")
  })

  test("listWorktrees returns [] when scan is unavailable", async () => {
    const storage: StorageLike = {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    }
    expect(await listWorktrees(storage)).toEqual([])
  })
})

describe("worktree tools", () => {
  test("registers the five orchestrator_worktree tools with the shared permission", () => {
    const { tools } = collectWorktreeTools()
    expect([...tools.keys()]).toEqual([
      "worktree_list",
      "worktree_create",
      "worktree_status",
      "worktree_push",
      "worktree_cleanup",
    ])
    for (const tool of tools.values()) {
      expect(tool.options?.namespace).toBe("orchestrator")
      expect(tool.options?.permission).toBe(WORKTREE_TOOL_PERMISSION)
    }
  })

  test("registers nothing when worktree.enabled is false", () => {
    const { tools } = collectWorktreeTools({ options: parseOptions({}) })
    expect(tools.size).toBe(0)
  })

  test("gates every tool to the orchestrator agent", async () => {
    const { tools } = collectWorktreeTools()
    const worker = toolContext("session-1", "explore")
    await expect(tools.get("worktree_list")!.execute({}, worker)).rejects.toThrow(/only to the orchestrator/)
    await expect(
      tools.get("worktree_create")!.execute({ confirm: true }, worker),
    ).rejects.toThrow(/only to the orchestrator/)
  })

  test("requires allow_mutations for create but not for list", async () => {
    const { tools } = collectWorktreeTools({
      options: wTreeOptions({ worktree: { enabled: true, allow_mutations: false, root: "/srv/worktrees" } }),
    })
    const output = await tools.get("worktree_list")!.execute({}, toolContext("session-1", "orchestrator"))
    expect(output.content).toBeTruthy()
    await expect(
      tools.get("worktree_create")!.execute({ confirm: true }, toolContext("session-1", "orchestrator")),
    ).rejects.toThrow(/allow_mutations/)
  })

  test("create requires a literal confirm: true", async () => {
    const { tools } = collectWorktreeTools()
    const context = toolContext("session-1", "orchestrator")
    const missing = await tools.get("worktree_create")!.execute({}, context)
    expect(missing.content).toContain("requires confirm: true")
    const falsy = await tools.get("worktree_create")!.execute({ confirm: false }, context)
    expect(falsy.content).toContain("requires confirm: true")
  })

  test("create requires worktree.root to be configured", async () => {
    const { tools } = collectWorktreeTools({
      options: wTreeOptions({ worktree: { enabled: true, allow_mutations: true, root: null } }),
    })
    const output = await tools
      .get("worktree_create")!
      .execute(
        { repoRoot: "/repo", directory: "/srv/worktrees/feature", branch: "feature", base: "main", confirm: true },
        toolContext("session-1", "orchestrator"),
      )
    expect(output.content).toContain("worktree.root must be configured")
  })

  test("create rejects directories outside the configured root", async () => {
    const { tools } = collectWorktreeTools()
    const output = await tools
      .get("worktree_create")!
      .execute(
        { repoRoot: "/repo", directory: "/elsewhere/feature", branch: "feature", base: "main", confirm: true },
        toolContext("session-1", "orchestrator"),
      )
    expect(output.content).toContain("must be inside worktree.root")
  })

  test("create writes a durable ready record and session index", async () => {
    const { runner } = scriptedGit(createSuccessScript())
    const { tools, values } = collectWorktreeTools({ runner })
    const output = await tools
      .get("worktree_create")!
      .execute(
        { repoRoot: "/repo", directory: "/srv/worktrees/feature", branch: "feature", base: "main", confirm: true },
        toolContext("session-1", "orchestrator"),
      )
    const parsed = JSON.parse(output.content) as { record: WorktreeRecord; verified: boolean }
    expect(parsed.verified).toBe(true)
    expect(parsed.record.status).toBe("ready")
    expect(parsed.record.originProjectID).toBe("origin")
    expect(values.has(worktreeStorageKey("origin", "session-1"))).toBe(true)
    expect(values.has(sessionIndexStorageKey("session-1"))).toBe(true)
  })

  test("status reports ready, dirty, and orphaned with durable write-back", async () => {
    const ready = collectWorktreeTools({
      runner: scriptedGit((call) => {
        if (call.args[0] === "worktree" && call.args[1] === "list") return ok(`${MAIN_ONLY}\n\nworktree /srv/worktrees/feature`)
        if (call.args[0] === "status") return ok("")
        return undefined
      }).runner,
    })
    seedRecord(ready.values)
    const readyOut = await ready.tools.get("worktree_status")!.execute({}, toolContext("session-1", "orchestrator"))
    expect((JSON.parse(readyOut.content) as { status: string }).status).toBe("ready")

    const dirty = collectWorktreeTools({
      runner: scriptedGit((call) => {
        if (call.args[0] === "worktree" && call.args[1] === "list") return ok(`${MAIN_ONLY}\n\nworktree /srv/worktrees/feature`)
        if (call.args[0] === "status") return ok(" M file.txt")
        return undefined
      }).runner,
    })
    seedRecord(dirty.values)
    const dirtyOut = await dirty.tools.get("worktree_status")!.execute({}, toolContext("session-1", "orchestrator"))
    expect((JSON.parse(dirtyOut.content) as { status: string }).status).toBe("dirty")
    const persisted = dirty.values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord
    expect(persisted.status).toBe("dirty")

    const cleaned = collectWorktreeTools({
      values: dirty.values,
      runner: scriptedGit((call) => {
        if (call.args[0] === "worktree" && call.args[1] === "list") return ok(`${MAIN_ONLY}\n\nworktree /srv/worktrees/feature`)
        if (call.args[0] === "status") return ok("")
        return undefined
      }).runner,
    })
    const cleanedOut = await cleaned.tools.get("worktree_status")!.execute({}, toolContext("session-1", "orchestrator"))
    expect((JSON.parse(cleanedOut.content) as { status: string }).status).toBe("ready")
    expect((cleaned.values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord).status).toBe("ready")

    const orphaned = collectWorktreeTools({
      runner: scriptedGit((call) => {
        if (call.args[0] === "worktree" && call.args[1] === "list") return ok(MAIN_ONLY)
        if (call.args[0] === "status") return ok("")
        return undefined
      }).runner,
    })
    seedRecord(orphaned.values)
    const orphanOut = await orphaned.tools.get("worktree_status")!.execute({}, toolContext("session-1", "orchestrator"))
    expect((JSON.parse(orphanOut.content) as { status: string }).status).toBe("orphaned")
  })

  test("push verifies the branch on the remote and updates status", async () => {
    const { runner, calls } = scriptedGit((call) => {
      if (call.args[0] === "push") return ok("")
      if (call.args[0] === "ls-remote") return ok("f1c2dc0\trefs/heads/feature")
      return undefined
    })
    const { tools, values } = collectWorktreeTools({ runner })
    const moved = { ...seedRecord(values), status: "moved" as const }
    values.set(worktreeStorageKey("origin", "session-1"), moved)

    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as { pushed: boolean; verified: boolean; remote: string; branch: string }
    expect(parsed.pushed).toBe(true)
    expect(parsed.verified).toBe(true)
    expect(parsed.remote).toBe("origin")
    expect(parsed.branch).toBe("feature")
    expect(calls.some((call) => call.args.join(" ").includes("--set-upstream"))).toBe(true)
    const persisted = values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord
    expect(persisted.status).toBe("ready")
  })

  test("push reports verification failure on a failed push", async () => {
    const { tools, values } = collectWorktreeTools({
      runner: scriptedGit((call) => {
        if (call.args[0] === "push") return fail("error: failed to push some refs")
        return undefined
      }).runner,
    })
    seedRecord(values)
    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("push failed")
  })

  test("cleanup refuses a dirty worktree without removing", async () => {
    const { runner, calls } = scriptedGit((call) => {
      if (call.args[0] === "worktree" && call.args[1] === "list") return ok(`${MAIN_ONLY}\n\nworktree /srv/worktrees/feature`)
      if (call.args[0] === "status") return ok(" M file.txt")
      return undefined
    })
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    const output = await tools
      .get("worktree_cleanup")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("refused")
    expect(output.content).toContain("uncommitted changes")
    expect(calls.some((call) => call.args[1] === "remove")).toBe(false)
  })

  test("cleanup refuses the main worktree", async () => {
    const { runner, calls } = scriptedGit((call) => {
      if (call.args[0] === "worktree" && call.args[1] === "list") return ok(MAIN_ONLY)
      return undefined
    })
    const { tools } = collectWorktreeTools({ runner })
    const output = await tools
      .get("worktree_cleanup")!
      .execute({ repoRoot: "/repo", directory: "/repo", confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("refused")
    expect(output.content).toContain("main worktree")
    expect(calls.some((call) => call.args[1] === "remove")).toBe(false)
  })

  test("cleanup refuses a worktree owned by another active session", async () => {
    const { tools, values } = collectWorktreeTools({
      runner: scriptedGit(() => undefined).runner,
    })
    for (const status of ["ready", "dirty", "orphaned", "cleanup-failed"] as const) {
      const other = newWorktree(
        {
          owner: "other-session",
          sessionID: "other-session",
          originProjectID: "origin",
          repoRoot: "/repo",
          dir: "/srv/worktrees/feature",
          branch: "feature",
          base: "main",
        },
        100,
      )
      values.set(worktreeStorageKey("origin", "other-session"), { ...other, status })
      const output = await tools
        .get("worktree_cleanup")!
        .execute(
          { repoRoot: "/repo", directory: "/srv/worktrees/feature", confirm: true },
          toolContext("session-1", "orchestrator"),
        )
      expect(output.content).toContain("refused")
      expect(output.content).toContain("owned by session other-session")
      values.delete(worktreeStorageKey("origin", "other-session"))
    }
  })

  test("cleanup removes a clean owned worktree and deletes the durable record", async () => {
    const { runner, calls } = scriptedGit((call) => {
      if (call.args[0] === "worktree" && call.args[1] === "list") return ok(`${MAIN_ONLY}\n\nworktree /srv/worktrees/feature`)
      if (call.args[0] === "worktree" && call.args[1] === "remove") return ok("")
      if (call.args[0] === "status") return ok("")
      return undefined
    })
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    const output = await tools
      .get("worktree_cleanup")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(JSON.parse(output.content)).toEqual({ removed: true, directory: "/srv/worktrees/feature" })
    expect(calls.some((call) => call.args[1] === "remove")).toBe(true)
    expect(values.has(worktreeStorageKey("origin", "session-1"))).toBe(false)
  })

  test("list merges git worktrees with durable records", async () => {
    const { runner } = scriptedGit((call) =>
      call.args[0] === "worktree" && call.args[1] === "list" ? ok(`${MAIN_ONLY}\n\nworktree /srv/worktrees/feature`) : undefined,
    )
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    const output = await tools
      .get("worktree_list")!
      .execute({ repoRoot: "/repo" }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as { worktrees: WorktreeEntry[]; records: WorktreeRecord[] }
    expect(parsed.worktrees.map((entry) => entry.directory)).toContain("/srv/worktrees/feature")
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0]?.status).toBe("ready")
  })

  test("create returns the redacted add failure and writes no ready record", async () => {
    const { runner, calls } = scriptedGit((call) => {
      if (call.args[0] === "rev-parse") {
        if (call.args[1] === "--is-bare-repository") return ok("false")
        if (call.args[1] === "--git-dir") return ok("/repo/.git")
        return fail("unknown revision")
      }
      if (call.args[0] === "worktree" && call.args[1] === "list") return ok(MAIN_ONLY)
      if (call.args[0] === "worktree" && call.args[1] === "add") {
        return fail("fatal: remote auth failed for supersecret-token")
      }
      return undefined
    })
    const { tools, values } = collectWorktreeTools({ runner })
    const output = await tools
      .get("worktree_create")!
      .execute(
        { repoRoot: "/repo", directory: "/srv/worktrees/feature", branch: "feature", base: "main", confirm: true },
        toolContext("session-1", "orchestrator"),
      )
    expect(output.content).toContain("worktree create failed")
    expect(output.content).toContain("exited with code 1")
    expect(output.content).toContain("[redacted]")
    expect(output.content).not.toContain("supersecret-token")
    expect(values.has(worktreeStorageKey("origin", "session-1"))).toBe(false)
    expect(values.has(sessionIndexStorageKey("session-1"))).toBe(false)
    expect(calls.filter((call) => call.args[1] === "list")).toHaveLength(1)
  })

  test("create accepts a directory aliased inside the configured root and persists the canonical record", async () => {
    const fixture = await createSymlinkFixture()
    if (!fixture) return
    try {
      const directory = path.join(fixture.link, "feature")
      const listed = path.join(fixture.real, "feature")
      let listCalls = 0
      let refChecks = 0
      const { runner, calls } = scriptedGit((call) => {
        if (call.args[0] === "rev-parse") {
          if (call.args[1] === "--is-bare-repository") return ok("false")
          if (call.args[1] === "--git-dir") return ok(path.join(fixture.real, ".git"))
          refChecks += 1
          return refChecks > 1 ? ok("f1c2dc0abc") : fail("unknown revision")
        }
        if (call.args[0] === "worktree" && call.args[1] === "list") {
          listCalls += 1
          if (listCalls === 1) return ok(MAIN_ONLY)
          return ok(`${MAIN_ONLY}\n\nworktree ${listed}\nHEAD f1c2dc0abc\nbranch refs/heads/feature`)
        }
        if (call.args[0] === "worktree" && call.args[1] === "add") return ok("")
        return undefined
      })
      const { tools, values } = collectWorktreeTools({
        runner,
        options: wTreeOptions({ worktree: { enabled: true, allow_mutations: true, root: fixture.link } }),
      })
      const output = await tools
        .get("worktree_create")!
        .execute(
          { repoRoot: fixture.real, directory, branch: "feature", base: "main", confirm: true },
          toolContext("session-1", "orchestrator"),
        )
      const parsed = JSON.parse(output.content) as { record: WorktreeRecord; verified: boolean }
      expect(parsed.verified).toBe(true)
      expect(parsed.record.status).toBe("ready")
      const canonicalReal = await resolveRealpath(fixture.real)
      expect(parsed.record.dir).toBe(path.join(canonicalReal, "feature"))
      expect(parsed.record.repoRoot).toBe(canonicalReal)
      expect(values.has(worktreeStorageKey("origin", "session-1"))).toBe(true)
      const addCall = calls.find((call) => call.args[1] === "add")
      expect(addCall?.args).toEqual(["worktree", "add", "-b", "feature", "--", directory, "main"])
    } finally {
      await fixture.cleanup()
    }
  })

  test("status returns the updated record after a status write-back", async () => {
    const { tools, values } = collectWorktreeTools({
      runner: scriptedGit((call) => {
        if (call.args[0] === "worktree" && call.args[1] === "list") {
          return ok(`${MAIN_ONLY}\n\nworktree /srv/worktrees/feature`)
        }
        if (call.args[0] === "status") return ok(" M dirty.txt")
        return undefined
      }).runner,
    })
    const original = seedRecord(values)
    expect(original.status).toBe("ready")
    const output = await tools.get("worktree_status")!.execute({}, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as { record: WorktreeRecord; status: string }
    expect(parsed.status).toBe("dirty")
    expect(parsed.record?.status).toBe("dirty")
  })

  test("status stays ready when the record dir is a symlink alias of the porcelain path", async () => {
    const fixture = await createSymlinkFixture()
    if (!fixture) return
    try {
      const recordDir = path.join(fixture.link, "tree")
      const listed = path.join(fixture.real, "tree")
      const { tools, values } = collectWorktreeTools({
        runner: scriptedGit((call) => {
          if (call.args[0] === "worktree" && call.args[1] === "list") {
            return ok(`${MAIN_ONLY}\n\nworktree ${listed}\nHEAD 1111\nbranch refs/heads/feature`)
          }
          if (call.args[0] === "status") return ok("")
          return undefined
        }).runner,
      })
      seedRecord(values, { dir: recordDir })
      const output = await tools
        .get("worktree_status")!
        .execute({ repoRoot: fixture.real }, toolContext("session-1", "orchestrator"))
      const parsed = JSON.parse(output.content) as { status: string; record: WorktreeRecord | null }
      expect(parsed.status).toBe("ready")
      expect(parsed.record?.status).toBe("ready")
    } finally {
      await fixture.cleanup()
    }
  })

  test("cleanup refuses the main worktree reached through a symlink alias", async () => {
    const fixture = await createSymlinkFixture()
    if (!fixture) return
    try {
      const { runner, calls } = scriptedGit((call) => {
        if (call.args[0] === "worktree" && call.args[1] === "list") {
          return ok(`worktree ${fixture.real}\nHEAD 0123\nbranch refs/heads/main`)
        }
        return undefined
      })
      const { tools } = collectWorktreeTools({ runner })
      const output = await tools
        .get("worktree_cleanup")!
        .execute(
          { repoRoot: fixture.real, directory: fixture.link, confirm: true },
          toolContext("session-1", "orchestrator"),
        )
      expect(output.content).toContain("refused")
      expect(output.content).toContain("main worktree")
      expect(calls.some((call) => call.args[1] === "remove")).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  test("cleanup attributes ownership through a symlink alias", async () => {
    const fixture = await createSymlinkFixture()
    if (!fixture) return
    try {
      const { tools, values } = collectWorktreeTools({ runner: scriptedGit(() => undefined).runner })
      const other = newWorktree(
        {
          owner: "other-session",
          sessionID: "other-session",
          originProjectID: "origin",
          repoRoot: fixture.real,
          dir: path.join(fixture.link, "tree"),
          branch: "feature",
          base: "main",
        },
        100,
      )
      values.set(worktreeStorageKey("origin", "other-session"), { ...other, status: "ready" })
      const output = await tools
        .get("worktree_cleanup")!
        .execute(
          { repoRoot: fixture.real, directory: path.join(fixture.real, "tree"), confirm: true },
          toolContext("session-1", "orchestrator"),
        )
      expect(output.content).toContain("refused")
      expect(output.content).toContain("owned by session other-session")
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("session.moved reconciliation", () => {
  test("first observed move writes an anchor and session index at the new project", async () => {
    const values = new Map<string, unknown>()
    const storage = memStorage(values)
    const stream = createEventStream()
    const stop = startWorktreeEventSync({ event: { subscribe: () => stream }, storage }, parseOptions({}))

    stream.push({
      type: "session.moved",
      data: { sessionID: "s1", projectID: "newproj", location: { directory: "/new/dir", workspaceID: "ws-1" } },
    })
    await waitFor(() => values.has(sessionIndexStorageKey("s1")))

    const anchor = values.get(sessionAnchorStorageKey("newproj", "s1")) as SessionAnchor
    expect(anchor.currentProjectID).toBe("newproj")
    expect(anchor.currentDirectory).toBe("/new/dir")
    expect(anchor.originProjectID).toBe("newproj")
    const index = values.get(sessionIndexStorageKey("s1")) as SessionIndexRecord
    expect(index.projectID).toBe("newproj")
    expect(index.originProjectID).toBe("newproj")

    stop()
    expect(stream.closed).toBe(true)
  })

  test("later move relocates the anchor, preserves origin, and marks the worktree moved", async () => {
    const values = new Map<string, unknown>()
    const storage = memStorage(values)
    values.set(sessionIndexStorageKey("s1"), {
      version: 1,
      sessionID: "s1",
      projectID: "oldproj",
      originProjectID: "origin",
      directory: "/old/dir",
      updatedAt: 1,
    })
    values.set(sessionAnchorStorageKey("oldproj", "s1"), {
      version: 1,
      sessionID: "s1",
      originProjectID: "origin",
      originDirectory: "/origin",
      currentProjectID: "oldproj",
      currentDirectory: "/old/dir",
      updatedAt: 1,
    })
    const record = newWorktree(
      {
        owner: "s1",
        sessionID: "s1",
        originProjectID: "origin",
        repoRoot: "/repo",
        dir: "/srv/worktrees/feature",
        branch: "feature",
        base: "main",
      },
      100,
    )
    values.set(worktreeStorageKey("origin", "s1"), { ...record, status: "ready" })
    expect((values.get(worktreeStorageKey("origin", "s1")) as WorktreeRecord).status).toBe("ready")

    const stream = createEventStream()
    const stop = startWorktreeEventSync({ event: { subscribe: () => stream }, storage }, parseOptions({}))

    stream.push({
      type: "session.moved",
      data: { sessionID: "s1", projectID: "newproj", location: { directory: "/new/dir" }, subpath: "sub" },
    })
    await waitFor(() => {
      const index = values.get(sessionIndexStorageKey("s1")) as SessionIndexRecord | undefined
      return index?.projectID === "newproj"
    })

    expect(values.has(sessionAnchorStorageKey("oldproj", "s1"))).toBe(false)
    const anchor = values.get(sessionAnchorStorageKey("newproj", "s1")) as SessionAnchor
    expect(anchor.currentProjectID).toBe("newproj")
    expect(anchor.currentDirectory).toBe("/new/dir")
    expect(anchor.originProjectID).toBe("origin")
    expect(anchor.originDirectory).toBe("/origin")
    expect(anchor.subpath).toBe("sub")

    const worktree = values.get(worktreeStorageKey("origin", "s1")) as WorktreeRecord
    expect(worktree.status).toBe("moved")
    expect(values.has(sessionAnchorStorageKey("newproj", "s1"))).toBe(true)

    stop()
  })

  test("same-project move rewrites the anchor in place without clobbering origin", async () => {
    const values = new Map<string, unknown>()
    const storage = memStorage(values)
    values.set(sessionIndexStorageKey("s1"), {
      version: 1,
      sessionID: "s1",
      projectID: "proj",
      originProjectID: "origin",
      directory: "/old/dir",
      updatedAt: 1,
    })
    values.set(sessionAnchorStorageKey("proj", "s1"), {
      version: 1,
      sessionID: "s1",
      originProjectID: "origin",
      originDirectory: "/origin",
      currentProjectID: "proj",
      currentDirectory: "/old/dir",
      updatedAt: 1,
    })
    const stream = createEventStream()
    const stop = startWorktreeEventSync({ event: { subscribe: () => stream }, storage }, parseOptions({}))

    stream.push({
      type: "session.moved",
      data: { sessionID: "s1", projectID: "proj", location: { directory: "/new/dir" } },
    })
    await waitFor(() => {
      const anchor = values.get(sessionAnchorStorageKey("proj", "s1")) as SessionAnchor | undefined
      return anchor?.currentDirectory === "/new/dir"
    })

    const anchor = values.get(sessionAnchorStorageKey("proj", "s1")) as SessionAnchor
    expect(anchor.originProjectID).toBe("origin")
    expect(anchor.originDirectory).toBe("/origin")
    expect(anchor.currentDirectory).toBe("/new/dir")
    expect(anchor.status).toBe("moved")

    stop()
  })

  test("same-project move without a directory preserves the existing anchor directory", async () => {
    const values = new Map<string, unknown>()
    const storage = memStorage(values)
    values.set(sessionIndexStorageKey("s1"), {
      version: 1,
      sessionID: "s1",
      projectID: "proj",
      originProjectID: "origin",
      directory: "/old/dir",
      updatedAt: 1,
    })
    values.set(sessionAnchorStorageKey("proj", "s1"), {
      version: 1,
      sessionID: "s1",
      originProjectID: "origin",
      originDirectory: "/origin",
      currentProjectID: "proj",
      currentDirectory: "/old/dir",
      updatedAt: 1,
    })
    const stream = createEventStream()
    const stop = startWorktreeEventSync({ event: { subscribe: () => stream }, storage }, parseOptions({}))

    stream.push({
      type: "session.moved",
      data: { sessionID: "s1", projectID: "proj" },
    })
    await waitFor(() => {
      const anchor = values.get(sessionAnchorStorageKey("proj", "s1")) as SessionAnchor | undefined
      return anchor?.status === "moved"
    })

    const anchor = values.get(sessionAnchorStorageKey("proj", "s1")) as SessionAnchor
    expect(anchor.currentDirectory).toBe("/old/dir")
    expect(anchor.originDirectory).toBe("/origin")

    stop()
  })

  test("removes nothing when the event is not a session.moved", async () => {
    const values = new Map<string, unknown>()
    const storage = memStorage(values)
    const stream = createEventStream()
    const stop = startWorktreeEventSync({ event: { subscribe: () => stream }, storage }, parseOptions({}))
    stream.push({ type: "session.idle", data: { sessionID: "s1" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(values.size).toBe(0)
    stop()
  })
})