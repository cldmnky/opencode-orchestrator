import { z } from "zod"
import { isSafeEvidenceRef, isSafeRelativeRepoPath } from "../../core/contracts.js"
import { stableProjectID, type LocationLike, type StorageLike } from "../goal/state.js"
import { redact } from "../process/redact.js"

/**
 * Durable Lead Board (slice: durable lead board).
 *
 * One bounded version-1 record per lead session + goal generation under
 * `lead-board/v1/<encoded-stable-project>/<encoded-lead-session>`, keyed by
 * the session's stable origin project exactly like goal/run/halt/step records
 * so a session move cannot orphan the ledger.
 *
 * Hard boundaries:
 * - This module makes NO Git, `gh`, provider, filesystem, or process calls. It
 *   only reads/writes durable storage through a storage-like interface.
 * - The board is a task ledger with lead-only lifecycle authority. A worker
 *   handoff is a report, never a completion: nothing here infers completion
 *   from a delivered prompt, an idle edge, the highest step receipt, or a
 *   worker's self-declared success.
 * - There is NO exactly-once, transaction, CAS, event log, projection,
 *   distributed lock/lease, or cross-process scheduler claim. `storage.set` is
 *   not transactional and `withSessionLock` is process-local: the caller owns
 *   locking and a failed write is a safety outcome that is never guessed
 *   around.
 * - Scope packets are ADVISORY: not filesystem isolation, not a permission
 *   boundary, not a worktree binding, and not proof of obedience. N2/session
 *   containment and managed-worktree ownership remain separate mechanisms.
 * - Overlap serialization is single-process only. Two active tasks are
 *   serialized when write/write or write/read scopes overlap, or when either
 *   packet is broad, unknown, malformed, or has an unresolvable root. Unknown
 *   is treated exactly like broad; read/read may proceed. A conflict leaves a
 *   `ready` task untouched (bounded `scope-conflict`), never failed.
 * - The `replay` descriptor plus `stepIndex` record identity before an
 *   external mutation; they can make a replay detectable, they cannot make an
 *   external side effect idempotent.
 * - Hydration parsing is strict and non-throwing: a missing record is
 *   `missing`, a malformed/mismatched record is `unavailable` (never
 *   auto-repaired, never dispatched from). Recovery is conservative:
 *   pending/dispatched/missing/malformed/unreadable receipts reconcile to
 *   `ambiguous` (claim retained); a step `completed` observation advances at
 *   most to `awaiting-validation`; a kept `completed` task requires its own
 *   persisted validation + review refs.
 * - Every stored string that can carry caller input is redacted with the
 *   canonical credential redactor, whitespace-collapsed, and length-bounded
 *   before schema parsing. No raw prompts, transcripts, tool IO, provider
 *   errors, credentials, or unbounded output are stored.
 */

export const LEAD_BOARD_RECORD_VERSION = 1

/** Hard bounds (exported; tests assert them). */
export const LEAD_BOARD_MAX_TASKS = 256
export const LEAD_BOARD_ID_MAX_LENGTH = 128
export const LEAD_BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
export const LEAD_TITLE_MAX_LENGTH = 1000
export const LEAD_OBJECTIVE_MAX_LENGTH = 1000
export const LEAD_TASK_MAX_DEPENDENCIES = 128
export const LEAD_TASK_MAX_READ_PATHS = 128
export const LEAD_TASK_MAX_WRITE_PATHS = 128
export const LEAD_TASK_MAX_EVIDENCE = 32
export const LEAD_BOARD_MAX_COMPLETION_EVIDENCE = 64
export const LEAD_REF_MAX_LENGTH = 512
export const LEAD_CURSOR_MAX_LENGTH = 512
export const LEAD_KEY_MAX_LENGTH = 512
export const LEAD_OWNER_SESSION_MAX_LENGTH = 512
export const LEAD_MAX_CHECK_IDS = 32
export const LEAD_CHECK_ID_MAX_LENGTH = 128

/** Full lowercase git object id (SHA-1 or SHA-256), shared by replay descriptors. */
export const LEAD_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export const LEAD_BOARD_STATUSES = ["active", "paused", "blocked", "complete"] as const
export type LeadBoardStatus = (typeof LEAD_BOARD_STATUSES)[number]

export const LEAD_TASK_STATUSES = [
  "planned",
  "ready",
  "reserved",
  "in-progress",
  "awaiting-validation",
  "awaiting-review",
  "changes-requested",
  "ambiguous",
  "failed",
  "blocked",
  "completed",
] as const
export type LeadTaskStatus = (typeof LEAD_TASK_STATUSES)[number]

export const LEAD_ROLES = ["lead", "planner", "explore", "implementer", "reviewer"] as const
export type LeadRole = (typeof LEAD_ROLES)[number]

export const LEAD_EVIDENCE_KINDS = ["file", "url", "command", "receipt", "review"] as const
export type LeadEvidenceKind = (typeof LEAD_EVIDENCE_KINDS)[number]

export const LEAD_REPLAY_KINDS = ["none", "github-pr-create", "github-pr-merge"] as const
export type LeadReplayKind = (typeof LEAD_REPLAY_KINDS)[number]

export type LeadOwner = { sessionID: string; role: LeadRole }

export type ScopePacket = {
  version: 1
  root: "project" | "managed-worktree"
  readPaths: string[]
  writePaths: string[]
  broad: boolean
}

export type EvidenceRef = {
  kind: LeadEvidenceKind
  reference: string
  description: string
  observedAt: number
}

export type ReplayDescriptor =
  | { kind: "none" }
  | {
      kind: "github-pr-create"
      repository: string
      headRef: string
      baseRef: string
      expectedHeadSHA: string
      expectedBaseSHA: string
      prNumber?: number
      prURL?: string
    }
  | {
      kind: "github-pr-merge"
      repository: string
      prNumber: number
      expectedHeadSHA: string
      expectedBaseSHA: string
      mergeSHA?: string
    }

export type LeadTaskValidation = {
  leadSessionID: string
  validatedAt: number
  revision: string
  checkIDs: string[]
  /** Plugin-observed verification receipts used for required commands. */
  receiptIDs?: string[]
}

export type LeadTaskReview = {
  reference: string
  revision: string
  approvedAt: number
}

export type LeadTask = {
  version: 1
  taskID: string
  title: string
  owner: LeadOwner
  scope: ScopePacket
  dependencies: string[]
  status: LeadTaskStatus
  attempt: number
  cursor?: string
  evidence: EvidenceRef[]
  lifecycleVersion: number
  idempotencyKey: string
  stepIndex?: number
  replay: ReplayDescriptor
  validation?: LeadTaskValidation
  review?: LeadTaskReview
  createdAt: number
  updatedAt: number
}

export type LeadBoardCompletion = {
  leadSessionID: string
  validatedAt: number
  revision: string
  reviewReference: string
  evidence: EvidenceRef[]
}

export type LeadBoard = {
  version: 1
  boardID: string
  leadSessionID: string
  projectID: string
  goalGeneration: number
  objective: string
  status: LeadBoardStatus
  boardRevision: number
  tasks: LeadTask[]
  completion?: LeadBoardCompletion
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* Bounded, redacted text                                              */
/* ------------------------------------------------------------------ */

/**
 * Canonical bounded text: redact known secrets (plus caller-known exact
 * secrets), collapse whitespace, trim, and truncate with a trailing ellipsis.
 * Every caller-controlled string stored on a board record passes through here
 * before schema validation.
 */
export function boundedBoardText(
  value: string,
  maxLength: number = LEAD_REF_MAX_LENGTH,
  secrets: readonly string[] = [],
): string {
  const collapsed = redact(value ?? "", secrets).replace(/\s+/g, " ").trim()
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`
}

/** Bounded, redacted opaque cursor (never interpreted here). */
export function boundedBoardCursor(value: string, secrets: readonly string[] = []): string {
  return boundedBoardText(value, LEAD_CURSOR_MAX_LENGTH, secrets)
}

function boundedRef(value: string, maxLength = LEAD_REF_MAX_LENGTH): string {
  return boundedBoardText(value, maxLength)
}

/**
 * Validate one evidence ref after redaction/bounding. `url` must be https,
 * `file` must be a repo-relative path, and every other kind is a bounded
 * identity string (command identity + result, receipt/review identity) —
 * never raw output or transcripts. Returns undefined when the ref cannot be
 * represented safely.
 */
export function normalizeEvidenceRef(input: {
  kind: LeadEvidenceKind
  reference: string
  description: string
  observedAt: number
  secrets?: readonly string[]
}): EvidenceRef | undefined {
  if (!Number.isFinite(input.observedAt) || input.observedAt < 0) return undefined
  const reference = boundedRef(input.reference ?? "", LEAD_REF_MAX_LENGTH)
  if (reference.length === 0) return undefined
  const description = boundedBoardText(input.description ?? "", LEAD_REF_MAX_LENGTH, input.secrets ?? [])
  if (description.length === 0) return undefined
  if (input.kind === "url" && !reference.startsWith("https://")) return undefined
  if (input.kind === "file" && !isSafeRelativeRepoPath(reference)) return undefined
  if ((input.kind === "file" || input.kind === "url") && !isSafeEvidenceRef(reference)) return undefined
  return { kind: input.kind, reference, description, observedAt: input.observedAt }
}

/** Bounded copy of an evidence list, keeping the most recent entries. */
export function boundedEvidenceList(refs: readonly EvidenceRef[], max = LEAD_TASK_MAX_EVIDENCE): EvidenceRef[] {
  if (refs.length <= max) return [...refs]
  return refs.slice(refs.length - max)
}

/* ------------------------------------------------------------------ */
/* Schemas (strict, no unknown keys, no metadata escape hatch)         */
/* ------------------------------------------------------------------ */

const boundedText = (max: number) => z.string().max(max)

const boardIdSchema = z.string().min(1).max(LEAD_BOARD_ID_MAX_LENGTH).regex(LEAD_BOARD_ID_PATTERN)

const relativePathSchema = z
  .string()
  .min(1)
  .max(LEAD_REF_MAX_LENGTH)
  .refine((value) => isSafeRelativeRepoPath(value), { message: "must be a canonical relative path" })

const scopePacketSchema = z
  .object({
    version: z.literal(1),
    root: z.enum(["project", "managed-worktree"]),
    readPaths: z.array(relativePathSchema).max(LEAD_TASK_MAX_READ_PATHS),
    writePaths: z.array(relativePathSchema).max(LEAD_TASK_MAX_WRITE_PATHS),
    broad: z.boolean(),
  })
  .strict()
  .refine((value) => new Set(value.readPaths).size === value.readPaths.length, {
    message: "duplicate read path",
    path: ["readPaths"],
  })
  .refine((value) => new Set(value.writePaths).size === value.writePaths.length, {
    message: "duplicate write path",
    path: ["writePaths"],
  })

const ownerSchema = z
  .object({
    sessionID: z.string().min(1).max(LEAD_OWNER_SESSION_MAX_LENGTH),
    role: z.enum(LEAD_ROLES),
  })
  .strict()

const evidenceRefSchema = z
  .object({
    kind: z.enum(LEAD_EVIDENCE_KINDS),
    reference: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
    description: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
    observedAt: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "url" && !value.reference.startsWith("https://")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reference"], message: "url evidence must be https" })
    }
    if (value.kind === "file" && !isSafeRelativeRepoPath(value.reference)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reference"], message: "file evidence must be a relative repo path" })
    }
  })

const repositorySchema = z
  .string()
  .min(3)
  .max(LEAD_REF_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/)

const shaSchema = z.string().regex(LEAD_SHA_PATTERN)

const replayDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("github-pr-create"),
      repository: repositorySchema,
      headRef: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
      baseRef: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
      expectedHeadSHA: shaSchema,
      expectedBaseSHA: shaSchema,
      prNumber: z.number().int().positive().safe().optional(),
      prURL: z.string().min(1).max(LEAD_REF_MAX_LENGTH).regex(/^https:\/\//).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("github-pr-merge"),
      repository: repositorySchema,
      prNumber: z.number().int().positive().safe(),
      expectedHeadSHA: shaSchema,
      expectedBaseSHA: shaSchema,
      mergeSHA: shaSchema.optional(),
    })
    .strict(),
])

const taskValidationSchema = z
  .object({
    leadSessionID: z.string().min(1).max(LEAD_OWNER_SESSION_MAX_LENGTH),
    validatedAt: z.number().finite().nonnegative(),
    revision: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
    checkIDs: z.array(z.string().min(1).max(LEAD_CHECK_ID_MAX_LENGTH)).max(LEAD_MAX_CHECK_IDS),
    receiptIDs: z.array(z.string().min(1).max(128)).max(64).optional(),
  })
  .strict()

const taskReviewSchema = z
  .object({
    reference: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
    revision: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
    approvedAt: z.number().finite().nonnegative(),
  })
  .strict()

const leadTaskSchema = z
  .object({
    version: z.literal(1),
    taskID: boardIdSchema,
    title: z.string().min(1).max(LEAD_TITLE_MAX_LENGTH),
    owner: ownerSchema,
    scope: scopePacketSchema,
    dependencies: z.array(boardIdSchema).max(LEAD_TASK_MAX_DEPENDENCIES),
    status: z.enum(LEAD_TASK_STATUSES),
    attempt: z.number().int().positive().safe(),
    cursor: z.string().min(1).max(LEAD_CURSOR_MAX_LENGTH).optional(),
    evidence: z.array(evidenceRefSchema).max(LEAD_TASK_MAX_EVIDENCE),
    lifecycleVersion: z.number().int().positive().safe(),
    idempotencyKey: z.string().min(1).max(LEAD_KEY_MAX_LENGTH),
    stepIndex: z.number().int().nonnegative().safe().optional(),
    replay: replayDescriptorSchema,
    validation: taskValidationSchema.optional(),
    review: taskReviewSchema.optional(),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict()

const boardCompletionSchema = z
  .object({
    leadSessionID: z.string().min(1).max(LEAD_OWNER_SESSION_MAX_LENGTH),
    validatedAt: z.number().finite().nonnegative(),
    revision: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
    reviewReference: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
    evidence: z.array(evidenceRefSchema).max(LEAD_BOARD_MAX_COMPLETION_EVIDENCE),
  })
  .strict()

export const leadBoardSchema = z
  .object({
    version: z.literal(LEAD_BOARD_RECORD_VERSION),
    boardID: boardIdSchema,
    leadSessionID: z.string().min(1).max(LEAD_OWNER_SESSION_MAX_LENGTH),
    projectID: z.string().min(1),
    goalGeneration: z.number().finite().nonnegative(),
    objective: z.string().min(1).max(LEAD_OBJECTIVE_MAX_LENGTH),
    status: z.enum(LEAD_BOARD_STATUSES),
    boardRevision: z.number().int().positive().safe(),
    tasks: z.array(leadTaskSchema).max(LEAD_BOARD_MAX_TASKS),
    completion: boardCompletionSchema.optional(),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict()

/** Strict parse of one stored board value; malformed/unknown data reads as undefined. */
export function parseLeadBoard(value: unknown): LeadBoard | undefined {
  const parsed = leadBoardSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/* ------------------------------------------------------------------ */
/* Identity and keys                                                   */
/* ------------------------------------------------------------------ */

/**
 * Deterministic, collision-resistant board id derived from the stable origin
 * project, lead session, and immutable goal generation (`goal.createdAt`).
 * FNV-1a (64-bit, BigInt) keeps this pure and dependency-free; a new goal
 * generation cannot alias an older board identity.
 */
export function leadBoardID(projectID: string, sessionID: string, goalGeneration: number): string {
  return `board-${fnv1a64(`${projectID}\u0000${sessionID}\u0000${goalGeneration}`)}`
}

/** Deterministic idempotency key for one task within one board generation. */
export function leadTaskIdempotencyKey(boardID: string, taskID: string): string {
  return boundedBoardText(`${boardID}/${taskID}`, LEAD_KEY_MAX_LENGTH)
}

/** Deterministic idempotency key for one dispatch attempt of one task. */
export function leadTaskStepIdempotencyKey(boardID: string, taskID: string, attempt: number): string {
  return boundedBoardText(`lead/${boardID}/${taskID}/${attempt}`, LEAD_KEY_MAX_LENGTH)
}

/** Storage prefix under which every board record of one project lives. */
export function leadBoardProjectPrefix(projectID: string): string {
  return `lead-board/v1/${segment(projectID)}/`
}

/** Key for one board record: `lead-board/v1/<project>/<lead-session>`. */
export function leadBoardStorageKey(location: LocationLike, sessionID: string): string {
  return `lead-board/v1/${segment(location.project.id)}/${segment(sessionID)}`
}

/**
 * Resolves the storage location keyed by the session's stable origin project,
 * exactly like goal/run/halt/step records, so a moved session still finds its
 * board.
 */
export async function leadBoardKeyedLocation(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
): Promise<LocationLike> {
  return { ...location, project: { id: await stableProjectID(storage, location, sessionID) } }
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, "0")
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

/* ------------------------------------------------------------------ */
/* DAG validation                                                      */
/* ------------------------------------------------------------------ */

/**
 * Structural graph issues for a task list: duplicate ids, unknown
 * dependencies, self-dependencies, and cycles. Deterministic order. The board
 * schema already enforces per-field shape; this adds the relational rules.
 */
export function validateTaskGraph(tasks: readonly LeadTask[]): string[] {
  const issues: string[] = []
  const ids = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.taskID)) issues.push(`duplicate-task-id:${task.taskID}`)
    ids.add(task.taskID)
  }
  for (const task of tasks) {
    const seen = new Set<string>()
    for (const dependency of task.dependencies) {
      if (seen.has(dependency)) issues.push(`duplicate-dependency:${task.taskID}->${dependency}`)
      seen.add(dependency)
      if (dependency === task.taskID) {
        issues.push(`self-dependency:${task.taskID}`)
        continue
      }
      if (!ids.has(dependency)) issues.push(`missing-dependency:${task.taskID}->${dependency}`)
    }
  }
  for (const cycle of detectCycles(tasks)) issues.push(`cycle:${cycle.join("->")}`)
  return [...new Set(issues)].sort()
}

/** Deterministic cycle paths (sorted for stable output). */
function detectCycles(tasks: readonly LeadTask[]): string[][] {
  const byID = new Map(tasks.map((task) => [task.taskID, task]))
  const state = new Map<string, "visiting" | "done">()
  const stack: string[] = []
  const cycles: string[][] = []
  const visit = (taskID: string): void => {
    const current = state.get(taskID)
    if (current === "done") return
    if (current === "visiting") {
      const start = stack.indexOf(taskID)
      if (start >= 0) cycles.push([...stack.slice(start), taskID])
      return
    }
    state.set(taskID, "visiting")
    stack.push(taskID)
    const task = byID.get(taskID)
    for (const dependency of [...(task?.dependencies ?? [])].sort()) {
      if (byID.has(dependency)) visit(dependency)
    }
    stack.pop()
    state.set(taskID, "done")
  }
  for (const taskID of [...byID.keys()].sort()) visit(taskID)
  return cycles.sort((a, b) => a.join("/").localeCompare(b.join("/")))
}

/** Structural issues for a full board record (identity, graph, counters). */
export function verifyLeadBoard(
  board: LeadBoard,
  expected: { projectID?: string; leadSessionID?: string; boardID?: string; goalGeneration?: number },
): string[] {
  const issues: string[] = []
  if (expected.projectID !== undefined && board.projectID !== expected.projectID) issues.push("project-mismatch")
  if (expected.leadSessionID !== undefined && board.leadSessionID !== expected.leadSessionID) issues.push("session-mismatch")
  if (expected.boardID !== undefined && board.boardID !== expected.boardID) issues.push("board-id-mismatch")
  if (expected.goalGeneration !== undefined && board.goalGeneration !== expected.goalGeneration) {
    issues.push("goal-generation-mismatch")
  }
  issues.push(...validateTaskGraph(board.tasks))
  if (board.tasks.length > LEAD_BOARD_MAX_TASKS) issues.push("too-many-tasks")
  return issues
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

export type NewLeadBoardInput = {
  projectID: string
  leadSessionID: string
  goalGeneration: number
  objective: string
  now?: number
  secrets?: readonly string[]
}

/**
 * Deterministic root board for one goal generation: exactly one `planned` root
 * task owned by the lead. The root scope is empty (a coordination task, never
 * broad) so child tasks are not artificially serialized against it. Tasks are
 * never parsed from prose; children are added only through the strict
 * validator.
 */
export function createLeadBoard(input: NewLeadBoardInput): LeadBoard {
  const now = input.now ?? Date.now()
  const objective = boundedBoardText(input.objective, LEAD_OBJECTIVE_MAX_LENGTH, input.secrets ?? [])
  const boardID = leadBoardID(input.projectID, input.leadSessionID, input.goalGeneration)
  const taskID = "root"
  const task: LeadTask = {
    version: 1,
    taskID,
    title: boundedBoardText(objective, LEAD_TITLE_MAX_LENGTH, input.secrets ?? []),
    owner: { sessionID: input.leadSessionID, role: "lead" },
    scope: { version: 1, root: "project", readPaths: [], writePaths: [], broad: false },
    dependencies: [],
    status: "planned",
    attempt: 1,
    evidence: [],
    lifecycleVersion: 1,
    idempotencyKey: leadTaskIdempotencyKey(boardID, taskID),
    replay: { kind: "none" },
    createdAt: now,
    updatedAt: now,
  }
  return {
    version: LEAD_BOARD_RECORD_VERSION,
    boardID,
    leadSessionID: input.leadSessionID,
    projectID: input.projectID,
    goalGeneration: input.goalGeneration,
    objective: objective || "goal",
    status: "active",
    boardRevision: 1,
    tasks: [task],
    createdAt: now,
    updatedAt: now,
  }
}

export type ScopeNormalization =
  | { ok: true; packet: ScopePacket }
  | { ok: false; reason: string }

/**
 * Canonical scope normalization: `/`-separated relative paths only; rejects
 * absolute paths, `.`/`..` segments, empty segments, NUL/control characters,
 * and duplicates. A `.` path or `broad: true` marks the packet broad
 * (conflicts with every active write). Unknown/unresolvable roots are treated
 * as broad by `scopesConflict`.
 */
export function normalizeScopePacket(input: {
  root?: "project" | "managed-worktree"
  readPaths?: readonly string[]
  writePaths?: readonly string[]
  broad?: boolean
}): ScopeNormalization {
  const root = input.root ?? "project"
  if (root !== "project" && root !== "managed-worktree") return { ok: false, reason: "invalid-root" }
  const normalizedRead: string[] = []
  const normalizedWrite: string[] = []
  let broad = input.broad === true
  for (const [paths, target] of [
    [input.readPaths ?? [], normalizedRead],
    [input.writePaths ?? [], normalizedWrite],
  ] as const) {
    for (const raw of paths) {
      const path = canonicalScopePath(raw)
      if (path === undefined) return { ok: false, reason: `invalid-path:${boundedBoardText(raw, 64)}` }
      if (path === ".") {
        broad = true
        continue
      }
      if (target.includes(path)) return { ok: false, reason: `duplicate-path:${path}` }
      target.push(path)
    }
  }
  if (normalizedRead.length > LEAD_TASK_MAX_READ_PATHS) return { ok: false, reason: "too-many-read-paths" }
  if (normalizedWrite.length > LEAD_TASK_MAX_WRITE_PATHS) return { ok: false, reason: "too-many-write-paths" }
  return {
    ok: true,
    packet: { version: 1, root, readPaths: normalizedRead, writePaths: normalizedWrite, broad },
  }
}

function canonicalScopePath(raw: string): string | undefined {
  const trimmed = raw.trim().replaceAll("\\", "/")
  if (trimmed.length === 0 || trimmed.length > LEAD_REF_MAX_LENGTH) return undefined
  if (trimmed.includes("\0")) return undefined
  if (trimmed.startsWith("/")) return undefined
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined
  const collapsed = trimmed.replace(/\/+$/, "")
  if (collapsed.length === 0) return undefined
  const segments = collapsed.split("/")
  for (const part of segments) {
    if (part.length === 0) return undefined
    if (part === "..") return undefined
    if (part === "." && collapsed !== ".") return undefined
  }
  return segments.join("/")
}

/** Segment-boundary overlap: equal or ancestor (`a` ~ `a/b`, but `a` ≁ `ab`). */
export function scopePathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function pathSetsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const left of a) {
    for (const right of b) {
      if (scopePathsOverlap(left, right)) return true
    }
  }
  return false
}

/**
 * Conservative conflict rule: broad/unknown/malformed on either side
 * conflicts with every active write; write/write and write/read overlaps
 * conflict; read/read may proceed.
 */
export function scopesConflict(a: ScopePacket, b: ScopePacket): boolean {
  if (a.broad || b.broad) return true
  if (pathSetsOverlap(a.writePaths, b.writePaths)) return true
  if (pathSetsOverlap(a.writePaths, b.readPaths)) return true
  if (pathSetsOverlap(b.writePaths, a.readPaths)) return true
  return false
}

/** Statuses that hold a scope claim (never released on idle or pending review). */
export const LEAD_CLAIM_STATUSES: readonly LeadTaskStatus[] = [
  "reserved",
  "in-progress",
  "awaiting-validation",
  "awaiting-review",
  "changes-requested",
  "ambiguous",
  "blocked",
]

export function taskHoldsClaim(task: LeadTask): boolean {
  return LEAD_CLAIM_STATUSES.includes(task.status)
}

/** True when every dependency of the task is `completed`. */
export function dependenciesCompleted(board: LeadBoard, task: LeadTask): boolean {
  const byID = new Map(board.tasks.map((candidate) => [candidate.taskID, candidate]))
  return task.dependencies.every((dependency) => byID.get(dependency)?.status === "completed")
}

/** First active task whose scope conflicts with the candidate, if any. */
export function findScopeConflict(board: LeadBoard, task: LeadTask): LeadTask | undefined {
  return board.tasks.find(
    (candidate) =>
      candidate.taskID !== task.taskID &&
      taskHoldsClaim(candidate) &&
      scopesConflict(candidate.scope, task.scope),
  )
}

export type NewLeadTaskInput = {
  taskID: string
  title: string
  owner: LeadOwner
  scope: ScopeNormalization
  dependencies?: readonly string[]
  now?: number
  secrets?: readonly string[]
}

/**
 * Strict child-task builder: validates id/scope/bounds/dependencies (including
 * the graph against the existing board) before any write. Returns issues
 * instead of a task on rejection.
 */
export function createLeadTask(
  board: LeadBoard,
  input: NewLeadTaskInput,
): { ok: true; task: LeadTask } | { ok: false; issues: string[] } {
  const issues: string[] = []
  if (!LEAD_BOARD_ID_PATTERN.test(input.taskID) || input.taskID.length > LEAD_BOARD_ID_MAX_LENGTH) {
    issues.push("invalid-task-id")
  }
  if (board.tasks.some((task) => task.taskID === input.taskID)) issues.push("duplicate-task-id")
  if (board.tasks.length >= LEAD_BOARD_MAX_TASKS) issues.push("too-many-tasks")
  const title = boundedBoardText(input.title, LEAD_TITLE_MAX_LENGTH, input.secrets ?? [])
  if (title.length === 0) issues.push("empty-title")
  const scope = input.scope
  if (!scope.ok) issues.push(`scope:${scope.reason}`)
  const dependencies = [...new Set(input.dependencies ?? [])]
  if (dependencies.length > LEAD_TASK_MAX_DEPENDENCIES) issues.push("too-many-dependencies")
  for (const dependency of dependencies) {
    if (dependency === input.taskID) issues.push("self-dependency")
    else if (!board.tasks.some((task) => task.taskID === dependency)) issues.push(`missing-dependency:${dependency}`)
  }
  if (issues.length > 0 || !scope.ok) return { ok: false, issues }
  const now = input.now ?? Date.now()
  const task: LeadTask = {
    version: 1,
    taskID: input.taskID,
    title,
    owner: input.owner,
    scope: scope.packet,
    dependencies,
    status: "planned",
    attempt: 1,
    evidence: [],
    lifecycleVersion: 1,
    idempotencyKey: leadTaskIdempotencyKey(board.boardID, input.taskID),
    replay: { kind: "none" },
    createdAt: now,
    updatedAt: now,
  }
  return { ok: true, task }
}

/* ------------------------------------------------------------------ */
/* Lifecycle transitions (pure)                                        */
/* ------------------------------------------------------------------ */

/**
 * Allowed status edges, exactly the lifecycle table. Terminal `completed` is
 * immutable; every applied transition bumps the task lifecycle version and the
 * board revision once.
 */
export const LEAD_TASK_TRANSITIONS: Readonly<Record<LeadTaskStatus, readonly LeadTaskStatus[]>> = {
  planned: ["ready"],
  ready: ["reserved"],
  reserved: ["in-progress", "ambiguous"],
  "in-progress": ["awaiting-validation", "failed", "ambiguous"],
  "awaiting-validation": ["awaiting-review", "changes-requested", "failed", "blocked"],
  "awaiting-review": ["completed", "changes-requested", "blocked"],
  "changes-requested": ["ready"],
  ambiguous: ["awaiting-validation", "ready", "failed", "blocked"],
  failed: ["ready"],
  blocked: ["ready", "ambiguous"],
  completed: [],
}

export type LeadTransitionAction =
  | "ready"
  | "reserve"
  | "deliver"
  | "report"
  | "fail"
  | "ambiguous"
  | "validate"
  | "complete"
  | "request-changes"
  | "block"
  | "requeue"
  | "adopt"
  | "reconcile"
  | "record-replay"

const ACTION_TARGET: Record<LeadTransitionAction, LeadTaskStatus> = {
  ready: "ready",
  reserve: "reserved",
  deliver: "in-progress",
  report: "awaiting-validation",
  fail: "failed",
  ambiguous: "ambiguous",
  validate: "awaiting-review",
  complete: "completed",
  "request-changes": "changes-requested",
  block: "blocked",
  requeue: "ready",
  adopt: "awaiting-validation",
  reconcile: "ready",
  "record-replay": "in-progress",
}

const ACTION_FROM: Record<LeadTransitionAction, readonly LeadTaskStatus[]> = {
  ready: ["planned"],
  reserve: ["ready"],
  deliver: ["reserved"],
  report: ["in-progress"],
  fail: ["in-progress", "ambiguous", "awaiting-validation"],
  ambiguous: ["reserved", "in-progress", "blocked"],
  validate: ["awaiting-validation"],
  complete: ["awaiting-review"],
  "request-changes": ["awaiting-validation", "awaiting-review"],
  block: ["awaiting-validation", "awaiting-review", "ambiguous"],
  requeue: ["changes-requested", "failed", "blocked"],
  adopt: ["ambiguous"],
  reconcile: ["ambiguous"],
  "record-replay": ["reserved", "in-progress"],
}

export type LeadTransitionReason =
  | "applied"
  | "board-not-active"
  | "board-complete"
  | "actor-mismatch"
  | "task-missing"
  | "version-mismatch"
  | "invalid-transition"
  | "dependencies-unmet"
  | "scope-conflict"
  | "missing-evidence"
  | "missing-validation"
  | "missing-review"
  | "review-mismatch"
  | "invalid-input"

export type LeadTransitionInput = {
  board: LeadBoard
  taskID: string
  expectedVersion: number
  actorSessionID: string
  action: LeadTransitionAction
  now?: number
  evidence?: readonly EvidenceRef[]
  note?: string
  cursor?: string
  validation?: LeadTaskValidation
  review?: LeadTaskReview
  replay?: ReplayDescriptor
  stepIndex?: number
  secrets?: readonly string[]
}

export type LeadTransitionResult =
  | { ok: true; board: LeadBoard; task: LeadTask; reason: "applied"; message: string }
  | { ok: false; reason: LeadTransitionReason; message: string }

/**
 * Pure single-task transition. Callers re-read the record and apply the result
 * under the process-local session lock; a version mismatch is a stale-writer
 * refusal (reload + refuse), never a CAS and never a retry loop. Completion is
 * sticky: `completed` never transitions again, and nothing here infers
 * completion from delivery/idle/receipt/worker claims.
 */
export function transitionLeadTask(input: LeadTransitionInput): LeadTransitionResult {
  const now = input.now ?? Date.now()
  if (input.actorSessionID !== input.board.leadSessionID) {
    return refuse("actor-mismatch", "only the board's lead session may transition a board task")
  }
  if (input.board.status === "complete") {
    return refuse("board-complete", "the board is complete and immutable")
  }
  if (input.board.status !== "active" && input.action !== "record-replay") {
    return refuse("board-not-active", `the board is ${input.board.status}; goal control governs pause/halt`)
  }
  const task = input.board.tasks.find((candidate) => candidate.taskID === input.taskID)
  if (!task) return refuse("task-missing", `no task ${input.taskID} exists on this board`)
  if (task.lifecycleVersion !== input.expectedVersion) {
    return refuse(
      "version-mismatch",
      `task ${task.taskID} is at lifecycle version ${task.lifecycleVersion}, not the expected ${input.expectedVersion}; re-read and retry`,
    )
  }
  const allowedFrom = ACTION_FROM[input.action]
  if (!allowedFrom.includes(task.status)) {
    return refuse(
      "invalid-transition",
      `task ${task.taskID} cannot apply ${input.action} from ${task.status}`,
    )
  }

  const next: LeadTask = { ...task, updatedAt: now }
  let evidence = [...task.evidence]

  if (input.action === "ready" || input.action === "reserve" || input.action === "requeue") {
    if (!dependenciesCompleted(input.board, task)) {
      return refuse("dependencies-unmet", `task ${task.taskID} has incomplete dependencies`)
    }
  }
  if (input.action === "reserve") {
    if (input.stepIndex === undefined || !Number.isSafeInteger(input.stepIndex) || input.stepIndex < 0) {
      return refuse("invalid-input", "a reservation requires the continuation step index")
    }
    const conflict = findScopeConflict(input.board, task)
    if (conflict) {
      return refuse(
        "scope-conflict",
        `task ${task.taskID} conflicts with active claim ${conflict.taskID}; it stays ready`,
      )
    }
    next.stepIndex = input.stepIndex
  }
  if (input.action === "report" || input.action === "adopt") {
    if (!input.evidence || input.evidence.length === 0) {
      return refuse("missing-evidence", `${input.action} requires at least one bounded evidence reference`)
    }
    evidence = boundedEvidenceList([...evidence, ...normalizeEvidence(input.evidence, now, input.secrets)])
  }
  if (input.action === "fail" || input.action === "ambiguous") {
    const note = input.note !== undefined ? boundedBoardText(input.note, LEAD_REF_MAX_LENGTH, input.secrets ?? []) : ""
    const supplied = input.evidence ?? []
    if (note.length === 0 && supplied.length === 0) {
      return refuse("missing-evidence", `${input.action} requires a bounded reason or evidence`)
    }
    if (note.length > 0) {
      evidence = boundedEvidenceList([
        ...evidence,
        {
          kind: "receipt",
          reference: boundedBoardText(`${input.taskID}/${task.lifecycleVersion}`, LEAD_REF_MAX_LENGTH),
          description: note,
          observedAt: now,
        },
      ])
    }
    if (supplied.length > 0) evidence = boundedEvidenceList([...evidence, ...normalizeEvidence(supplied, now, input.secrets)])
  }
  if (input.action === "validate") {
    if (!input.validation || input.validation.checkIDs.length === 0) {
      return refuse("missing-validation", "validate requires the lead's bounded check results")
    }
    next.validation = {
      leadSessionID: input.actorSessionID,
      validatedAt: now,
      revision: boundedBoardText(input.validation.revision, LEAD_REF_MAX_LENGTH, input.secrets ?? []),
      checkIDs: input.validation.checkIDs
        .slice(0, LEAD_MAX_CHECK_IDS)
        .map((check) => boundedBoardText(check, LEAD_CHECK_ID_MAX_LENGTH, input.secrets ?? [])),
      ...(input.validation.receiptIDs !== undefined
        ? {
            receiptIDs: input.validation.receiptIDs
              .slice(0, 64)
              .map((receiptID) => boundedBoardText(receiptID, 128, input.secrets ?? [])),
          }
        : {}),
    }
    if (input.cursor !== undefined) next.cursor = boundedBoardCursor(input.cursor, input.secrets ?? [])
    if (input.evidence && input.evidence.length > 0) {
      evidence = boundedEvidenceList([...evidence, ...normalizeEvidence(input.evidence, now, input.secrets)])
    }
  }
  if (input.action === "complete") {
    if (!next.validation) {
      return refuse("missing-validation", "completion requires a persisted lead validation on this lifecycle")
    }
    if (!input.review) {
      return refuse("missing-review", "completion requires an approved exact-revision review reference")
    }
    const review: LeadTaskReview = {
      reference: boundedBoardText(input.review.reference, LEAD_REF_MAX_LENGTH, input.secrets ?? []),
      revision: boundedBoardText(input.review.revision, LEAD_REF_MAX_LENGTH, input.secrets ?? []),
      approvedAt: input.review.approvedAt,
    }
    if (review.revision !== next.validation.revision) {
      return refuse("review-mismatch", "the approved review revision does not match the validated revision")
    }
    next.review = review
  }
  if (input.action === "record-replay") {
    if (!input.replay) return refuse("invalid-input", "record-replay requires a replay descriptor")
    next.replay = input.replay
  }
  if (input.action === "requeue") {
    next.attempt = task.attempt + 1
  }
  if (input.action === "reconcile") {
    // Compensating recovery is explicit: the attempt is never bumped to clear
    // ambiguity (attempt+1 is not evidence).
    next.attempt = task.attempt
  }

  next.evidence = evidence
  next.status = ACTION_TARGET[input.action]
  next.lifecycleVersion = task.lifecycleVersion + 1
  const board: LeadBoard = {
    ...input.board,
    tasks: input.board.tasks.map((candidate) => (candidate.taskID === task.taskID ? next : candidate)),
    boardRevision: input.board.boardRevision + 1,
    updatedAt: now,
  }
  return { ok: true, board, task: next, reason: "applied", message: `task ${task.taskID}: ${task.status} -> ${next.status}` }
}

function normalizeEvidence(refs: readonly EvidenceRef[], now: number, secrets: readonly string[] | undefined): EvidenceRef[] {
  const normalized: EvidenceRef[] = []
  for (const ref of refs) {
    const safe = normalizeEvidenceRef({ ...ref, observedAt: Number.isFinite(ref.observedAt) ? ref.observedAt : now, secrets })
    if (safe) normalized.push(safe)
  }
  return normalized
}

function refuse(reason: LeadTransitionReason, message: string): LeadTransitionResult {
  return { ok: false, reason, message }
}

/* ------------------------------------------------------------------ */
/* Reservation + release                                               */
/* ------------------------------------------------------------------ */

export type LeadReservation = {
  taskID: string
  stepIndex: number
  stepIdempotencyKey: string
  attempt: number
  lifecycleVersion: number
  boardRevision: number
}

export type LeadReserveResult = {
  board: LeadBoard
  reservation?: LeadReservation
  reason?: "no-ready-task" | "scope-conflict" | "dependencies-pending"
}

/**
 * Deterministic reservation pass: promotes `planned` tasks whose dependencies
 * are complete to `ready`, then reserves the first `ready` task with a
 * conflict-free scope. A scope conflict leaves the task `ready` and the pass
 * continues with the next candidate; all-conflict is waiting, not failed.
 * Callers persist the returned board and the pending step receipt under the
 * same process-local session lock before queueing a prompt.
 */
export function reserveNextLeadTask(
  board: LeadBoard,
  input: { stepIndex: number; now?: number },
): LeadReserveResult {
  if (board.status !== "active") return { board, reason: "no-ready-task" }
  const now = input.now ?? Date.now()
  let working = board
  let sawConflict = false
  for (const taskID of board.tasks.map((task) => task.taskID)) {
    const current = working.tasks.find((task) => task.taskID === taskID)
    if (!current) continue
    if (current.status === "planned") {
      if (!dependenciesCompleted(working, current)) continue
      const promoted = transitionLeadTask({
        board: working,
        taskID,
        expectedVersion: current.lifecycleVersion,
        actorSessionID: working.leadSessionID,
        action: "ready",
        now,
      })
      if (!promoted.ok) continue
      working = promoted.board
    }
    const candidate = working.tasks.find((task) => task.taskID === taskID)
    if (!candidate || candidate.status !== "ready") continue
    if (!dependenciesCompleted(working, candidate)) continue
    const reserved = transitionLeadTask({
      board: working,
      taskID,
      expectedVersion: candidate.lifecycleVersion,
      actorSessionID: working.leadSessionID,
      action: "reserve",
      stepIndex: input.stepIndex,
      now,
    })
    if (reserved.ok) {
      return {
        board: reserved.board,
        reservation: {
          taskID: reserved.task.taskID,
          stepIndex: input.stepIndex,
          stepIdempotencyKey: leadTaskStepIdempotencyKey(working.boardID, reserved.task.taskID, reserved.task.attempt),
          attempt: reserved.task.attempt,
          lifecycleVersion: reserved.task.lifecycleVersion,
          boardRevision: reserved.board.boardRevision,
        },
      }
    }
    if (reserved.reason === "scope-conflict") sawConflict = true
  }
  return { board: working, reason: sawConflict ? "scope-conflict" : "no-ready-task" }
}

export type LeadReleaseResult =
  | { ok: true; board: LeadBoard }
  | { ok: false; reason: "version-mismatch" | "not-reserved" | "board-not-active" }

/**
 * Releases a reservation that was never delivered (stale pre-delivery read).
 * The task returns to `ready` with its attempt unchanged; both versions bump so
 * the stale reservation can never be mistaken for a live one.
 */
export function releaseLeadReservation(input: {
  board: LeadBoard
  taskID: string
  expectedLifecycleVersion: number
  expectedBoardRevision: number
  now?: number
  reason?: string
  secrets?: readonly string[]
}): LeadReleaseResult {
  const now = input.now ?? Date.now()
  if (input.board.status !== "active") return { ok: false, reason: "board-not-active" }
  const task = input.board.tasks.find((candidate) => candidate.taskID === input.taskID)
  if (!task || task.status !== "reserved") return { ok: false, reason: "not-reserved" }
  if (task.lifecycleVersion !== input.expectedLifecycleVersion || input.board.boardRevision !== input.expectedBoardRevision) {
    return { ok: false, reason: "version-mismatch" }
  }
  const note = boundedBoardText(input.reason ?? "delivery aborted before prompt", LEAD_REF_MAX_LENGTH, input.secrets ?? [])
  const next: LeadTask = {
    ...task,
    status: "ready",
    lifecycleVersion: task.lifecycleVersion + 1,
    updatedAt: now,
    evidence: boundedEvidenceList([
      ...task.evidence,
      {
        kind: "receipt",
        reference: boundedBoardText(`${task.taskID}/${task.stepIndex ?? 0}`, LEAD_REF_MAX_LENGTH),
        description: note,
        observedAt: now,
      },
    ]),
  }
  return {
    ok: true,
    board: {
      ...input.board,
      tasks: input.board.tasks.map((candidate) => (candidate.taskID === task.taskID ? next : candidate)),
      boardRevision: input.board.boardRevision + 1,
      updatedAt: now,
    },
  }
}

/** Strict parse of one replay descriptor value; unknown shapes read as undefined. */
export function parseReplayDescriptor(value: unknown): ReplayDescriptor | undefined {
  const parsed = replayDescriptorSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export type LeadAssignResult =
  | { ok: true; board: LeadBoard; task: LeadTask }
  | { ok: false; reason: LeadTransitionReason; message: string }

/**
 * Lead-only owner assignment (not a status edge). Bumps the task lifecycle
 * version and board revision once; a completed task is immutable.
 */
export function assignLeadTaskOwner(input: {
  board: LeadBoard
  taskID: string
  expectedVersion: number
  actorSessionID: string
  owner: LeadOwner
  now?: number
}): LeadAssignResult {
  const now = input.now ?? Date.now()
  if (input.actorSessionID !== input.board.leadSessionID) {
    return { ok: false, reason: "actor-mismatch", message: "only the board's lead session may assign a task owner" }
  }
  if (input.board.status === "complete") {
    return { ok: false, reason: "board-complete", message: "the board is complete and immutable" }
  }
  if (input.board.status !== "active") {
    return { ok: false, reason: "board-not-active", message: `the board is ${input.board.status}` }
  }
  const task = input.board.tasks.find((candidate) => candidate.taskID === input.taskID)
  if (!task) return { ok: false, reason: "task-missing", message: `no task ${input.taskID} exists on this board` }
  if (task.lifecycleVersion !== input.expectedVersion) {
    return {
      ok: false,
      reason: "version-mismatch",
      message: `task ${task.taskID} is at lifecycle version ${task.lifecycleVersion}, not the expected ${input.expectedVersion}`,
    }
  }
  if (task.status === "completed") {
    return { ok: false, reason: "invalid-transition", message: `task ${task.taskID} is completed and immutable` }
  }
  const owner: LeadOwner = {
    sessionID: boundedBoardText(input.owner.sessionID, LEAD_OWNER_SESSION_MAX_LENGTH),
    role: input.owner.role,
  }
  const next: LeadTask = {
    ...task,
    owner,
    lifecycleVersion: task.lifecycleVersion + 1,
    updatedAt: now,
  }
  return {
    ok: true,
    board: {
      ...input.board,
      tasks: input.board.tasks.map((candidate) => (candidate.taskID === task.taskID ? next : candidate)),
      boardRevision: input.board.boardRevision + 1,
      updatedAt: now,
    },
    task: next,
  }
}

/* ------------------------------------------------------------------ */
/* Board status                                                        */
/* ------------------------------------------------------------------ */

export function pauseLeadBoard(board: LeadBoard, now = Date.now()): LeadBoard {
  if (board.status !== "active") return board
  return { ...board, status: "paused", boardRevision: board.boardRevision + 1, updatedAt: now }
}

export function resumeLeadBoard(board: LeadBoard, now = Date.now()): LeadBoard {
  if (board.status !== "paused") return board
  return { ...board, status: "active", boardRevision: board.boardRevision + 1, updatedAt: now }
}

/** All tasks completed, none ambiguous/blocked/failed — the board gate. */
export function boardCompletionEligible(board: LeadBoard): boolean {
  return board.status === "active" && board.tasks.length > 0 && board.tasks.every((task) => task.status === "completed")
}

export function boardUnfinishedTasks(board: LeadBoard): LeadTask[] {
  return board.tasks.filter((task) => task.status !== "completed")
}

export type BoardCompletionInput = {
  revision: string
  reviewReference: string
  validatedAt?: number
  evidence?: readonly EvidenceRef[]
  secrets?: readonly string[]
}

export function completeLeadBoard(board: LeadBoard, input: BoardCompletionInput, now = Date.now()): LeadBoard {
  const evidence = boundedEvidenceList(
    (input.evidence ?? []).flatMap((ref) => {
      const safe = normalizeEvidenceRef({ ...ref, secrets: input.secrets })
      return safe ? [safe] : []
    }),
    LEAD_BOARD_MAX_COMPLETION_EVIDENCE,
  )
  return {
    ...board,
    status: "complete",
    boardRevision: board.boardRevision + 1,
    updatedAt: now,
    completion: {
      leadSessionID: board.leadSessionID,
      validatedAt: input.validatedAt ?? now,
      revision: boundedBoardText(input.revision, LEAD_REF_MAX_LENGTH, input.secrets ?? []),
      reviewReference: boundedBoardText(input.reviewReference, LEAD_REF_MAX_LENGTH, input.secrets ?? []),
      evidence,
    },
  }
}

/* ------------------------------------------------------------------ */
/* Hydration + receipt recovery                                        */
/* ------------------------------------------------------------------ */

export type LeadBoardHydration = {
  status: "ok" | "missing" | "unavailable"
  key: string
  board?: LeadBoard
  issues: string[]
  warning?: string
}

/**
 * Strict, non-throwing hydration of the board for one lead session. Resolves
 * the stable origin project exactly like goal/run/halt/step records. A missing
 * record is `missing` (legacy: explicit init required); a malformed or
 * identity-mismatched record is `unavailable` with a bounded warning. Never
 * auto-repairs, never overwrites, never dispatches from a malformed record.
 */
export async function hydrateLeadBoard(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  expected: { goalGeneration?: number; boardID?: string } = {},
): Promise<LeadBoardHydration> {
  let key = leadBoardStorageKey(location, sessionID)
  let raw: unknown
  try {
    const keyed = await leadBoardKeyedLocation(storage, location, sessionID)
    key = leadBoardStorageKey(keyed, sessionID)
    raw = await storage.get(key)
  } catch {
    return { status: "unavailable", key, issues: ["unreadable"], warning: "board record could not be read" }
  }
  if (raw === undefined) return { status: "missing", key, issues: [] }
  const board = parseLeadBoard(raw)
  if (!board) {
    return { status: "unavailable", key, issues: ["malformed"], warning: "board record is malformed" }
  }
  const keyed = await leadBoardKeyedLocation(storage, location, sessionID)
  const issues = verifyLeadBoard(board, {
    projectID: keyed.project.id,
    leadSessionID: sessionID,
    ...(expected.boardID !== undefined ? { boardID: expected.boardID } : {}),
    ...(expected.goalGeneration !== undefined ? { goalGeneration: expected.goalGeneration } : {}),
  })
  if (issues.length > 0) {
    return {
      status: "unavailable",
      key,
      board,
      issues: issues.slice(0, 16),
      warning: `board record failed verification: ${issues.slice(0, 4).join(", ")}`,
    }
  }
  return { status: "ok", key, board, issues: [] }
}

/** Writes one board after strict schema validation. Caller owns locking. */
export async function writeLeadBoard(
  storage: StorageLike,
  location: LocationLike,
  board: LeadBoard,
): Promise<LeadBoard> {
  const parsed = leadBoardSchema.parse(board)
  const keyed = await leadBoardKeyedLocation(storage, location, parsed.leadSessionID)
  await storage.set(leadBoardStorageKey(keyed, parsed.leadSessionID), parsed)
  return parsed
}

/** Removes the board record (session cleanup). Removing a missing record is a no-op. */
export async function removeLeadBoard(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
): Promise<void> {
  const keyed = await leadBoardKeyedLocation(storage, location, sessionID)
  await storage.remove(leadBoardStorageKey(keyed, sessionID))
}

export type LeadStepObservation =
  | { state: "missing" }
  | { state: "malformed" }
  | { state: "unreadable" }
  | { state: "pending"; stepIndex: number; idempotencyKey: string }
  | { state: "dispatched"; stepIndex: number; idempotencyKey: string }
  | { state: "completed"; stepIndex: number; idempotencyKey: string }
  | { state: "failed"; stepIndex: number; idempotencyKey: string }

export type LeadReconcileChange = {
  taskID: string
  from: LeadTaskStatus
  to: LeadTaskStatus
  observation: LeadStepObservation["state"]
}

export type LeadReconcileResult = {
  board: LeadBoard
  changes: LeadReconcileChange[]
  warnings: string[]
}

/**
 * Conservative receipt recovery for nonterminal claim-holding tasks. Never
 * replays and never infers success:
 * - pending/dispatched/missing/malformed/unreadable/failed → `ambiguous`
 *   (the possible external effect is retained as a claim);
 * - a `completed` step observation (an idle edge) advances at most to
 *   `awaiting-validation`, never to `completed`;
 * - `completed` tasks keep their own persisted validation + review refs and are
 *   never rebuilt from a step receipt.
 *
 * `liveStepIndex` marks the step this process just delivered: it is skipped so
 * a live turn is not mistaken for a crashed one. The function is pure; callers
 * persist the returned board under the session lock.
 */
export function reconcileLeadBoard(
  board: LeadBoard,
  input: {
    observations: ReadonlyMap<string, LeadStepObservation>
    liveStepIndex?: number
    now?: number
  },
): LeadReconcileResult {
  const now = input.now ?? Date.now()
  const changes: LeadReconcileChange[] = []
  const warnings: string[] = []
  let working = board
  for (const task of board.tasks) {
    if (task.status !== "reserved" && task.status !== "in-progress") continue
    const stepIndex = task.stepIndex
    if (stepIndex === undefined) {
      const ambiguous = markAmbiguous(working, task, now, "reservation has no step identity")
      if (ambiguous) {
        working = ambiguous
        changes.push({ taskID: task.taskID, from: task.status, to: "ambiguous", observation: "missing" })
      } else {
        warnings.push(`reconcile-refused:${task.taskID}`)
      }
      continue
    }
    if (input.liveStepIndex !== undefined && input.liveStepIndex === stepIndex) continue
    const observation = input.observations.get(task.taskID)
    if (observation === undefined || observation.state !== "completed") {
      const state = observation?.state ?? "missing"
      const ambiguous = markAmbiguous(working, task, now, reconcileNote(state, stepIndex))
      if (ambiguous) {
        working = ambiguous
        changes.push({ taskID: task.taskID, from: task.status, to: "ambiguous", observation: state })
      } else {
        warnings.push(`reconcile-refused:${task.taskID}`)
      }
      continue
    }
    // Step completed is an idle-edge observation: at most awaiting-validation.
    if (observation.stepIndex !== stepIndex) {
      const ambiguous = markAmbiguous(working, task, now, "step identity mismatch")
      if (ambiguous) {
        working = ambiguous
        changes.push({ taskID: task.taskID, from: task.status, to: "ambiguous", observation: "malformed" })
      } else {
        warnings.push(`reconcile-refused:${task.taskID}`)
      }
      continue
    }
    const advanced = advanceTask(working, task, "awaiting-validation", now, "step receipt completed at idle edge")
    if (advanced) {
      working = advanced
      changes.push({ taskID: task.taskID, from: task.status, to: "awaiting-validation", observation: "completed" })
    } else {
      warnings.push(`reconcile-refused:${task.taskID}`)
    }
  }
  return { board: working, changes, warnings }
}

function reconcileNote(state: LeadStepObservation["state"], stepIndex: number): string {
  const suffix = `step ${stepIndex}`
  switch (state) {
    case "pending":
      return `reservation ${suffix} was never confirmed delivered; outcome unknown, no blind resubmit`
    case "dispatched":
      return `${suffix} was delivered and its outcome is unknown; no blind resubmit`
    case "failed":
      return `${suffix} recorded a failure; lead classification required`
    case "malformed":
      return `${suffix} receipt is malformed or has a mismatched identity`
    case "unreadable":
      return `${suffix} receipt could not be read`
    case "missing":
    default:
      return `${suffix} receipt is missing`
  }
}

function markAmbiguous(board: LeadBoard, task: LeadTask, now: number, note: string): LeadBoard | undefined {
  const result = transitionLeadTask({
    board,
    taskID: task.taskID,
    expectedVersion: task.lifecycleVersion,
    actorSessionID: board.leadSessionID,
    action: "ambiguous",
    note,
    now,
  })
  return result.ok ? result.board : undefined
}

function advanceTask(
  board: LeadBoard,
  task: LeadTask,
  status: LeadTaskStatus,
  now: number,
  description: string,
): LeadBoard | undefined {
  const result = transitionLeadTask({
    board,
    taskID: task.taskID,
    expectedVersion: task.lifecycleVersion,
    actorSessionID: board.leadSessionID,
    action: "report",
    evidence: [
      {
        kind: "receipt",
        reference: `${task.taskID}/${task.stepIndex ?? 0}`,
        description,
        observedAt: now,
      },
    ],
    now,
  })
  if (!result.ok || result.task.status !== status) return undefined
  return result.board
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

export type LeadBoardProjection = {
  version: 1
  boardID: string
  leadSessionID: string
  projectID: string
  goalGeneration: number
  status: LeadBoardStatus
  boardRevision: number
  objective: string
  counts: Record<LeadTaskStatus, number>
  tasks: Array<{
    taskID: string
    title: string
    status: LeadTaskStatus
    owner: LeadOwner
    attempt: number
    lifecycleVersion: number
    stepIndex?: number
    cursor?: string
    dependencies: string[]
    scope: ScopePacket
    replay: ReplayKindSummary
    evidenceCount: number
    validation?: LeadTaskValidation
    review?: LeadTaskReview
    updatedAt: number
  }>
  updatedAt: number
}

export type ReplayKindSummary = {
  kind: LeadReplayKind
  repository?: string
  prNumber?: number
  prURL?: string
  mergeSHA?: string
}

/** Bounded lead-facing projection: never raw step receipts or transcripts. */
export function projectLeadBoard(board: LeadBoard): LeadBoardProjection {
  const counts = Object.fromEntries(LEAD_TASK_STATUSES.map((status) => [status, 0])) as Record<LeadTaskStatus, number>
  for (const task of board.tasks) counts[task.status] += 1
  return {
    version: 1,
    boardID: board.boardID,
    leadSessionID: board.leadSessionID,
    projectID: board.projectID,
    goalGeneration: board.goalGeneration,
    status: board.status,
    boardRevision: board.boardRevision,
    objective: board.objective,
    counts,
    tasks: board.tasks.map((task) => ({
      taskID: task.taskID,
      title: task.title,
      status: task.status,
      owner: task.owner,
      attempt: task.attempt,
      lifecycleVersion: task.lifecycleVersion,
      ...(task.stepIndex !== undefined ? { stepIndex: task.stepIndex } : {}),
      ...(task.cursor !== undefined ? { cursor: task.cursor } : {}),
      dependencies: task.dependencies,
      scope: task.scope,
      replay: replaySummary(task.replay),
      evidenceCount: task.evidence.length,
      ...(task.validation !== undefined ? { validation: task.validation } : {}),
      ...(task.review !== undefined ? { review: task.review } : {}),
      updatedAt: task.updatedAt,
    })),
    updatedAt: board.updatedAt,
  }
}

function replaySummary(replay: ReplayDescriptor): ReplayKindSummary {
  if (replay.kind === "none") return { kind: "none" }
  if (replay.kind === "github-pr-create") {
    return {
      kind: replay.kind,
      repository: replay.repository,
      ...(replay.prNumber !== undefined ? { prNumber: replay.prNumber } : {}),
      ...(replay.prURL !== undefined ? { prURL: replay.prURL } : {}),
    }
  }
  return {
    kind: replay.kind,
    repository: replay.repository,
    prNumber: replay.prNumber,
    ...(replay.mergeSHA !== undefined ? { mergeSHA: replay.mergeSHA } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Prompt packet (advisory)                                            */
/* ------------------------------------------------------------------ */

/**
 * The task packet rendered verbatim (post-normalization) into the lead's
 * continuation prompt. Advisory only: not isolation, permission, worktree
 * binding, or obedience proof.
 */
export function leadTaskPacketText(task: LeadTask): string {
  const read = task.scope.readPaths.length > 0 ? task.scope.readPaths.join(", ") : "(none)"
  const write = task.scope.writePaths.length > 0 ? task.scope.writePaths.join(", ") : "(none)"
  const dependencies = task.dependencies.length > 0 ? task.dependencies.join(", ") : "(none)"
  return [
    "Board task packet (advisory scope; not isolation or permission):",
    `Task: ${task.taskID} at lifecycle version ${task.lifecycleVersion}`,
    `Owner: ${task.owner.role}/${task.owner.sessionID}`,
    `Read scope: ${read}`,
    `Write scope: ${write}`,
    `Dependencies: ${dependencies}`,
    `Attempt: ${task.attempt}`,
    `Cursor: ${task.cursor ?? "none"}`,
    `Scope root: ${task.scope.root}`,
    `Broad scope: ${task.scope.broad ? "yes" : "no"}`,
  ].join("\n")
}

/** Operating instructions appended when a board task drives a continuation. */
export const LEAD_BOARD_PROMPT_GUIDANCE = [
  "The lead board is the durable task ledger for this goal generation.",
  "Report the task's bounded evidence with orchestrator_lead_board_transition; a delivered prompt, an idle edge, or a step receipt never completes a task.",
  "A worker handoff is a report until you validate it: call orchestrator_handoff_validate on the unchanged D2 envelope first.",
  "Then rerun the required checks yourself and record bounded results, revision, and redacted refs with the validate action.",
  "Completion additionally requires an approved exact-revision review for the same revision; keep the task lifecycle version and use expectedVersion on every transition.",
  "If an external outcome is unknowable, mark the task ambiguous instead of retrying; resume only from a lead-validated cursor.",
  "Scope packets are advisory: they are not filesystem isolation, permissions, or a worktree binding.",
].join("\n")

/** Fixed limitation statement returned alongside lead-board projections. */
export const LEAD_BOARD_LIMITATIONS = [
  "the board is a durable ledger under the existing process-local session lock; there is no exactly-once, transaction, CAS, event-log, projection, distributed-lock, or cross-process scheduler guarantee",
  "scope packets are advisory: not filesystem/process isolation, not a permission boundary, and not a worktree binding",
  "overlap serialization is single-process only and treats broad/unknown/malformed scopes as conflicts",
  "completion requires the lead's own D2 validation, check rerun, and an approved exact-revision review; workers can only report evidence or failure",
  "a missing board is board-missing (legacy, explicit init required); a malformed board is board-unavailable and is never auto-repaired or dispatched from",
  "replay descriptors make a replay detectable; they cannot make an external side effect idempotent",
] as const

export type { LocationLike, StorageLike }
