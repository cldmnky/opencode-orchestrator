import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { parseOptions, type OrchestratorOptions } from "../../src/core/config.js"
import { GH_TOOL_PERMISSION } from "../../src/core/permissions.js"
import { createRedactor } from "../../src/opencode-v2/process/redact.js"
import type { ProcessResult, ProcessRunner } from "../../src/opencode-v2/process/runner.js"
import {
  GhError,
  assertFullSha,
  assertIssueNumber,
  assertIssueShape,
  assertMergeSha,
  assertPullMergeShape,
  assertPullReviewShape,
  assertPullShape,
  assertRefSegment,
  assertRepoSlug,
  assertReviewEvent,
  branchEndpoint,
  compareRefs,
  compareEndpoint,
  createIssue,
  createPull,
  createPullReview,
  getBranchRef,
  getViewer,
  listIssues,
  listPullReviews,
  listPulls,
  markPullReady,
  mergePull,
  probeCapabilities,
  resolveRepo,
  viewIssue,
  viewPull,
  type BranchRef,
  type CapabilitiesProbe,
  type CompareResult,
  type IssueInfo,
  type PullInfo,
  type PullMergeResult,
  type PullReview,
  type RepoInfo,
} from "../../src/opencode-v2/gh/client.js"
import { addGhTools } from "../../src/opencode-v2/gh/tools.js"
import type { StorageLike } from "../../src/opencode-v2/goal/state.js"
import { evidenceSchema, type EvidenceRecord } from "../../src/opencode-v2/orchestration/evidence.js"
import type { ReviewV1Record } from "../../src/opencode-v2/observability/review.js"

const location = { directory: "/workspace", project: { id: "origin" } }

type Call = { cmd: string; args: string[]; cwd?: string; timeoutMs?: number }

type ToolLike = {
  name: string
  options?: { namespace?: string; permission?: string }
  execute(input: unknown, tool: { sessionID: string; agent: string }): Promise<{ content: string }>
}

/** Exact full git object ids used across the lifecycle tests (40 lowercase hex). */
const HEAD_SHA = "1a2b3c4d".repeat(5)
const BASE_SHA = "9f8e7d6c".repeat(5)
const OTHER_SHA = "5e6f7a8b".repeat(5)

const ISSUE = {
  id: 1001,
  number: 42,
  html_url: "https://github.com/acme/widgets/issues/42",
  title: "Fix the bug",
  state: "open",
  body: "details here",
  user: { login: "octocat" },
}

const PULL = {
  id: 2001,
  number: 7,
  html_url: "https://github.com/acme/widgets/pulls/7",
  title: "Implement the fix",
  state: "open",
  merged: false,
  user: { login: "octocat" },
  head: { ref: "feature", sha: HEAD_SHA },
  base: { ref: "main", sha: BASE_SHA },
  draft: true,
  mergeable: true,
  mergeable_state: "clean",
}

const REPO = {
  id: "R_kgDOABC",
  nameWithOwner: "acme/widgets",
  url: "https://github.com/acme/widgets",
  defaultBranchRef: { name: "main" },
}

/** Durable exact-revision APPROVED review receipt (review/v1 schema). */
const APPROVED_REVIEW: ReviewV1Record = {
  version: 1,
  taskId: "task-1",
  runId: "run-1",
  maker: "implementer",
  checker: "reviewer",
  state: "approved",
  round: 1,
  maxRounds: 2,
  reason: "approval-complete",
  requiresHuman: false,
  createdAt: 1,
  updatedAt: 2,
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
}

/**
 * Storage backing the durable publication capability and the internal review
 * receipt. `capabilities` grants the publish record for the stable project
 * "origin"; `record` (when provided) is returned for the session's review key.
 */
function lifecycleStorage(options: {
  capabilities?: readonly string[]
  record?: ReviewV1Record | undefined
  publishRecord?: unknown
} = {}): StorageLike {
  const publishRecord =
    options.publishRecord ??
    (options.capabilities
      ? {
          version: 1,
          projectID: "origin",
          enabled: true,
          capabilities: [...options.capabilities],
          updatedAt: 1,
          updatedBy: "session-1",
        }
      : undefined)
  return {
    async get(key) {
      if (key.startsWith("review/v1/")) return options.record
      if (key.startsWith("publish/v1/")) return publishRecord
      return undefined
    },
    async set() {},
    async remove() {},
  }
}

function ok(stdout = "", stderr = ""): ProcessResult {
  return { exitCode: 0, stdout, stderr }
}

function fail(stderr = "gh: error"): ProcessResult {
  return { exitCode: 1, stdout: "", stderr }
}

/** A `GET /repos/{o}/{r}/branches/{branch}` response. */
function branchJson(name: string, sha: string): string {
  return JSON.stringify({ name, commit: { sha } })
}

/** A `GET /repos/{o}/{r}/compare/{base}...{head}` response. */
function compareJson(status: string, aheadBy: number, behindBy: number, baseSha: string): string {
  return JSON.stringify({ status, ahead_by: aheadBy, behind_by: behindBy, base_commit: { sha: baseSha } })
}

/**
 * Scripted fake `gh`. Passes the parsed POST body (read from the `--input`
 * temp file) as the third argument to the script; any unhandled call throws,
 * so an unexpected invocation fails the test instead of silently passing.
 */
function scriptedGh(
  script: (call: Call, calls: Call[], body: unknown) => ProcessResult | undefined,
): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = []
  const runner: ProcessRunner = {
    async run(cmd, args, opts) {
      const call: Call = { cmd, args: [...args], cwd: opts?.cwd, timeoutMs: opts?.timeoutMs }
      calls.push(call)
      const inputIdx = args.indexOf("--input")
      let body: unknown
      if (inputIdx !== -1) {
        body = JSON.parse(await readFile(args[inputIdx + 1] ?? "", "utf8"))
      }
      const handled = await script(call, calls, body)
      if (handled) return handled
      throw new Error(`unexpected gh call: ${cmd} ${args.join(" ")}`)
    },
  }
  return { runner, calls }
}

function ghOptions(overrides: Record<string, unknown> = {}): OrchestratorOptions {
  return parseOptions({ github: { enabled: true, allow_mutations: true }, ...overrides })
}

function collectGhTools(deps: {
  options?: OrchestratorOptions
  runner?: ProcessRunner
  secrets?: readonly string[]
  storage?: StorageLike
} = {}): { tools: Map<string, ToolLike> } {
  const tools = new Map<string, ToolLike>()
  addGhTools(
    {
      add(tool) {
        tools.set(tool.name, tool as ToolLike)
      },
    },
    {
      storage: deps.storage ?? lifecycleStorage(),
      runner: deps.runner ?? scriptedGh(() => fail()).runner,
      location,
      options: deps.options ?? ghOptions(),
      secrets: deps.secrets ?? ["supersecret-token"],
    },
  )
  return { tools }
}

function toolContext(sessionID: string, agent: string): { sessionID: string; agent: string } {
  return { sessionID, agent }
}

describe("gh repo resolve", () => {
  test("resolves the cwd repo with the exact gh repo view JSON fields", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args[0] === "repo" && call.args[1] === "view") return ok(JSON.stringify(REPO))
      return undefined
    })
    const info = await resolveRepo({ runner }, { cwd: "/repo" })
    expect(info).toEqual({ id: "R_kgDOABC", nameWithOwner: "acme/widgets", url: REPO.url, defaultBranch: "main" })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(["repo", "view", "--json", "id,nameWithOwner,url,defaultBranchRef"])
    expect(calls[0]?.cwd).toBe("/repo")
  })

  test("resolves an explicit owner/repo argument", async () => {
    const { runner, calls } = scriptedGh((call) => (call.args[1] === "view" ? ok(JSON.stringify(REPO)) : undefined))
    const info = await resolveRepo({ runner }, { owner: "acme", repo: "widgets" })
    expect(info.nameWithOwner).toBe("acme/widgets")
    expect(calls[0]?.args).toEqual(["repo", "view", "acme/widgets", "--json", "id,nameWithOwner,url,defaultBranchRef"])
  })

  test("accepts defaultBranchRef as a plain string", async () => {
    const { runner } = scriptedGh((call) =>
      call.args[1] === "view" ? ok(JSON.stringify({ ...REPO, defaultBranchRef: "develop" })) : undefined,
    )
    expect((await resolveRepo({ runner }, {})).defaultBranch).toBe("develop")
  })

  test("rejects owner without repo before any runner call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    await expect(resolveRepo({ runner }, { owner: "acme" })).rejects.toThrow(/together/)
    expect(calls).toBe(0)
  })

  test("throws when the repo view JSON lacks url", async () => {
    const { runner } = scriptedGh((call) => {
      const { url: _url, ...rest } = REPO
      return call.args[1] === "view" ? ok(JSON.stringify(rest)) : undefined
    })
    await expect(resolveRepo({ runner }, {})).rejects.toThrow(/"url"/)
  })

  test("rejects sloppy owner slugs", () => {
    expect(assertRepoSlug("acme", "owner")).toBe("acme")
    for (const bad of ["ac me", "a;rm -rf", "../x", "-lead", ".hidden", "a\nb"]) {
      expect(() => assertRepoSlug(bad, "owner")).toThrow(/slug/)
    }
    expect(() => assertRepoSlug("", "owner")).toThrow(/empty/)
    expect(() => assertRepoSlug("x\0y", "owner")).toThrow(/NUL/)
  })
})

describe("gh issues", () => {
  test("createIssue posts to the fixed issues endpoint and validates the response", async () => {
    const { runner, calls } = scriptedGh((call, _calls, body) => {
      if (call.args[0] === "api" && call.args.includes("repos/acme/widgets/issues")) {
        expect(body).toEqual({ title: "Fix the bug", body: "details", labels: ["bug"] })
        return ok(JSON.stringify(ISSUE))
      }
      return undefined
    })
    const created = await createIssue({ runner }, { owner: "acme", repo: "widgets", title: " Fix the bug ", body: "details", labels: ["bug"] })
    expect(created.id).toBe(1001)
    expect(created.number).toBe(42)
    expect(created.html_url).toBe(ISSUE.html_url)

    const call = calls[0]
    expect(call?.args[0]).toBe("api")
    expect(call?.args).toEqual(["api", "--method", "POST", "--input", expect.any(String), "repos/acme/widgets/issues"])
    const inputPath = call?.args[3]
    await expect(readFile(inputPath ?? "")).rejects.toThrow() // temp body removed afterwards
  })

  test("createIssue omits empty body and labels", async () => {
    const { runner } = scriptedGh((call, _calls, body) => {
      if (call.args.includes("repos/acme/widgets/issues")) {
        expect(body).toEqual({ title: "T" })
        return ok(JSON.stringify(ISSUE))
      }
      return undefined
    })
    const created = await createIssue({ runner }, { owner: "acme", repo: "widgets", title: "T", body: "  " })
    expect(created.number).toBe(42)
  })

  test("createIssue rejects an empty title before any runner call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    await expect(createIssue({ runner }, { owner: "acme", repo: "widgets", title: "   " })).rejects.toThrow(
      /title must be a non-empty string/,
    )
    expect(calls).toBe(0)
  })

  test("createIssue throws when the response lacks html_url", async () => {
    const { runner } = scriptedGh((call) => {
      const { html_url: _url, ...rest } = ISSUE
      return call.args.includes("repos/acme/widgets/issues") ? ok(JSON.stringify(rest)) : undefined
    })
    await expect(createIssue({ runner }, { owner: "acme", repo: "widgets", title: "T" })).rejects.toThrow(/"html_url"/)
  })

  test("viewIssue uses the numbered endpoint", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/issues/42")) return ok(JSON.stringify(ISSUE))
      return undefined
    })
    const issue = await viewIssue({ runner }, { owner: "acme", repo: "widgets", number: 42 })
    expect(issue.number).toBe(42)
    expect(calls[0]?.args).toEqual(["api", "--method", "GET", "repos/acme/widgets/issues/42"])
  })

  test("listIssues returns validated items and carries the state query", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/issues")) return ok(JSON.stringify([ISSUE]))
      return undefined
    })
    const issues = await listIssues({ runner }, { owner: "acme", repo: "widgets", state: "open" })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.number).toBe(42)
    expect(calls[0]?.args).toEqual(["api", "--method", "GET", "repos/acme/widgets/issues", "-f", "state=open"])
  })

  test("listIssues throws when the response is not an array", async () => {
    const { runner } = scriptedGh((call) =>
      call.args.includes("repos/acme/widgets/issues") ? ok(JSON.stringify({ items: [] })) : undefined,
    )
    await expect(listIssues({ runner }, { owner: "acme", repo: "widgets" })).rejects.toThrow(/not an array/)
  })

  test("rejects invalid issue numbers and states before any runner call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok(JSON.stringify(ISSUE))
      },
    }
    expect(() => assertIssueNumber(0)).toThrow(/positive integer/)
    await expect(viewIssue({ runner }, { owner: "acme", repo: "widgets", number: 0 })).rejects.toThrow(/positive integer/)
    await expect(listIssues({ runner }, { owner: "acme", repo: "widgets", state: "bogus" as never })).rejects.toThrow(/state must be one of/)
    expect(calls).toBe(0)
  })

  test("assertIssueShape validates id, number, and html_url", () => {
    expect(() => assertIssueShape(null)).toThrow(/not an object/)
    expect(() => assertIssueShape({ number: 1, html_url: "u" })).toThrow(/"id"/)
    expect(() => assertIssueShape({ id: 1, html_url: "u" })).toThrow(/"number"/)
    expect(() => assertIssueShape({ id: 1, number: 1 })).toThrow(/"html_url"/)
  })
})

describe("gh pulls", () => {
  test("createPull always posts draft:true to the fixed pulls endpoint and validates the strict pull shape", async () => {
    const { runner, calls } = scriptedGh((call, _calls, body) => {
      if (call.args.includes("repos/acme/widgets/pulls")) {
        expect(body).toEqual({ title: "Implement the fix", head: "feature", base: "main", body: "why", draft: true })
        return ok(JSON.stringify(PULL))
      }
      return undefined
    })
    const created = await createPull(
      { runner },
      { owner: "acme", repo: "widgets", title: "Implement the fix", head: "feature", base: "main", body: "why" },
    )
    expect(created.number).toBe(7)
    expect(created.head).toEqual({ ref: "feature", sha: HEAD_SHA })
    expect(created.base).toEqual({ ref: "main", sha: BASE_SHA })
    expect(created.draft).toBe(true)
    expect(created.mergeable).toBe(true)
    expect(created.mergeableState).toBe("clean")
    expect(created.merged).toBe(false)
    expect(calls[0]?.args).toEqual(["api", "--method", "POST", "--input", expect.any(String), "repos/acme/widgets/pulls"])
  })

  test("createPull refuses a response that is not a draft", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls")) {
        return ok(JSON.stringify({ ...PULL, draft: false }))
      }
      return undefined
    })
    await expect(
      createPull({ runner }, { owner: "acme", repo: "widgets", title: "T", head: "f", base: "m" }),
    ).rejects.toThrow(/not a draft/)
  })

  test("createPull verifies the created head/base SHAs against the expected exact revisions", async () => {
    const { runner } = scriptedGh((call, _calls, body) => {
      if (call.args.includes("repos/acme/widgets/pulls")) {
        expect(body).toEqual({ title: "T", head: "f", base: "m", draft: true })
        return ok(JSON.stringify(PULL))
      }
      return undefined
    })
    const created = await createPull({ runner }, {
      owner: "acme",
      repo: "widgets",
      title: "T",
      head: "f",
      base: "m",
      expectedHeadSha: HEAD_SHA,
      expectedBaseSha: BASE_SHA,
    })
    expect(created.head?.sha).toBe(HEAD_SHA)
    expect(created.base?.sha).toBe(BASE_SHA)
  })

  test("createPull refuses when the created head/base SHAs drift from the expected exact revisions", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls")) {
        return ok(JSON.stringify({ ...PULL, head: { ref: "feature", sha: OTHER_SHA } }))
      }
      return undefined
    })
    await expect(
      createPull(
        { runner },
        { owner: "acme", repo: "widgets", title: "T", head: "f", base: "m", expectedHeadSha: HEAD_SHA },
      ),
    ).rejects.toThrow(/returned head/)
  })

  test("createPull rejects abbreviated or malformed expected SHAs before any runner call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok(JSON.stringify(PULL))
      },
    }
    await expect(
      createPull({ runner }, { owner: "acme", repo: "widgets", title: "T", head: "f", base: "m", expectedHeadSha: HEAD_SHA.slice(0, 7) }),
    ).rejects.toThrow(/full 40- or 64-character lowercase hex git SHA/)
    await expect(
      createPull({ runner }, { owner: "acme", repo: "widgets", title: "T", head: "f", base: "m", expectedBaseSha: "ABC" }),
    ).rejects.toThrow(/full 40- or 64-character lowercase hex git SHA/)
    expect(calls).toBe(0)
  })

  test("viewPull uses the numbered endpoint", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(PULL))
      return undefined
    })
    const pull = await viewPull({ runner }, { owner: "acme", repo: "widgets", number: 7 })
    expect(pull.number).toBe(7)
    expect(calls[0]?.args).toEqual(["api", "--method", "GET", "repos/acme/widgets/pulls/7"])
  })

  test("listPulls returns validated items", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls")) return ok(JSON.stringify([PULL]))
      return undefined
    })
    const pulls = await listPulls({ runner }, { owner: "acme", repo: "widgets", state: "closed" })
    expect(pulls).toHaveLength(1)
    expect(pulls[0]?.state).toBe("open")
    expect(calls[0]?.args).toEqual(["api", "--method", "GET", "repos/acme/widgets/pulls", "-f", "state=closed"])
  })

  // Live shapes from the orchestrator repo: the direct pull endpoint carries the
  // boolean `merged`, while the list endpoint omits it and only sets `merged_at`.
  const MERGED_PULL = {
    id: 4386918944,
    number: 4,
    html_url: "https://github.com/cldmnky/opencode-orchestrator/pull/4",
    title: "Fix the live PR list merge state",
    state: "closed",
    merged_at: "2026-08-29T10:12:34Z",
    user: { login: "octocat" },
    head: { ref: "fix", sha: "deadbeef" },
    base: { ref: "main" },
  }

  test("viewPull reports a merged PR from the direct payload's merged boolean", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify({ ...MERGED_PULL, number: 7, merged: true }))
      return undefined
    })
    const pull = await viewPull({ runner }, { owner: "acme", repo: "widgets", number: 7 })
    expect(pull.id).toBe(4386918944)
    expect(pull.html_url).toBe("https://github.com/cldmnky/opencode-orchestrator/pull/4")
    expect(pull.merged).toBe(true)
  })

  test("listPulls derives merged=true from a non-null merged_at on the list payload", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls")) return ok(JSON.stringify([MERGED_PULL]))
      return undefined
    })
    const pulls = await listPulls({ runner }, { owner: "acme", repo: "widgets", state: "all" })
    expect(pulls).toHaveLength(1)
    expect(pulls[0]?.id).toBe(4386918944)
    expect(pulls[0]?.html_url).toBe("https://github.com/cldmnky/opencode-orchestrator/pull/4")
    expect(pulls[0]?.merged).toBe(true)
    expect(calls[0]?.args).toEqual(["api", "--method", "GET", "repos/acme/widgets/pulls", "-f", "state=all"])
  })

  test("listPulls keeps merged=false when the list payload has a null merged_at", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls"))
        return ok(JSON.stringify([{ ...MERGED_PULL, merged_at: null }]))
      return undefined
    })
    const pulls = await listPulls({ runner }, { owner: "acme", repo: "widgets", state: "all" })
    expect(pulls).toHaveLength(1)
    expect(pulls[0]?.merged).toBe(false)
  })

  test("assertPullShape honors the explicit merged boolean over merged_at", () => {
    expect(assertPullShape({ ...MERGED_PULL, merged: false }).merged).toBe(false)
    expect(assertPullShape({ ...MERGED_PULL, merged: true }).merged).toBe(true)
  })

  test("assertPullShape validates id, number, and html_url", () => {
    expect(() => assertPullShape({ id: 1, number: 2 })).toThrow(/"html_url"/)
    expect(() => assertPullShape([PULL])).toThrow(/not an object/)
  })

  test("assertPullShape strictly validates draft, mergeable, mergeable_state, and base.sha when present", () => {
    expect(() => assertPullShape({ ...PULL, draft: "yes" })).toThrow(/"draft"/)
    expect(() => assertPullShape({ ...PULL, draft: null })).toThrow(/"draft"/)
    expect(() => assertPullShape({ ...PULL, mergeable: "yes" })).toThrow(/"mergeable"/)
    expect(assertPullShape({ ...PULL, mergeable: null, mergeable_state: undefined }).mergeable).toBeNull()
    expect(assertPullShape({ ...PULL, mergeable: null, mergeable_state: undefined }).mergeableState).toBeUndefined()
    expect(() => assertPullShape({ ...PULL, mergeable_state: 7 })).toThrow(/"mergeable_state"/)
    expect(assertPullShape({ ...PULL, mergeable_state: null }).mergeableState).toBeNull()
    expect(() => assertPullShape({ ...PULL, base: { ref: "main", sha: 42 } })).toThrow(/"base.sha"/)
    expect(() => assertPullShape({ ...PULL, head: { ref: "feature" } })).not.toThrow()
    expect(assertPullShape({ ...PULL, head: { ref: "feature" } }).head).toBeUndefined()
    expect(assertPullShape({ ...PULL }).draft).toBe(true)
  })

  test("assertFullSha and assertRefSegment enforce exact-revision tokens and preserve valid refs", () => {
    expect(assertFullSha(HEAD_SHA, "head")).toBe(HEAD_SHA)
    expect(() => assertFullSha(HEAD_SHA.toUpperCase(), "head")).toThrow(/lowercase hex git SHA/)
    expect(() => assertFullSha("abc1234", "head")).toThrow(/lowercase hex git SHA/)
    expect(() => assertFullSha("  ", "head")).toThrow(/lowercase hex git SHA/)
    expect(assertRefSegment("feature", "head")).toBe("feature")
    expect(assertRefSegment("feat/ure", "head")).toBe("feat/ure")
    expect(() => assertRefSegment("-x", "head")).toThrow(/must not start with '-'/)
    expect(() => assertRefSegment("a b", "head")).toThrow(/not a valid ref/)
  })

  test("encodes slashed refs as single URL path segments", () => {
    expect(branchEndpoint("acme", "widgets", "feat/ure")).toBe("repos/acme/widgets/branches/feat%2Fure")
    expect(compareEndpoint("acme", "widgets", "main", "feat/ure")).toBe(
      "repos/acme/widgets/compare/main...feat%2Fure",
    )
  })
})

describe("gh current user, branch refs, and compare", () => {
  test("getViewer reads the fixed user endpoint and validates login", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("user")) return ok(JSON.stringify({ login: "octocat" }))
      return undefined
    })
    const viewer = await getViewer({ runner })
    expect(viewer).toEqual({ login: "octocat" })
    expect(calls[0]?.args).toEqual(["api", "--method", "GET", "user"])
  })

  test("getViewer throws when login is missing or empty", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("user")) return ok(JSON.stringify({ login: "" }))
      return undefined
    })
    await expect(getViewer({ runner })).rejects.toThrow(/"login"/)
  })

  test("getBranchRef reads the fixed branch endpoint and validates the full commit sha", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/branches/feature")) {
        return ok(branchJson("feature", HEAD_SHA))
      }
      return undefined
    })
    const ref: BranchRef = await getBranchRef({ runner }, { owner: "acme", repo: "widgets", branch: "feature" })
    expect(ref).toEqual({ name: "feature", sha: HEAD_SHA })
    expect(calls[0]?.args).toEqual(["api", "--method", "GET", "repos/acme/widgets/branches/feature"])
  })

  test("getBranchRef refuses abbreviated shas and accepts slashed branch names", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/branches/short")) {
        return ok(branchJson("short", "abc1234"))
      }
      if (call.args.includes("repos/acme/widgets/branches/feat%2Fure")) {
        return ok(branchJson("feat/ure", HEAD_SHA))
      }
      return undefined
    })
    await expect(getBranchRef({ runner }, { owner: "acme", repo: "widgets", branch: "short" })).rejects.toThrow(
      /full 40- or 64-character lowercase hex git SHA/,
    )
    await expect(getBranchRef({ runner }, { owner: "acme", repo: "widgets", branch: "feat/ure" })).resolves.toEqual({
      name: "feat/ure",
      sha: HEAD_SHA,
    })
  })

  test("compareRefs derives ancestor from the fixed compare endpoint", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
        return ok(compareJson("ahead", 2, 0, BASE_SHA))
      }
      return undefined
    })
    const cmp: CompareResult = await compareRefs({ runner }, { owner: "acme", repo: "widgets", base: "main", head: "feature" })
    expect(cmp).toEqual({ status: "ahead", aheadBy: 2, behindBy: 0, baseSha: BASE_SHA, ancestor: true })
    expect(calls[0]?.args).toEqual(["api", "--method", "GET", "repos/acme/widgets/compare/main...feature"])
  })

  test("compareRefs reports non-ancestry for diverged or behind compares", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
        return ok(compareJson("diverged", 1, 1, BASE_SHA))
      }
      return undefined
    })
    const cmp = await compareRefs({ runner }, { owner: "acme", repo: "widgets", base: "main", head: "feature" })
    expect(cmp.ancestor).toBe(false)
    expect(cmp.status).toBe("diverged")
  })

  test("compareRefs accepts slashed branch names and encodes them in the endpoint", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/compare/main...feat%2Fure")) {
        return ok(compareJson("ahead", 2, 0, BASE_SHA))
      }
      return undefined
    })
    const cmp = await compareRefs({ runner }, { owner: "acme", repo: "widgets", base: "main", head: "feat/ure" })
    expect(cmp).toEqual({ status: "ahead", aheadBy: 2, behindBy: 0, baseSha: BASE_SHA, ancestor: true })
    expect(calls[0]?.args).toEqual(["api", "--method", "GET", "repos/acme/widgets/compare/main...feat%2Fure"])
  })

  test("compareRefs fails closed on unsupported status, negative counts, and missing base_commit", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
        return ok(compareJson("sideways", 0, 0, BASE_SHA))
      }
      return undefined
    })
    await expect(compareRefs({ runner }, { owner: "acme", repo: "widgets", base: "main", head: "feature" })).rejects.toThrow(
      /unsupported status/,
    )
    const { runner: runner2 } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
        return ok(compareJson("ahead", -1, 0, BASE_SHA))
      }
      return undefined
    })
    await expect(compareRefs({ runner: runner2 }, { owner: "acme", repo: "widgets", base: "main", head: "feature" })).rejects.toThrow(
      /non-negative integer/,
    )
    const { runner: runner3 } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
        return ok(JSON.stringify({ status: "ahead", ahead_by: 1, behind_by: 0 }))
      }
      return undefined
    })
    await expect(compareRefs({ runner: runner3 }, { owner: "acme", repo: "widgets", base: "main", head: "feature" })).rejects.toThrow(
      /base_commit/,
    )
  })
})

describe("gh pull ready and reviews (client)", () => {
  const READY_PULL = { ...PULL, draft: false }

  test("markPullReady POSTs to the fixed ready_for_review endpoint with no body", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls/7/ready_for_review")) return ok(JSON.stringify(READY_PULL))
      return undefined
    })
    const marked = await markPullReady({ runner }, { owner: "acme", repo: "widgets", number: 7 })
    expect(marked.draft).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(["api", "--method", "POST", "repos/acme/widgets/pulls/7/ready_for_review"])
  })

  test("createPullReview POSTs the exact commit_id and event and verifies the echoed commit_id", async () => {
    const { runner, calls } = scriptedGh((call, _calls, body) => {
      if (call.args.includes("repos/acme/widgets/pulls/7/reviews")) {
        expect(body).toEqual({ commit_id: HEAD_SHA, event: "APPROVE" })
        return ok(
          JSON.stringify({
            id: 9001,
            state: "APPROVE",
            commit_id: HEAD_SHA,
            html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-9001",
            user: { login: "reviewer-bot" },
          }),
        )
      }
      return undefined
    })
    const review = await createPullReview({ runner }, { owner: "acme", repo: "widgets", number: 7, commitId: HEAD_SHA, event: "APPROVE" })
    expect(review).toEqual({
      id: 9001,
      state: "APPROVE",
      commit_id: HEAD_SHA,
      html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-9001",
      user: { login: "reviewer-bot" },
    })
    expect(calls[0]?.args).toEqual(["api", "--method", "POST", "--input", expect.any(String), "repos/acme/widgets/pulls/7/reviews"])
  })

  test("createPullReview fails closed when the response does not echo the exact commit_id", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls/7/reviews")) {
        return ok(
          JSON.stringify({
            id: 9001,
            state: "APPROVE",
            commit_id: OTHER_SHA,
            html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-9001",
          }),
        )
      }
      return undefined
    })
    await expect(
      createPullReview({ runner }, { owner: "acme", repo: "widgets", number: 7, commitId: HEAD_SHA, event: "APPROVE" }),
    ).rejects.toThrow(/returned commit_id/)
  })

  test("createPullReview rejects abbreviated commit ids and unknown events before any runner call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    await expect(
      createPullReview({ runner }, { owner: "acme", repo: "widgets", number: 7, commitId: "abc1234", event: "APPROVE" }),
    ).rejects.toThrow(/full 40- or 64-character lowercase hex git SHA/)
    await expect(
      createPullReview({ runner }, { owner: "acme", repo: "widgets", number: 7, commitId: HEAD_SHA, event: "APROVE" as never }),
    ).rejects.toThrow(/review event must be one of/)
    expect(assertReviewEvent("APPROVE")).toBe("APPROVE")
    expect(calls).toBe(0)
  })

  test("listPullReviews returns validated review items", async () => {
    const REVIEW = {
      id: 9001,
      state: "APPROVE",
      commit_id: HEAD_SHA,
      html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-9001",
    }
    const { runner, calls } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls/7/reviews")) return ok(JSON.stringify([REVIEW]))
      return undefined
    })
    const reviews = await listPullReviews({ runner }, { owner: "acme", repo: "widgets", number: 7 })
    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.id).toBe(9001)
    expect(calls[0]?.args).toEqual(["api", "--method", "GET", "repos/acme/widgets/pulls/7/reviews"])
  })

  test("assertPullReviewShape requires id, state, and html_url; commit_id is optional", () => {
    expect(() => assertPullReviewShape({ state: "APPROVE", html_url: "u" })).toThrow(/"id"/)
    expect(() => assertPullReviewShape({ id: 1, html_url: "u" })).toThrow(/"state"/)
    expect(() => assertPullReviewShape({ id: 1, state: "APPROVE" })).toThrow(/"html_url"/)
    expect(() => assertPullReviewShape({ id: 1, state: "APPROVE", html_url: "u", commit_id: 5 })).toThrow(/"commit_id"/)
    expect(assertPullReviewShape({ id: 1, state: "APPROVE", html_url: "u" }).commit_id).toBeUndefined()
  })

  test("listPullReviews throws when the response is not an array", async () => {
    const { runner } = scriptedGh((call) =>
      call.args.includes("repos/acme/widgets/pulls/7/reviews") ? ok(JSON.stringify({ items: [] })) : undefined,
    )
    await expect(listPullReviews({ runner }, { owner: "acme", repo: "widgets", number: 7 })).rejects.toThrow(/not an array/)
  })
})

describe("gh pull merge (client)", () => {
  const HEAD_SHA_7_40 = "abc1234def567890123456789012345678901234"
  const MERGE_SHA = "9f8e7d6c5b4a39281726354b6a7c8d9e0f1a2b3c4"

  test("mergePull PUTs the expected head sha plus optional fields to the fixed merge endpoint and validates the response", async () => {
    const { runner, calls } = scriptedGh((call, _calls, body) => {
      if (call.args.includes("repos/acme/widgets/pulls/7/merge")) {
        expect(body).toEqual({ sha: HEAD_SHA_7_40, merge_method: "squash", commit_title: "Ship it", commit_message: "why" })
        return ok(JSON.stringify({ sha: MERGE_SHA, merged: true, message: "Pull Request successfully merged" }))
      }
      return undefined
    })
    const merged: PullMergeResult = await mergePull(
      { runner },
      {
        owner: "acme",
        repo: "widgets",
        number: 7,
        sha: HEAD_SHA_7_40,
        mergeMethod: "squash",
        commitTitle: " Ship it ",
        commitMessage: "why",
      },
    )
    expect(merged).toEqual({ sha: MERGE_SHA, merged: true, message: "Pull Request successfully merged" })
    expect(calls[0]?.args).toEqual(["api", "--method", "PUT", "--input", expect.any(String), "repos/acme/widgets/pulls/7/merge"])
    // The mode-0600 temp body is removed immediately after the call.
    const inputPath = calls[0]?.args[4]
    await expect(readFile(inputPath ?? "")).rejects.toThrow()
  })

  test("mergePull omits absent optional fields so a bare sha body is sent", async () => {
    const { runner } = scriptedGh((call, _calls, body) => {
      if (call.args.includes("repos/acme/widgets/pulls/7/merge")) {
        expect(body).toEqual({ sha: HEAD_SHA_7_40 })
        return ok(JSON.stringify({ sha: MERGE_SHA, merged: true, message: "merged" }))
      }
      return undefined
    })
    const merged = await mergePull({ runner }, { owner: "acme", repo: "widgets", number: 7, sha: HEAD_SHA_7_40 })
    expect(merged.merged).toBe(true)
  })

  test("mergePull rejects an invalid sha before any runner call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    await expect(mergePull({ runner }, { owner: "acme", repo: "widgets", number: 7, sha: "  " })).rejects.toThrow(
      /hexadecimal commit SHA/,
    )
    await expect(mergePull({ runner }, { owner: "acme", repo: "widgets", number: 7, sha: "abc;rm -rf" })).rejects.toThrow(
      /hexadecimal commit SHA/,
    )
    expect(assertMergeSha(HEAD_SHA_7_40)).toBe(HEAD_SHA_7_40)
    expect(calls).toBe(0)
  })

  test("mergePull rejects an invalid merge method before any runner call", async () => {
    let calls = 0
    const runner: ProcessRunner = {
      async run() {
        calls += 1
        return ok()
      },
    }
    await expect(
      mergePull({ runner }, { owner: "acme", repo: "widgets", number: 7, sha: HEAD_SHA_7_40, mergeMethod: "reword" as never }),
    ).rejects.toThrow(/mergeMethod must be one of/)
    expect(calls).toBe(0)
  })

  test("assertPullMergeShape requires sha, merged, and message", () => {
    expect(() => assertPullMergeShape(null)).toThrow(/not an object/)
    expect(() => assertPullMergeShape({ merged: true, message: "m" })).toThrow(/"sha"/)
    expect(() => assertPullMergeShape({ sha: "s", message: "m" })).toThrow(/"merged"/)
    expect(() => assertPullMergeShape({ sha: "s", merged: true })).toThrow(/"message"/)
    expect(assertPullMergeShape({ sha: MERGE_SHA, merged: true, message: "m" })).toEqual({
      sha: MERGE_SHA,
      merged: true,
      message: "m",
    })
  })

  test("mergePull raises a redacted GhError when the merge API refuses (409/422)", async () => {
    const seeded = "Merge blocked: branch protection\nclient_secret: leaked-leak\nsupersecret-token"
    const { runner } = scriptedGh((call) =>
      call.args.includes("repos/acme/widgets/pulls/7/merge") ? fail(seeded) : undefined,
    )
    const gh = { runner, redact: createRedactor(["supersecret-token"]) }
    try {
      await mergePull(gh, { owner: "acme", repo: "widgets", number: 7, sha: HEAD_SHA_7_40 })
      expect.unreachable("mergePull should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(GhError)
      const ghError = error as GhError
      expect(ghError.exitCode).toBe(1)
      expect(ghError.message).toContain("gh pr merge failed (exit 1)")
      expect(ghError.message).not.toContain("leaked-leak")
      expect(ghError.message).not.toContain("supersecret-token")
      expect(ghError.stderr).not.toContain("supersecret-token")
    }
  })
})

describe("gh error handling and redaction", () => {
  test("non-zero exits raise GhError with redacted output", async () => {
    const seeded = "client_secret: s3cret-value\ntoken: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123\nsupersecret-token"
    const { runner } = scriptedGh(() => fail(seeded))
    const gh = { runner, redact: createRedactor(["supersecret-token"]) }
    try {
      await viewIssue(gh, { owner: "acme", repo: "widgets", number: 1 })
      expect.unreachable("viewIssue should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(GhError)
      const ghError = error as GhError
      expect(ghError.exitCode).toBe(1)
      expect(ghError.message).toContain("gh issue view failed (exit 1)")
      expect(ghError.message).not.toContain("s3cret-value")
      expect(ghError.message).not.toContain("ghp_")
      expect(ghError.message).not.toContain("supersecret-token")
      expect(ghError.stderr).not.toContain("supersecret-token")
    }
  })

  test("invalid JSON responses throw a redacted parse error", async () => {
    const { runner } = scriptedGh((call) =>
      call.args.includes("repos/acme/widgets/issues") ? ok("not json token=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123") : undefined,
    )
    try {
      await listIssues({ runner }, { owner: "acme", repo: "widgets" })
      expect.unreachable("listIssues should have thrown")
    } catch (error) {
      expect((error as Error).message).toContain("invalid JSON")
      expect((error as Error).message).not.toContain("ghp_")
    }
  })

  test("probeCapabilities degrades gracefully when gh is missing", async () => {
    const { runner } = scriptedGh(() => fail("command not found"))
    const probe = await probeCapabilities({ runner })
    expect(probe.gh.available).toBe(false)
    expect(probe.auth.authenticated).toBe(false)
    expect(probe.repo).toBeNull()
  })

  test("probeCapabilities reports unavailable when spawning gh rejects", async () => {
    const runner: ProcessRunner = {
      async run() {
        throw new Error("spawn gh ENOENT")
      },
    }
    const probe = await probeCapabilities({ runner })
    expect(probe.gh.available).toBe(false)
  })

  test("probeCapabilities reports version, auth hosts, and resolved repo", async () => {
    const { runner, calls } = scriptedGh((call) => {
      if (call.args[0] === "--version") return ok("gh version 2.45.0 (2024-04-24)")
      if (call.args[0] === "auth" && call.args[1] === "status") {
        return ok("Logged in to github.com as octocat\nLogged in to github.example.com as bot")
      }
      if (call.args[1] === "view") return ok(JSON.stringify(REPO))
      return undefined
    })
    const probe: CapabilitiesProbe = await probeCapabilities({ runner }, { cwd: "/repo" })
    expect(probe.gh.available).toBe(true)
    expect(probe.gh.version).toContain("gh version 2.45.0")
    expect(probe.auth.authenticated).toBe(true)
    expect(probe.auth.hosts).toEqual(["github.com", "github.example.com"])
    expect(probe.repo?.nameWithOwner).toBe("acme/widgets")
    expect(calls.some((call) => call.args[0] === "--version")).toBe(true)
  })

  test("probeCapabilities reports auth failure and unresolved repo without throwing", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args[0] === "--version") return ok("gh version 2.45.0")
      if (call.args[0] === "auth" && call.args[1] === "status") return fail("not logged in")
      if (call.args[1] === "view") return fail("Could not resolve hostname")
      return undefined
    })
    const probe = await probeCapabilities({ runner })
    expect(probe.gh.available).toBe(true)
    expect(probe.auth.authenticated).toBe(false)
    expect(probe.repo).toBeNull()
  })
})

describe("github tools", () => {
  test("registers the github tool family with the shared permission", () => {
    const { tools } = collectGhTools()
    expect([...tools.keys()]).toEqual([
      "github_capabilities",
      "github_repo_view",
      "github_issue_view",
      "github_issue_list",
      "github_issue_create",
      "github_pr_view",
      "github_pr_list",
      "github_pr_create",
      "github_pr_ready",
      "github_pr_approve",
      "github_pr_merge",
    ])
    for (const tool of tools.values()) {
      expect(tool.options?.namespace).toBe("orchestrator")
      expect(tool.options?.permission).toBe(GH_TOOL_PERMISSION)
    }
  })

  test("registers nothing when github.enabled is false", () => {
    const { tools } = collectGhTools({ options: parseOptions({}) })
    expect(tools.size).toBe(0)
  })

  test("gates every tool to the orchestrator agent", async () => {
    const { tools } = collectGhTools()
    const worker = toolContext("session-1", "explore")
    await expect(tools.get("github_repo_view")!.execute({}, worker)).rejects.toThrow(/only to the orchestrator/)
    await expect(tools.get("github_issue_create")!.execute({ confirm: true }, worker)).rejects.toThrow(
      /only to the orchestrator/,
    )
    await expect(
      tools.get("github_pr_ready")!.execute(
        { owner: "acme", repo: "widgets", number: 7, expectedHeadSha: HEAD_SHA, confirm: true },
        worker,
      ),
    ).rejects.toThrow(/only to the orchestrator/)
    await expect(
      tools.get("github_pr_approve")!.execute(
        { owner: "acme", repo: "widgets", number: 7, expectedHeadSha: HEAD_SHA, expectedBaseSha: BASE_SHA, confirm: true },
        worker,
      ),
    ).rejects.toThrow(/only to the orchestrator/)
    await expect(
      tools.get("github_pr_merge")!.execute({ owner: "acme", repo: "widgets", number: 7, expectedHeadSha: "abc", confirm: true }, worker),
    ).rejects.toThrow(/only to the orchestrator/)
  })

  test("requires allow_mutations for the mutating tools but not for view or list", async () => {
    const { tools } = collectGhTools({ options: ghOptions({ github: { enabled: true, allow_mutations: false } }) })
    const session = toolContext("session-1", "orchestrator")
    const viewed = await tools
      .get("github_issue_view")!
      .execute({ owner: "acme", repo: "widgets", number: 1 }, session)
    expect(viewed.content).toContain("failed")
    await expect(
      tools.get("github_issue_create")!.execute({ owner: "acme", repo: "widgets", title: "T", confirm: true }, session),
    ).rejects.toThrow(/allow_mutations/)
    await expect(
      tools.get("github_pr_create")!.execute(
        { owner: "acme", repo: "widgets", title: "T", head: "f", base: "m", expectedHeadSha: HEAD_SHA, expectedBaseSha: BASE_SHA, confirm: true },
        session,
      ),
    ).rejects.toThrow(/allow_mutations/)
    await expect(
      tools.get("github_pr_ready")!.execute(
        { owner: "acme", repo: "widgets", number: 7, expectedHeadSha: HEAD_SHA, confirm: true },
        session,
      ),
    ).rejects.toThrow(/allow_mutations/)
    await expect(
      tools.get("github_pr_approve")!.execute(
        { owner: "acme", repo: "widgets", number: 7, expectedHeadSha: HEAD_SHA, expectedBaseSha: BASE_SHA, confirm: true },
        session,
      ),
    ).rejects.toThrow(/allow_mutations/)
    await expect(
      tools.get("github_pr_merge")!.execute(
        { owner: "acme", repo: "widgets", number: 7, expectedHeadSha: "abc", confirm: true },
        session,
      ),
    ).rejects.toThrow(/allow_mutations/)
  })

  test("create requires a literal confirm: true", async () => {
    const { tools } = collectGhTools()
    const session = toolContext("session-1", "orchestrator")
    const missing = await tools
      .get("github_issue_create")!
      .execute({ owner: "acme", repo: "widgets", title: "T" }, session)
    expect(missing.content).toContain("requires confirm: true")
    const falsy = await tools
      .get("github_issue_create")!
      .execute({ owner: "acme", repo: "widgets", title: "T", confirm: false }, session)
    expect(falsy.content).toContain("requires confirm: true")
  })

  test("ready and approve require a literal confirm: true", async () => {
    const { tools } = collectGhTools()
    const session = toolContext("session-1", "orchestrator")
    const ready = await tools
      .get("github_pr_ready")!
      .execute({ owner: "acme", repo: "widgets", number: 7, expectedHeadSha: HEAD_SHA }, session)
    expect(ready.content).toContain("github_pr_ready requires confirm: true")
    const readyFalsy = await tools
      .get("github_pr_ready")!
      .execute({ owner: "acme", repo: "widgets", number: 7, expectedHeadSha: HEAD_SHA, confirm: false }, session)
    expect(readyFalsy.content).toContain("github_pr_ready requires confirm: true")
    const approve = await tools
      .get("github_pr_approve")!
      .execute(
        { owner: "acme", repo: "widgets", number: 7, expectedHeadSha: HEAD_SHA, expectedBaseSha: BASE_SHA },
        session,
      )
    expect(approve.content).toContain("github_pr_approve requires confirm: true")
  })

  test("issue_create writes through the client and reports verified evidence", async () => {
    const { runner } = scriptedGh((call, _calls, body) => {
      if (call.args.includes("repos/acme/widgets/issues")) {
        expect(body).toEqual({ title: "Ship it", labels: ["bug"] })
        return ok(JSON.stringify(ISSUE))
      }
      return undefined
    })
    const { tools } = collectGhTools({ runner })
    const output = await tools
      .get("github_issue_create")!
      .execute(
        { owner: "acme", repo: "widgets", title: "Ship it", labels: ["bug"], confirm: true },
        toolContext("session-1", "orchestrator"),
      )
    const parsed = JSON.parse(output.content) as IssueInfo & { verified: boolean; evidence: unknown }
    expect(parsed.verified).toBe(true)
    expect(parsed.number).toBe(42)
    expect(parsed.html_url).toBe(ISSUE.html_url)
    expect(parsed.evidence).toEqual({
      marker: "EVIDENCE_MUTATION",
      freshness: "per-invocation",
      authority: "authoritative-for-tested-fields",
      version: 1,
      source: "opencode-orchestrator.gh.issue.create",
      sessionID: "session-1",
      capturedAt: expect.any(Number),
      mutation: { verified: true, id: 1001, number: 42, url: ISSUE.html_url },
    })
  })

  test("issue_create failure surfaces the redacted gh error", async () => {
    const { runner } = scriptedGh(() => fail("client_secret: leaked-leak super-dupersecret"))
    const { tools } = collectGhTools({ runner, secrets: ["super-dupersecret"] })
    const output = await tools
      .get("github_issue_create")!
      .execute(
        { owner: "acme", repo: "widgets", title: "T", confirm: true },
        toolContext("session-1", "orchestrator"),
      )
    expect(output.content).toContain("github issue create failed")
    expect(output.content).not.toContain("leaked-leak")
    expect(output.content).not.toContain("super-dupersecret")
    // Errors remain redacted strings: no success evidence is attached.
    expect(output.content).not.toContain("evidence")
  })

  test("repo_view tool resolves an explicit owner/repo", async () => {
    const { runner } = scriptedGh((call) => (call.args[1] === "view" ? ok(JSON.stringify(REPO)) : undefined))
    const { tools } = collectGhTools({ runner })
    const output = await tools
      .get("github_repo_view")!
      .execute({ owner: "acme", repo: "widgets" }, toolContext("session-1", "orchestrator"))
    const repo = JSON.parse(output.content) as RepoInfo & { evidence: EvidenceRecord }
    expect(repo.nameWithOwner).toBe("acme/widgets")
    expect(repo.defaultBranch).toBe("main")
    expect(repo.evidence).toMatchObject({
      marker: "EVIDENCE_LIVE",
      freshness: "per-invocation",
      authority: "authoritative-for-tested-fields",
      version: 1,
      source: "opencode-orchestrator.gh.repo.view",
      sessionID: "session-1",
    })
    expect(repo.evidence.mutation).toBeUndefined()
    expect(evidenceSchema.safeParse(repo.evidence).success).toBe(true)
  })

  test("issue_list propagates client errors into the result", async () => {
    const { runner } = scriptedGh((call) =>
      call.args.includes("repos/acme/widgets/issues") ? fail("Not Found") : undefined,
    )
    const { tools } = collectGhTools({ runner })
    const output = await tools
      .get("github_issue_list")!
      .execute({ owner: "acme", repo: "widgets" }, toolContext("session-1", "orchestrator"))
    expect(output.content).toContain("github issue list failed")
    expect(output.content).toContain("Not Found")
    expect(output.content).not.toContain("evidence")
    expect(() => JSON.parse(output.content)).toThrow()
  })

  test("capabilities tool probes the gh binary through the fake runner", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args[0] === "--version") return ok("gh version 2.50.0")
      if (call.args[0] === "auth" && call.args[1] === "status") return fail("not logged in")
      return undefined
    })
    const { tools } = collectGhTools({ runner })
    const output = await tools
      .get("github_capabilities")!
      .execute({}, toolContext("session-1", "orchestrator"))
    const probe = JSON.parse(output.content) as CapabilitiesProbe & { evidence: EvidenceRecord }
    expect(probe.gh.available).toBe(true)
    expect(probe.auth.authenticated).toBe(false)
    expect(probe.evidence).toMatchObject({
      marker: "EVIDENCE_LIVE",
      source: "opencode-orchestrator.gh.capabilities",
      sessionID: "session-1",
    })
    expect(evidenceSchema.safeParse(probe.evidence).success).toBe(true)
  })

  test("no live gh calls: unhandled invocations throw inside the fake", async () => {
    const { runner } = scriptedGh(() => undefined)
    await expect(listIssues({ runner }, { owner: "acme", repo: "widgets" })).rejects.toThrow(/unexpected gh call/)
    await expect(resolveRepo({ runner }, {})).rejects.toThrow(/unexpected gh call/)
  })

  test("issue_list adds per-item live evidence while the top level stays an array", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/issues")) return ok(JSON.stringify([ISSUE, { ...ISSUE, id: 1002, number: 43 }]))
      return undefined
    })
    const { tools } = collectGhTools({ runner })
    const output = await tools
      .get("github_issue_list")!
      .execute({ owner: "acme", repo: "widgets", state: "open" }, toolContext("session-9", "orchestrator"))
    const issues = JSON.parse(output.content) as Array<IssueInfo & { evidence: EvidenceRecord }>
    expect(Array.isArray(issues)).toBe(true)
    expect(issues).toHaveLength(2)
    for (const issue of issues) {
      expect(issue.number).toBeGreaterThan(0)
      expect(issue.evidence).toMatchObject({
        marker: "EVIDENCE_LIVE",
        freshness: "per-invocation",
        authority: "authoritative-for-tested-fields",
        source: "opencode-orchestrator.gh.issue.list",
        sessionID: "session-9",
      })
      expect(issue.evidence.mutation).toBeUndefined()
      expect(evidenceSchema.safeParse(issue.evidence).success).toBe(true)
    }
    // The two items share one per-invocation evidence record.
    expect(issues[0]?.evidence.capturedAt).toBe(issues[1]?.evidence.capturedAt)
  })

  test("pr_list adds per-item live evidence", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/pulls")) return ok(JSON.stringify([PULL]))
      return undefined
    })
    const { tools } = collectGhTools({ runner })
    const output = await tools
      .get("github_pr_list")!
      .execute({ owner: "acme", repo: "widgets", state: "all" }, toolContext("session-1", "orchestrator"))
    const pulls = JSON.parse(output.content) as Array<PullInfo & { evidence: EvidenceRecord }>
    expect(pulls).toHaveLength(1)
    expect(pulls[0]?.title).toBe("Implement the fix")
    expect(pulls[0]?.evidence.source).toBe("opencode-orchestrator.gh.pr.list")
    expect(pulls[0]?.evidence.sessionID).toBe("session-1")
    expect(evidenceSchema.safeParse(pulls[0]?.evidence).success).toBe(true)
  })

  test("read results carry per-session provenance matching the tool context", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args.includes("repos/acme/widgets/issues/1")) return ok(JSON.stringify(ISSUE))
      if (call.args.includes("repos/acme/widgets/pulls/2")) {
        return ok(JSON.stringify({ ...PULL, number: 2 }))
      }
      return undefined
    })
    const { tools } = collectGhTools({ runner })
    const sessionA = await tools
      .get("github_issue_view")!
      .execute({ owner: "acme", repo: "widgets", number: 1 }, toolContext("session-A", "orchestrator"))
    const sessionB = await tools
      .get("github_pr_view")!
      .execute({ owner: "acme", repo: "widgets", number: 2 }, toolContext("session-B", "orchestrator"))
    const issue = JSON.parse(sessionA.content) as IssueInfo & { evidence: EvidenceRecord }
    const pull = JSON.parse(sessionB.content) as PullInfo & { evidence: EvidenceRecord }
    expect(issue.evidence.sessionID).toBe("session-A")
    expect(pull.evidence.sessionID).toBe("session-B")
    expect(issue.evidence.capturedAt).toBeGreaterThanOrEqual(0)
    expect(evidenceSchema.safeParse(pull.evidence).success).toBe(true)
  })

  test("capabilities evidence is an object property and contains only validated metadata", async () => {
    const { runner } = scriptedGh((call) => {
      if (call.args[0] === "--version") return ok("gh version 2.50.0")
      if (call.args[0] === "auth" && call.args[1] === "status") {
        return fail("token: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123")
      }
      return undefined
    })
    const { tools } = collectGhTools({ runner, secrets: ["supersecret-token"] })
    const output = await tools
      .get("github_capabilities")!
      .execute({}, toolContext("session-1", "orchestrator"))
    const serialized = output.content
    expect(serialized).not.toContain("ghp_")
    const parsed = JSON.parse(serialized) as CapabilitiesProbe & { evidence: EvidenceRecord }
    expect(parsed).toMatchObject({
      gh: { available: true, version: "gh version 2.50.0" },
      auth: { authenticated: false, hosts: [] },
      repo: null,
    })
    expect(Object.keys(parsed).sort()).toEqual(["auth", "evidence", "gh", "repo"])
    expect(JSON.stringify(parsed.evidence)).not.toContain("ghp_")
    expect(JSON.stringify(parsed.evidence)).not.toContain("supersecret-token")
    expect(evidenceSchema.safeParse(parsed.evidence).success).toBe(true)
  })

  describe("github pr create tool", () => {
    const createInput = {
      owner: "acme",
      repo: "widgets",
      title: "Implement the fix",
      head: "feature",
      base: "main",
      expectedHeadSha: HEAD_SHA,
      expectedBaseSha: BASE_SHA,
      confirm: true,
    }
    const CREATE_STORAGE = lifecycleStorage({
      capabilities: ["pr-draft-create"],
      record: APPROVED_REVIEW,
    })

    /** Scripted gh answering the create gate pipeline: refs, compare, create. */
    function createScripted() {
      return scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        if (call.args.includes("repos/acme/widgets/pulls")) return ok(JSON.stringify(PULL))
        return undefined
      })
    }

    test("performs the full publication gate pipeline (capability, receipt, ancestry, exact revisions) and reports mutation evidence", async () => {
      const { runner, calls } = createScripted()
      const { tools } = collectGhTools({ runner, storage: CREATE_STORAGE })
      const output = await tools
        .get("github_pr_create")!
        .execute(createInput, toolContext("session-1", "orchestrator"))
      const parsed = JSON.parse(output.content) as PullInfo & { verified: boolean; evidence: unknown }
      expect(parsed.verified).toBe(true)
      expect(parsed.number).toBe(7)
      expect(parsed.draft).toBe(true)
      expect(parsed.head).toEqual({ ref: "feature", sha: HEAD_SHA })
      expect(parsed.base).toEqual({ ref: "main", sha: BASE_SHA })
      expect(parsed.evidence).toEqual({
        marker: "EVIDENCE_MUTATION",
        freshness: "per-invocation",
        authority: "authoritative-for-tested-fields",
        version: 1,
        source: "opencode-orchestrator.gh.pr.create",
        sessionID: "session-1",
        capturedAt: expect.any(Number),
        mutation: { verified: true, id: 2001, number: 7, url: PULL.html_url },
      })
      expect(PULL.html_url.startsWith("https://")).toBe(true)
      // Exact sequence: head ref, base ref, compare, then the create POST.
      expect(calls.map((call) => `${call.args[2]} ${call.args.at(-1)}`)).toEqual([
        "GET repos/acme/widgets/branches/feature",
        "GET repos/acme/widgets/branches/main",
        "GET repos/acme/widgets/compare/main...feature",
        "POST repos/acme/widgets/pulls",
      ])
    })

    test("accepts established feat/... branch names without changing the exact publication gates", async () => {
      const head = "feat/ure"
      const { runner, calls } = scriptedGh((call, _calls, body) => {
        if (call.args.includes("repos/acme/widgets/branches/feat%2Fure")) return ok(branchJson(head, HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feat%2Fure")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        if (call.args.includes("repos/acme/widgets/pulls")) {
          expect(body).toMatchObject({ head, base: "main", draft: true })
          return ok(JSON.stringify({ ...PULL, head: { ref: head, sha: HEAD_SHA } }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: CREATE_STORAGE })
      const output = await tools
        .get("github_pr_create")!
        .execute({ ...createInput, head }, toolContext("session-1", "orchestrator"))
      const parsed = JSON.parse(output.content) as PullInfo & { verified: boolean }
      expect(parsed.verified).toBe(true)
      expect(parsed.head).toEqual({ ref: head, sha: HEAD_SHA })
      expect(calls.map((call) => `${call.args[2]} ${call.args.at(-1)}`)).toEqual([
        "GET repos/acme/widgets/branches/feat%2Fure",
        "GET repos/acme/widgets/branches/main",
        "GET repos/acme/widgets/compare/main...feat%2Fure",
        "POST repos/acme/widgets/pulls",
      ])
    })

    test("refuses when the durable publish capability pr-draft-create is not authorized", async () => {
      const { runner } = createScripted()
      const { tools } = collectGhTools({ runner, storage: lifecycleStorage({ record: APPROVED_REVIEW }) })
      const output = await tools
        .get("github_pr_create")!
        .execute(createInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr create refused")
      expect(output.content).toContain("pr-draft-create")
      expect(output.content).toContain("/publish enable")
      expect(() => JSON.parse(output.content)).toThrow()
    })

    test("refuses without an exact-revision approved internal receipt", async () => {
      const { runner } = createScripted()
      const { tools } = collectGhTools({
        runner,
        storage: lifecycleStorage({ capabilities: ["pr-draft-create"] }),
      })
      const output = await tools
        .get("github_pr_create")!
        .execute(createInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr create refused")
      expect(output.content).toContain("no review record")
    })

    test("refuses a receipt that is not approved or bound to a different revision", async () => {
      const pending: ReviewV1Record = { ...APPROVED_REVIEW, state: "pending", reason: "manual-start" }
      const { runner } = createScripted()
      const { tools } = collectGhTools({
        runner,
        storage: lifecycleStorage({ capabilities: ["pr-draft-create"], record: pending }),
      })
      const output = await tools
        .get("github_pr_create")!
        .execute(createInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr create refused")
      expect(output.content).toContain("pending, not approved")

      const otherRevision = { ...APPROVED_REVIEW, headSha: OTHER_SHA }
      const { runner: runner2 } = createScripted()
      const { tools: tools2 } = collectGhTools({
        runner: runner2,
        storage: lifecycleStorage({ capabilities: ["pr-draft-create"], record: otherRevision }),
      })
      const output2 = await tools2
        .get("github_pr_create")!
        .execute(createInput, toolContext("session-1", "orchestrator"))
      expect(output2.content).toContain("github pr create refused")
      expect(output2.content).toContain("bound to a different head/base revision")
    })

    test("refuses when the remote head or base no longer matches the exact reviewed revisions", async () => {
      const { runner, calls } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", OTHER_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: CREATE_STORAGE })
      const output = await tools
        .get("github_pr_create")!
        .execute(createInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr create refused")
      expect(output.content).toContain("remote head ref feature")
      expect(calls.map((call) => call.args.at(-1))).toEqual([
        "repos/acme/widgets/branches/feature",
        "repos/acme/widgets/branches/main",
        "repos/acme/widgets/compare/main...feature",
      ])
      expect(calls.some((call) => call.args.includes("POST"))).toBe(false)
    })

    test("refuses when the current remote base is not an ancestor of the remote head", async () => {
      const { runner, calls } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("diverged", 1, 2, BASE_SHA))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: CREATE_STORAGE })
      const output = await tools
        .get("github_pr_create")!
        .execute(createInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr create refused")
      expect(output.content).toContain("not an ancestor")
      expect(calls).toHaveLength(3)
    })

    test("refuses when the compare base commit disagrees with the current base ref (ancestor=false)", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, OTHER_SHA))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: CREATE_STORAGE })
      const output = await tools
        .get("github_pr_create")!
        .execute(createInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr create refused")
      expect(output.content).toContain("not an ancestor")
    })

    test("never claims success when the create API fails: the error stays a redacted string", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("identicial" as never, 0, 0, BASE_SHA))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: CREATE_STORAGE })
      const output = await tools
        .get("github_pr_create")!
        .execute(createInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr create failed")
      expect(output.content).toContain("unsupported status")
      expect(output.content).not.toContain("evidence")
    })
  })

  describe("github pr ready tool", () => {
    const readyInput = {
      owner: "acme",
      repo: "widgets",
      number: 7,
      expectedHeadSha: HEAD_SHA,
      confirm: true,
    }
    const READY_STORAGE = lifecycleStorage({ capabilities: ["pr-ready-transition"] })
    const OPEN_DRAFT = { ...PULL, state: "open", merged: false, draft: true, mergeable: true, mergeable_state: "clean" }
    const READY_DONE = { ...PULL, state: "open", merged: false, draft: false, mergeable: true, mergeable_state: "clean" }

    function readyScripted() {
      return scriptedGh((call, calls) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7/ready_for_review")) return ok(JSON.stringify(READY_DONE))
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          const views = calls.filter((c) => c.args[0] === "api" && c.args.includes("repos/acme/widgets/pulls/7"))
          return ok(JSON.stringify(views.length <= 1 ? OPEN_DRAFT : READY_DONE))
        }
        return undefined
      })
    }

    test("marks the draft ready only after fresh exact revision, ancestry, draft/mergeable/conflict gates, and a verified post-view", async () => {
      const { runner, calls } = readyScripted()
      const { tools } = collectGhTools({ runner, storage: READY_STORAGE })
      const output = await tools
        .get("github_pr_ready")!
        .execute(readyInput, toolContext("session-1", "orchestrator"))
      const parsed = JSON.parse(output.content) as PullInfo & { verified: boolean; evidence: unknown }
      expect(parsed.verified).toBe(true)
      expect(parsed.draft).toBe(false)
      expect(parsed.number).toBe(7)
      expect(parsed.evidence).toEqual({
        marker: "EVIDENCE_MUTATION",
        freshness: "per-invocation",
        authority: "authoritative-for-tested-fields",
        version: 1,
        source: "opencode-orchestrator.gh.pr.ready",
        sessionID: "session-1",
        capturedAt: expect.any(Number),
        mutation: { verified: true, id: 2001, number: 7, url: PULL.html_url },
      })
      // Exact sequence: view, head ref, base ref, compare, ready POST, post-view.
      expect(calls.map((call) => `${call.args[2]} ${call.args.at(-1)}`)).toEqual([
        "GET repos/acme/widgets/pulls/7",
        "GET repos/acme/widgets/branches/feature",
        "GET repos/acme/widgets/branches/main",
        "GET repos/acme/widgets/compare/main...feature",
        "POST repos/acme/widgets/pulls/7/ready_for_review",
        "GET repos/acme/widgets/pulls/7",
      ])
    })

    test("refuses a pull that is not a draft", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify({ ...OPEN_DRAFT, draft: false }))
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: READY_STORAGE })
      const output = await tools
        .get("github_pr_ready")!
        .execute(readyInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr ready refused")
      expect(output.content).toContain("not a draft")
    })

    test("refuses when the fresh view head does not match the expected exact revision", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          return ok(JSON.stringify({ ...OPEN_DRAFT, head: { ref: "feature", sha: OTHER_SHA } }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: READY_STORAGE })
      const output = await tools
        .get("github_pr_ready")!
        .execute(readyInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr ready refused")
      expect(output.content).toContain("expected head SHA")
    })

    test("refuses when the pull is not mergeable", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          return ok(JSON.stringify({ ...OPEN_DRAFT, mergeable: false, mergeable_state: "dirty" }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: READY_STORAGE })
      const output = await tools
        .get("github_pr_ready")!
        .execute(readyInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr ready refused")
      expect(output.content).toContain("not mergeable")
    })

    test("refuses a dirty conflict state even when mergeable is true", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          return ok(JSON.stringify({ ...OPEN_DRAFT, mergeable: true, mergeable_state: "dirty" }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: READY_STORAGE })
      const output = await tools
        .get("github_pr_ready")!
        .execute(readyInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr ready refused")
      expect(output.content).toContain("conflict state 'dirty'")
    })

    test("refuses an unknown conflict state instead of assuming it is clean", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          return ok(JSON.stringify({ ...OPEN_DRAFT, mergeable: true, mergeable_state: "unknown" }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: READY_STORAGE })
      const output = await tools
        .get("github_pr_ready")!
        .execute(readyInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr ready refused")
      expect(output.content).toContain("conflict state 'unknown'")
    })

    test("refuses when the current remote base is not an ancestor of the pull head", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("behind", 0, 1, BASE_SHA))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(OPEN_DRAFT))
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: READY_STORAGE })
      const output = await tools
        .get("github_pr_ready")!
        .execute(readyInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr ready refused")
      expect(output.content).toContain("not an ancestor")
    })

    test("refuses when the ready_for_review response still reports draft:true", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7/ready_for_review")) {
          return ok(JSON.stringify({ ...OPEN_DRAFT, draft: true }))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(OPEN_DRAFT))
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: READY_STORAGE })
      const output = await tools
        .get("github_pr_ready")!
        .execute(readyInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr ready failed")
      expect(output.content).toContain("still reports draft:true")
    })

    test("never claims success when the post-view does not confirm the draft transition", async () => {
      const { runner, calls } = scriptedGh((call, allCalls) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7/ready_for_review")) return ok(JSON.stringify(READY_DONE))
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          const views = allCalls.filter((c) => c.args[0] === "api" && c.args.includes("repos/acme/widgets/pulls/7"))
          return ok(JSON.stringify(views.length <= 1 ? OPEN_DRAFT : { ...OPEN_DRAFT, draft: true }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: READY_STORAGE })
      const output = await tools
        .get("github_pr_ready")!
        .execute(readyInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr ready failed")
      expect(output.content).toContain("post-view does not confirm the draft transition")
      expect(output.content).not.toContain("evidence")
      expect(calls).toHaveLength(6)
    })

    test("refuses without the durable publish capability pr-ready-transition", async () => {
      const { runner } = readyScripted()
      const { tools } = collectGhTools({ runner, storage: lifecycleStorage() })
      const output = await tools
        .get("github_pr_ready")!
        .execute(readyInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr ready refused")
      expect(output.content).toContain("pr-ready-transition")
    })
  })

  describe("github pr approve tool", () => {
    const approveInput = {
      owner: "acme",
      repo: "widgets",
      number: 7,
      expectedHeadSha: HEAD_SHA,
      expectedBaseSha: BASE_SHA,
      confirm: true,
    }
    const APPROVE_STORAGE = lifecycleStorage({
      capabilities: ["approve-after-review"],
      record: APPROVED_REVIEW,
    })
    const APPROVABLE = {
      ...PULL,
      state: "open",
      merged: false,
      draft: false,
      mergeable: true,
      mergeable_state: "clean",
      user: { login: "octocat" },
    }
    const CREATED_REVIEW: PullReview = {
      id: 9001,
      state: "APPROVE",
      commit_id: HEAD_SHA,
      html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-9001",
      user: { login: "reviewer-bot" },
    }

    function approveScripted() {
      return scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        if (call.args.includes("user")) return ok(JSON.stringify({ login: "reviewer-bot" }))
        if (call.args.includes("repos/acme/widgets/pulls/7/reviews") && call.args.includes("--method")) {
          if (call.args.includes("POST")) return ok(JSON.stringify(CREATED_REVIEW))
          return ok(JSON.stringify([CREATED_REVIEW]))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(APPROVABLE))
        return undefined
      })
    }

    test("approves with an exact-commit APPROVE after every gate and verifies the durable listing matches", async () => {
      const { runner, calls } = approveScripted()
      const { tools } = collectGhTools({ runner, storage: APPROVE_STORAGE })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      const parsed = JSON.parse(output.content) as PullReview & { number: number; verified: boolean; evidence: unknown }
      expect(parsed.verified).toBe(true)
      expect(parsed.id).toBe(9001)
      expect(parsed.number).toBe(7)
      expect(parsed.state).toBe("APPROVE")
      expect(parsed.commit_id).toBe(HEAD_SHA)
      expect(parsed.user).toEqual({ login: "reviewer-bot" })
      expect(parsed.html_url.startsWith("https://")).toBe(true)
      expect(parsed.evidence).toEqual({
        marker: "EVIDENCE_MUTATION",
        freshness: "per-invocation",
        authority: "authoritative-for-tested-fields",
        version: 1,
        source: "opencode-orchestrator.gh.pr.approve",
        sessionID: "session-1",
        capturedAt: expect.any(Number),
        mutation: { verified: true, id: 9001, number: 7, url: CREATED_REVIEW.html_url },
      })
      // Exact sequence: view, viewer, head ref, base ref, compare, review POST,
      // review list verification.
      expect(calls.map((call) => `${call.args[2]} ${call.args.at(-1)}`)).toEqual([
        "GET repos/acme/widgets/pulls/7",
        "GET user",
        "GET repos/acme/widgets/branches/feature",
        "GET repos/acme/widgets/branches/main",
        "GET repos/acme/widgets/compare/main...feature",
        "POST repos/acme/widgets/pulls/7/reviews",
        "GET repos/acme/widgets/pulls/7/reviews",
      ])
    })

    test("refuses when the authenticated viewer is the pull author (self-approve)", async () => {
      const { runner, calls } = scriptedGh((call) => {
        if (call.args.includes("user")) return ok(JSON.stringify({ login: "octocat" }))
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(APPROVABLE))
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: APPROVE_STORAGE })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve refused")
      expect(output.content).toContain("self-approval")
      expect(output.content).toContain("octocat")
      expect(calls.some((call) => call.args.includes("reviews"))).toBe(false)
    })

    test("refuses a pull with an unknown author", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("user")) return ok(JSON.stringify({ login: "reviewer-bot" }))
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          return ok(JSON.stringify({ ...APPROVABLE, user: undefined }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: APPROVE_STORAGE })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve refused")
      expect(output.content).toContain("unknown author")
    })

    test("refuses a pull that is still a draft", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          return ok(JSON.stringify({ ...APPROVABLE, draft: true }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: APPROVE_STORAGE })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve refused")
      expect(output.content).toContain("still a draft")
    })

    test("refuses a conflict state and never counts branch-protection states as clean", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          return ok(JSON.stringify({ ...APPROVABLE, mergeable: true, mergeable_state: "dirty" }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: APPROVE_STORAGE })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve refused")
      expect(output.content).toContain("conflict state 'dirty'")
      expect(output.content).not.toContain("verified")
    })

    test("refuses without an exact-revision approved internal receipt", async () => {
      const { runner } = approveScripted()
      const { tools } = collectGhTools({
        runner,
        storage: lifecycleStorage({ capabilities: ["approve-after-review"] }),
      })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve refused")
      expect(output.content).toContain("no review record")
    })

    test("refuses without the durable publish capability approve-after-review", async () => {
      const { runner } = approveScripted()
      const { tools } = collectGhTools({ runner, storage: lifecycleStorage({ record: APPROVED_REVIEW }) })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve refused")
      expect(output.content).toContain("approve-after-review")
    })

    test("refuses when the remote head moved past the exact reviewed revision", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", OTHER_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        if (call.args.includes("user")) return ok(JSON.stringify({ login: "reviewer-bot" }))
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(APPROVABLE))
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: APPROVE_STORAGE })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve refused")
      expect(output.content).toContain("remote head ref feature")
    })

    test("never claims success when the review create does not echo APPROVE", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        if (call.args.includes("user")) return ok(JSON.stringify({ login: "reviewer-bot" }))
        if (call.args.includes("repos/acme/widgets/pulls/7/reviews") && call.args.includes("--method")) {
          if (call.args.includes("POST")) {
            return ok(JSON.stringify({ ...CREATED_REVIEW, state: "COMMENT" }))
          }
          return ok(JSON.stringify([{ ...CREATED_REVIEW, state: "COMMENT" }]))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(APPROVABLE))
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: APPROVE_STORAGE })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve failed")
      expect(output.content).toContain("not APPROVE")
      expect(output.content).not.toContain("evidence")
    })

    test("never claims success when the durable review listing does not match the created approval", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        if (call.args.includes("user")) return ok(JSON.stringify({ login: "reviewer-bot" }))
        if (call.args.includes("repos/acme/widgets/pulls/7/reviews") && call.args.includes("--method")) {
          if (call.args.includes("POST")) return ok(JSON.stringify(CREATED_REVIEW))
          // The listing disagrees: unknown author on the durable record.
          return ok(JSON.stringify([{ ...CREATED_REVIEW, user: { login: "someone-else" } }]))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(APPROVABLE))
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: APPROVE_STORAGE })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve failed")
      expect(output.content).toContain("does not match the created approval")
      expect(output.content).not.toContain("evidence")
    })

    test("never claims success when the created review cannot be found in the listing", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", BASE_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, BASE_SHA))
        }
        if (call.args.includes("user")) return ok(JSON.stringify({ login: "reviewer-bot" }))
        if (call.args.includes("repos/acme/widgets/pulls/7/reviews") && call.args.includes("--method")) {
          if (call.args.includes("POST")) return ok(JSON.stringify(CREATED_REVIEW))
          return ok(JSON.stringify([]))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(APPROVABLE))
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: APPROVE_STORAGE })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve failed")
      expect(output.content).toContain("does not match the created approval")
      expect(output.content).not.toContain("evidence")
    })

    test("refuses when the remote base no longer matches the exact reviewed base", async () => {
      const { runner, calls } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/branches/feature")) return ok(branchJson("feature", HEAD_SHA))
        if (call.args.includes("repos/acme/widgets/branches/main")) return ok(branchJson("main", OTHER_SHA))
        if (call.args.includes("repos/acme/widgets/compare/main...feature")) {
          return ok(compareJson("ahead", 1, 0, OTHER_SHA))
        }
        if (call.args.includes("user")) return ok(JSON.stringify({ login: "reviewer-bot" }))
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(APPROVABLE))
        return undefined
      })
      const { tools } = collectGhTools({ runner, storage: APPROVE_STORAGE })
      const output = await tools
        .get("github_pr_approve")!
        .execute(approveInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr approve refused")
      expect(output.content).toContain("remote base ref main")
      expect(calls.some((call) => call.args.includes("reviews"))).toBe(false)
    })
  })

  describe("github pr merge tool", () => {
    const HEAD_SHA_7_40 = "abc1234def567890123456789012345678901234"
    const MERGE_SHA = "9f8e7d6c5b4a39281726354b6a7c8d9e0f1a2b3c4"
    const OPEN_PULL = { ...PULL, state: "open", merged: false, head: { ref: "feature", sha: HEAD_SHA_7_40 } }
    const MERGED_PULL = {
      ...PULL,
      state: "closed",
      merged: true,
      merged_at: "2026-08-31T00:00:00Z",
      head: { ref: "feature", sha: HEAD_SHA_7_40 },
    }
    const mergeInput = {
      owner: "acme",
      repo: "widgets",
      number: 7,
      expectedHeadSha: HEAD_SHA_7_40,
      confirm: true,
    }

    test("requires a literal confirm: true", async () => {
      const { tools } = collectGhTools()
      const session = toolContext("session-1", "orchestrator")
      const missing = await tools.get("github_pr_merge")!.execute({ owner: "acme", repo: "widgets", number: 7, expectedHeadSha: HEAD_SHA_7_40 }, session)
      expect(missing.content).toContain("requires confirm: true")
      const falsy = await tools
        .get("github_pr_merge")!
        .execute({ ...mergeInput, confirm: false }, session)
      expect(falsy.content).toContain("requires confirm: true")
    })

    test("requires owner, repo, number, and expectedHeadSha", async () => {
      const { tools } = collectGhTools()
      const output = await tools
        .get("github_pr_merge")!
        .execute({ owner: "acme", repo: "widgets", number: 7, confirm: true }, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("owner, repo, number, and expectedHeadSha are required")
    })

    test("runs pre-view -> merge with the expected head SHA -> verified post-view and reports mutation evidence", async () => {
      const { runner, calls } = scriptedGh((call, calls, body) => {
        if (call.args[0] === "api" && call.args.includes("--method") && call.args.includes("PUT")) {
          expect(body).toEqual({ sha: HEAD_SHA_7_40, merge_method: "squash", commit_title: "Ship it", commit_message: "why" })
          return ok(JSON.stringify({ sha: MERGE_SHA, merged: true, message: "Pull Request successfully merged" }))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          const views = calls.filter((c) => c.args[0] === "api" && c.args.includes("repos/acme/widgets/pulls/7"))
          return ok(JSON.stringify(views.length <= 1 ? OPEN_PULL : MERGED_PULL))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner })
      const output = await tools
        .get("github_pr_merge")!
        .execute(
          { ...mergeInput, mergeMethod: "squash", commitTitle: "Ship it", commitMessage: "why" },
          toolContext("session-1", "orchestrator"),
        )
      const parsed = JSON.parse(output.content) as PullInfo & {
        mergeSha: string
        mergeMessage: string
        expectedHeadSha: string
        verified: boolean
        evidence: unknown
      }
      expect(parsed.verified).toBe(true)
      expect(parsed.id).toBe(2001)
      expect(parsed.number).toBe(7)
      expect(parsed.merged).toBe(true)
      expect(parsed.mergeSha).toBe(MERGE_SHA)
      expect(parsed.expectedHeadSha).toBe(HEAD_SHA_7_40)
      expect(parsed.html_url.startsWith("https://")).toBe(true)
      expect(parsed.evidence).toEqual({
        marker: "EVIDENCE_MUTATION",
        freshness: "per-invocation",
        authority: "authoritative-for-tested-fields",
        version: 1,
        source: "opencode-orchestrator.gh.pr.merge",
        sessionID: "session-1",
        capturedAt: expect.any(Number),
        mutation: { verified: true, id: 2001, number: 7, url: PULL.html_url },
      })
      expect(evidenceSchema.safeParse(parsed.evidence).success).toBe(true)
      // Exact sequence: pre-view GET, merge PUT, post-view GET — no retries or fallbacks.
      expect(calls.map((call) => `${call.args[2]} ${call.args.at(-1)}`)).toEqual([
        "GET repos/acme/widgets/pulls/7",
        "PUT repos/acme/widgets/pulls/7/merge",
        "GET repos/acme/widgets/pulls/7",
      ])
    })

    test("refuses a stale expected head SHA before any merge call", async () => {
      const { runner, calls } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          return ok(JSON.stringify({ ...PULL, state: "open", merged: false, head: { ref: "feature", sha: "d15ea5ed" } }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner })
      const output = await tools
        .get("github_pr_merge")!
        .execute(mergeInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr merge refused")
      expect(output.content).toContain("expected head SHA")
      expect(output.content).not.toContain("evidence")
      expect(() => JSON.parse(output.content)).toThrow()
      expect(calls).toHaveLength(1)
      expect(calls[0]?.args).not.toContain("PUT")
    })

    test("refuses a PR that is already merged or not open", async () => {
      const { runner, calls } = scriptedGh((call) => {
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          return ok(JSON.stringify({ ...PULL, state: "closed", merged: true }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner })
      const output = await tools
        .get("github_pr_merge")!
        .execute(
          { ...mergeInput, expectedHeadSha: HEAD_SHA_7_40 },
          toolContext("session-1", "orchestrator"),
        )
      expect(output.content).toContain("github pr merge refused")
      expect(output.content).toContain("not open and unmerged")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.args).not.toContain("PUT")
    })

    test("never claims success when the merge API reports merged:false", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args[0] === "api" && call.args.includes("--method") && call.args.includes("PUT")) {
          return ok(JSON.stringify({ sha: HEAD_SHA_7_40, merged: false, message: "Pull Request is not mergeable" }))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(OPEN_PULL))
        return undefined
      })
      const { tools } = collectGhTools({ runner })
      const output = await tools
        .get("github_pr_merge")!
        .execute(mergeInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr merge failed")
      expect(output.content).toContain("merged:false")
      expect(output.content).not.toContain("evidence")
      expect(() => JSON.parse(output.content)).toThrow()
    })

    test("never claims success when the post-merge view does not confirm merged:true", async () => {
      const { runner, calls } = scriptedGh((call, calls) => {
        if (call.args[0] === "api" && call.args.includes("--method") && call.args.includes("PUT")) {
          return ok(JSON.stringify({ sha: MERGE_SHA, merged: true, message: "merged" }))
        }
        if (call.args.includes("repos/acme/widgets/pulls/7")) {
          const views = calls.filter((c) => c.args[0] === "api" && c.args.includes("repos/acme/widgets/pulls/7"))
          return ok(JSON.stringify(views.length <= 1 ? OPEN_PULL : { ...OPEN_PULL, state: "closed", merged: false }))
        }
        return undefined
      })
      const { tools } = collectGhTools({ runner })
      const output = await tools
        .get("github_pr_merge")!
        .execute(mergeInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr merge failed")
      expect(output.content).toContain("post-merge view")
      expect(output.content).not.toContain("evidence")
      expect(calls).toHaveLength(3)
    })

    test("failure surfaces the redacted gh error with no success evidence", async () => {
      const { runner } = scriptedGh((call) => {
        if (call.args[0] === "api" && call.args.includes("--method") && call.args.includes("PUT")) {
          return fail("Merge blocked: review required\nclient_secret: leaked-leak super-dupersecret")
        }
        if (call.args.includes("repos/acme/widgets/pulls/7")) return ok(JSON.stringify(OPEN_PULL))
        return undefined
      })
      const { tools } = collectGhTools({ runner, secrets: ["super-dupersecret"] })
      const output = await tools
        .get("github_pr_merge")!
        .execute(mergeInput, toolContext("session-1", "orchestrator"))
      expect(output.content).toContain("github pr merge failed")
      expect(output.content).not.toContain("leaked-leak")
      expect(output.content).not.toContain("super-dupersecret")
      expect(output.content).not.toContain("evidence")
      expect(() => JSON.parse(output.content)).toThrow()
    })
  })
})
