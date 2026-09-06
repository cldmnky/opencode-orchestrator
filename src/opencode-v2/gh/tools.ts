import type { OrchestratorOptions } from "../../core/config.js"
import { GH_TOOL_PERMISSION } from "../../core/permissions.js"
import type { Info as ToolInfo } from "@opencode-ai/plugin/promise/tool"
import type { LocationLike, StorageLike } from "../goal/state.js"
import { liveEvidence, mutationEvidence } from "../orchestration/evidence.js"
import { createRedactor } from "../process/redact.js"
import type { ProcessRunner } from "../process/runner.js"
import { isPublishCapabilityAuthorized } from "../publish/state.js"
import { readReviewRecord } from "../observability/runtime.js"
import { validateApprovedReviewRevision } from "../observability/review.js"
import {
  assertIssueState,
  compareRefs,
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
  type GhContext,
  type PullMergeInput,
} from "./client.js"

/**
 * `orchestrator_github_*` tools (stage 3), registered via the tool transform.
 *
 * Gating mirrors the worktree family: the whole set requires `github.enabled`,
 * mutating tools (issue_create / pr_create / pr_ready / pr_approve /
 * pr_merge) additionally require `github.allow_mutations` plus a literal
 * `confirm: true` input field, and every tool is orchestrator-only via the
 * shared `orchestrator_gh` permission action plus the runtime agent check
 * (server-side: a worker that somehow reaches the execute handler is rejected
 * regardless of visibility rules).
 *
 * `github_pr_create` is the draft-first gate: the client ALWAYS sends
 * `draft: true` (no caller-controlled draft field). The tool refuses unless
 * the static gates, the literal `confirm: true`, the durable project publish
 * capability `pr-draft-create`, an exact-revision APPROVED internal review
 * receipt matching the exact expected head/base SHAs, and current remote base
 * ancestry all pass; the created pull must itself report `draft: true` with
 * head/base SHAs equal to the expected exact revisions.
 *
 * `github_pr_ready` transitions a draft to reviewable and requires a fresh PR
 * view proving the exact head revision, current remote base ancestry,
 * `draft: true`, `mergeable: true`, and no dirty/unknown conflict state
 * before the mutation, then verifies the transition with a fresh post-view
 * (open, unmerged, `draft: false`, exact head revision).
 *
 * `github_pr_approve` submits an APPROVE review pinned to the exact commit
 * after the durable capability `approve-after-review`, an exact-revision
 * approved internal receipt, a fresh non-draft conflict-free view, current
 * remote base ancestry, and an authenticated viewer different from the pull
 * author all pass, and verifies the durable review listing shows the created
 * review with matching id/state/commit/viewer/https URL. It never counts
 * branch-protection required checks or claims any blocked state is clean.
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
 * `storage` and `location` resolve the durable publish capability and the
 * exact-revision internal review receipt; `secrets` feed the redactor.
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
    description:
      "Create a GitHub pull request that is ALWAYS a draft, and only after every publication gate passes: static mutation gates, a literal confirm: true, the durable publish capability 'pr-draft-create', an exact-revision approved internal review receipt, current remote base ancestry, and exact head/base revision verification on the created pull. Requires confirm: true.",
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
      const expectedHeadSha = stringField(input, "expectedHeadSha")
      const expectedBaseSha = stringField(input, "expectedBaseSha")
      if (!owner || !repo || !title || !head || !base || !expectedHeadSha || !expectedBaseSha) {
        return result("owner, repo, title, head, base, expectedHeadSha, and expectedBaseSha are required")
      }
      try {
        // Durable publication authorization: policy only, never caller
        // identity proof, and never a substitute for the static gates above.
        const grant = await isPublishCapabilityAuthorized(deps.storage, deps.location, tool.sessionID, "pr-draft-create")
        if (!grant.authorized) {
          return result(
            `github pr create refused: publication capability 'pr-draft-create' is not authorized for project ${grant.projectID}; enable it with /publish enable`,
          )
        }
        // Exact-revision internal review: the current bounded review record
        // must be APPROVED and carry the exact expected head/base pair.
        const reviewRecord = await readReviewRecord(deps.storage, deps.location, tool.sessionID)
        const review = validateApprovedReviewRevision({
          record: reviewRecord,
          headSha: expectedHeadSha,
          baseSha: expectedBaseSha,
        })
        if (!review.valid) {
          return result(`github pr create refused: ${review.message}`)
        }
        // Current remote base ancestry plus exact revisions: the remote head
        // ref must equal the reviewed head exactly, the remote base ref must
        // equal the reviewed base exactly, and the current remote base must
        // be an ancestor of the current remote head.
        const ancestry = await currentRemoteBaseAncestry(gh, owner, repo, head, base)
        if (ancestry.headSha !== expectedHeadSha) {
          return result(
            `github pr create refused: remote head ref ${head} is ${ancestry.headSha}, not the expected exact revision ${expectedHeadSha}`,
          )
        }
        if (ancestry.baseSha !== expectedBaseSha) {
          return result(
            `github pr create refused: remote base ref ${base} is ${ancestry.baseSha}, not the expected exact revision ${expectedBaseSha}`,
          )
        }
        if (!ancestry.ancestor) {
          return result(
            `github pr create refused: the current remote base (${base}) is not an ancestor of the remote head (${head})`,
          )
        }
        // The client always sends draft: true and verifies the created pull
        // reports draft === true with the exact expected head/base SHAs.
        const created = await createPull(gh, {
          owner,
          repo,
          title,
          head,
          base,
          body: body || undefined,
          expectedHeadSha,
          expectedBaseSha,
        })
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
    name: "github_pr_ready",
    description:
      "Mark a draft pull request ready for review only when a fresh view proves the exact head revision, current remote base ancestry, draft:true, mergeable:true, and no dirty or unknown conflict state, then verifies the transition with a fresh post-view (open, unmerged, draft:false, exact head revision). Requires the durable publish capability 'pr-ready-transition' and confirm: true.",
    input: prReadyInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      requireMutations(deps.options)
      if (inputConfirm(input) !== true) return result("github_pr_ready requires confirm: true")
      const owner = stringField(input, "owner")
      const repo = stringField(input, "repo")
      const number = numberField(input, "number")
      const expectedHeadSha = stringField(input, "expectedHeadSha")
      if (!owner || !repo || number === undefined || !expectedHeadSha) {
        return result("owner, repo, number, and expectedHeadSha are required")
      }
      try {
        const grant = await isPublishCapabilityAuthorized(deps.storage, deps.location, tool.sessionID, "pr-ready-transition")
        if (!grant.authorized) {
          return result(
            `github pr ready refused: publication capability 'pr-ready-transition' is not authorized for project ${grant.projectID}; enable it with /publish enable`,
          )
        }
        // Fresh pre-view: every gate is checked against this exact snapshot.
        const before = await viewPull(gh, { owner, repo, number })
        if (before.merged || before.state !== "open") {
          return result(`github pr ready refused: pull ${owner}/${repo}#${number} is not open and unmerged`)
        }
        if (before.draft !== true) {
          return result(
            `github pr ready refused: pull ${owner}/${repo}#${number} is not a draft (draft=${String(before.draft)})`,
          )
        }
        if (before.head?.sha !== expectedHeadSha) {
          return result(
            `github pr ready refused: expected head SHA does not match pull ${owner}/${repo}#${number} (head ${before.head?.sha ?? "(unknown)"})`,
          )
        }
        if (before.mergeable !== true) {
          return result(
            `github pr ready refused: pull ${owner}/${repo}#${number} is not mergeable (mergeable=${String(before.mergeable)})`,
          )
        }
        if (before.mergeableState === "dirty" || before.mergeableState === "unknown") {
          return result(
            `github pr ready refused: pull ${owner}/${repo}#${number} has conflict state '${before.mergeableState}' and cannot be marked ready`,
          )
        }
        const headRef = before.head?.ref
        const baseRef = before.base?.ref
        if (!headRef || !baseRef) {
          return result(`github pr ready refused: pull ${owner}/${repo}#${number} has no head or base ref`)
        }
        // Current remote base ancestry: the current remote base must be an
        // ancestor of the current remote head, and the remote head must be
        // the exact expected revision even on a second fresh read.
        const ancestry = await currentRemoteBaseAncestry(gh, owner, repo, headRef, baseRef)
        if (ancestry.headSha !== expectedHeadSha) {
          return result(
            `github pr ready refused: remote head ref ${headRef} moved to ${ancestry.headSha}, no longer the expected exact revision ${expectedHeadSha}`,
          )
        }
        if (!ancestry.ancestor) {
          return result(
            `github pr ready refused: the current remote base (${baseRef}) is not an ancestor of the pull head (${headRef})`,
          )
        }

        const marked = await markPullReady(gh, { owner, repo, number })
        if (marked.draft === true) {
          return result(
            `github pr ready failed: the ready_for_review response still reports draft:true for pull ${owner}/${repo}#${number}`,
          )
        }

        // Fresh post-view: the transition must be durably visible.
        const after = await viewPull(gh, { owner, repo, number })
        if (after.merged || after.state !== "open") {
          return result(
            `github pr ready failed: post-view does not confirm pull ${owner}/${repo}#${number} is open and unmerged`,
          )
        }
        if (after.draft !== false) {
          return result(
            `github pr ready failed: post-view does not confirm the draft transition (draft=${String(after.draft)})`,
          )
        }
        if (after.head?.sha !== expectedHeadSha) {
          return result(
            `github pr ready failed: post-view head is ${after.head?.sha ?? "(unknown)"}, not the expected exact revision ${expectedHeadSha}`,
          )
        }

        const evidence = mutationEvidence({
          source: "opencode-orchestrator.gh.pr.ready",
          sessionID: tool.sessionID,
          proof: { id: after.id, number: after.number, url: after.html_url },
        })
        return result(JSON.stringify({ ...after, verified: true, evidence }))
      } catch (error) {
        return result(`github pr ready failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "github_pr_approve",
    description:
      "Approve a pull request with an APPROVE review pinned to the exact commit, only after the durable publish capability 'approve-after-review', an exact-revision approved internal review receipt, a fresh non-draft conflict-free view, current remote base ancestry, and an authenticated viewer different from the pull author all pass, and after the durable review listing verifies the created review's id/state/commit/viewer/https URL. Requires confirm: true.",
    input: prApproveInput,
    options: { namespace: "orchestrator", permission: GH_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      requireMutations(deps.options)
      if (inputConfirm(input) !== true) return result("github_pr_approve requires confirm: true")
      const owner = stringField(input, "owner")
      const repo = stringField(input, "repo")
      const number = numberField(input, "number")
      const expectedHeadSha = stringField(input, "expectedHeadSha")
      const expectedBaseSha = stringField(input, "expectedBaseSha")
      if (!owner || !repo || number === undefined || !expectedHeadSha || !expectedBaseSha) {
        return result("owner, repo, number, expectedHeadSha, and expectedBaseSha are required")
      }
      try {
        const grant = await isPublishCapabilityAuthorized(deps.storage, deps.location, tool.sessionID, "approve-after-review")
        if (!grant.authorized) {
          return result(
            `github pr approve refused: publication capability 'approve-after-review' is not authorized for project ${grant.projectID}; enable it with /publish enable`,
          )
        }
        // Exact internal receipt: the approved review record must carry the
        // exact expected head/base pair; anything else fails closed.
        const reviewRecord = await readReviewRecord(deps.storage, deps.location, tool.sessionID)
        const receipt = validateApprovedReviewRevision({
          record: reviewRecord,
          headSha: expectedHeadSha,
          baseSha: expectedBaseSha,
        })
        if (!receipt.valid) {
          return result(`github pr approve refused: ${receipt.message}`)
        }
        // Fresh pre-view: open, unmerged, NOT a draft, conflict-free, and the
        // exact expected head revision.
        const before = await viewPull(gh, { owner, repo, number })
        if (before.merged || before.state !== "open") {
          return result(`github pr approve refused: pull ${owner}/${repo}#${number} is not open and unmerged`)
        }
        if (before.draft === true) {
          return result(`github pr approve refused: pull ${owner}/${repo}#${number} is still a draft`)
        }
        if (before.head?.sha !== expectedHeadSha) {
          return result(
            `github pr approve refused: expected head SHA does not match pull ${owner}/${repo}#${number} (head ${before.head?.sha ?? "(unknown)"})`,
          )
        }
        if (before.mergeable !== true) {
          return result(
            `github pr approve refused: pull ${owner}/${repo}#${number} is not mergeable (mergeable=${String(before.mergeable)})`,
          )
        }
        if (before.mergeableState === "dirty" || before.mergeableState === "unknown") {
          return result(
            `github pr approve refused: pull ${owner}/${repo}#${number} has conflict state '${before.mergeableState}'`,
          )
        }
        const headRef = before.head?.ref
        const baseRef = before.base?.ref
        if (!headRef || !baseRef) {
          return result(`github pr approve refused: pull ${owner}/${repo}#${number} has no head or base ref`)
        }
        // Authenticated viewer must exist and differ from the pull author;
        // an unknown author or a self-approval is refused truthfully.
        const viewer = await getViewer(gh, {})
        const author = before.user?.login
        if (!author) {
          return result(`github pr approve refused: pull ${owner}/${repo}#${number} has an unknown author`)
        }
        if (author === viewer.login) {
          return result(
            `github pr approve refused: self-approval is not allowed (authenticated viewer ${viewer.login} is the pull author)`,
          )
        }
        // Current remote base ancestry with a second fresh head read.
        const ancestry = await currentRemoteBaseAncestry(gh, owner, repo, headRef, baseRef)
        if (ancestry.headSha !== expectedHeadSha) {
          return result(
            `github pr approve refused: remote head ref ${headRef} moved to ${ancestry.headSha}, no longer the expected exact revision ${expectedHeadSha}`,
          )
        }
        if (ancestry.baseSha !== expectedBaseSha) {
          return result(
            `github pr approve refused: remote base ref ${baseRef} is ${ancestry.baseSha}, not the expected exact revision ${expectedBaseSha}`,
          )
        }
        if (!ancestry.ancestor) {
          return result(
            `github pr approve refused: the current remote base (${baseRef}) is not an ancestor of the pull head (${headRef})`,
          )
        }

        // Exact-commit APPROVE: pinned to the exact expected head commit.
        const created = await createPullReview(gh, {
          owner,
          repo,
          number,
          commitId: expectedHeadSha,
          event: "APPROVE",
        })
        if (created.state !== "APPROVE") {
          return result(
            `github pr approve failed: review create reported state ${created.state}, not APPROVE, for pull ${owner}/${repo}#${number}`,
          )
        }
        // Durable verification: the review listing must contain the created
        // review with matching id/state/commit/viewer/https URL. A listing
        // that disagrees is an API failure, never a claimed success.
        const listed = await listPullReviews(gh, { owner, repo, number })
        const match = listed.find((review) => review.id === created.id)
        if (
          !match ||
          match.state !== "APPROVE" ||
          match.commit_id !== expectedHeadSha ||
          match.user?.login !== viewer.login ||
          !match.html_url.startsWith("https://") ||
          match.html_url !== created.html_url
        ) {
          return result(
            `github pr approve failed: the review listing for pull ${owner}/${repo}#${number} does not match the created approval (id/state/commit/viewer/https)`,
          )
        }

        const evidence = mutationEvidence({
          source: "opencode-orchestrator.gh.pr.approve",
          sessionID: tool.sessionID,
          proof: { id: match.id, number, url: match.html_url },
        })
        return result(JSON.stringify({ ...match, number, verified: true, evidence }))
      } catch (error) {
        return result(`github pr approve failed: ${message(error)}`)
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

/**
 * Fresh remote truth used by the publication gates: the current remote head
 * and base refs (exact full object ids) plus the compare-derived fact that
 * the current remote base ref is an ancestor of the current remote head ref.
 * The head/base names come from the caller (create) or from the fresh pull
 * view (ready/approve); both refs are resolved against the base repository,
 * so a fork PR whose head ref does not resolve there fails closed with a gh
 * error instead of claiming ancestry.
 */
async function currentRemoteBaseAncestry(
  gh: GhContext,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<{ headSha: string; baseSha: string; ancestor: boolean }> {
  const headRef = await getBranchRef(gh, { owner, repo, branch: head })
  const baseRef = await getBranchRef(gh, { owner, repo, branch: base })
  const cmp = await compareRefs(gh, { owner, repo, base, head })
  return { headSha: headRef.sha, baseSha: baseRef.sha, ancestor: cmp.ancestor && cmp.baseSha === baseRef.sha }
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

const FULL_SHA_PATTERN = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"

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
    expectedHeadSha: { type: "string", pattern: FULL_SHA_PATTERN, minLength: 40 },
    expectedBaseSha: { type: "string", pattern: FULL_SHA_PATTERN, minLength: 40 },
    confirm: { type: "boolean" },
  },
  required: ["owner", "repo", "title", "head", "base", "expectedHeadSha", "expectedBaseSha", "confirm"],
  additionalProperties: false,
} as const

const prReadyInput = {
  type: "object",
  properties: {
    owner: { type: "string", minLength: 1 },
    repo: { type: "string", minLength: 1 },
    number: { type: "number", minimum: 1 },
    expectedHeadSha: { type: "string", pattern: FULL_SHA_PATTERN, minLength: 40 },
    confirm: { type: "boolean" },
  },
  required: ["owner", "repo", "number", "expectedHeadSha", "confirm"],
  additionalProperties: false,
} as const

const prApproveInput = {
  type: "object",
  properties: {
    owner: { type: "string", minLength: 1 },
    repo: { type: "string", minLength: 1 },
    number: { type: "number", minimum: 1 },
    expectedHeadSha: { type: "string", pattern: FULL_SHA_PATTERN, minLength: 40 },
    expectedBaseSha: { type: "string", pattern: FULL_SHA_PATTERN, minLength: 40 },
    confirm: { type: "boolean" },
  },
  required: ["owner", "repo", "number", "expectedHeadSha", "expectedBaseSha", "confirm"],
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