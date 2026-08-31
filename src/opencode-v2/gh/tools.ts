import type { OrchestratorOptions } from "../../core/config.js"
import { GH_TOOL_PERMISSION } from "../../core/permissions.js"
import type { Info as ToolInfo } from "@opencode-ai/plugin/promise/tool"
import type { LocationLike, StorageLike } from "../goal/state.js"
import { liveEvidence, mutationEvidence } from "../orchestration/evidence.js"
import { createRedactor } from "../process/redact.js"
import type { ProcessRunner } from "../process/runner.js"
import {
  assertIssueState,
  createIssue,
  createPull,
  listIssues,
  listPulls,
  mergePull,
  probeCapabilities,
  resolveRepo,
  viewIssue,
  viewPull,
  type GhContext,
  type PullMergeInput,
} from "./client.js"

/**
 * `orchestrator_github_*` tools (stage 3), registered via the tool transform.
 *
 * Gating mirrors the worktree family: the whole set requires `github.enabled`,
 * mutating tools (issue_create / pr_create / pr_merge) additionally require
 * `github.allow_mutations` plus a literal `confirm: true` input field, and
 * every tool is orchestrator-only via the shared `orchestrator_gh` permission
 * action plus the runtime agent check (server-side: a worker that somehow
 * reaches the execute handler is rejected regardless of visibility rules).
 *
 * `github_pr_merge` is the safe explicit-confirmation merge: it never trusts
 * the caller's SHA, method, or a `confirm: true` flag as user authorization.
 * It runs a fresh PR view, requires an open unmerged PR whose head SHA matches
 * the required `expectedHeadSha` exactly, merges with that SHA, requires
 * `merged: true`, and verifies with a second fresh view before returning any
 * success evidence. `confirm: true` is a tool flag, not proof of user
 * authorization; the caller (the orchestrator prompt) is told to merge only
 * after a separate explicit user request.
 *
 * All raw `gh` process output and error text is redacted inside the client
 * (known secret shapes plus caller-known `secrets`); only validated typed
 * evidence (API `id`, `number`, `html_url`) is serialized back to the model.
 * Every successful result additionally carries a per-invocation `evidence`
 * record (EVIDENCE_LIVE for probes/reads, EVIDENCE_MUTATION with an https
 * mutation proof for creates/merges) sourced from `tool.sessionID` +
 * `Date.now()`. Error results stay redacted strings and carry no evidence.
 * `storage` and `location` are accepted for the stage contract but not yet
 * used; durable GitHub records are a later stage.
 */

type ToolDraftLike = {
  add(tool: ToolInfo<any, undefined>): void
}

type ToolResult = { content: string }

export type GhToolsDeps = {
  storage: StorageLike
  runner: ProcessRunner
  location: LocationLike
  options: OrchestratorOptions
  secrets?: readonly string[]
}

export function addGhTools(draft: ToolDraftLike, deps: GhToolsDeps): void {
  if (!deps.options.github.enabled) return

  const gh: GhContext = {
    runner: deps.runner,
    redact: createRedactor(deps.secrets),
  }

  draft.add({
    name: "github_capabilities",
    description: "Probe the gh CLI: binary availability, auth state, and the resolved repository.",
    input: capabilitiesInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      try {
        const probe = await probeCapabilities(gh, { cwd: stringField(input, "cwd") || undefined })
        const evidence = liveEvidence({
          source: "opencode-orchestrator.gh.capabilities",
          sessionID: tool.sessionID,
        })
        return result(JSON.stringify({ ...probe, evidence }, null, 2))
      } catch (error) {
        return result(`github capabilities probe failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "github_repo_view",
    description: "Resolve and view a repository: from the cwd, or owner/repo explicitly.",
    input: repoViewInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const owner = stringField(input, "owner")
      const repo = stringField(input, "repo")
      try {
        const info = await resolveRepo(gh, {
          owner: owner || undefined,
          repo: repo || undefined,
          cwd: stringField(input, "cwd") || undefined,
        })
        const evidence = liveEvidence({ source: "opencode-orchestrator.gh.repo.view", sessionID: tool.sessionID })
        return result(JSON.stringify({ ...info, evidence }))
      } catch (error) {
        return result(`github repo view failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "github_issue_view",
    description: "View a single GitHub issue by number.",
    input: issueViewInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const owner = stringField(input, "owner")
      const repo = stringField(input, "repo")
      const number = numberField(input, "number")
      if (!owner || !repo || number === undefined) return result("owner, repo, and number are required")
      try {
        const issue = await viewIssue(gh, { owner, repo, number })
        const evidence = liveEvidence({ source: "opencode-orchestrator.gh.issue.view", sessionID: tool.sessionID })
        return result(JSON.stringify({ ...issue, evidence }))
      } catch (error) {
        return result(`github issue view failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "github_issue_list",
    description: "List GitHub issues (state: open, closed, or all).",
    input: issueListInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const owner = stringField(input, "owner")
      const repo = stringField(input, "repo")
      const state = stringField(input, "state")
      if (!owner || !repo) return result("owner and repo are required")
      try {
        const issues = await listIssues(gh, { owner, repo, state: state ? assertIssueState(state) : undefined })
        const evidence = liveEvidence({ source: "opencode-orchestrator.gh.issue.list", sessionID: tool.sessionID })
        return result(JSON.stringify(issues.map((issue) => ({ ...issue, evidence }))))
      } catch (error) {
        return result(`github issue list failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "github_issue_create",
    description: "Create a GitHub issue. Requires confirm: true.",
    input: issueCreateInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      requireMutations(deps.options)
      if (inputConfirm(input) !== true) return result("github_issue_create requires confirm: true")
      const owner = stringField(input, "owner")
      const repo = stringField(input, "repo")
      const title = stringField(input, "title")
      const body = stringField(input, "body")
      const labels = arrayField(input, "labels")
      if (!owner || !repo || !title) return result("owner, repo, and title are required")
      try {
        const created = await createIssue(gh, { owner, repo, title, body: body || undefined, labels })
        const evidence = mutationEvidence({
          source: "opencode-orchestrator.gh.issue.create",
          sessionID: tool.sessionID,
          proof: { id: created.id, number: created.number, url: created.html_url },
        })
        return result(JSON.stringify({ ...created, verified: true, evidence }))
      } catch (error) {
        return result(`github issue create failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "github_pr_view",
    description: "View a single GitHub pull request by number.",
    input: prViewInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const owner = stringField(input, "owner")
      const repo = stringField(input, "repo")
      const number = numberField(input, "number")
      if (!owner || !repo || number === undefined) return result("owner, repo, and number are required")
      try {
        const pull = await viewPull(gh, { owner, repo, number })
        const evidence = liveEvidence({ source: "opencode-orchestrator.gh.pr.view", sessionID: tool.sessionID })
        return result(JSON.stringify({ ...pull, evidence }))
      } catch (error) {
        return result(`github pr view failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "github_pr_list",
    description: "List GitHub pull requests (state: open, closed, or all).",
    input: prListInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const owner = stringField(input, "owner")
      const repo = stringField(input, "repo")
      const state = stringField(input, "state")
      if (!owner || !repo) return result("owner and repo are required")
      try {
        const pulls = await listPulls(gh, { owner, repo, state: state ? assertIssueState(state) : undefined })
        const evidence = liveEvidence({ source: "opencode-orchestrator.gh.pr.list", sessionID: tool.sessionID })
        return result(JSON.stringify(pulls.map((pull) => ({ ...pull, evidence }))))
      } catch (error) {
        return result(`github pr list failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "github_pr_create",
    description: "Create a GitHub pull request. Requires confirm: true.",
    input: prCreateInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      requireMutations(deps.options)
      if (inputConfirm(input) !== true) return result("github_pr_create requires confirm: true")
      const owner = stringField(input, "owner")
      const repo = stringField(input, "repo")
      const title = stringField(input, "title")
      const head = stringField(input, "head")
      const base = stringField(input, "base")
      const body = stringField(input, "body")
      const draft = booleanField(input, "draft")
      if (!owner || !repo || !title || !head || !base) {
        return result("owner, repo, title, head, and base are required")
      }
      try {
        const created = await createPull(gh, { owner, repo, title, head, base, body: body || undefined, draft })
        const evidence = mutationEvidence({
          source: "opencode-orchestrator.gh.pr.create",
          sessionID: tool.sessionID,
          proof: { id: created.id, number: created.number, url: created.html_url },
        })
        return result(JSON.stringify({ ...created, verified: true, evidence }))
      } catch (error) {
        return result(`github pr create failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "github_pr_merge",
    description:
      "Merge a GitHub pull request after a fresh view, the exact expected head SHA, and post-merge verification. Requires confirm: true and a separate explicit user request.",
    input: prMergeInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      requireMutations(deps.options)
      if (inputConfirm(input) !== true) return result("github_pr_merge requires confirm: true")
      const owner = stringField(input, "owner")
      const repo = stringField(input, "repo")
      const number = numberField(input, "number")
      const expectedHeadSha = stringField(input, "expectedHeadSha")
      const mergeMethod = stringField(input, "mergeMethod")
      const commitTitle = stringField(input, "commitTitle")
      const commitMessage = stringField(input, "commitMessage")
      if (!owner || !repo || number === undefined || !expectedHeadSha) {
        return result("owner, repo, number, and expectedHeadSha are required")
      }
      const merge: PullMergeInput = {
        owner,
        repo,
        number,
        sha: expectedHeadSha,
        mergeMethod: mergeMethod ? (mergeMethod as PullMergeInput["mergeMethod"]) : undefined,
        commitTitle: commitTitle || undefined,
        commitMessage: commitMessage || undefined,
      }
      try {
        // Fresh pre-view: the PR must be open and unmerged, and its head SHA
        // must match the required expected head SHA exactly. A stale or moved
        // head refuses before any merge call; nothing is retried or fallen
        // back to a different SHA.
        const before = await viewPull(gh, { owner, repo, number })
        if (before.merged || before.state !== "open") {
          return result(`github pr merge refused: pull ${owner}/${repo}#${number} is not open and unmerged`)
        }
        if (before.head?.sha !== expectedHeadSha) {
          return result(
            `github pr merge refused: expected head SHA does not match pull ${owner}/${repo}#${number} (head ${before.head?.sha ?? "(unknown)"})`,
          )
        }

        const merged = await mergePull(gh, merge)
        if (!merged.merged) {
          return result(`github pr merge failed: API reported merged:false (${merged.message || "no message"})`)
        }

        // Post-merge verification: a second fresh view must confirm the merge.
        const after = await viewPull(gh, { owner, repo, number })
        if (!after.merged) {
          return result("github pr merge failed: post-merge view does not confirm merged:true")
        }

        const evidence = mutationEvidence({
          source: "opencode-orchestrator.gh.pr.merge",
          sessionID: tool.sessionID,
          proof: { id: after.id, number: after.number, url: after.html_url },
        })
        return result(
          JSON.stringify({
            ...after,
            mergeSha: merged.sha,
            mergeMessage: merged.message,
            expectedHeadSha,
            verified: true,
            evidence,
          }),
        )
      } catch (error) {
        return result(`github pr merge failed: ${message(error)}`)
      }
    },
  })
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) {
    throw new Error("github tools are available only to the orchestrator")
  }
}

function requireMutations(options: OrchestratorOptions): void {
  if (!options.github.enabled) throw new Error("github tools require github.enabled")
  if (!options.github.allow_mutations) {
    throw new Error("github mutations require github.allow_mutations")
  }
}

function inputConfirm(input: unknown): unknown {
  if (!input || typeof input !== "object") return undefined
  return (input as Record<string, unknown>).confirm
}

function stringField(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return ""
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "string" ? value.trim() : ""
}

function numberField(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== "object") return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanField(input: unknown, key: string): boolean {
  if (!input || typeof input !== "object") return false
  return (input as Record<string, unknown>)[key] === true
}

function arrayField(input: unknown, key: string): string[] {
  if (!input || typeof input !== "object") return []
  const value = (input as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function result(content: string): ToolResult {
  return { content }
}

const capabilitiesInput = {
  type: "object",
  properties: {
    cwd: { type: "string" },
  },
  additionalProperties: false,
} as const

const repoViewInput = {
  type: "object",
  properties: {
    owner: { type: "string" },
    repo: { type: "string" },
    cwd: { type: "string" },
  },
  additionalProperties: false,
} as const

const issueCreateInput = {
  type: "object",
  properties: {
    owner: { type: "string", minLength: 1 },
    repo: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    body: { type: "string" },
    labels: { type: "array", items: { type: "string" }, maxItems: 20 },
    confirm: { type: "boolean" },
  },
  required: ["owner", "repo", "title", "confirm"],
  additionalProperties: false,
} as const

const issueViewInput = {
  type: "object",
  properties: {
    owner: { type: "string", minLength: 1 },
    repo: { type: "string", minLength: 1 },
    number: { type: "number", minimum: 1 },
  },
  required: ["owner", "repo", "number"],
  additionalProperties: false,
} as const

const issueListInput = {
  type: "object",
  properties: {
    owner: { type: "string", minLength: 1 },
    repo: { type: "string", minLength: 1 },
    state: { type: "string", enum: ["open", "closed", "all"] },
  },
  required: ["owner", "repo"],
  additionalProperties: false,
} as const

const prCreateInput = {
  type: "object",
  properties: {
    owner: { type: "string", minLength: 1 },
    repo: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    head: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 },
    body: { type: "string" },
    draft: { type: "boolean" },
    confirm: { type: "boolean" },
  },
  required: ["owner", "repo", "title", "head", "base", "confirm"],
  additionalProperties: false,
} as const

const prViewInput = {
  type: "object",
  properties: {
    owner: { type: "string", minLength: 1 },
    repo: { type: "string", minLength: 1 },
    number: { type: "number", minimum: 1 },
  },
  required: ["owner", "repo", "number"],
  additionalProperties: false,
} as const

const prListInput = {
  type: "object",
  properties: {
    owner: { type: "string", minLength: 1 },
    repo: { type: "string", minLength: 1 },
    state: { type: "string", enum: ["open", "closed", "all"] },
  },
  required: ["owner", "repo"],
  additionalProperties: false,
} as const

const prMergeInput = {
  type: "object",
  properties: {
    owner: { type: "string", minLength: 1 },
    repo: { type: "string", minLength: 1 },
    number: { type: "number", minimum: 1 },
    expectedHeadSha: { type: "string", pattern: "^[A-Fa-f0-9]{7,40}$", minLength: 1 },
    mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"] },
    commitTitle: { type: "string" },
    commitMessage: { type: "string" },
    confirm: { type: "boolean" },
  },
  required: ["owner", "repo", "number", "expectedHeadSha", "confirm"],
  additionalProperties: false,
} as const