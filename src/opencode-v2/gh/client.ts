import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { redact } from "../process/redact.js"
import type { ProcessResult, ProcessRunner } from "../process/runner.js"

/**
 * Structured GitHub client (stage 3, draft-first lifecycle).
 *
 * All GitHub access goes through the `gh` CLI via the stage-2 `ProcessRunner`
 * (shell off, 1 MiB output bound, 30s default timeout), so tests inject fakes
 * and nothing here ever sees or handles tokens. `gh api` is invoked with the
 * fixed endpoint templates below and `--method GET/POST/PUT`.
 *
 * Request bodies cannot ride along as `--input -` stdin because the stage-2
 * runner spawns with `stdio: ["ignore", ...]` (stdin is closed). Bodies are
 * therefore written to a mode-0600 temp file and passed via `--input <file>`,
 * removed immediately after the call. The endpoint templates stay fixed.
 *
 * Every response is validated before it is returned: issues and pulls must
 * carry numeric `id`/`number` and a non-empty `html_url`; pulls additionally
 * preserve draft/mergeability/mergeable_state and the base/head ref+sha fields;
 * branches must carry a full lowercase object-id `commit.sha`; compare
 * responses must carry a supported status, non-negative ahead/behind counts,
 * and a full `base_commit.sha`; reviews must carry `id`, `state`, `html_url`,
 * and (strictly on create) the exact `commit_id` that was submitted; pull
 * merges must carry `sha`, `merged`, and `message`; the authenticated viewer
 * must carry a non-empty `login`. All raw process text and every raised error
 * message pass through the redactor (known secret shapes plus caller-known
 * exact secrets) before leaving this module.
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
  base?: { ref: string; sha?: string }
  draft?: boolean
  mergeable?: boolean | null
  mergeableState?: string | null
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

/**
 * Draft-first pull creation: the client ALWAYS sends `draft: true` (there is
 * no caller-controlled draft field) and refuses the created pull unless the
 * response reports `draft === true` and, when expected SHAs are provided, the
 * returned head/base SHAs equal them exactly.
 */
export type PullCreateInput = {
  owner: string
  repo: string
  title: string
  head: string
  base: string
  body?: string
  /** When provided, the created pull's `head.sha` must equal this exactly. */
  expectedHeadSha?: string
  /** When provided, the created pull's `base.sha` must equal this exactly. */
  expectedBaseSha?: string
  timeoutMs?: number
}

export type PullMergeInput = {
  owner: string
  repo: string
  number: number
  /** SHA that the pull request head must match for the merge to be allowed. */
  sha: string
  mergeMethod?: "merge" | "squash" | "rebase"
  commitTitle?: string
  commitMessage?: string
  timeoutMs?: number
}

/** Validated `PUT /repos/{owner}/{repo}/pulls/{number}/merge` response body. */
export type PullMergeResult = {
  sha: string
  merged: boolean
  message: string
}

/** Authenticated viewer from `GET /user`. */
export type ViewerInfo = { login: string }

export type BranchRefInput = {
  owner: string
  repo: string
  branch: string
  timeoutMs?: number
}

/** Validated branch ref: `name` plus the FULL lowercase object id of `commit.sha`. */
export type BranchRef = { name: string; sha: string }

export const COMPARE_STATUSES = ["ahead", "behind", "diverged", "identical"] as const
export type CompareStatus = (typeof COMPARE_STATUSES)[number]

export type CompareInput = {
  owner: string
  repo: string
  /** Base ref used inside the compare URL path segment. */
  base: string
  /** Head ref used inside the compare URL path segment. */
  head: string
  timeoutMs?: number
}

export type CompareResult = {
  status: CompareStatus
  /** Commits the head ref is ahead of the base ref. */
  aheadBy: number
  /** Commits the head ref is behind the base ref (base-only commits). */
  behindBy: number
  /** Full lowercase object id of the base commit in the current remote base ref. */
  baseSha: string
  /**
   * True exactly when the compare proves the current remote base ref is an
   * ancestor of the current remote head ref (not diverged, zero behind).
   */
  ancestor: boolean
}

export type PullReadyInput = {
  owner: string
  repo: string
  number: number
  timeoutMs?: number
}

export const PULL_REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const
export type PullReviewEvent = (typeof PULL_REVIEW_EVENTS)[number]

export type PullReviewInput = {
  owner: string
  repo: string
  number: number
  /** Exact FULL commit id the review is pinned to (`body.commit_id`). */
  commitId: string
  event: PullReviewEvent
  timeoutMs?: number
}

/** Validated pull review object (create response and list items). */
export type PullReview = {
  id: number
  state: string
  commit_id?: string
  html_url: string
  user?: { login: string }
}

const ISSUE_STATES = ["open", "closed", "all"] as const

const MERGE_METHODS = ["merge", "squash", "rebase"] as const

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

/**
 * Exact full git object-id token: FULL lowercase 40-hex (SHA-1) or 64-hex
 * (SHA-256) only. Abbreviated or upper-case forms are never treated as an
 * exact revision, because publication safety needs an unambiguous pin.
 */
export function assertFullSha(value: string, label: string): string {
  const sha = value.trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new Error(`${label} must be a full 40- or 64-character lowercase hex git SHA`)
  }
  return sha
}

/**
 * Validate a ref before it is encoded into a URL path segment. GitHub branch
 * names commonly contain '/', so the raw ref is preserved and encoded by the
 * endpoint builder rather than rejected as though the slash were a route
 * separator.
 */
export function assertRefSegment(value: string, label: string): string {
  return assertRef(value, label)
}

export function assertReviewEvent(value: string): PullReviewEvent {
  if (!(PULL_REVIEW_EVENTS as readonly string[]).includes(value)) {
    throw new Error(`review event must be one of: ${PULL_REVIEW_EVENTS.join(", ")}`)
  }
  return value as PullReviewEvent
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

/**
 * Validate a raw GitHub API pull object: id, number, and html_url are
 * required; base/head refs, draft, mergeable, and mergeable_state are
 * preserved with type validation when present (absent stays absent — list
 * items are pull-request-simple objects). `base.sha`, when present, must be
 * a string; the head object, when present, must carry both `ref` and `sha`.
 */
export function assertPullShape(value: unknown): PullInfo {
  const pull = objectOf(value)
  if (typeof pull.id !== "number") throw new Error('github pull response is missing numeric "id"')
  if (typeof pull.number !== "number") throw new Error('github pull response is missing numeric "number"')
  if (typeof pull.html_url !== "string" || pull.html_url.length === 0) {
    throw new Error('github pull response is missing "html_url"')
  }
  const head = pull.head && typeof pull.head === "object" ? (pull.head as Record<string, unknown>) : undefined
  const base = pull.base && typeof pull.base === "object" ? (pull.base as Record<string, unknown>) : undefined
  if (pull.draft !== undefined && typeof pull.draft !== "boolean") {
    throw new Error('github pull response has invalid "draft"')
  }
  if (pull.mergeable !== undefined && pull.mergeable !== null && typeof pull.mergeable !== "boolean") {
    throw new Error('github pull response has invalid "mergeable"')
  }
  if (pull.mergeable_state !== undefined && pull.mergeable_state !== null && typeof pull.mergeable_state !== "string") {
    throw new Error('github pull response has invalid "mergeable_state"')
  }
  const baseSha = base && typeof base.sha === "string" ? base.sha : undefined
  if (base && base.sha !== undefined && typeof base.sha !== "string") {
    throw new Error('github pull response has invalid "base.sha"')
  }
  return {
    id: pull.id,
    number: pull.number,
    html_url: pull.html_url,
    title: typeof pull.title === "string" ? pull.title : "",
    state: typeof pull.state === "string" ? pull.state : "",
    merged: mergedOf(pull),
    user: loginOf(pull.user),
    head: head && typeof head.ref === "string" && typeof head.sha === "string" ? { ref: head.ref, sha: head.sha } : undefined,
    base:
      base && typeof base.ref === "string"
        ? { ref: base.ref, ...(baseSha !== undefined ? { sha: baseSha } : {}) }
        : undefined,
    draft: pull.draft === undefined ? undefined : (pull.draft as boolean),
    mergeable: pull.mergeable === undefined ? undefined : (pull.mergeable as boolean | null),
    mergeableState: pull.mergeable_state === undefined ? undefined : (pull.mergeable_state as string | null),
  }
}

/**
 * Validate the expected head SHA for a merge: a non-empty, whitespace-free,
 * 7-40 character hexadecimal git SHA. GitHub compares the value exactly
 * against the pull's `head.sha`, so a short unambiguous prefix still fails
 * the freshness check rather than merging on a stale head.
 */
export function assertMergeSha(value: string): string {
  const sha = value.trim()
  if (!/^[A-Fa-f0-9]{7,40}$/.test(sha)) {
    throw new Error("sha must be a 7-40 character hexadecimal commit SHA")
  }
  return sha
}

export function assertMergeMethod(value: string): (typeof MERGE_METHODS)[number] {
  if (!(MERGE_METHODS as readonly string[]).includes(value)) {
    throw new Error(`mergeMethod must be one of: ${MERGE_METHODS.join(", ")}`)
  }
  return value as (typeof MERGE_METHODS)[number]
}

/** Validate a raw GitHub pull-merge response: sha, merged, and message are required. */
export function assertPullMergeShape(value: unknown): PullMergeResult {
  const merge = objectOf(value)
  if (typeof merge.sha !== "string" || merge.sha.length === 0) {
    throw new Error('github pull merge response is missing "sha"')
  }
  if (typeof merge.merged !== "boolean") throw new Error('github pull merge response is missing "merged"')
  if (typeof merge.message !== "string") throw new Error('github pull merge response is missing "message"')
  return { sha: merge.sha, merged: merge.merged, message: merge.message }
}

/**
 * Validate a raw GitHub pull-review object: id, state, and html_url are
 * required; `commit_id` is preserved when present (the list endpoint may
 * return reviews without one); user login is optional. Create responses are
 * additionally checked for the exact submitted `commit_id` by
 * `createPullReview` itself.
 */
export function assertPullReviewShape(value: unknown): PullReview {
  const review = objectOf(value)
  if (typeof review.id !== "number") throw new Error('github pull review response is missing numeric "id"')
  if (typeof review.state !== "string" || review.state.length === 0) {
    throw new Error('github pull review response is missing "state"')
  }
  if (typeof review.html_url !== "string" || review.html_url.length === 0) {
    throw new Error('github pull review response is missing "html_url"')
  }
  if (review.commit_id !== undefined && typeof review.commit_id !== "string") {
    throw new Error('github pull review response has invalid "commit_id"')
  }
  return {
    id: review.id,
    state: review.state,
    commit_id: typeof review.commit_id === "string" ? review.commit_id : undefined,
    html_url: review.html_url,
    user: loginOf(review.user),
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

/**
 * Draft-first pull creation: ALWAYS sends `draft: true` (there is no
 * caller-controlled draft input), then refuses the result unless the created
 * pull reports `draft === true` and, when expected SHAs are provided, its
 * head/base SHAs match them exactly. Callers (the orchestrator) must have
 * already proven remote ancestry plus the approved exact-revision internal
 * review; this client only makes the mutation and verifies the returned
 * object.
 */
export async function createPull(gh: GhContext, input: PullCreateInput): Promise<PullInfo> {
  const { owner, repo } = repoOf(input)
  const title = assertTitle(input.title)
  const head = assertRef(input.head, "head")
  const base = assertRef(input.base, "base")
  // Expected exact revisions are validated up front so a malformed pin
  // refuses before any network call and no mutation can be attempted.
  const expectedHead = input.expectedHeadSha !== undefined ? assertFullSha(input.expectedHeadSha, "expectedHeadSha") : undefined
  const expectedBase = input.expectedBaseSha !== undefined ? assertFullSha(input.expectedBaseSha, "expectedBaseSha") : undefined
  const body: Record<string, unknown> = { title, head, base, draft: true }
  if (input.body !== undefined && input.body.trim().length > 0) body.body = input.body
  const result = await ghApi(gh, "POST", pullsEndpoint(owner, repo), { body, timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh pr create")
  const pull = assertPullShape(parseJson(result.stdout, gh))
  if (pull.draft !== true) {
    throw new Error(`github pull create response is not a draft (draft=${String(pull.draft)})`)
  }
  if (expectedHead !== undefined && pull.head?.sha !== expectedHead) {
    throw new Error(
      `github pull create returned head ${pull.head?.sha ?? "(unknown)"} but expected ${expectedHead}`,
    )
  }
  if (expectedBase !== undefined && pull.base?.sha !== expectedBase) {
    throw new Error(
      `github pull create returned base ${pull.base?.sha ?? "(unknown)"} but expected ${expectedBase}`,
    )
  }
  return pull
}

/**
 * Merge a pull request via the fixed `repos/{owner}/{repo}/pulls/{number}/merge`
 * endpoint. The expected head `sha` is required and sent in the body so GitHub
 * refuses the merge if the head moved; absent optional fields are omitted. The
 * response is validated as `{sha, merged, message}` before it is returned;
 * a non-zero `gh` exit (403/404/405/409/422) raises a redacted `GhError`.
 */
export async function mergePull(gh: GhContext, input: PullMergeInput): Promise<PullMergeResult> {
  const { owner, repo } = repoOf(input)
  const number = assertIssueNumber(input.number)
  const sha = assertMergeSha(input.sha)
  const body: Record<string, unknown> = { sha }
  if (input.mergeMethod !== undefined) body.merge_method = assertMergeMethod(input.mergeMethod)
  if (input.commitTitle !== undefined && input.commitTitle.trim().length > 0) {
    body.commit_title = input.commitTitle.trim()
  }
  if (input.commitMessage !== undefined && input.commitMessage.trim().length > 0) {
    body.commit_message = input.commitMessage.trim()
  }
  const result = await ghApi(gh, "PUT", pullMergeEndpoint(owner, repo, number), {
    body,
    timeoutMs: input.timeoutMs,
  })
  requireZero(result, gh, "gh pr merge")
  return assertPullMergeShape(parseJson(result.stdout, gh))
}

/** Authenticated viewer (`GET /user`): validated non-empty `login`. */
export async function getViewer(gh: GhContext, input: { timeoutMs?: number } = {}): Promise<ViewerInfo> {
  const result = await ghApi(gh, "GET", viewerEndpoint(), { timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh api user")
  const view = objectOf(parseJson(result.stdout, gh))
  const login = view.login
  if (typeof login !== "string" || login.length === 0) {
    throw new Error('github viewer response is missing "login"')
  }
  return { login }
}

/** Current remote branch ref: validated `name` plus FULL lowercase `commit.sha`. */
export async function getBranchRef(gh: GhContext, input: BranchRefInput): Promise<BranchRef> {
  const { owner, repo } = repoOf(input)
  const branch = assertRefSegment(input.branch, "branch")
  const result = await ghApi(gh, "GET", branchEndpoint(owner, repo, branch), { timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh branch view")
  const view = objectOf(parseJson(result.stdout, gh))
  if (typeof view.name !== "string" || view.name.length === 0) {
    throw new Error('github branch response is missing "name"')
  }
  const commit = view.commit
  if (!commit || typeof commit !== "object" || Array.isArray(commit)) {
    throw new Error('github branch response is missing "commit"')
  }
  const sha = (commit as Record<string, unknown>).sha
  if (typeof sha !== "string" || sha.length === 0) {
    throw new Error('github branch response is missing "commit.sha"')
  }
  return { name: view.name, sha: assertFullSha(sha, "branch sha") }
}

/**
 * Compare the current remote `base` ref against the current remote `head`
 * ref via the fixed `repos/{o}/{r}/compare/{base}...{head}` endpoint and
 * derive base-ancestry evidence: `ancestor` is true exactly when the
 * compare is not diverged and the head ref is not behind the base ref, and
 * the response's `base_commit.sha` must be a full lowercase object id.
 * Exact SHAs for both refs come from `getBranchRef` (this response does not
 * reliably carry the head's own object id).
 */
export async function compareRefs(gh: GhContext, input: CompareInput): Promise<CompareResult> {
  const { owner, repo } = repoOf(input)
  const base = assertRefSegment(input.base, "base")
  const head = assertRefSegment(input.head, "head")
  const result = await ghApi(gh, "GET", compareEndpoint(owner, repo, base, head), { timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh compare")
  const cmp = objectOf(parseJson(result.stdout, gh))
  const status = cmp.status
  if (typeof status !== "string" || !(COMPARE_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`github compare response has unsupported status ${redactText(gh, String(status))}`)
  }
  const aheadBy = countOf(cmp, "ahead_by", "ahead_by")
  const behindBy = countOf(cmp, "behind_by", "behind_by")
  const baseCommit = cmp.base_commit
  if (!baseCommit || typeof baseCommit !== "object" || Array.isArray(baseCommit)) {
    throw new Error('github compare response is missing "base_commit"')
  }
  const baseShaRaw = (baseCommit as Record<string, unknown>).sha
  if (typeof baseShaRaw !== "string" || baseShaRaw.length === 0) {
    throw new Error('github compare response is missing "base_commit.sha"')
  }
  return {
    status: status as CompareStatus,
    aheadBy,
    behindBy,
    baseSha: assertFullSha(baseShaRaw, "compare base sha"),
    ancestor: status !== "diverged" && behindBy === 0,
  }
}

/**
 * Mark a draft PR ready for review via the fixed
 * `POST repos/{owner}/{repo}/pulls/{number}/ready_for_review` endpoint (no
 * body) and validate the returned pull object. The caller must already hold
 * a fresh PR view proving draft/mergeability/conflict state; here only the
 * mutation and the response shape are handled.
 */
export async function markPullReady(gh: GhContext, input: PullReadyInput): Promise<PullInfo> {
  const { owner, repo } = repoOf(input)
  const number = assertIssueNumber(input.number)
  const result = await ghApi(gh, "POST", pullReadyEndpoint(owner, repo, number), { timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh pr ready")
  return assertPullShape(parseJson(result.stdout, gh))
}

/**
 * Create a pull review pinned to an exact commit id via the fixed
 * `POST repos/{owner}/{repo}/pulls/{number}/reviews` endpoint with
 * `{commit_id, event}`. The response must carry the exact submitted
 * `commit_id` or the call fails closed.
 */
export async function createPullReview(gh: GhContext, input: PullReviewInput): Promise<PullReview> {
  const { owner, repo } = repoOf(input)
  const number = assertIssueNumber(input.number)
  const commitId = assertFullSha(input.commitId, "review commit_id")
  const event = assertReviewEvent(input.event)
  const body: Record<string, unknown> = { commit_id: commitId, event }
  const result = await ghApi(gh, "POST", pullReviewsEndpoint(owner, repo, number), { body, timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh pr review")
  const review = assertPullReviewShape(parseJson(result.stdout, gh))
  if (review.commit_id !== commitId) {
    throw new Error(
      `github review create returned commit_id ${review.commit_id ?? "(none)"} but expected ${commitId}`,
    )
  }
  return review
}

/** List pull reviews via the fixed `GET .../pulls/{number}/reviews` endpoint. */
export async function listPullReviews(gh: GhContext, input: PullViewInput): Promise<PullReview[]> {
  const { owner, repo } = repoOf(input)
  const number = assertIssueNumber(input.number)
  const result = await ghApi(gh, "GET", pullReviewsEndpoint(owner, repo, number), { timeoutMs: input.timeoutMs })
  requireZero(result, gh, "gh pr reviews")
  const items = parseJson(result.stdout, gh)
  if (!Array.isArray(items)) throw new Error("github pull review list response is not an array")
  return items.map(assertPullReviewShape)
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
  method: "GET" | "POST" | "PUT",
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

function countOf(obj: Record<string, unknown>, key: string, label: string): number {
  const value = obj[key]
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`github compare response ${label} must be a non-negative integer`)
  }
  return value
}

/** Fixed endpoint template: `user` (authenticated viewer). */
export function viewerEndpoint(): string {
  return "user"
}

/** Fixed endpoint template: `repos/{owner}/{repo}/issues`. */
export function issuesEndpoint(owner: string, repo: string): string {
  return `repos/${owner}/${repo}/issues`
}

/** Fixed endpoint template: `repos/{owner}/{repo}/pulls`. */
export function pullsEndpoint(owner: string, repo: string): string {
  return `repos/${owner}/${repo}/pulls`
}

/** Fixed endpoint template: `repos/{owner}/{repo}/pulls/{number}/merge`. */
export function pullMergeEndpoint(owner: string, repo: string, number: number): string {
  return `${pullsEndpoint(owner, repo)}/${number}/merge`
}

/** Fixed endpoint template: `repos/{owner}/{repo}/pulls/{number}/ready_for_review`. */
export function pullReadyEndpoint(owner: string, repo: string, number: number): string {
  return `${pullsEndpoint(owner, repo)}/${number}/ready_for_review`
}

/** Fixed endpoint template: `repos/{owner}/{repo}/pulls/{number}/reviews`. */
export function pullReviewsEndpoint(owner: string, repo: string, number: number): string {
  return `${pullsEndpoint(owner, repo)}/${number}/reviews`
}

/** Fixed endpoint template: `repos/{owner}/{repo}/branches/{branch}`. */
export function branchEndpoint(owner: string, repo: string, branch: string): string {
  return `repos/${owner}/${repo}/branches/${encodeRefSegment(branch, "branch")}`
}

/** Fixed endpoint template: `repos/{owner}/{repo}/compare/{base}...{head}`. */
export function compareEndpoint(owner: string, repo: string, base: string, head: string): string {
  return `repos/${owner}/${repo}/compare/${encodeRefSegment(base, "base")}...${encodeRefSegment(head, "head")}`
}

/** Encode one validated ref without allowing it to add URL path segments. */
function encodeRefSegment(value: string, label: string): string {
  return encodeURIComponent(assertRefSegment(value, label))
}
