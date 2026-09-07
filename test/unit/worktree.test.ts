import path from "node:path"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { parseOptions, type OrchestratorOptions } from "../../src/core/config.js"
import { WORKTREE_TOOL_PERMISSION } from "../../src/core/permissions.js"
import type { ProcessResult, ProcessRunner } from "../../src/opencode-v2/process/runner.js"
import {
  gitFetch,
  gitLsRemote,
  gitMerge,
  gitMergeAbort,
  gitMergeBaseIsAncestor,
  gitPush,
  gitRevParse,
  gitStatus,
  gitUnmergedPaths,
  gitWorktreeAdd,
  gitWorktreeList,
  gitWorktreeRemove,
  isPathInside,
  isValidBranchName,
  isValidRemoteName,
  parseLsRemoteRefSha,
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
  type WorktreeSyncReceipt,
} from "../../src/opencode-v2/worktree/state.js"
import { addWorktreeTools } from "../../src/opencode-v2/worktree/tools.js"
import { startWorktreeEventSync } from "../../src/opencode-v2/worktree/events.js"
import { moveSessionToDirectory } from "../../src/opencode-v2/session/move.js"
import { createSessionMoveCoordinator, type SessionMoveCoordinator } from "../../src/opencode-v2/session/move-coordinator.js"
import { sessionAnchorStorageKey, type SessionAnchor } from "../../src/opencode-v2/session/state.js"
import { evidenceSchema, type EvidenceRecord } from "../../src/opencode-v2/orchestration/evidence.js"
import { reviewStorageKey, type ReviewV1Record } from "../../src/opencode-v2/observability/review.js"
import { publishStorageKey } from "../../src/opencode-v2/publish/state.js"

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

// Exact full-SHA fixtures used across the sync/push gate tests. The base is
// the remote base pinned at sync time; HEAD is the feature head after sync.
const BASE_SHA = "aaa1111111111111111111111111111111111111"
const HEAD_SHA = "bbb2222222222222222222222222222222222222"
const MERGED_HEAD_SHA = "ccc3333333333333333333333333333333333333"

function syncReceipt(overrides: Partial<WorktreeSyncReceipt> = {}): WorktreeSyncReceipt {
  return {
    remote: "origin",
    baseBranch: "main",
    baseRef: "refs/heads/main",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    merged: true,
    syncedAt: 1000,
    ...overrides,
  }
}

/** Seed a tracked record that carries an exact-revision sync receipt. */
function seedSyncedRecord(values: Map<string, unknown>, overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  const finalized = { ...syncReceipt(), ...(overrides.sync ?? {}) }
  return seedRecord(values, { ...overrides, sync: finalized })
}

/** Seed the durable project-scoped publication grant for capability `push`. */
function seedPublishGrant(values: Map<string, unknown>): void {
  values.set(publishStorageKey("origin"), {
    version: 1,
    projectID: "origin",
    enabled: true,
    capabilities: ["push"],
    updatedAt: 1,
    updatedBy: "session-1",
  })
}

/** Seed an approved review record pinned to the exact synced base/head. */
function seedApprovedReview(
  values: Map<string, unknown>,
  overrides: {
    headSha?: string
    baseSha?: string
    state?: ReviewV1Record["state"]
  } = {},
): void {
  const review: ReviewV1Record = {
    version: 1,
    taskId: "impl-worktree-sync",
    runId: "run-1",
    maker: "implementer",
    checker: "reviewer",
    state: overrides.state ?? "approved",
    round: 1,
    maxRounds: 3,
    reason: overrides.state === "approved" ? "approval-complete" : "manual-start",
    requiresHuman: false,
    createdAt: 1,
    updatedAt: 2,
    headSha: overrides.headSha ?? HEAD_SHA,
    baseSha: overrides.baseSha ?? BASE_SHA,
  }
  values.set(reviewStorageKey({ project: { id: "origin" } }, "session-1"), review)
}

/**
 * Scripts a full successful sync: clean tree, fetch, tracking-ref resolve,
 * HEAD resolve, not-ancestor merge-base, clean merge, ancestor verification,
 * clean status, and post-merge HEAD resolve.
 */
function syncSuccessScript(options: {
  dirtyBefore?: string
  remoteBase?: string
  headAfter?: string
  ancestorBefore?: boolean
  mergeOutcome?: ProcessResult
  dirtyAfter?: string
} = {}): (call: Call, calls: Call[]) => ProcessResult | undefined {
  let statusCalls = 0
  let mergeBaseCalls = 0
  return (call) => {
    switch (call.args[0]) {
      case "status": {
        statusCalls += 1
        return ok(statusCalls === 1 ? options.dirtyBefore ?? "" : options.dirtyAfter ?? "")
      }
      case "fetch":
        return ok("")
      case "rev-parse":
        if (call.args[1] === "refs/remotes/origin/main") return ok(options.remoteBase ?? BASE_SHA)
        if (call.args[1] === "HEAD") return ok(options.headAfter ?? MERGED_HEAD_SHA)
        return undefined
      case "merge-base": {
        mergeBaseCalls += 1
        if (mergeBaseCalls === 1) return options.ancestorBefore === true ? ok("") : fail("")
        return ok("")
      }
      case "merge":
        if (call.args[1] === "--abort") return ok("")
        return options.mergeOutcome ?? ok("")
      case "diff":
        // No unmerged paths: the merge failed for a reason other than conflict.
        return ok("")
      default:
        return undefined
    }
  }
}

/**
 * Scripts the standard push gate sequence: clean status, re-fetch, tracking
 * base resolve, HEAD resolve, ancestry, push, and ls-remote verification.
 * Each stage is overridable so one failure at a time can be injected.
 */
function pushGateScript(options: {
  dirty?: string
  fetchOutcome?: ProcessResult
  remoteBase?: string
  head?: string
  ancestor?: boolean
  pushOutcome?: ProcessResult
  lsRemote?: string
} = {}): (call: Call, calls: Call[]) => ProcessResult | undefined {
  const head = options.head ?? HEAD_SHA
  return (call) => {
    switch (call.args[0]) {
      case "status":
        return ok(options.dirty ?? "")
      case "fetch":
        return options.fetchOutcome ?? ok("")
      case "rev-parse":
        if (call.args[1] === "refs/remotes/origin/main") return ok(options.remoteBase ?? BASE_SHA)
        if (call.args[1] === "HEAD") return ok(head)
        return undefined
      case "merge-base":
        return options.ancestor === false ? fail("") : ok("")
      case "push":
        return options.pushOutcome ?? ok("")
      case "ls-remote":
        return ok(options.lsRemote ?? `${head}\trefs/heads/feature`)
      default:
        return undefined
    }
  }
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

type SessionState = {
  id: string
  projectID: string
  directory: string
  workspaceID?: string
}

// Fake session mirroring the real Session.Info shape. It records every move
// and advances its own location so the move helper's re-read verification
// observes the moved session; the project ID is preserved across moves unless
// `projectIDFor` derives a new one from the destination directory.
function sessionFixture(
  initial: SessionState,
  projectIDFor?: (directory: string) => string,
): {
  state(): SessionState
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

function wTreeOptions(overrides: Record<string, unknown> = {}): OrchestratorOptions {
  return parseOptions({ worktree: { enabled: true, allow_mutations: true, root: "/srv/worktrees" }, ...overrides })
}

function collectWorktreeTools(deps: {
  options?: OrchestratorOptions
  values?: Map<string, unknown>
  runner?: ProcessRunner
  pathExists?: (directory: string) => Promise<boolean>
  session?: Parameters<typeof addWorktreeTools>[1]["session"]
  moveCoordinator?: SessionMoveCoordinator
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
      session: deps.session ?? sessionFixture({ id: "session-1", projectID: "origin", directory: "/workspace" }),
      pathExists: deps.pathExists,
      secrets: ["supersecret-token"],
      moveCoordinator: deps.moveCoordinator,
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

  test("parseLsRemoteRefSha requires an exact full SHA for the exact ref", () => {
    const line = `${HEAD_SHA}\trefs/heads/feature`
    expect(parseLsRemoteRefSha(`${line}\n`, "refs/heads/feature")).toBe(HEAD_SHA)
    // Substring of the SHA, a different ref, a short SHA, or garbage never match.
    expect(parseLsRemoteRefSha(`refs/heads/feature ${HEAD_SHA}\n`, "refs/heads/feature")).toBeUndefined()
    expect(parseLsRemoteRefSha(`${HEAD_SHA}\trefs/heads/feature-old\n`, "refs/heads/feature")).toBeUndefined()
    expect(parseLsRemoteRefSha(`${HEAD_SHA}\trefs/heads/feature\n${HEAD_SHA.slice(0, 12)}\trefs/heads/other\n`, "refs/heads/other")).toBeUndefined()
    expect(parseLsRemoteRefSha("", "refs/heads/feature")).toBeUndefined()
    expect(parseLsRemoteRefSha(`* ${HEAD_SHA}\trefs/heads/feature\n`, "refs/heads/feature")).toBeUndefined()
  })

  test("gitFetch builds positional remote + ref args and never options", async () => {
    const { runner, calls } = scriptedGit((call) => (call.args[0] === "fetch" ? ok("") : undefined))
    const result = await gitFetch({ runner }, { repoRoot: "/repo", remote: "origin", ref: "refs/heads/main" })
    expect(result.exitCode).toBe(0)
    expect(calls[0]?.args).toEqual(["fetch", "origin", "refs/heads/main"])
    expect(calls[0]?.cwd).toBe("/repo")
  })

  test("gitMerge builds --no-edit into the current branch", async () => {
    const { runner, calls } = scriptedGit((call) => (call.args[0] === "merge" ? ok("") : undefined))
    const result = await gitMerge({ runner }, { repoRoot: "/srv/worktrees/feature", into: "refs/remotes/origin/main" })
    expect(result.exitCode).toBe(0)
    expect(calls[0]?.args).toEqual(["merge", "--no-edit", "refs/remotes/origin/main"])
    expect(calls[0]?.cwd).toBe("/srv/worktrees/feature")
  })

  test("gitMergeAbort and gitMergeBaseIsAncestor map exits to booleans", async () => {
    const { runner, calls } = scriptedGit((call) => {
      if (call.args[0] === "merge" && call.args[1] === "--abort") return ok("")
      if (call.args[0] === "merge-base") return fail("")
      return undefined
    })
    expect((await gitMergeAbort({ runner }, "/srv/worktrees/feature")).exitCode).toBe(0)
    expect(calls[0]?.args).toEqual(["merge", "--abort"])
    expect(await gitMergeBaseIsAncestor({ runner }, "/srv/worktrees/feature", BASE_SHA, "HEAD")).toBe(false)
    expect(calls[1]?.args).toEqual(["merge-base", "--is-ancestor", BASE_SHA, "HEAD"])
  })

  test("gitMergeBaseIsAncestor raises on exits other than 0/1", async () => {
    const { runner } = scriptedGit((call) =>
      call.args[0] === "merge-base" ? { exitCode: 128, stdout: "", stderr: "fatal: not a valid commit name" } : undefined,
    )
    await expect(
      gitMergeBaseIsAncestor({ runner }, "/srv/worktrees/feature", BASE_SHA, "HEAD"),
    ).rejects.toThrow(/merge-base --is-ancestor failed/)
  })

  test("gitUnmergedPaths returns only safe relative unmerged paths", async () => {
    const { runner } = scriptedGit((call) =>
      call.args[0] === "diff"
        ? ok("src/a.ts\n  src/with space.ts\n\"/quoted weird\"\n/absolute/path\n")
        : undefined,
    )
    const paths = await gitUnmergedPaths({ runner }, "/srv/worktrees/feature")
    expect(paths).toEqual(["src/a.ts", "src/with space.ts"])
    expect(paths.some((entry) => entry.startsWith("/"))).toBe(false)
    expect(paths.some((entry) => entry.startsWith('"'))).toBe(false)
  })

  test("isValidRemoteName rejects option-shaped and malformed remotes", () => {
    for (const remote of ["origin", "upstream", "origin/upstream", "gh-remote_1"]) {
      expect(isValidRemoteName(remote), `remote=${remote}`).toBe(true)
    }
    for (const remote of ["", "-evil", "-u", ".hidden", "has space", "a..b", "a@{b", "a~b", "a:b", "a?b", "a*b", "a[b", "x".repeat(256)]) {
      expect(isValidRemoteName(remote), `remote=${remote}`).toBe(false)
    }
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

  test("writes and reads back a worktree record with an exact-revision sync receipt", async () => {
    const storage = memStorage()
    const record = seedRecord(storage.values)
    await writeWorktree(storage, { ...record, sync: syncReceipt({ syncedAt: 1500 }) }, 2000)
    const read = await readWorktree(storage, "origin", "session-1")
    expect(read?.sync).toEqual(syncReceipt({ syncedAt: 1500 }))
    expect(read?.sync?.baseSha).toBe(BASE_SHA)
    expect(read?.sync?.headSha).toBe(HEAD_SHA)
    expect(read?.sync?.merged).toBe(true)
  })

  test("legacy records without a sync receipt still parse with sync undefined", async () => {
    const storage = memStorage()
    seedRecord(storage.values)
    const read = await readWorktree(storage, "origin", "session-1")
    expect(read?.sync).toBeUndefined()
  })

  test("ignores a worktree record whose sync receipt is malformed", async () => {
    const storage = memStorage()
    const record = seedRecord(storage.values)
    storage.values.set(worktreeStorageKey("origin", "session-1"), {
      ...record,
      sync: { ...syncReceipt(), baseSha: "not-a-full-sha" },
    })
    expect(await readWorktree(storage, "origin", "session-1")).toBeUndefined()
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
  test("registers the seven orchestrator_worktree tools with the shared permission", () => {
    const { tools } = collectWorktreeTools()
    expect([...tools.keys()]).toEqual([
      "worktree_list",
      "worktree_create",
      "worktree_status",
      "worktree_sync",
      "worktree_push",
      "worktree_cleanup",
      "worktree_enter",
    ])
    for (const tool of tools.values()) {
      expect(tool.options?.namespace).toBe("orchestrator")
      expect(tool.options?.permission).toBe(WORKTREE_TOOL_PERMISSION)
    }
  })

  test("registers nothing when worktree.enabled is false, including worktree_enter", () => {
    const { tools } = collectWorktreeTools({ options: parseOptions({}) })
    expect(tools.size).toBe(0)
    expect(tools.has("worktree_enter")).toBe(false)
  })

  test("gates every tool to the orchestrator agent", async () => {
    const { tools } = collectWorktreeTools()
    const worker = toolContext("session-1", "explore")
    await expect(tools.get("worktree_list")!.execute({}, worker)).rejects.toThrow(/only to the orchestrator/)
    await expect(
      tools.get("worktree_create")!.execute({ confirm: true }, worker),
    ).rejects.toThrow(/only to the orchestrator/)
    await expect(
      tools.get("worktree_enter")!.execute({}, worker),
    ).rejects.toThrow(/only to the orchestrator/)
  })

  test("worktree_enter requires no confirm flag and no allow_mutations", async () => {
    const { tools } = collectWorktreeTools({
      options: wTreeOptions({ worktree: { enabled: true, allow_mutations: false, root: "/srv/worktrees" } }),
    })
    // No tracked record: with allow_mutations off the tool still runs (it
    // never runs git) and answers truthfully instead of failing the gate.
    const output = await tools.get("worktree_enter")!.execute({}, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("no tracked worktree for this session")
  })

  describe("worktree_enter", () => {
    test("moves the invoking parent session into its tracked ready worktree with verified durable state", async () => {
      const tracked = await mkdtemp(path.join(tmpdir(), "orchestrator-enter-"))
      const session = sessionFixture({ id: "session-1", projectID: "origin", directory: "/workspace", workspaceID: "ws-1" })
      const { tools, values } = collectWorktreeTools({ session })
      seedRecord(values, { dir: tracked })

      const output = await tools.get("worktree_enter")!.execute({}, toolContext("session-1", "orchestrator"))
      const parsed = JSON.parse(output.content) as {
        entered: boolean
        directory: string
        record: WorktreeRecord
        anchor: SessionAnchor
        session: { id: string; location: { directory: string } }
        evidence: EvidenceRecord
      }

      expect(parsed.entered).toBe(true)
      const canonical = await resolveRealpath(tracked)
      expect(parsed.directory).toBe(canonical)
      // The tracked directory comes only from the durable record; the
      // invoking parent tool.sessionID is the session that moved.
      expect(session.moves).toHaveLength(1)
      expect(session.moves[0]?.sessionID).toBe("session-1")
      expect(session.moves[0]?.directory).toBe(canonical)
      expect(parsed.session.id).toBe("session-1")
      expect(parsed.session.location?.directory).toBe(canonical)

      // Helper-updated durable state: anchor, session index, and worktree
      // record are all verified after the move.
      const anchor = values.get(sessionAnchorStorageKey("origin", "session-1")) as SessionAnchor | undefined
      expect(anchor?.currentProjectID).toBe("origin")
      expect(anchor?.currentDirectory).toBe(canonical)
      const index = values.get(sessionIndexStorageKey("session-1")) as SessionIndexRecord | undefined
      expect(index?.projectID).toBe("origin")
      expect(index?.directory).toBe(canonical)
      expect(parsed.record.status).toBe("moved")
      expect((values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord).status).toBe("moved")

      // Live per-invocation evidence bound to the invoking parent session;
      // the result never claims child isolation.
      expect(parsed.evidence).toMatchObject({
        marker: "EVIDENCE_LIVE",
        freshness: "per-invocation",
        authority: "authoritative-for-tested-fields",
        source: "opencode-orchestrator.worktree.enter",
        sessionID: "session-1",
      })
      expect(evidenceSchema.safeParse(parsed.evidence).success).toBe(true)
      expect(JSON.stringify(parsed)).not.toContain("isolat")
    })

    test("reports truthfully when no tracked worktree exists", async () => {
      const { tools } = collectWorktreeTools()
      const output = await tools.get("worktree_enter")!.execute({}, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("no tracked worktree for this session")
      expect(output.content).not.toContain("evidence")
    })

    test("refuses non-ready lifecycle states truthfully", async () => {
      for (const status of ["pending", "moved", "dirty", "orphaned", "cleanup-failed"] as const) {
        const session = sessionFixture({ id: "session-1", projectID: "origin", directory: "/workspace" })
        const { tools, values } = collectWorktreeTools({ session })
        seedRecord(values, { status })
        const output = await tools.get("worktree_enter")!.execute({}, toolContext("session-1", "orchestrator"))
        expect(output.content, `status=${status}`).toContain(`tracked worktree is ${status}`)
        expect(output.content, `status=${status}`).toContain("only a ready worktree can be entered")
        expect(session.moves).toHaveLength(0)
        expect(output.content).not.toContain("evidence")
      }
    })

    test("rejects a tracked record whose directory no longer exists", async () => {
      const session = sessionFixture({ id: "session-1", projectID: "origin", directory: "/workspace" })
      const { tools, values } = collectWorktreeTools({ session })
      seedRecord(values, { dir: "/nonexistent-enter-target-xyz" })
      const output = await tools.get("worktree_enter")!.execute({}, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("worktree_enter failed")
      expect(output.content).toContain("does not exist")
      expect(session.moves).toHaveLength(0)
    })

    test("surfaces a native session.move failure redacted", async () => {
      const tracked = await mkdtemp(path.join(tmpdir(), "orchestrator-enter-"))
      const base = sessionFixture({ id: "session-1", projectID: "origin", directory: "/workspace" })
      const failing = {
        get: base.get,
        move: async () => {
          throw new Error("boom client_secret=leaked-value")
        },
      }
      const { tools, values } = collectWorktreeTools({ session: failing })
      seedRecord(values, { dir: tracked })
      const output = await tools.get("worktree_enter")!.execute({}, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("worktree_enter failed")
      expect(output.content).toContain("session move failed")
      expect(output.content).not.toContain("leaked-value")
      expect(output.content).toContain("[redacted]")
      expect(output.content).not.toContain("evidence")
    })

    test("reports helper verification failure without durable writes", async () => {
      const tracked = await mkdtemp(path.join(tmpdir(), "orchestrator-enter-"))
      const base = sessionFixture({ id: "session-1", projectID: "origin", directory: "/workspace" })
      let reads = 0
      const rogue = {
        get: async () => {
          reads += 1
          if (reads > 1) return { ...base.state(), location: { directory: "/somewhere-else" } }
          return base.get({ sessionID: "session-1" })
        },
        move: base.move,
      }
      const { tools, values } = collectWorktreeTools({ session: rogue })
      seedRecord(values, { dir: tracked })
      const output = await tools.get("worktree_enter")!.execute({}, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("verification failed")
      expect(output.content).not.toContain("evidence")
    })

    test("returns a pending receipt for a queued current-session move and requires a later verified enter", async () => {
      const tracked = await mkdtemp(path.join(tmpdir(), "orchestrator-enter-"))
      const canonical = await resolveRealpath(tracked)
      const values = new Map<string, unknown>()
      const stream = createEventStream()
      const moveCoordinator = createSessionMoveCoordinator()
      const base = sessionFixture({ id: "session-1", projectID: "origin", directory: "/workspace" })
      let current = base.state()
      const session = {
        get: async () => ({
          id: current.id,
          projectID: current.projectID,
          location: { directory: current.directory },
        }),
        move: async (input: Record<string, unknown>) => {
          // The real V2 server queues a move for the next safe boundary. Keep
          // the fake old until after the helper's bounded verification window.
          setTimeout(() => {
            current = { ...current, directory: String(input.directory) }
            stream.push({
              type: "session.moved",
              data: {
                sessionID: "session-1",
                projectID: "origin",
                location: { directory: String(input.directory) },
              },
            })
          }, 220)
        },
      }
      const { tools } = collectWorktreeTools({ values, session, moveCoordinator })
      seedRecord(values, { dir: canonical })
      values.set(sessionIndexStorageKey("session-1"), {
        version: 1,
        sessionID: "session-1",
        projectID: "origin",
        originProjectID: "origin",
        directory: "/workspace",
        updatedAt: 100,
      })
      const stop = startWorktreeEventSync(
        { event: { subscribe: () => stream }, storage: memStorage(values), moveCoordinator },
        parseOptions({}),
      )

      const first = await tools.get("worktree_enter")!.execute({}, toolContext("session-1", "orchestrator"))
      const pending = JSON.parse(first.content) as { entered: boolean; pending: boolean; message: string }
      expect(pending).toMatchObject({ entered: false, pending: true })
      expect(pending.message).toContain("do not delegate yet")
      expect((values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord).status).toBe("ready")

      await waitFor(() => (values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord | undefined)?.status === "moved")
      const second = await tools.get("worktree_enter")!.execute({}, toolContext("session-1", "orchestrator"))
      const entered = JSON.parse(second.content) as { entered: boolean; record: WorktreeRecord }
      expect(entered.entered).toBe(true)
      expect(entered.record.status).toBe("moved")
      expect(current.directory).toBe(canonical)

      await stop()
      moveCoordinator.dispose()
    })
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
    const parsed = JSON.parse(output.content) as { record: WorktreeRecord; verified: boolean; evidence: EvidenceRecord }
    expect(parsed.verified).toBe(true)
    expect(parsed.record.status).toBe("ready")
    expect(parsed.record.originProjectID).toBe("origin")
    expect(parsed.evidence).toMatchObject({
      marker: "EVIDENCE_LIVE",
      freshness: "per-invocation",
      authority: "authoritative-for-tested-fields",
      source: "opencode-orchestrator.worktree.create",
      sessionID: "session-1",
    })
    expect(parsed.evidence.mutation).toBeUndefined()
    expect(evidenceSchema.safeParse(parsed.evidence).success).toBe(true)
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

  test("status preserves moved lifecycle state when the clean worktree is still present", async () => {
    const { tools, values } = collectWorktreeTools({
      runner: scriptedGit((call) => {
        if (call.args[0] === "worktree" && call.args[1] === "list") return ok(`${MAIN_ONLY}\n\nworktree /srv/worktrees/feature`)
        if (call.args[0] === "status") return ok("")
        return undefined
      }).runner,
    })
    seedRecord(values, { status: "moved" })

    const output = await tools.get("worktree_status")!.execute({}, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as { status: string; record: WorktreeRecord }
    expect(parsed.status).toBe("moved")
    expect(parsed.record.status).toBe("moved")
    expect((values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord).status).toBe("moved")
  })

  test("sync merges the latest remote base into the tracked branch and persists an exact-revision receipt", async () => {
    const { runner, calls } = scriptedGit(syncSuccessScript())
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    // No publish/v1 record at all: sync must NOT require the publish capability.
    const output = await tools
      .get("worktree_sync")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as {
      synced: boolean
      merged: boolean
      alreadyCurrent: boolean
      baseBranch: string
      baseRef: string
      remote: string
      baseSha: string
      headSha: string
      syncedAt: number
      record: WorktreeRecord
      evidence: EvidenceRecord
    }
    expect(parsed.synced).toBe(true)
    expect(parsed.merged).toBe(true)
    expect(parsed.alreadyCurrent).toBe(false)
    expect(parsed.baseBranch).toBe("main")
    expect(parsed.baseRef).toBe("refs/heads/main")
    expect(parsed.remote).toBe("origin")
    expect(parsed.baseSha).toBe(BASE_SHA)
    expect(parsed.headSha).toBe(MERGED_HEAD_SHA)
    expect(parsed.evidence.source).toBe("opencode-orchestrator.worktree.sync")
    expect(parsed.evidence.sessionID).toBe("session-1")
    expect(evidenceSchema.safeParse(parsed.evidence).success).toBe(true)
    // The merge runs inside the tracked worktree; the fetch in the repo.
    const mergeCall = calls.find((call) => call.args[0] === "merge" && call.args[1] !== "--abort")
    expect(mergeCall?.args).toEqual(["merge", "--no-edit", "refs/remotes/origin/main"])
    expect(mergeCall?.cwd).toBe("/srv/worktrees/feature")
    const fetchCall = calls.find((call) => call.args[0] === "fetch")
    expect(fetchCall?.args).toEqual(["fetch", "origin", "refs/heads/main"])
    expect(fetchCall?.cwd).toBe("/repo")
    // Post-merge verification ran: ancestry checked, tree clean, head resolved.
    expect(calls.filter((call) => call.args[0] === "merge-base")).toHaveLength(2)
    expect(calls.filter((call) => call.args[0] === "status")).toHaveLength(2)
    // The durable record carries the exact-revision receipt.
    const persisted = values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord
    expect(persisted.sync).toEqual({
      remote: "origin",
      baseBranch: "main",
      baseRef: "refs/heads/main",
      baseSha: BASE_SHA,
      headSha: MERGED_HEAD_SHA,
      merged: true,
      syncedAt: parsed.syncedAt,
    })
  })

  test("sync records an exact receipt without creating a commit when the branch already contains the latest base", async () => {
    const { runner, calls } = scriptedGit(
      syncSuccessScript({ ancestorBefore: true, headAfter: HEAD_SHA }),
    )
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    const output = await tools
      .get("worktree_sync")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as {
      synced: boolean
      merged: boolean
      alreadyCurrent: boolean
      headSha: string
      record: WorktreeRecord
    }
    expect(parsed.synced).toBe(true)
    expect(parsed.merged).toBe(false)
    expect(parsed.alreadyCurrent).toBe(true)
    expect(parsed.headSha).toBe(HEAD_SHA)
    // No merge commit: git merge was never invoked.
    expect(calls.some((call) => call.args[0] === "merge" && call.args[1] !== "--abort")).toBe(false)
    const persisted = values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord
    expect(persisted.sync).toEqual(
      expect.objectContaining({ baseSha: BASE_SHA, headSha: HEAD_SHA, merged: false, baseBranch: "main" }),
    )
  })

  test("sync surfaces conflicts truthfully, aborts the merge, and never pushes", async () => {
    let statusCalls = 0
    let headCalls = 0
    let mergeBaseCalls = 0
    const { runner, calls } = scriptedGit((call) => {
      switch (call.args[0]) {
        case "status": {
          statusCalls += 1
          return ok(statusCalls === 1 ? "" : "")
        }
        case "fetch":
          return ok("")
        case "rev-parse": {
          if (call.args[1] === "refs/remotes/origin/main") return ok(BASE_SHA)
          if (call.args[1] === "HEAD") {
            headCalls += 1
            return ok(HEAD_SHA)
          }
          return undefined
        }
        case "merge-base": {
          mergeBaseCalls += 1
          return mergeBaseCalls === 1 ? fail("") : ok("")
        }
        case "merge": {
          if (call.args[1] === "--abort") return ok("")
          return fail("CONFLICT (content): Merge conflict in src/lib.ts")
        }
        case "diff":
          return ok("src/lib.ts\nsrc/other.ts")
        default:
          return undefined
      }
    })
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    const output = await tools
      .get("worktree_sync")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as {
      synced: boolean
      conflicted: boolean
      merged: boolean
      aborted: boolean
      treeRestored: boolean
      unmergedPaths: string[]
      message: string
    }
    expect(parsed.synced).toBe(false)
    expect(parsed.conflicted).toBe(true)
    expect(parsed.merged).toBe(false)
    expect(parsed.aborted).toBe(true)
    expect(parsed.treeRestored).toBe(true)
    expect(parsed.unmergedPaths).toEqual(["src/lib.ts", "src/other.ts"])
    expect(parsed.message).toContain("nothing was pushed")
    // The abort ran and the merge was never left half-merged; no receipt and
    // no push ever happened.
    expect(calls.some((call) => call.args[1] === "--abort")).toBe(true)
    expect(calls.filter((call) => call.args[0] === "diff" && call.args[1] === "--name-only")).toHaveLength(1)
    expect(calls.some((call) => call.args[0] === "push")).toBe(false)
    expect((values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord).sync).toBeUndefined()
    expect(output.content).not.toContain("evidence")
  })

  test("sync reports a bare merge failure (no unmerged paths) without a receipt", async () => {
    const { runner, calls } = scriptedGit(
      syncSuccessScript({
        mergeOutcome: { exitCode: 2, stdout: "", stderr: "fatal: refusing to merge unrelated histories" },
      }),
    )
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    const output = await tools
      .get("worktree_sync")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("worktree sync failed")
    expect(output.content).toContain("exited with code 2")
    expect(calls.some((call) => call.args[0] === "push")).toBe(false)
    expect((values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord).sync).toBeUndefined()
    expect(output.content).not.toContain("evidence")
  })

  test("sync refuses a dirty tracked worktree before fetching", async () => {
    const { runner, calls } = scriptedGit(syncSuccessScript({ dirtyBefore: " M file.txt" }))
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    const output = await tools
      .get("worktree_sync")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("refused")
    expect(output.content).toContain("uncommitted changes")
    expect(calls.some((call) => call.args[0] === "fetch")).toBe(false)
    expect((values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord).sync).toBeUndefined()
    expect(output.content).not.toContain("evidence")
  })

  test("sync requires a literal confirm: true and never requires the publish capability", async () => {
    const { runner } = scriptedGit(syncSuccessScript())
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    const context = toolContext("session-1", "orchestrator")
    const missing = await tools.get("worktree_sync")!.execute({}, context)
    expect(missing.content).toContain("requires confirm: true")
    const falsy = await tools.get("worktree_sync")!.execute({ confirm: false }, context)
    expect(falsy.content).toContain("requires confirm: true")
    // Even with no publish record, sync proceeds once confirmed.
    expect(values.has(publishStorageKey("origin"))).toBe(false)
  })

  test("sync requires allow_mutations but not for list", async () => {
    const { tools } = collectWorktreeTools({
      options: wTreeOptions({ worktree: { enabled: true, allow_mutations: false, root: "/srv/worktrees" } }),
    })
    const output = await tools.get("worktree_list")!.execute({}, toolContext("session-1", "orchestrator"))
    expect(output.content).toBeTruthy()
    await expect(
      tools.get("worktree_sync")!.execute({ confirm: true }, toolContext("session-1", "orchestrator")),
    ).rejects.toThrow(/allow_mutations/)
  })

  test("sync rejects unsafe branch, remote, and base tokens before any git call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    const context = toolContext("session-1", "orchestrator")
    const cases: Array<Record<string, unknown>> = [
      { confirm: true, remote: "-evil" },
      { confirm: true, remote: "a..b" },
      { confirm: true, branch: "bad..branch" },
      { confirm: true, base: "a..b" },
      { confirm: true, base: "-main" },
      { confirm: true, base: BASE_SHA },
    ]
    for (const input of cases) {
      const output = await tools.get("worktree_sync")!.execute(input, context)
      expect(output.content).toContain("refused")
      expect(output.content).not.toContain("evidence")
    }
    expect(calls).toBe(0)
  })

  test("sync resolves an explicit full-ref base to its branch name", async () => {
    const { runner, calls } = scriptedGit(syncSuccessScript({ ancestorBefore: true, headAfter: HEAD_SHA }))
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    const output = await tools
      .get("worktree_sync")!
      .execute({ confirm: true, base: "refs/heads/main" }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as { synced: boolean; baseBranch: string }
    expect(parsed.synced).toBe(true)
    expect(parsed.baseBranch).toBe("main")
    expect(calls.some((call) => call.args[0] === "fetch" && call.args[2] === "refs/heads/main")).toBe(true)
  })

  test("push passes every publication gate and verifies the exact remote head", async () => {
    const { runner, calls } = scriptedGit(pushGateScript())
    const { tools, values } = collectWorktreeTools({ runner })
    const moved = { ...seedSyncedRecord(values), status: "moved" as const }
    values.set(worktreeStorageKey("origin", "session-1"), moved)
    seedPublishGrant(values)
    seedApprovedReview(values)

    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as {
      pushed: boolean
      verified: boolean
      remote: string
      branch: string
      headSha: string
      baseSha: string
      receipt: WorktreeSyncReceipt
      evidence: EvidenceRecord
    }
    expect(parsed.pushed).toBe(true)
    expect(parsed.verified).toBe(true)
    expect(parsed.remote).toBe("origin")
    expect(parsed.branch).toBe("feature")
    expect(parsed.headSha).toBe(HEAD_SHA)
    expect(parsed.baseSha).toBe(BASE_SHA)
    expect(parsed.receipt.baseRef).toBe("refs/heads/main")
    expect(parsed.evidence.source).toBe("opencode-orchestrator.worktree.push")
    expect(parsed.evidence.sessionID).toBe("session-1")
    expect(evidenceSchema.safeParse(parsed.evidence).success).toBe(true)
    // Gate sequence: clean status, base re-fetch, tracking resolve, HEAD
    // resolve, ancestry, push, then exact ls-remote verification.
    const pushCall = calls.find((call) => call.args[0] === "push")
    expect(pushCall?.args).toEqual(["push", "--set-upstream", "origin", "feature"])
    const lsRemoteCall = calls.find((call) => call.args[0] === "ls-remote")
    expect(lsRemoteCall?.args).toEqual(["ls-remote", "origin", "refs/heads/feature"])
    expect(calls.some((call) => call.args[0] === "fetch" && call.args[2] === "refs/heads/main")).toBe(true)
    expect(calls.filter((call) => call.args[0] === "merge-base")).toHaveLength(1)
    const persisted = values.get(worktreeStorageKey("origin", "session-1")) as WorktreeRecord
    expect(persisted.status).toBe("ready")
    expect(persisted.sync?.headSha).toBe(HEAD_SHA)
  })

  test("push reports verification failure on a failed push", async () => {
    const { tools, values } = collectWorktreeTools({
      runner: scriptedGit(
        pushGateScript({
          pushOutcome: fail("error: failed to push some refs"),
        }),
      ).runner,
    })
    seedSyncedRecord(values)
    seedPublishGrant(values)
    seedApprovedReview(values)
    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("push failed")
    expect(output.content).not.toContain("evidence")
  })

  test("push reports unverified truthfully when the remote SHA differs from the pushed head", async () => {
    const wrongRemoteSha = "fff9999999999999999999999999999999999999"
    const { runner, calls } = scriptedGit(
      pushGateScript({ lsRemote: `${wrongRemoteSha}\trefs/heads/feature\n` }),
    )
    const { tools, values } = collectWorktreeTools({ runner })
    seedSyncedRecord(values)
    seedPublishGrant(values)
    seedApprovedReview(values)
    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(output.content) as {
      pushed: boolean
      verified: boolean
      expected: string
      remoteSha: string
    }
    // The push happened, but the exact remote-head check failed: the result
    // must never claim verification and carries no evidence.
    expect(parsed.pushed).toBe(true)
    expect(parsed.verified).toBe(false)
    expect(parsed.expected).toBe(HEAD_SHA)
    expect(parsed.remoteSha).toBe(wrongRemoteSha)
    expect(output.content).not.toContain("evidence")
    expect(calls.some((call) => call.args[0] === "push")).toBe(true)
  })

  test("push refuses before any git call when the durable publish grant is missing", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    const { tools, values } = collectWorktreeTools({ runner })
    seedSyncedRecord(values)
    // No publish/v1/origin record: capability 'push' is not authorized.
    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("refused")
    expect(output.content).toContain("publication capability 'push' is not authorized for project origin")
    expect(output.content).not.toContain("evidence")
    expect(calls).toBe(0)
  })

  test("push refuses a legacy record without a sync receipt, before any git call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    const { tools, values } = collectWorktreeTools({ runner })
    seedRecord(values)
    seedPublishGrant(values)
    seedApprovedReview(values)
    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("refused")
    expect(output.content).toContain("no sync receipt")
    expect(output.content).not.toContain("evidence")
    expect(calls).toBe(0)
  })

  test("push refuses without an exact-revision approved review record", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    const { tools, values } = collectWorktreeTools({ runner })
    seedSyncedRecord(values)
    seedPublishGrant(values)
    // No review record at all.
    const missing = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(missing.content).toContain("refused")
    expect(missing.content).toContain("no review record exists")
    expect(calls).toBe(0)

    // A review record bound to a different revision never authenticates.
    const mismatched = collectWorktreeTools({
      runner,
      values: new Map(values),
    })
    seedApprovedReview(mismatched.values, { headSha: "ddd4444444444444444444444444444444444444" })
    const output = await mismatched.tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("refused")
    expect(output.content).toContain("bound to a different head/base revision")
    expect(calls).toBe(0)
  })

  test("push refuses when the re-fetched remote base moved since sync", async () => {
    const { runner, calls } = scriptedGit(
      pushGateScript({ remoteBase: "ddd4444444444444444444444444444444444444" }),
    )
    const { tools, values } = collectWorktreeTools({ runner })
    seedSyncedRecord(values)
    seedPublishGrant(values)
    seedApprovedReview(values)
    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("refused")
    expect(output.content).toContain("moved since sync")
    expect(output.content).toContain(BASE_SHA)
    expect(output.content).not.toContain("evidence")
    expect(calls.some((call) => call.args[0] === "push")).toBe(false)
  })

  test("push refuses when the local head changed since sync", async () => {
    const { runner, calls } = scriptedGit(
      pushGateScript({ head: "ddd4444444444444444444444444444444444444" }),
    )
    const { tools, values } = collectWorktreeTools({ runner })
    seedSyncedRecord(values)
    seedPublishGrant(values)
    seedApprovedReview(values)
    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("refused")
    expect(output.content).toContain("local head changed since sync")
    expect(output.content).not.toContain("evidence")
    expect(calls.some((call) => call.args[0] === "push")).toBe(false)
  })

  test("push refuses when the synced base is not an ancestor of the head", async () => {
    const { runner, calls } = scriptedGit(pushGateScript({ ancestor: false }))
    const { tools, values } = collectWorktreeTools({ runner })
    seedSyncedRecord(values)
    seedPublishGrant(values)
    seedApprovedReview(values)
    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("refused")
    expect(output.content).toContain("not an ancestor")
    expect(output.content).not.toContain("evidence")
    expect(calls.some((call) => call.args[0] === "push")).toBe(false)
  })

  test("push refuses a dirty tracked worktree without pushing", async () => {
    const { runner, calls } = scriptedGit(pushGateScript({ dirty: " M file.txt" }))
    const { tools, values } = collectWorktreeTools({ runner })
    seedSyncedRecord(values)
    seedPublishGrant(values)
    seedApprovedReview(values)
    const output = await tools
      .get("worktree_push")!
      .execute({ confirm: true }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("refused")
    expect(output.content).toContain("uncommitted changes")
    expect(output.content).not.toContain("evidence")
    expect(calls.some((call) => call.args[0] === "push")).toBe(false)
  })

  test("push rejects option-shaped tokens before any gate or git call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    const { tools, values } = collectWorktreeTools({ runner })
    seedSyncedRecord(values)
    seedPublishGrant(values)
    seedApprovedReview(values)
    for (const input of [
      { confirm: true, remote: "-evil" },
      { confirm: true, branch: "bad..branch" },
    ]) {
      const output = await tools
        .get("worktree_push")!
        .execute(input, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("refused")
      expect(output.content).not.toContain("evidence")
    }
    expect(calls).toBe(0)
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
    expect(output.content).not.toContain("evidence")
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
    const parsed = JSON.parse(output.content) as { removed: boolean; directory: string; evidence: EvidenceRecord }
    expect(parsed).toMatchObject({ removed: true, directory: "/srv/worktrees/feature" })
    expect(parsed.evidence.source).toBe("opencode-orchestrator.worktree.cleanup")
    expect(parsed.evidence.marker).toBe("EVIDENCE_LIVE")
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
    const parsed = JSON.parse(output.content) as {
      worktrees: WorktreeEntry[]
      records: WorktreeRecord[]
      evidence: EvidenceRecord
    }
    expect(parsed.worktrees.map((entry) => entry.directory)).toContain("/srv/worktrees/feature")
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0]?.status).toBe("ready")
    expect(parsed.evidence.source).toBe("opencode-orchestrator.worktree.list")
    expect(evidenceSchema.safeParse(parsed.evidence).success).toBe(true)
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
    expect(output.content).not.toContain("evidence")
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

describe("worktree tool evidence", () => {
  test("every successful worktree tool result carries live per-invocation evidence", async () => {
    const { runner } = scriptedGit((call) => {
      if (call.args[0] === "worktree" && call.args[1] === "list") {
        return ok(`${MAIN_ONLY}\n\nworktree /srv/worktrees/feature`)
      }
      if (call.args[0] === "status") return ok("")
      return undefined
    })
    const { tools, values } = collectWorktreeTools({ runner })
    const seeded = newWorktree(
      {
        owner: "session-evidence",
        sessionID: "session-evidence",
        originProjectID: "origin",
        repoRoot: "/repo",
        dir: "/srv/worktrees/feature",
        branch: "feature",
        base: "main",
      },
      100,
    )
    values.set(worktreeStorageKey("origin", "session-evidence"), { ...seeded, status: "ready" })
    const context = toolContext("session-evidence", "orchestrator")
    const outputs: Array<{ name: string; content: string }> = []
    outputs.push(
      { name: "list", content: (await tools.get("worktree_list")!.execute({ repoRoot: "/repo" }, context)).content },
      { name: "status", content: (await tools.get("worktree_status")!.execute({}, context)).content },
    )
    for (const { name, content } of outputs) {
      const parsed = JSON.parse(content) as { evidence: EvidenceRecord }
      expect(parsed.evidence.marker).toBe("EVIDENCE_LIVE")
      expect(parsed.evidence.freshness).toBe("per-invocation")
      expect(parsed.evidence.authority).toBe("authoritative-for-tested-fields")
      expect(parsed.evidence.version).toBe(1)
      expect(parsed.evidence.source).toBe(`opencode-orchestrator.worktree.${name}`)
      // Per-session provenance: the evidence is bound to the invoking session.
      expect(parsed.evidence.sessionID).toBe("session-evidence")
      expect(Number.isInteger(parsed.evidence.capturedAt)).toBe(true)
      expect(parsed.evidence.capturedAt).toBeGreaterThanOrEqual(0)
      expect(parsed.evidence.mutation).toBeUndefined()
      expect(evidenceSchema.safeParse(parsed.evidence).success).toBe(true)
    }
  })

  test("worktree evidence never claims child isolation and carries only schema fields", async () => {
    const { runner } = scriptedGit(createSuccessScript())
    const { tools } = collectWorktreeTools({ runner })
    const output = await tools
      .get("worktree_create")!
      .execute(
        { repoRoot: "/repo", directory: "/srv/worktrees/feature", branch: "feature", base: "main", confirm: true },
        toolContext("session-1", "orchestrator"),
      )
    const parsed = JSON.parse(output.content) as { record: WorktreeRecord; verified: boolean; evidence: EvidenceRecord }
    // Live local operation results with durable worktree bookkeeping — NOT
    // proof of native child isolation; the evidence must never say otherwise.
    expect(parsed.verified).toBe(true)
    expect(JSON.stringify(parsed.evidence)).not.toContain("isolat")
    expect(JSON.stringify(parsed.evidence)).not.toContain("child")
    expect(Object.keys(parsed.evidence).sort()).toEqual([
      "authority",
      "capturedAt",
      "freshness",
      "marker",
      "sessionID",
      "source",
      "version",
    ])
    expect(evidenceSchema.safeParse(parsed.evidence).success).toBe(true)
  })

  test("worktree evidence and output serialize no raw secrets", async () => {
    const { runner } = scriptedGit((call) => {
      if (call.args[0] === "worktree" && call.args[1] === "list") {
        return ok(`worktree /srv/worktrees/supersecret-token\nHEAD 0123\nbranch refs/heads/feature`)
      }
      return undefined
    })
    const { tools } = collectWorktreeTools({ runner })
    const output = await tools
      .get("worktree_list")!
      .execute({ repoRoot: "/repo" }, toolContext("session-1", "orchestrator"))
    expect(output.content).not.toContain("supersecret-token")
    const parsed = JSON.parse(output.content) as { worktrees: WorktreeEntry[]; evidence: EvidenceRecord }
    expect(parsed.worktrees[0]?.directory).toContain("[redacted]")
    expect(JSON.stringify(parsed.evidence)).not.toContain("supersecret-token")
  })
})

describe("session.moved reconciliation", () => {
  test("defers a helper-owned move event until verification decides durable state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "orchestrator-event-race-"))
    const target = path.join(directory, "app")
    await mkdir(target)
    const values = new Map<string, unknown>()
    const storage = memStorage(values)
    const stream = createEventStream()
    const moveCoordinator = createSessionMoveCoordinator()
    const stop = startWorktreeEventSync({ event: { subscribe: () => stream }, storage, moveCoordinator }, parseOptions({}))
    const base = sessionFixture({ id: "session-1", projectID: "origin", directory })
    let reads = 0
    const session = {
      get: async () => {
        reads += 1
        if (reads > 1) return { ...base.state(), location: { directory: "/somewhere-else" } }
        return base.get({ sessionID: "session-1" })
      },
      move: async (input: Record<string, unknown>) => {
        await base.move(input)
        stream.push({
          type: "session.moved",
          data: { sessionID: "session-1", projectID: "origin", location: { directory: String(input.directory) } },
        })
      },
    }

    const outcome = await moveSessionToDirectory(
      {
        session,
        storage,
        location,
        moveCoordinator,
        wait: async () => {},
      },
      { sessionID: "session-1", target },
    )

    expect(outcome.ok).toBe(false)
    await new Promise((done) => setTimeout(done, 20))
    expect(values.size).toBe(0)
    await stop()
    moveCoordinator.dispose()
  })

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
