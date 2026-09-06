import type { OrchestratorOptions } from "../../core/config.js"
import { WORKTREE_TOOL_PERMISSION } from "../../core/permissions.js"
import type { Info as ToolInfo } from "@opencode-ai/plugin/promise/tool"
import { liveEvidence } from "../orchestration/evidence.js"
import { createRedactor } from "../process/redact.js"
import type { ProcessRunner } from "../process/runner.js"
import {
  canonicalPath,
  FULL_SHA_PATTERN,
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
  type GitContext,
  type WorktreeEntry,
} from "./git.js"
import {
  listWorktrees,
  newWorktree,
  readWorktree,
  worktreeStorageKey,
  writeSessionIndex,
  writeWorktree,
  type StorageLike,
  type WorktreeRecord,
  type WorktreeSyncReceipt,
} from "./state.js"
import { isPublishCapabilityAuthorized } from "../publish/state.js"
import { readReviewRecord } from "../observability/runtime.js"
import { validateApprovedReviewRevision } from "../observability/review.js"
import { moveSessionToDirectory } from "../session/move.js"
import type { SessionMoveCoordinator } from "../session/move-coordinator.js"

/**
 * `orchestrator_worktree_*` tools (stage 2/3), registered via the tool
 * transform. Gating: the whole family requires `worktree.enabled`;
 * mutating git tools (create/sync/push/cleanup) additionally require
 * `worktree.allow_mutations` and a literal `confirm: true` input field, and
 * every tool is orchestrator-only via the shared `orchestrator_worktree`
 * permission action plus the runtime agent check. `worktree_sync` fetches
 * the latest remote base branch, merges it into the tracked feature branch
 * when needed, and persists an exact-revision sync receipt (it never pushes
 * and does not require the publish capability). `worktree_push` is the
 * exact publication gate: it refuses unless the static mutation gates, the
 * durable publish authorization, a clean tree, an unchanged latest remote
 * base, the exact synced local head, base ancestry, an exact-revision
 * approved review receipt, a literal `confirm: true`, and exact remote-head
 * verification all pass. `worktree_enter` requires neither
 * `allow_mutations` nor a confirm field: it moves the current session
 * (native `session.move` plus durable anchor/index/worktree bookkeeping via
 * `moveSessionToDirectory`) instead of running git, and `worktree.enabled`
 * is the operator opt-in for the whole family. Durable records are written
 * per op with the stage-2 lifecycle enum; outputs are redacted (known
 * patterns plus any caller-known secrets) before they reach the transcript.
 *
 * Every successful JSON result carries a per-invocation `evidence` record
 * (marker EVIDENCE_LIVE, authoritative-for-tested-fields, sourced from
 * `tool.sessionID` + `Date.now()`). These are live local operation results
 * with durable worktree bookkeeping; they are NOT proof of native child
 * isolation, and the evidence/tests never claim it. Errors and refusals
 * stay redacted strings and carry no evidence; a conflicted sync is a
 * truthful structured non-success result (no evidence, never a push).
 */

type ToolDraftLike = {
  add(tool: ToolInfo<any, undefined>): void
}

type ToolResult = { content: string }

type WorktreeLocation = {
  directory: string
  workspaceID?: string
  project: { id: string }
}

export type WorktreeToolsDeps = {
  storage: StorageLike
  runner: ProcessRunner
  location: WorktreeLocation
  options: OrchestratorOptions
  /**
   * Session source compatible with `moveSessionToDirectory` (get + move);
   * plugin wiring passes `context.session` (the pinned `SessionDomain`
   * includes `move`).
   */
  session: {
    get(input: { sessionID: string }): Promise<unknown>
    move(input: {
      sessionID: string
      directory: string
      workspaceID?: string
      delivery?: "steer" | "queue" | null
    }): Promise<void>
  }
  secrets?: readonly string[]
  pathExists?: (directory: string) => Promise<boolean>
  /**
   * Optional canonical path resolver shared with the git client. Defaults to
   * realpath with nearest-existing-ancestor resolution so `/tmp` vs
   * `/private/tmp` aliases of the same directory compare equal.
   */
  realpath?: (directory: string) => Promise<string | undefined>
  moveCoordinator?: SessionMoveCoordinator
}

export function addWorktreeTools(draft: ToolDraftLike, deps: WorktreeToolsDeps): void {
  if (!deps.options.worktree.enabled) return

  const redactor = createRedactor(deps.secrets)
  const git: GitContext = {
    runner: deps.runner,
    pathExists: deps.pathExists,
    realpath: deps.realpath,
    redact: redactor,
  }

  /** Canonicalize through the shared resolver, falling back to the fs default. */
  const canon = (directory: string): Promise<string> => canonicalPath(git.realpath, directory)

  draft.add({
    name: "worktree_list",
    description: "List tracked git worktrees and their durable records.",
    input: listInput,
    options: { namespace: "orchestrator", permission: WORKTREE_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const repoRoot = stringField(input, "repoRoot")
      try {
        const entries: WorktreeEntry[] = repoRoot ? await gitWorktreeList(git, repoRoot) : []
        const records = await listWorktrees(deps.storage)
        const evidence = liveEvidence({ source: "opencode-orchestrator.worktree.list", sessionID: tool.sessionID })
        return result(JSON.stringify({ worktrees: entries, records, evidence }))
      } catch (error) {
        return result(`worktree list failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "worktree_create",
    description: "Create a tracked git worktree (git worktree add -b). Requires confirm: true.",
    input: createInput,
    options: { namespace: "orchestrator", permission: WORKTREE_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      requireMutations(deps.options)
      if (inputConfirm(input) !== true) return result("worktree_create requires confirm: true")

      const repoRoot = stringField(input, "repoRoot")
      const directory = stringField(input, "directory")
      const branch = stringField(input, "branch")
      const base = stringField(input, "base")
      if (!repoRoot || !directory || !branch || !base) {
        return result("repoRoot, directory, branch, and base are required")
      }
      const root = deps.options.worktree.root
      if (root === null) {
        return result("worktree.root must be configured to create worktrees")
      }
      // Containment compares canonically so a symlink alias of the configured
      // root (e.g. `/tmp` vs `/private/tmp` on macOS) still accepts the target.
      if (!isPathInside(await canon(directory), await canon(root))) {
        return result(`worktree directory must be inside worktree.root (${root})`)
      }

      try {
        const addResult = await gitWorktreeAdd(git, { repoRoot, branch, directory, base })
        // Persist the canonical forms so later status/cleanup/ownership
        // comparisons match `git worktree list` output regardless of aliases.
        const [canonicalRepoRoot, canonicalDir] = await Promise.all([canon(repoRoot), canon(directory)])
        const record: WorktreeRecord = {
          ...newWorktree({
            owner: tool.sessionID,
            sessionID: tool.sessionID,
            originProjectID: deps.location.project.id,
            repoRoot: canonicalRepoRoot,
            dir: canonicalDir,
            branch,
            base,
          }),
          status: "ready",
        }
        const written = await writeWorktree(deps.storage, record)
        await writeSessionIndex(deps.storage, {
          version: 1,
          sessionID: tool.sessionID,
          projectID: deps.location.project.id,
          originProjectID: deps.location.project.id,
          directory: deps.location.directory,
          updatedAt: written.updatedAt,
        })
        return result(
          JSON.stringify({
            record: written,
            verified: addResult.verified,
            evidence: liveEvidence({ source: "opencode-orchestrator.worktree.create", sessionID: tool.sessionID }),
          }),
        )
      } catch (error) {
        return result(`worktree create failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "worktree_status",
    description: "Report the tracked worktree status: ready, dirty, moved, or orphaned.",
    input: statusInput,
    options: { namespace: "orchestrator", permission: WORKTREE_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      const record = await readWorktree(deps.storage, deps.location.project.id, tool.sessionID)
      const repoRoot = stringField(input, "repoRoot") || record?.repoRoot
      if (!repoRoot) return result("no worktree record and no repoRoot provided")
      try {
        const entries = await gitWorktreeList(git, repoRoot)
        const dirtyText = await gitStatus(git, record?.dir ?? repoRoot)
        // Presence is compared canonically so a record stored under one alias
        // (e.g. `/private/tmp/...`) matches porcelain output under another
        // (`/tmp/...`).
        let present = true
        if (record) {
          const canonicalRecordDir = await canon(record.dir)
          present = false
          for (const entry of entries) {
            if ((await canon(entry.directory)) === canonicalRecordDir) {
              present = true
              break
            }
          }
        }
        let status: WorktreeRecord["status"] = record?.status ?? "pending"
        if (!present) status = "orphaned"
        else if (dirtyText.length > 0) status = "dirty"
        else if (record) status = "ready"
        let current = record
        if (record && status !== record.status) {
          current = await writeWorktree(deps.storage, { ...record, status })
        }
        return result(
          JSON.stringify({
            record: current,
            status,
            dirty: dirtyText.length > 0,
            worktrees: entries,
            evidence: liveEvidence({ source: "opencode-orchestrator.worktree.status", sessionID: tool.sessionID }),
          }),
        )
      } catch (error) {
        return result(`worktree status failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "worktree_sync",
    description:
      "Fetch the latest remote base branch, merge it into the tracked worktree branch when needed, and record an exact-revision sync receipt. Refuses a dirty tree, surfaces conflicts truthfully (listing only safe relative unmerged paths) without pushing, and never resolves conflicts automatically. Requires worktree.allow_mutations and confirm: true; does not require the publish capability.",
    input: syncInput,
    options: { namespace: "orchestrator", permission: WORKTREE_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      requireMutations(deps.options)
      if (inputConfirm(input) !== true) return result("worktree_sync requires confirm: true")

      const record = await readWorktree(deps.storage, deps.location.project.id, tool.sessionID)
      if (!record) return result("no worktree record to sync")
      const repoRoot = stringField(input, "repoRoot") || record.repoRoot
      const branch = stringField(input, "branch") || record.branch
      const remote = stringField(input, "remote") || "origin"
      if (!isValidBranchName(branch)) return result("worktree_sync refused: invalid branch name")
      if (!isValidRemoteName(remote)) return result("worktree_sync refused: invalid remote name")
      const baseBranch = resolveBaseBranch(stringField(input, "base"), record.base)
      if (!baseBranch) {
        return result(
          "worktree_sync refused: a valid base branch is required (the record base is a commit id or no base was provided); pass base with the branch name",
        )
      }
      const baseRef = `refs/heads/${baseBranch}`
      const trackingRef = `refs/remotes/${remote}/${baseBranch}`
      // Worktree-local git operations run inside the tracked checkout so a
      // clean-tree check, merge, and HEAD resolution always observe the
      // tracked worktree itself.
      const cwd = record.dir

      try {
        const dirty = await gitStatus(git, cwd)
        if (dirty.length > 0) {
          return result("worktree_sync refused: tracked worktree has uncommitted changes; commit or stash them before syncing")
        }
        const fetched = await gitFetch(git, { repoRoot, remote, ref: baseRef })
        if (fetched.exitCode !== 0) {
          return result(
            `worktree sync failed: git fetch exited with code ${fetched.exitCode}: ${fetched.stderr || fetched.stdout || "unknown error"}`,
          )
        }
        const remoteBase = await gitRevParse(git, repoRoot, trackingRef)
        if (remoteBase === undefined) {
          return result(`worktree sync failed: could not resolve the fetched remote base ${trackingRef}`)
        }
        // Already current: the branch contains the latest base, so no commit
        // is created — only the exact-revision receipt is recorded.
        let merged = false
        if (!(await gitMergeBaseIsAncestor(git, cwd, remoteBase, "HEAD"))) {
          const outcome = await gitMerge(git, { repoRoot: cwd, into: trackingRef })
          if (outcome.exitCode !== 0) {
            // The merge failed; report what actually happened. Conflicts are
            // never resolved automatically and never pushed: only safe
            // relative unmerged paths are listed, then the merge is aborted
            // so the sync never leaves the tracked worktree half-merged.
            const unmerged = await listUnmergedPaths(git, cwd)
            if (!unmerged.ok) {
              return result(`worktree sync failed: ${unmerged.error}; no receipt was recorded`)
            }
            const abort = await abortFailedMerge(git, cwd)
            if (!abort.ok) {
              return result(`worktree sync failed after the merge exited with code ${outcome.exitCode}: ${abort.error}`)
            }
            if (unmerged.paths.length === 0) {
              return result(
                `worktree sync failed: git merge exited with code ${outcome.exitCode}: ${outcome.stderr || outcome.stdout || "unknown error"}; the merge was aborted and no receipt was recorded`,
              )
            }
            return result(
              JSON.stringify({
                synced: false,
                conflicted: true,
                merged: false,
                aborted: true,
                treeRestored: abort.treeRestored,
                unmergedPaths: unmerged.paths,
                baseBranch,
                baseRef,
                remote,
                baseSha: remoteBase,
                message:
                  "worktree sync conflicted: the merge failed on unmerged paths; the merge was aborted, no receipt was recorded, and nothing was pushed",
              }),
            )
          }
          merged = true
        }
        // Success verification: the synced base must be an ancestor of the
        // (possibly merged) head and the tree must be clean before any
        // receipt is persisted.
        if (!(await gitMergeBaseIsAncestor(git, cwd, remoteBase, "HEAD"))) {
          return result("worktree sync failed verification: synced base is not an ancestor of the worktree HEAD; no receipt was recorded")
        }
        const after = await gitStatus(git, cwd)
        if (after.length > 0) {
          return result("worktree sync failed verification: tracked worktree is dirty after the merge; no receipt was recorded")
        }
        const headAfter = await gitRevParse(git, cwd, "HEAD")
        if (headAfter === undefined) {
          return result("worktree sync failed verification: could not resolve the synced HEAD; no receipt was recorded")
        }
        const receipt: WorktreeSyncReceipt = {
          remote,
          baseBranch,
          baseRef,
          baseSha: remoteBase,
          headSha: headAfter,
          merged,
          syncedAt: Date.now(),
        }
        const written = await writeWorktree(deps.storage, { ...record, sync: receipt })
        return result(
          JSON.stringify({
            synced: true,
            merged,
            alreadyCurrent: !merged,
            baseBranch,
            baseRef,
            remote,
            baseSha: remoteBase,
            headSha: headAfter,
            syncedAt: receipt.syncedAt,
            record: written,
            evidence: liveEvidence({ source: "opencode-orchestrator.worktree.sync", sessionID: tool.sessionID }),
          }),
        )
      } catch (error) {
        return result(`worktree sync failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "worktree_push",
    description:
      "Push the tracked worktree branch only when every publication gate passes: static mutation gates, durable publish authorization (capability 'push'), a clean tree, an unchanged latest remote base, the exact synced local head, base ancestry, an exact-revision approved review receipt, a literal confirm: true, and exact ls-remote SHA verification after the push. Requires confirm: true.",
    input: pushInput,
    options: { namespace: "orchestrator", permission: WORKTREE_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      requireMutations(deps.options)
      if (inputConfirm(input) !== true) return result("worktree_push requires confirm: true")

      const record = await readWorktree(deps.storage, deps.location.project.id, tool.sessionID)
      if (!record) return result("no worktree record to push")
      const repoRoot = stringField(input, "repoRoot") || record.repoRoot
      const branch = stringField(input, "branch") || record.branch
      const remote = stringField(input, "remote") || record.sync?.remote || "origin"
      if (!isValidBranchName(branch)) return result("worktree_push refused: invalid branch name")
      if (!isValidRemoteName(remote)) return result("worktree_push refused: invalid remote name")
      // Fail closed: a legacy record without an exact-revision sync receipt
      // can never be pushed, even when every other gate looks fine.
      if (!record.sync) {
        return result(
          "worktree_push refused: tracked worktree has no sync receipt; run orchestrator_worktree_sync (with confirm: true) against the latest remote base first",
        )
      }
      const receipt = record.sync
      const cwd = record.dir

      try {
        // Durable publication authorization: policy only (never caller
        // identity proof) and never a substitute for the static gates above.
        const grant = await isPublishCapabilityAuthorized(deps.storage, deps.location, tool.sessionID, "push")
        if (!grant.authorized) {
          return result(
            `worktree_push refused: publication capability 'push' is not authorized for project ${grant.projectID}; enable it with /publish enable`,
          )
        }
        // Exact-revision approved review receipt: the current bounded review
        // record must be APPROVED and carry the exact synced base/head pair.
        const reviewRecord = await readReviewRecord(deps.storage, deps.location, tool.sessionID)
        const review = validateApprovedReviewRevision({
          record: reviewRecord,
          headSha: receipt.headSha,
          baseSha: receipt.baseSha,
        })
        if (!review.valid) {
          return result(`worktree_push refused: ${review.message}`)
        }
        const dirty = await gitStatus(git, cwd)
        if (dirty.length > 0) {
          return result("worktree_push refused: tracked worktree has uncommitted changes")
        }
        // Re-fetch the stored base branch: the remote base must be exactly
        // unchanged since the sync receipt, or the gate fails closed.
        const fetched = await gitFetch(git, { repoRoot, remote, ref: receipt.baseRef })
        if (fetched.exitCode !== 0) {
          return result(
            `worktree_push refused: could not re-fetch the stored base branch (git fetch exited with code ${fetched.exitCode}: ${fetched.stderr || fetched.stdout || "unknown error"})`,
          )
        }
        const remoteBase = await gitRevParse(git, repoRoot, `refs/remotes/${remote}/${receipt.baseBranch}`)
        if (remoteBase === undefined) {
          return result("worktree_push refused: could not resolve the remote base after re-fetch")
        }
        if (remoteBase !== receipt.baseSha) {
          return result(
            `worktree_push refused: the remote base ${receipt.baseRef} moved since sync (synced ${receipt.baseSha}, remote now ${remoteBase}); run orchestrator_worktree_sync again`,
          )
        }
        const head = await gitRevParse(git, cwd, "HEAD")
        if (head === undefined) {
          return result("worktree_push refused: could not resolve the tracked worktree HEAD")
        }
        if (head !== receipt.headSha) {
          return result(
            `worktree_push refused: the local head changed since sync (synced ${receipt.headSha}, local now ${head}); run orchestrator_worktree_sync again`,
          )
        }
        if (!(await gitMergeBaseIsAncestor(git, cwd, receipt.baseSha, "HEAD"))) {
          return result(
            "worktree_push refused: the synced base is not an ancestor of the local head; run orchestrator_worktree_sync again",
          )
        }

        const pushed = await gitPush(git, { repoRoot, branch, remote })
        if (pushed.exitCode !== 0) return result(`worktree push failed: ${pushed.stderr || "unknown error"}`)

        // Exact remote-head verification: the remote ref must equal the
        // pushed head EXACTLY (full-SHA equality, never substring or another
        // ref); anything else is reported truthfully as unverified.
        const refs = await gitLsRemote(git, { repoRoot, remote, ref: `refs/heads/${branch}` })
        const remoteSha = parseLsRemoteRefSha(refs, `refs/heads/${branch}`)
        if (remoteSha !== head) {
          return result(
            JSON.stringify({
              pushed: true,
              verified: false,
              remote,
              branch,
              expected: head,
              remoteSha: remoteSha ?? "(remote ref absent)",
              refs,
              message: "worktree push verification failed: the remote ref does not equal the pushed head exactly",
            }),
          )
        }
        if (record.status === "moved") {
          await writeWorktree(deps.storage, { ...record, status: "ready" })
        }
        return result(
          JSON.stringify({
            pushed: true,
            verified: true,
            remote,
            branch,
            headSha: head,
            baseSha: receipt.baseSha,
            receipt,
            evidence: liveEvidence({ source: "opencode-orchestrator.worktree.push", sessionID: tool.sessionID }),
          }),
        )
      } catch (error) {
        return result(`worktree push failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "worktree_cleanup",
    description: "Remove a tracked git worktree after refusal checks. Requires confirm: true.",
    input: cleanupInput,
    options: { namespace: "orchestrator", permission: WORKTREE_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      requireMutations(deps.options)
      if (inputConfirm(input) !== true) return result("worktree_cleanup requires confirm: true")

      const record = await readWorktree(deps.storage, deps.location.project.id, tool.sessionID)
      const repoRoot = stringField(input, "repoRoot") || record?.repoRoot
      const directory = stringField(input, "directory") || record?.dir
      if (!repoRoot || !directory) return result("repoRoot and directory are required")

      try {
        // Ownership is compared canonically: two aliases of the same directory
        // belong to the same session.
        const canonicalDirectory = await canon(directory)
        let otherOwner: WorktreeRecord | undefined
        for (const candidate of await listWorktrees(deps.storage)) {
          if ((await canon(candidate.dir)) === canonicalDirectory && candidate.sessionID !== tool.sessionID) {
            otherOwner = candidate
            break
          }
        }
        if (otherOwner) {
          return result(`worktree cleanup refused: worktree is owned by session ${otherOwner.sessionID}`)
        }

        const entries = await gitWorktreeList(git, repoRoot)
        const main = entries[0]
        if (main && (await canon(main.directory)) === canonicalDirectory) {
          return result("worktree cleanup refused: cannot remove the main worktree")
        }
        const dirty = await gitStatus(git, directory)
        if (dirty.length > 0) {
          return result("worktree cleanup refused: worktree has uncommitted changes")
        }

        const removed = await gitWorktreeRemove(git, { repoRoot, directory })
        if (removed.exitCode !== 0) {
          if (record) await writeWorktree(deps.storage, { ...record, status: "cleanup-failed" })
          return result(`worktree cleanup failed: ${removed.stderr || "unknown error"}`)
        }
        if (record) {
          await deps.storage.remove(worktreeStorageKey(record.originProjectID, record.sessionID))
        }
        return result(
          JSON.stringify({
            removed: true,
            directory,
            evidence: liveEvidence({ source: "opencode-orchestrator.worktree.cleanup", sessionID: tool.sessionID }),
          }),
        )
      } catch (error) {
        return result(`worktree cleanup failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "worktree_enter",
    description:
      "Move the current session into its tracked ready worktree (session ID and history preserved). Requires no directory or confirm: the tracked worktree is resolved from durable records for the invoking session.",
    input: enterInput,
    options: { namespace: "orchestrator", permission: WORKTREE_TOOL_PERMISSION },
    execute: async (_input, tool) => {
      requireOrchestrator(tool.agent, deps.options)
      // worktree_enter moves the current session (native session.move plus
      // durable anchor/index/worktree bookkeeping) and never runs git, so it
      // deliberately does not require worktree.allow_mutations;
      // worktree.enabled (checked at registration) is the operator opt-in.
      try {
        const record = await readWorktree(deps.storage, deps.location.project.id, tool.sessionID)
        if (!record) {
          return result("worktree_enter: no tracked worktree for this session; create one with orchestrator_worktree_create first")
        }
        if (record.status !== "ready") {
          return result(`worktree_enter refused: tracked worktree is ${record.status}; only a ready worktree can be entered`)
        }
        // The record's dir is already the canonical form persisted at create;
        // canonicalize again so symlink aliases resolve to the same directory
        // the session is moved into. No caller-supplied path is accepted.
        const directory = await canon(record.dir)
        const outcome = await moveSessionToDirectory(
          { session: deps.session, storage: deps.storage, location: deps.location, moveCoordinator: deps.moveCoordinator },
          { sessionID: tool.sessionID, target: directory },
        )
        if (!outcome.ok) {
          return result(`worktree_enter failed: ${redactor(outcome.reason)}`)
        }
        // The helper relocated/marked the anchor and index and flipped the
        // tracked record to `moved`; re-read it so the result reports the
        // durable state the helper actually left behind.
        const movedRecord = await readWorktree(deps.storage, deps.location.project.id, tool.sessionID)
        return result(
          JSON.stringify({
            entered: true,
            directory,
            session: outcome.session,
            anchor: outcome.anchor,
            record: movedRecord ?? record,
            // Live local result: the current session entered its tracked
            // worktree. Children delegated afterward inherit/start from this
            // context; no atomic child isolation is claimed.
            evidence: liveEvidence({ source: "opencode-orchestrator.worktree.enter", sessionID: tool.sessionID }),
          }),
        )
      } catch (error) {
        return result(`worktree_enter failed: ${redactor(message(error))}`)
      }
    },
  })
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) {
    throw new Error("worktree tools are available only to the orchestrator")
  }
}

function requireMutations(options: OrchestratorOptions): void {
  if (!options.worktree.enabled) throw new Error("worktree tools require worktree.enabled")
  if (!options.worktree.allow_mutations) {
    throw new Error("worktree mutations require worktree.allow_mutations")
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the base branch token for sync: an explicit input wins; otherwise
 * the record's base is used when it is a branch name. Full commit ids are
 * never treated as branch names (a sync must fetch a *branch*), full-ref
 * forms like `refs/heads/main` are normalized to the branch name, and any
 * option-shaped/malformed token resolves to `undefined` (callers refuse).
 */
function resolveBaseBranch(inputBase: string, recordBase: string): string | undefined {
  const raw = inputBase.length > 0 ? inputBase : recordBase
  if (raw.length === 0) return undefined
  if (FULL_SHA_PATTERN.test(raw)) return undefined
  if (raw.startsWith("refs/heads/")) {
    return isValidBranchName(raw.slice("refs/heads/".length)) ? raw.slice("refs/heads/".length) : undefined
  }
  return isValidBranchName(raw) ? raw : undefined
}

/**
 * List unmerged paths after a failed merge. A failure to read git output
 * returns the error instead of throwing, so the caller can still report the
 * merge failure truthfully. Only safe relative unmerged paths are returned.
 */
async function listUnmergedPaths(
  git: GitContext,
  cwd: string,
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  try {
    return { ok: true, paths: await gitUnmergedPaths(git, cwd) }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

/**
 * Abort a failed merge and verify the tree was restored. Conflicts are
 * never resolved automatically and never left half-merged: when the abort
 * fails, the failure is reported truthfully (no receipt is ever recorded).
 */
async function abortFailedMerge(
  git: GitContext,
  cwd: string,
): Promise<{ ok: boolean; treeRestored: boolean; error?: string }> {
  let aborted = false
  try {
    const outcome = await gitMergeAbort(git, cwd)
    aborted = outcome.exitCode === 0
  } catch (error) {
    return { ok: false, treeRestored: false, error: message(error) }
  }
  if (!aborted) return { ok: false, treeRestored: false, error: "git merge --abort failed; the tracked worktree may still be mid-merge" }
  let treeRestored = false
  try {
    treeRestored = (await gitStatus(git, cwd)).length === 0
  } catch {
    treeRestored = false
  }
  return { ok: true, treeRestored }
}

function result(content: string): ToolResult {
  return { content }
}

const listInput = {
  type: "object",
  properties: {
    repoRoot: { type: "string" },
  },
  additionalProperties: false,
} as const

const createInput = {
  type: "object",
  properties: {
    repoRoot: { type: "string", minLength: 1 },
    directory: { type: "string", minLength: 1 },
    branch: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 },
    confirm: { type: "boolean" },
  },
  required: ["repoRoot", "directory", "branch", "base", "confirm"],
  additionalProperties: false,
} as const

const statusInput = {
  type: "object",
  properties: {
    repoRoot: { type: "string" },
  },
  additionalProperties: false,
} as const

const syncInput = {
  type: "object",
  properties: {
    repoRoot: { type: "string" },
    branch: { type: "string" },
    remote: { type: "string" },
    base: { type: "string" },
    confirm: { type: "boolean" },
  },
  required: ["confirm"],
  additionalProperties: false,
} as const

const pushInput = {
  type: "object",
  properties: {
    repoRoot: { type: "string" },
    branch: { type: "string" },
    remote: { type: "string" },
    confirm: { type: "boolean" },
  },
  required: ["confirm"],
  additionalProperties: false,
} as const

const cleanupInput = {
  type: "object",
  properties: {
    repoRoot: { type: "string" },
    directory: { type: "string" },
    confirm: { type: "boolean" },
  },
  required: ["confirm"],
  additionalProperties: false,
} as const

// worktree_enter takes no caller-supplied fields: the tracked directory comes
// only from the durable record for the invoking session, and there is no
// confirm flag (it does not run git).
const enterInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const
