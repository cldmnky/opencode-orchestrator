import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { parseOptions, type OrchestratorOptions } from "../../src/core/config.js"
import { GH_TOOL_PERMISSION } from "../../src/core/permissions.js"
import { createRedactor } from "../../src/opencode-v2/process/redact.js"
import type { ProcessResult, ProcessRunner } from "../../src/opencode-v2/process/runner.js"
import {
  GhError,
  assertIssueNumber,
  assertIssueShape,
  assertPullShape,
  assertRepoSlug,
  createIssue,
  createPull,
  listIssues,
  listPulls,
  probeCapabilities,
  resolveRepo,
  viewIssue,
  viewPull,
  type CapabilitiesProbe,
  type IssueInfo,
  type PullInfo,
  type RepoInfo,
} from "../../src/opencode-v2/gh/client.js"
import { addGhTools } from "../../src/opencode-v2/gh/tools.js"

const location = { directory: "/workspace", project: { id: "origin" } }

type Call = { cmd: string; args: string[]; cwd?: string; timeoutMs?: number }

type ToolLike = {
  name: string
  options?: { namespace?: string; permission?: string }
  execute(input: unknown, tool: { sessionID: string; agent: string }): Promise<{ content: string }>
}

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
  head: { ref: "feature", sha: "abc1234" },
  base: { ref: "main" },
}

const REPO = {
  id: "R_kgDOABC",
  nameWithOwner: "acme/widgets",
  url: "https://github.com/acme/widgets",
  defaultBranchRef: { name: "main" },
}

function ok(stdout = "", stderr = ""): ProcessResult {
  return { exitCode: 0, stdout, stderr }
}

function fail(stderr = "gh: error"): ProcessResult {
  return { exitCode: 1, stdout: "", stderr }
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
} = {}): { tools: Map<string, ToolLike> } {
  const tools = new Map<string, ToolLike>()
  addGhTools(
    {
      add(tool) {
        tools.set(tool.name, tool as ToolLike)
      },
    },
    {
      storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
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
  test("createPull posts head/base/draft to the fixed pulls endpoint", async () => {
    const { runner, calls } = scriptedGh((call, _calls, body) => {
      if (call.args.includes("repos/acme/widgets/pulls")) {
        expect(body).toEqual({ title: "Implement the fix", head: "feature", base: "main", body: "why", draft: true })
        return ok(JSON.stringify(PULL))
      }
      return undefined
    })
    const created = await createPull(
      { runner },
      { owner: "acme", repo: "widgets", title: "Implement the fix", head: "feature", base: "main", body: "why", draft: true },
    )
    expect(created.number).toBe(7)
    expect(created.head).toEqual({ ref: "feature", sha: "abc1234" })
    expect(created.base).toEqual({ ref: "main" })
    expect(created.merged).toBe(false)
    expect(calls[0]?.args).toEqual(["api", "--method", "POST", "--input", expect.any(String), "repos/acme/widgets/pulls"])
  })

  test("createPull omits draft when false", async () => {
    const { runner } = scriptedGh((call, _calls, body) => {
      if (call.args.includes("repos/acme/widgets/pulls")) {
        expect(body).toEqual({ title: "T", head: "f", base: "m" })
        return ok(JSON.stringify(PULL))
      }
      return undefined
    })
    expect((await createPull({ runner }, { owner: "acme", repo: "widgets", title: "T", head: "f", base: "m" })).id).toBe(2001)
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
  })

  test("requires allow_mutations for create but not for view or list", async () => {
    const { tools } = collectGhTools({ options: ghOptions({ github: { enabled: true, allow_mutations: false } }) })
    const session = toolContext("session-1", "orchestrator")
    const viewed = await tools
      .get("github_issue_view")!
      .execute({ owner: "acme", repo: "widgets", number: 1 }, session)
    expect(viewed.content).toContain("failed")
    await expect(
      tools.get("github_issue_create")!.execute({ owner: "acme", repo: "widgets", title: "T", confirm: true }, session),
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
    const parsed = JSON.parse(output.content) as IssueInfo & { verified: boolean }
    expect(parsed.verified).toBe(true)
    expect(parsed.number).toBe(42)
    expect(parsed.html_url).toBe(ISSUE.html_url)
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
  })

  test("repo_view tool resolves an explicit owner/repo", async () => {
    const { runner } = scriptedGh((call) => (call.args[1] === "view" ? ok(JSON.stringify(REPO)) : undefined))
    const { tools } = collectGhTools({ runner })
    const output = await tools
      .get("github_repo_view")!
      .execute({ owner: "acme", repo: "widgets" }, toolContext("session-1", "orchestrator"))
    const repo = JSON.parse(output.content) as RepoInfo
    expect(repo.nameWithOwner).toBe("acme/widgets")
    expect(repo.defaultBranch).toBe("main")
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
    const probe = JSON.parse(output.content) as CapabilitiesProbe
    expect(probe.gh.available).toBe(true)
    expect(probe.auth.authenticated).toBe(false)
  })

  test("no live gh calls: unhandled invocations throw inside the fake", async () => {
    const { runner } = scriptedGh(() => undefined)
    await expect(listIssues({ runner }, { owner: "acme", repo: "widgets" })).rejects.toThrow(/unexpected gh call/)
    await expect(resolveRepo({ runner }, {})).rejects.toThrow(/unexpected gh call/)
  })
})