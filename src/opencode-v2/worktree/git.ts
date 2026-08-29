import path from "node:path"
import { realpath as fsRealpath } from "node:fs/promises"
import type { ProcessResult, ProcessRunner } from "../process/runner.js"

/**
 * Tracked git worktree lifecycle client (stage 2).
 *
 * Every git invocation goes through an injected `ProcessRunner` (shell off,
 * 1 MiB output bound, 30s default timeout). Path safety is enforced
 * caller-side, before any runner call: invalid branches, bare or linked
 * repos, existing worktree paths, existing local branches, and directories
 * inside the main checkout are all rejected up front. Creates are verified
 * afterwards via `git worktree list --porcelain` and `git rev-parse`.
 *
 * Path *comparisons* (overlap detection, post-add verification, main-checkout
 * identity) are canonical: each side is resolved through an optional injected
 * `realpath` resolver, defaulting to realpath with nearest-existing-ancestor
 * fallback for targets that do not exist yet. That keeps `/tmp/...` and
 * `/private/tmp/...` aliases of the same directory comparable. The resolver
 * probes the filesystem read-only; tests inject fakes or use throwaway temp
 * fixtures. Lexical input safety (absolute, NUL-free, branch format, inside
 * the main checkout) is intentionally preserved on the raw inputs.
 *
 * A nonzero `git worktree add` exits immediately: the (already redacted)
 * stderr/stdout is raised, and no post-add list/ref verification or ready
 * state is produced.
 *
 * All runner invocations funnel through a fixed allowlist of git subcommand
 * families (`assertGitFamilyAllowed`), so an untrusted field can never smuggle
 * arbitrary git arguments into a process.
 */

export const GIT_CMD = "git"

/** The only git subcommand families this client is allowed to run. */
export const GIT_FAMILIES = ["worktree", "ls-remote", "push", "rev-parse", "branch", "status"] as const

const familySet = new Set<string>(GIT_FAMILIES)

/** Args allowlist: the first argument must be a known git subcommand family. */
export function assertGitFamilyAllowed(args: readonly string[]): void {
  if (args.length === 0) throw new Error("empty git argument list")
  const family = args[0]
  if (!familySet.has(family)) throw new Error(`disallowed git subcommand: ${family}`)
}

export type GitContext = {
  runner: ProcessRunner
  /** Optional existence probe for the "existing path" safety check. */
  pathExists?: (directory: string) => Promise<boolean>
  /** Optional redactor applied to every returned/raised text. */
  redact?: (text: string) => string
  /**
   * Optional canonical path resolver. `undefined` from a resolver (or an
   * absent resolver) falls back to realpath with nearest-existing-ancestor
   * resolution, so not-yet-created create targets stay comparable.
   */
  realpath?: (directory: string) => Promise<string | undefined>
}

/** Injected canonical path resolver used by `canonicalPath`. */
export type RealpathResolver = (directory: string) => Promise<string | undefined>

export type WorktreeEntry = {
  directory: string
  head?: string
  /** Full ref such as `refs/heads/feature`; absent when detached. */
  branch?: string
  detached?: boolean
  locked?: boolean
  prunable?: boolean
}

export type WorktreeAddInput = {
  repoRoot: string
  branch: string
  directory: string
  base: string
  timeoutMs?: number
}

export type WorktreeAddResult = ProcessResult & {
  verified: boolean
  verification: { listed: boolean; branchResolved: boolean }
}

export type PushInput = {
  repoRoot: string
  branch: string
  remote?: string
  timeoutMs?: number
}

export type RemoveInput = {
  repoRoot: string
  directory: string
  force?: boolean
  timeoutMs?: number
}

export type LsRemoteInput = {
  repoRoot: string
  remote?: string
  ref?: string
  timeoutMs?: number
}

export type ValidationResult = { ok: true } | { ok: false; reason: string }

/**
 * Pure, runner-free validation of a create request. Rejects relative paths,
 * invalid branch names, directories inside the main checkout (and the main
 * checkout inside the directory), and empty/option-shaped bases.
 */
export function validateWorktreeCreate(input: WorktreeAddInput): ValidationResult {
  if (!isAbsoluteSafe(input.repoRoot)) return { ok: false, reason: "repoRoot must be an absolute path" }
  if (!isAbsoluteSafe(input.directory)) return { ok: false, reason: "directory must be an absolute path" }
  if (!isValidBranchName(input.branch)) return { ok: false, reason: `invalid branch name: ${input.branch}` }
  if (input.base.length === 0) return { ok: false, reason: "base must be a non-empty ref" }
  if (input.base.startsWith("-")) return { ok: false, reason: "base must not start with '-'" }
  if (input.base.includes("\0")) return { ok: false, reason: "base must not contain NUL" }

  const repo = path.resolve(input.repoRoot)
  const dir = path.resolve(input.directory)
  if (repo === dir) return { ok: false, reason: "worktree directory must not be the main checkout" }
  if (isPathInside(dir, repo)) return { ok: false, reason: "worktree directory must be outside the main checkout" }
  if (isPathInside(repo, dir)) return { ok: false, reason: "main checkout must not be inside the worktree directory" }
  return { ok: true }
}

/**
 * Strict subset of `git check-ref-format` for `-b <branch>` targets: no
 * whitespace, control chars, git metacharacters, `..`, `@{`, leading `-`/`.`,
 * `.lock` suffix, or reserved names.
 */
export function isValidBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.length > 255) return false
  if (branch === "HEAD" || branch === "@") return false
  if (/\s/.test(branch)) return false
  if (branch.startsWith("-") || branch.startsWith(".")) return false
  if (/[~^:?*[\\]/.test(branch)) return false
  if (branch.includes("..") || branch.includes("@{") || branch.includes("\0")) return false
  if (branch.endsWith(".") || branch.endsWith(".lock")) return false
  return true
}

/**
 * Pure path containment (no filesystem access). `false` when `child` equals
 * `parent` (equality is handled by callers) or lies outside it.
 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * Canonicalize an absolute path with nearest-existing-ancestor resolution:
 * `realpath` succeeds when the path exists; otherwise walk up to the closest
 * existing ancestor, canonicalize it, and re-append the missing tail. A path
 * under a plain (non-symlinked) prefix canonicalizes to its lexical form, so
 * synthetic paths in tests resolve to themselves. `realpath` failures other
 * than missing paths degrade to the lexical form too.
 */
export async function resolveRealpath(target: string): Promise<string> {
  const absolute = path.resolve(target)
  try {
    return await fsRealpath(absolute)
  } catch {
    // Fall through to the ancestor walk.
  }
  let current = absolute
  const tail: string[] = []
  for (;;) {
    const parent = path.dirname(current)
    if (parent === current) {
      // Nothing above the root exists; the lexical form is all we can know.
      return absolute
    }
    try {
      const canonicalAncestor = await fsRealpath(current)
      return tail.length === 0 ? canonicalAncestor : path.resolve(canonicalAncestor, ...tail.reverse())
    } catch {
      tail.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Canonicalize `directory` using the injected resolver when provided;
 * otherwise use realpath with nearest-existing-ancestor fallback. A resolver
 * returning `undefined` also falls back to the default resolution.
 */
export async function canonicalPath(resolver: RealpathResolver | undefined, directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  if (resolver) {
    const canonical = await resolver(resolved)
    if (canonical !== undefined) return canonical
  }
  return resolveRealpath(resolved)
}

/**
 * Create a linked worktree. Safety checks run strictly before the add:
 * bare/linked repo, existing local branch, existing path, and overlap with an
 * existing worktree are all rejected; afterwards the create is verified via
 * `worktree list --porcelain` and `rev-parse` of the new branch. Path
 * comparisons are canonical; a nonzero `git worktree add` raises immediately
 * with the redacted output and produces no verification or ready state.
 */
export async function gitWorktreeAdd(ctx: GitContext, input: WorktreeAddInput): Promise<WorktreeAddResult> {
  const validation = validateWorktreeCreate(input)
  if (!validation.ok) throw new Error(`worktree create rejected: ${validation.reason}`)

  const bare = await gitRevParse(ctx, input.repoRoot, "--is-bare-repository")
  if (bare === undefined) throw new Error("worktree create rejected: not a git repository")
  if (bare === "true") throw new Error("worktree create rejected: bare repository")

  const gitDir = await gitRevParse(ctx, input.repoRoot, "--git-dir")
  if (gitDir === undefined) throw new Error("worktree create rejected: not a git repository")
  // `--git-dir` may be relative to the runner cwd (repoRoot) with cwd-bound git
  // (e.g. `.git` on a normal main checkout); resolve it against repoRoot, never
  // against the server process cwd, before comparing to the main checkout. The
  // comparison is canonical so a symlink alias of repoRoot (e.g. `/tmp` vs
  // `/private/tmp` on macOS) still matches the same main checkout.
  const resolvedGitDir = path.isAbsolute(gitDir) ? path.resolve(gitDir) : path.resolve(input.repoRoot, gitDir)
  const canonicalGitDir = await canonicalize(ctx, resolvedGitDir)
  const mainGitDir = await canonicalize(ctx, path.resolve(input.repoRoot, ".git"))
  if (canonicalGitDir !== mainGitDir) {
    throw new Error("worktree create rejected: repoRoot is a linked worktree; create from the main checkout")
  }

  const existingBranch = await gitRevParse(ctx, input.repoRoot, `refs/heads/${input.branch}`)
  if (existingBranch !== undefined) {
    throw new Error(`worktree create rejected: local branch already exists: ${input.branch}`)
  }

  if (ctx.pathExists && (await ctx.pathExists(input.directory))) {
    throw new Error(`worktree create rejected: directory already exists: ${input.directory}`)
  }

  const before = await gitWorktreeList(ctx, input.repoRoot)
  const target = path.resolve(input.directory)
  const canonicalTarget = await canonicalize(ctx, target)
  for (const entry of before) {
    if (conflictsWith(await canonicalize(ctx, entry.directory), canonicalTarget)) {
      throw new Error(`worktree create rejected: directory overlaps an existing worktree: ${input.directory}`)
    }
  }

  const args = ["worktree", "add", "-b", input.branch, "--", input.directory, input.base]
  assertGitFamilyAllowed(args)
  // Runs through `run` so stdout/stderr are redacted before they can leave.
  const result = await run(ctx, input.repoRoot, args, input.timeoutMs)
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].filter((part) => part.length > 0).join(" ").trim()
    const suffix = detail.length > 0 ? `: ${detail}` : ""
    throw new Error(`worktree create failed: git worktree add exited with code ${result.exitCode}${suffix}`)
  }

  // Only reach here on a successful add.
  const after = await gitWorktreeList(ctx, input.repoRoot)
  let listed = false
  for (const entry of after) {
    if ((await canonicalize(ctx, entry.directory)) === canonicalTarget) {
      listed = true
      break
    }
  }
  const branchResolved = (await gitRevParse(ctx, input.repoRoot, `refs/heads/${input.branch}`)) !== undefined
  if (!listed || !branchResolved) {
    throw new Error("worktree create failed verification after git worktree add")
  }
  return {
    ...result,
    verified: true,
    verification: { listed, branchResolved },
  }
}

/** Parse `git worktree list --porcelain` output into structured entries. */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.length > 0)
    if (lines.length === 0) continue
    const entry: WorktreeEntry = { directory: "" }
    for (const line of lines) {
      const [key, ...rest] = line.split(" ")
      const value = rest.join(" ")
      switch (key) {
        case "worktree":
          entry.directory = value
          break
        case "HEAD":
          entry.head = value
          break
        case "branch":
          entry.branch = value
          break
        case "detached":
          entry.detached = true
          break
        case "locked":
          entry.locked = true
          break
        case "prunable":
          entry.prunable = true
          break
      }
    }
    entries.push(entry)
  }
  return entries
}

export async function gitWorktreeList(ctx: GitContext, repoRoot: string): Promise<WorktreeEntry[]> {
  const args = ["worktree", "list", "--porcelain"]
  const result = await run(ctx, repoRoot, args)
  if (result.exitCode !== 0) throw new Error(`git worktree list failed: ${result.stderr}`)
  return parseWorktreeList(result.stdout)
}

/**
 * `git rev-parse` for a single argument: `--is-bare-repository`,
 * `--git-dir`, `--show-toplevel`, or a ref such as `refs/heads/x`.
 * Returns `undefined` for any non-zero exit (missing ref, not a repo).
 */
export async function gitRevParse(ctx: GitContext, repoRoot: string, arg: string): Promise<string | undefined> {
  const args = ["rev-parse", arg]
  const result = await run(ctx, repoRoot, args)
  if (result.exitCode !== 0) return undefined
  return result.stdout.trim()
}

/** The current branch name, or `undefined` when detached or not a repo. */
export async function gitBranchShowCurrent(ctx: GitContext, repoRoot: string): Promise<string | undefined> {
  const args = ["branch", "--show-current"]
  const result = await run(ctx, repoRoot, args)
  if (result.exitCode !== 0) return undefined
  return result.stdout.trim()
}

/** `git status --porcelain` output; empty string means a clean tree. */
export async function gitStatus(ctx: GitContext, repoRoot: string): Promise<string> {
  const args = ["status", "--porcelain"]
  const result = await run(ctx, repoRoot, args)
  if (result.exitCode !== 0) throw new Error(`git status failed: ${result.stderr}`)
  return result.stdout
}

/** Push and set the upstream: `git push --set-upstream <remote> <branch>`. */
export async function gitPush(ctx: GitContext, input: PushInput): Promise<ProcessResult> {
  const remote = input.remote ?? "origin"
  const args = ["push", "--set-upstream", remote, input.branch]
  return run(ctx, input.repoRoot, args, input.timeoutMs)
}

/** `git ls-remote <remote> <ref>`; empty string when the ref is absent. */
export async function gitLsRemote(ctx: GitContext, input: LsRemoteInput): Promise<string> {
  const remote = input.remote ?? "origin"
  const args = ["ls-remote", remote, input.ref ?? "HEAD"]
  const result = await run(ctx, input.repoRoot, args, input.timeoutMs)
  if (result.exitCode !== 0) throw new Error(`git ls-remote failed: ${result.stderr}`)
  return result.stdout
}

/** `git worktree remove <directory>` (optionally `--force`). */
export async function gitWorktreeRemove(ctx: GitContext, input: RemoveInput): Promise<ProcessResult> {
  const args = input.force
    ? ["worktree", "remove", "--force", input.directory]
    : ["worktree", "remove", input.directory]
  return run(ctx, input.repoRoot, args, input.timeoutMs)
}

async function run(ctx: GitContext, cwd: string, args: readonly string[], timeoutMs?: number): Promise<ProcessResult> {
  assertGitFamilyAllowed(args)
  const result = await ctx.runner.run(GIT_CMD, args, { cwd, timeoutMs })
  if (ctx.redact) {
    return { ...result, stdout: ctx.redact(result.stdout), stderr: ctx.redact(result.stderr) }
  }
  return result
}

function conflictsWith(entryDirectory: string, target: string): boolean {
  const entry = path.resolve(entryDirectory)
  return entry === target || isPathInside(target, entry) || isPathInside(entry, target)
}

function isAbsoluteSafe(value: string): boolean {
  return value.length > 0 && path.isAbsolute(value) && !value.includes("\0")
}

/** Canonicalize via the injected resolver when present, else the fs default. */
function canonicalize(ctx: GitContext, directory: string): Promise<string> {
  return canonicalPath(ctx.realpath, directory)
}
