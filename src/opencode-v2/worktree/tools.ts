import type { OrchestratorOptions } from "../../core/config.js"
import { WORKTREE_TOOL_PERMISSION } from "../../core/permissions.js"
import type { Info as ToolInfo } from "@opencode-ai/plugin/promise/tool"
import { createRedactor } from "../process/redact.js"
import type { ProcessRunner } from "../process/runner.js"
import {
  canonicalPath,
  gitLsRemote,
  gitPush,
  gitStatus,
  gitWorktreeAdd,
  gitWorktreeList,
  gitWorktreeRemove,
  isPathInside,
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
} from "./state.js"

/**
 * `orchestrator_worktree_*` tools (stage 2), registered via the tool
 * transform. Gating: the whole family requires `worktree.enabled`, mutating
 * tools (create/push/cleanup) additionally require `worktree.allow_mutations`
 * and a literal `confirm: true` input field, and every tool is
 * orchestrator-only via the shared `orchestrator_worktree` permission action
 * plus the runtime agent check. Durable records are written per op with the
 * stage-2 lifecycle enum; outputs are redacted (known patterns plus any
 * caller-known secrets) before they reach the transcript.
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
  secrets?: readonly string[]
  pathExists?: (directory: string) => Promise<boolean>
  /**
   * Optional canonical path resolver shared with the git client. Defaults to
   * realpath with nearest-existing-ancestor resolution so `/tmp` vs
   * `/private/tmp` aliases of the same directory compare equal.
   */
  realpath?: (directory: string) => Promise<string | undefined>
}

export function addWorktreeTools(draft: ToolDraftLike, deps: WorktreeToolsDeps): void {
  if (!deps.options.worktree.enabled) return

  const git: GitContext = {
    runner: deps.runner,
    pathExists: deps.pathExists,
    realpath: deps.realpath,
    redact: createRedactor(deps.secrets),
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
        return result(JSON.stringify({ worktrees: entries, records }))
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
        return result(JSON.stringify({ record: written, verified: addResult.verified }))
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
        return result(JSON.stringify({ record: current, status, dirty: dirtyText.length > 0, worktrees: entries }))
      } catch (error) {
        return result(`worktree status failed: ${message(error)}`)
      }
    },
  })

  draft.add({
    name: "worktree_push",
    description: "Push the tracked worktree branch and verify it on the remote. Requires confirm: true.",
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
      const remote = stringField(input, "remote") || "origin"

      try {
        const pushed = await gitPush(git, { repoRoot, branch, remote })
        if (pushed.exitCode !== 0) return result(`worktree push failed: ${pushed.stderr || "unknown error"}`)
        const refs = await gitLsRemote(git, { repoRoot, remote, ref: `refs/heads/${branch}` })
        const verified = refs.includes(`refs/heads/${branch}`)
        if (record.status === "moved") {
          await writeWorktree(deps.storage, { ...record, status: "ready" })
        }
        return result(JSON.stringify({ pushed: true, verified, remote, branch, refs }))
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
        return result(JSON.stringify({ removed: true, directory }))
      } catch (error) {
        return result(`worktree cleanup failed: ${message(error)}`)
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