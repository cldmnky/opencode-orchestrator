import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { redact } from "../process/redact.js"
import type { ProcessResult, ProcessRunner } from "../process/runner.js"

/**
 * Structured GitHub client (stage 3).
 *
 * All GitHub access goes through the `gh` CLI via the stage-2 `ProcessRunner`
 * (shell off, 1 MiB output bound, 30s default timeout), so tests inject fakes
 * and nothing here ever sees or handles tokens. `gh api` is invoked with the
 * fixed endpoint templates below (`repos/{owner}/{repo}/issues`,
 * `repos/{owner}/{repo}/pulls`, plus `/number`) and `--method GET/POST`.
 *
 * POST bodies cannot ride along as `--input -` stdin because the stage-2
 * runner spawns with `stdio: ["ignore", ...]` (stdin is closed). Bodies are
 * therefore written to a mode-0600 temp file and passed via `--input <file>`,
 * removed immediately after the call. The endpoint templates stay fixed.
 *
 * Every response is validated before it is returned: issues and pulls must
 * carry numeric `id`/`number` and a non-empty `html_url`; repo views must
 * carry `id`, `nameWithOwner`, and `url`. All raw process text and every
 * raised error message pass through the redactor (known secret shapes plus
 * caller-known exact secrets) before leaving this module.
 */

export const GH_CMD = "gh"

export type GhContext = {
  runner: ProcessRunner
  /** Optional redactor applied to every returned/raised text. */
  redact?: (text: string) => string
}

/** Raised for non-zero `gh` exits; fields already redacted. */
export class GhError extends Error {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string

  constructor(message: string, exitCode: number, stdout: string, stderr: string) {
    super(message)
    this.name = "GhError"
    this.exitCode = exitCode
    this.stdout = stdout
    this.stderr = stderr
  }
}

export type RepoInfo = {
  id: string
  nameWithOwner: string
  url: string
  defaultBranch: string | null
}

export type IssueInfo = {
  id: number
  number: number
  html_url: string
  title: string
  state: string
  body: string | null
  user?: { login: string }
}

export type PullInfo = {
  id: number
  number: number
  html_url: string
  title: string
  state: string
  merged: boolean
  user?: { login: string }
  head?: { ref: string; sha: string }
  base?: { ref: string }
}

export type CapabilitiesProbe = {
  gh: { available: boolean; version?: string }
  auth: { authenticated: boolean; hosts?: string[] }
  repo: RepoInfo | null
}

export type ResolveRepoInput = {
  owner?: string
  repo?: string
  cwd?: string
  timeoutMs?: number
}

export type IssueListInput = {
  owner: string
  repo: string
  state?: "open" | "closed" | "all"
  timeoutMs?: number
}

export type IssueViewInput = {
  owner: string
  repo: string
  number: number
  timeoutMs?: number
}

export type IssueCreateInput = {
  owner: string
  repo: string
  title: string
  body?: string
  labels?: readonly string[]
  timeoutMs?: number
}

export type PullListInput = {
  owner: string
  repo: string
  state?: "open" | "closed" | "all"
  timeoutMs?: number
}

export type PullViewInput = {
  owner: string
  repo: string
  number: number
  timeoutMs?: number
}

export type PullCreateInput = {
  owner: string
  repo: string
  title: string
  head: string
  base: string
  body?: string
  draft?: boolean
  timeoutMs?: number
}

const ISSUE_STATES = ["open", "closed", "all"] as const

/** Repo slug hygiene: endpoint segments must be URL-safe (http://gh.io/repos). */
export function assertRepoSlug(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`)
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`${label} must be a URL-safe slug: ${value}`)
  return value
}

export function assertIssueNumber(value: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`number must be a positive integer`)
  }
  return value
}

export function assertIssueState(value: string): (typeof ISSUE_STATES)[number] {
  if (!(ISSUE_STATES as readonly string[]).includes(value)) {
    throw new Error(`state must be one of: ${ISSUE_STATES.join(", ")}`)
  }
  return value as (typeof ISSUE_STATES)[number]
}

/** Validate a raw GitHub API issue object: id, number, and html_url are required. */
export function assertIssueShape(value: unknown): IssueInfo {
  const issue = objectOf(value)
  if (typeof issue.id !== "number") throw new Error('github issue response is missing numeric "id"')
  if (typeof issue.number !== "number") throw new Error('github issue response is missing numeric "number"')
  if (typeof issue.html_url !== "string" || issue.html_url.length === 0) {
    throw new Error('github issue response is missing "html_url"')
  }
  return {
    id: issue.id,
    number: issue.number,
    html_url: issue.html_url,
    title: typeof issue.title === "string" ? issue.title : "",
    state: typeof issue.state === "string" ? issue.state : "",
    body: typeof issue.body === "string" ? issue.body : null,
    user: loginOf(issue.user),
  }
}

/** Validate a raw GitHub API pull object: id, number, and html_url are required. */
export function assertPullShape(value: unknown): PullInfo {
  const pull = objectOf(value)
  if (typeof pull.id !== "number") throw new Error('github pull response is missing numeric "id"')
  if (typeof pull.number !== "number") throw new Error('github pull response is missing numeric "number"')
  if (typeof pull.html_url !== "string" || pull.html_url.length === 0) {
    throw new Error('github pull response is missing "html_url"')
  }
  const head = pull.head && typeof pull.head === "object" ? (pull.head as Record<string, unknown>) : undefined
  const base = pull.base && typeof pull.base === "object" ? (pull.base as Record<string, unknown>) : undefined
  return {
    id: pull.id,
    number: pull.number,
    html_url: pull.html_url,
    title: typeof pull.title === "string" ? pull.title : "",
    state: typeof pull.state === "string" ? pull.state : "",
    merged: mergedOf(pull),
    user: loginOf(pull.user),
    head:
      head && typeof head.ref === "string" && typeof head.sha === "string" ? { ref: head.ref, sha: head.sha } : undefined,
    base: base && typeof base.ref === "string" ? { ref: base.ref } : undefined,
  }
}

/** Resolve the current directory's repo, or `owner/repo` when both are given. */
export async function resolveRepo(gh: GhContext, input: ResolveRepoInput = {}): Promise<RepoInfo> {
  const owner = input.owner !== undefined ? assertRepoSlug(input.owner, "owner") : undefined
  const repo = input.repo !== undefined ? assertRepoSlug(input.repo, "repo") : undefined
  if ((owner === undefined) !== (repo === undefined)) {
    throw new Error("owner and repo must be provided together")
  }
  const args = ["repo", "view"]
  if (owner && repo) args.push(`${owner}/${repo}`)
  args.push("--json", "id,nameWithOwner,url,defaultBranchRef")
  const result = await run(gh, args, { cwd: input.cwd, timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh repo view")
  const view = objectOf(parseJson(result.stdout, gh))
  if (typeof view.id !== "string" || view.id.length === 0) throw new Error('gh repo view response is missing "id"')
  if (typeof view.nameWithOwner !== "string" || view.nameWithOwner.length === 0) {
    throw new Error('gh repo view response is missing "nameWithOwner"')
  }
  if (typeof view.url !== "string" || view.url.length === 0) throw new Error('gh repo view response is missing "url"')
  return {
    id: view.id,
    nameWithOwner: view.nameWithOwner,
    url: view.url,
    defaultBranch: defaultBranchOf(view.defaultBranchRef),
  }
}

export async function listIssues(gh: GhContext, input: IssueListInput): Promise<IssueInfo[]> {
  const { owner, repo } = repoOf(input)
  const state = input.state !== undefined ? assertIssueState(input.state) : undefined
  const result = await ghApi(gh, "GET", issuesEndpoint(owner, repo), {
    query: state !== undefined ? `state=${state}` : undefined,
    timeoutMs: input.timeoutMs,
  })
  requireZero(result, gh, "gh issue list")
  const items = parseJson(result.stdout, gh)
  if (!Array.isArray(items)) throw new Error("github issue list response is not an array")
  return items.map(assertIssueShape)
}

export async function viewIssue(gh: GhContext, input: IssueViewInput): Promise<IssueInfo> {
  const { owner, repo } = repoOf(input)
  const number = assertIssueNumber(input.number)
  const result = await ghApi(gh, "GET", `${issuesEndpoint(owner, repo)}/${number}`, { timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh issue view")
  return assertIssueShape(parseJson(result.stdout, gh))
}

export async function createIssue(gh: GhContext, input: IssueCreateInput): Promise<IssueInfo> {
  const { owner, repo } = repoOf(input)
  const title = assertTitle(input.title)
  const labels = (input.labels ?? []).map(assertLabel)
  const body: Record<string, unknown> = { title }
  if (input.body !== undefined && input.body.trim().length > 0) body.body = input.body
  if (labels.length > 0) body.labels = labels
  const result = await ghApi(gh, "POST", issuesEndpoint(owner, repo), { body, timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh issue create")
  return assertIssueShape(parseJson(result.stdout, gh))
}

export async function listPulls(gh: GhContext, input: PullListInput): Promise<PullInfo[]> {
  const { owner, repo } = repoOf(input)
  const state = input.state !== undefined ? assertIssueState(input.state) : undefined
  const result = await ghApi(gh, "GET", pullsEndpoint(owner, repo), {
    query: state !== undefined ? `state=${state}` : undefined,
    timeoutMs: input.timeoutMs,
  })
  requireZero(result, gh, "gh pr list")
  const items = parseJson(result.stdout, gh)
  if (!Array.isArray(items)) throw new Error("github pull list response is not an array")
  return items.map(assertPullShape)
}

export async function viewPull(gh: GhContext, input: PullViewInput): Promise<PullInfo> {
  const { owner, repo } = repoOf(input)
  const number = assertIssueNumber(input.number)
  const result = await ghApi(gh, "GET", `${pullsEndpoint(owner, repo)}/${number}`, { timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh pr view")
  return assertPullShape(parseJson(result.stdout, gh))
}

export async function createPull(gh: GhContext, input: PullCreateInput): Promise<PullInfo> {
  const { owner, repo } = repoOf(input)
  const title = assertTitle(input.title)
  const head = assertRef(input.head, "head")
  const base = assertRef(input.base, "base")
  const body: Record<string, unknown> = { title, head, base }
  if (input.body !== undefined && input.body.trim().length > 0) body.body = input.body
  if (input.draft === true) body.draft = true
  const result = await ghApi(gh, "POST", pullsEndpoint(owner, repo), { body, timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh pr create")
  return assertPullShape(parseJson(result.stdout, gh))
}

/**
 * Best-effort capability probe for the `orchestrator_github_capabilities`
 * tool. Never throws for an absent gh binary, failed auth, or an unresolvable
 * repo; each probe degrades to the corresponding `false`/`null` field.
 */
export async function probeCapabilities(
  gh: GhContext,
  input: { cwd?: string; timeoutMs?: number } = {},
): Promise<CapabilitiesProbe> {
  let version: ProcessResult
  try {
    version = await run(gh, ["--version"], { cwd: input.cwd, timeoutMs: input.timeoutMs ?? 10_000 })
  } catch {
    return { gh: { available: false }, auth: { authenticated: false }, repo: null }
  }
  if (version.exitCode !== 0) {
    return { gh: { available: false }, auth: { authenticated: false }, repo: null }
  }

  let authResult: ProcessResult
  try {
    authResult = await run(gh, ["auth", "status"], { cwd: input.cwd, timeoutMs: input.timeoutMs ?? 10_000 })
  } catch {
    authResult = { exitCode: 1, stdout: "", stderr: "" }
  }
  const hosts = authResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^Logged in to (\S+)/)?.[1])
    .filter((host): host is string => Boolean(host))

  let repo: RepoInfo | null = null
  try {
    repo = await resolveRepo(gh, { cwd: input.cwd })
  } catch {
    repo = null
  }

  return {
    gh: { available: true, version: firstLine(version.stdout) },
    auth: { authenticated: authResult.exitCode === 0, hosts },
    repo,
  }
}

// --- internal plumbing -------------------------------------------------------

/** `gh api` with the fixed endpoint templates; redacts raw output at the source. */
async function ghApi(
  gh: GhContext,
  method: "GET" | "POST",
  endpoint: string,
  opts: { body?: unknown; query?: string; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  const args = ["api", "--method", method]
  let temp: string | undefined
  if (opts.body !== undefined) {
    temp = await writeTempBody(opts.body)
    args.push("--input", temp)
  }
  args.push(endpoint)
  if (opts.query !== undefined) args.push("-f", opts.query)
  try {
    return await run(gh, args, { timeoutMs: opts.timeoutMs })
  } finally {
    if (temp) await rm(path.dirname(temp), { recursive: true, force: true })
  }
}

async function run(
  gh: GhContext,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  const result = await gh.runner.run(GH_CMD, args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs })
  return { ...result, stdout: redactText(gh, result.stdout), stderr: redactText(gh, result.stderr) }
}

function requireZero(result: ProcessResult, gh: GhContext, what: string): void {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output"
    throw new GhError(`${what} failed (exit ${result.exitCode}): ${detail}`, result.exitCode, result.stdout, result.stderr)
  }
}

async function writeTempBody(body: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-gh-"))
  const file = path.join(dir, "input.json")
  await writeFile(file, JSON.stringify(body), { mode: 0o600 })
  return file
}

function parseJson(text: string, gh: GhContext): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    const snippet = text.length > 400 ? `${text.slice(0, 400)}...` : text
    throw new Error(`github returned invalid JSON: ${error instanceof Error ? error.message : String(error)} (${redactText(gh, snippet)})`)
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("github response is not an object")
  return value as Record<string, unknown>
}

function redactText(gh: GhContext, text: string): string {
  if (!text) return text
  return gh.redact ? gh.redact(text) : redact(text)
}

function loginOf(value: unknown): { login: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const login = (value as Record<string, unknown>).login
  return typeof login === "string" && login.length > 0 ? { login } : undefined
}

/**
 * GitHub expresses merge state differently across pull payloads: the direct
 * pull endpoint returns a boolean `merged`, while the list endpoint omits it
 * and only sets `merged_at` (a timestamp when merged, null otherwise). A
 * non-empty `merged_at` therefore counts as merged; an explicit boolean wins.
 */
function mergedOf(pull: Record<string, unknown>): boolean {
  if (typeof pull.merged === "boolean") return pull.merged
  return typeof pull.merged_at === "string" && pull.merged_at.length > 0
}

function defaultBranchOf(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value
  if (value && typeof value === "object") {
    const name = (value as Record<string, unknown>).name
    if (typeof name === "string" && name.length > 0) return name
  }
  return null
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? ""
}

function repoOf(input: { owner: string; repo: string }): { owner: string; repo: string } {
  return {
    owner: assertRepoSlug(input.owner, "owner"),
    repo: assertRepoSlug(input.repo, "repo"),
  }
}

function assertTitle(value: string): string {
  const title = value.trim()
  if (title.length === 0) throw new Error("title must be a non-empty string")
  if (title.length > 512) throw new Error("title must be at most 512 characters")
  return title
}

function assertLabel(value: string): string {
  const label = value.trim()
  if (label.length === 0) throw new Error("labels must be non-empty strings")
  if (label.length > 50) throw new Error("labels must be at most 50 characters")
  return label
}

function assertRef(value: string, label: string): string {
  const ref = value.trim()
  if (ref.length === 0) throw new Error(`${label} must be a non-empty ref`)
  if (ref.includes("\0") || /\s/.test(ref)) throw new Error(`${label} is not a valid ref`)
  if (ref.startsWith("-")) throw new Error(`${label} must not start with '-'`)
  return ref
}

/** Fixed endpoint template: `repos/{owner}/{repo}/issues`. */
export function issuesEndpoint(owner: string, repo: string): string {
  return `repos/${owner}/${repo}/issues`
}

/** Fixed endpoint template: `repos/{owner}/{repo}/pulls`. */
export function pullsEndpoint(owner: string, repo: string): string {
  return `repos/${owner}/${repo}/pulls`
}