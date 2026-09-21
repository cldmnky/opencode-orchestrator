import { z } from "zod"
import { isSafeRelativeRepoPath } from "../../core/contracts.js"
import { stableProjectID, type LocationLike, type StorageLike } from "../goal/state.js"
import {
  LEAD_BOARD_ID_MAX_LENGTH,
  LEAD_BOARD_ID_PATTERN,
  LEAD_BOARD_MAX_COMPLETION_EVIDENCE,
  LEAD_BOARD_MAX_TASKS,
  LEAD_CHECK_ID_MAX_LENGTH,
  LEAD_CURSOR_MAX_LENGTH,
  LEAD_KEY_MAX_LENGTH,
  LEAD_MAX_CHECK_IDS,
  LEAD_OBJECTIVE_MAX_LENGTH,
  LEAD_OWNER_SESSION_MAX_LENGTH,
  LEAD_REF_MAX_LENGTH,
  LEAD_TASK_MAX_DEPENDENCIES,
  LEAD_TASK_MAX_EVIDENCE,
  LEAD_TASK_MAX_READ_PATHS,
  LEAD_TASK_MAX_WRITE_PATHS,
  LEAD_TITLE_MAX_LENGTH,
  LEAD_ROLES,
  LEAD_TASK_STATUSES,
  LEAD_BOARD_STATUSES,
  LEAD_EVIDENCE_KINDS,
  LEAD_SHA_PATTERN,
  assignLeadTaskOwner,
  boundedBoardText,
  boardCompletionEligible,
  boardUnfinishedTasks,
  completeLeadBoard,
  createLeadBoard,
  createLeadTask,
  leadBoardID,
  leadBoardStorageKey as leadBoardV1StorageKey,
  leadTaskIdempotencyKey,
  leadTaskPacketText,
  leadTaskStepIdempotencyKey,
  parseLeadBoard as parseLeadBoardV1,
  parseReplayDescriptor,
  pauseLeadBoard,
  reconcileLeadBoard,
  releaseLeadReservation,
  reserveNextLeadTask,
  resumeLeadBoard,
  projectLeadBoard as projectLeadBoardLegacy,
  transitionLeadTask,
  verifyLeadBoard as verifyLeadBoardV1,
  type EvidenceRef,
  type LeadAssignResult,
  type LeadBoard as LeadBoardV1,
  type LeadBoardCompletion as LeadBoardCompletionV1,
  type LeadBoardProjection as LeadBoardProjectionV1,
  type LeadReleaseResult,
  type LeadReservation,
  type LeadStepObservation,
  type LeadTask as LeadTaskV1,
  type LeadTaskReview as LeadTaskReviewV1,
  type LeadTaskValidation as LeadTaskValidationV1,
  type LeadRole,
  type LeadTransitionAction,
  type LeadTransitionReason,
  type ReplayDescriptor,
  type ScopeNormalization,
  type ScopePacket,
} from "./lead-board.js"

/** Version 2 is the runtime lead-board authority after Phase 5. */
export const LEAD_BOARD_V2_RECORD_VERSION = 2
export const LEAD_BOARD_RECORD_VERSION = LEAD_BOARD_V2_RECORD_VERSION
export const LEAD_BOARD_V2_PREFIX = "lead-board/v2"

export type LeadBoardMigration = {
  fromVersion: 1
  migratedAt: number
  note: string
}

/** Validation proof is always tied to the invoking lead ToolContext. */
export type LeadTaskValidationV2 = {
  actorSessionID: string
  validatedAt: number
  revision: string
  checkIDs: string[]
  receiptIDs: string[]
}

/** A task review reference is a V2 review record, never a caller label. */
export type LeadTaskReviewV2 = {
  reference: string
  revision: string
  baseRevision: string
  approvedAt: number
  reviewVersion: 2
}

export type LeadTaskV2 = Omit<LeadTaskV1, "version" | "validation" | "review"> & {
  version: 2
  validation?: LeadTaskValidationV2
  review?: LeadTaskReviewV2
  /** Set only by the explicit V1 migration; never treated as proof. */
  migrationNote?: string
}

export type LeadBoardCompletionV2 = Omit<LeadBoardCompletionV1, "leadSessionID" | "revision" | "reviewReference"> & {
  leadSessionID: string
  validationActorSessionID: string
  revision: string
  baseRevision: string
  receiptIDs: string[]
  reviewReference: string
}

export type LeadBoardV2 = Omit<LeadBoardV1, "version" | "tasks" | "completion"> & {
  version: 2
  tasks: LeadTaskV2[]
  completion?: LeadBoardCompletionV2
  /** Historical V1 completion remains readable but can never be reused. */
  historical?: boolean
  migration?: LeadBoardMigration
}

const boardID = z.string().min(1).max(LEAD_BOARD_ID_MAX_LENGTH).regex(LEAD_BOARD_ID_PATTERN)
const sha = z.string().regex(LEAD_SHA_PATTERN)
const path = z
  .string()
  .min(1)
  .max(LEAD_REF_MAX_LENGTH)
  .refine((value) => isSafeRelativeRepoPath(value), { message: "must be a canonical relative path" })
const scopeSchema = z
  .object({
    version: z.literal(1),
    root: z.enum(["project", "managed-worktree"]),
    readPaths: z.array(path).max(LEAD_TASK_MAX_READ_PATHS),
    writePaths: z.array(path).max(LEAD_TASK_MAX_WRITE_PATHS),
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
const evidenceSchema = z
  .object({
    kind: z.enum(LEAD_EVIDENCE_KINDS),
    reference: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
    description: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
    observedAt: z.number().finite().nonnegative(),
  })
  .strict()
const replaySchema = z.custom<ReplayDescriptor>((value) => parseReplayDescriptor(value) !== undefined)
const validationSchema = z
  .object({
    actorSessionID: z.string().min(1).max(LEAD_OWNER_SESSION_MAX_LENGTH),
    validatedAt: z.number().finite().nonnegative(),
    revision: sha,
    checkIDs: z.array(z.string().min(1).max(LEAD_CHECK_ID_MAX_LENGTH)).max(LEAD_MAX_CHECK_IDS),
    receiptIDs: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict()
const reviewSchema = z
  .object({
    reference: z.string().min(1).max(LEAD_REF_MAX_LENGTH).startsWith("review/v2/"),
    revision: sha,
    baseRevision: sha,
    approvedAt: z.number().finite().nonnegative(),
    reviewVersion: z.literal(2),
  })
  .strict()
const migrationSchema = z
  .object({
    fromVersion: z.literal(1),
    migratedAt: z.number().finite().nonnegative(),
    note: z.string().min(1).max(LEAD_REF_MAX_LENGTH),
  })
  .strict()
const taskSchema = z
  .object({
    version: z.literal(2),
    taskID: boardID,
    title: z.string().min(1).max(LEAD_TITLE_MAX_LENGTH),
    owner: ownerSchema,
    scope: scopeSchema,
    dependencies: z.array(boardID).max(LEAD_TASK_MAX_DEPENDENCIES),
    status: z.enum(LEAD_TASK_STATUSES),
    attempt: z.number().int().positive().safe(),
    cursor: z.string().min(1).max(LEAD_CURSOR_MAX_LENGTH).optional(),
    evidence: z.array(evidenceSchema).max(LEAD_TASK_MAX_EVIDENCE),
    lifecycleVersion: z.number().int().positive().safe(),
    idempotencyKey: z.string().min(1).max(LEAD_KEY_MAX_LENGTH),
    stepIndex: z.number().int().nonnegative().safe().optional(),
    replay: replaySchema,
    validation: validationSchema.optional(),
    review: reviewSchema.optional(),
    migrationNote: z.string().min(1).max(LEAD_REF_MAX_LENGTH).optional(),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.review && (!value.validation || value.review.revision !== value.validation.revision)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["review"], message: "review must match the validated revision" })
    }
  })
const completionSchema = z
  .object({
    leadSessionID: z.string().min(1).max(LEAD_OWNER_SESSION_MAX_LENGTH),
    validationActorSessionID: z.string().min(1).max(LEAD_OWNER_SESSION_MAX_LENGTH),
    validatedAt: z.number().finite().nonnegative(),
    revision: sha,
    baseRevision: sha,
    receiptIDs: z.array(z.string().min(1).max(128)).max(64),
    reviewReference: z.string().min(1).max(LEAD_REF_MAX_LENGTH).startsWith("review/v2/"),
    evidence: z.array(evidenceSchema).max(LEAD_BOARD_MAX_COMPLETION_EVIDENCE),
  })
  .strict()

export const leadBoardV2Schema = z
  .object({
    version: z.literal(LEAD_BOARD_V2_RECORD_VERSION),
    boardID,
    leadSessionID: z.string().min(1).max(LEAD_OWNER_SESSION_MAX_LENGTH),
    projectID: z.string().min(1),
    goalGeneration: z.number().finite().nonnegative(),
    objective: z.string().min(1).max(LEAD_OBJECTIVE_MAX_LENGTH),
    status: z.enum(LEAD_BOARD_STATUSES),
    boardRevision: z.number().int().positive().safe(),
    tasks: z.array(taskSchema).max(LEAD_BOARD_MAX_TASKS),
    completion: completionSchema.optional(),
    historical: z.boolean().optional(),
    migration: migrationSchema.optional(),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const task of value.tasks) {
      if (task.validation && task.validation.actorSessionID !== value.leadSessionID) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: `task ${task.taskID} validation actor must be the board lead` })
      }
      if (!value.historical && task.status === "awaiting-review" && !task.validation) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: `task ${task.taskID} awaiting-review requires V2 validation proof` })
      }
      if (!value.historical && task.status === "completed" && (!task.validation || !task.review)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: `task ${task.taskID} completed without V2 validation and review proof` })
      }
    }
    if (value.completion) {
      if (value.completion.leadSessionID !== value.leadSessionID) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completion", "leadSessionID"], message: "completion lead session must match the board lead" })
      }
      if (value.completion.validationActorSessionID !== value.leadSessionID) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completion"], message: "completion validation actor must be the board lead" })
      }
    }
    if (value.status === "complete" && !value.historical && value.tasks.some((task) => task.status !== "completed")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: "active complete boards require every task to be completed" })
    }
    if (value.status === "complete" && !value.historical && !value.completion) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completion"], message: "active complete boards require completion proof" })
    }
    if (value.historical && !value.migration) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["historical"], message: "historical boards require migration metadata" })
    }
    if (value.historical && value.status !== "complete") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["historical"], message: "historical boards must retain complete status" })
    }
    if (value.status === "complete" && !value.historical && value.completion) {
      for (const task of value.tasks) {
        if (!task.validation || !task.review) continue
        if (task.validation.revision !== value.completion.revision || task.review.revision !== value.completion.revision) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completion", "revision"], message: `task ${task.taskID} proof is not bound to the completion revision` })
        }
        if (task.review.baseRevision !== value.completion.baseRevision) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completion", "baseRevision"], message: `task ${task.taskID} review is not bound to the completion base revision` })
        }
      }
    }
  })

export type LeadBoardV2Hydration = {
  status: "ok" | "missing" | "unavailable" | "legacy"
  key: string
  legacyKey?: string
  board?: LeadBoardV2
  issues: string[]
  warning?: string
}

export type LeadTransitionInputV2 = {
  board: LeadBoardV2
  taskID: string
  expectedVersion: number
  actorSessionID: string
  action: LeadTransitionAction
  now?: number
  evidence?: readonly EvidenceRef[]
  note?: string
  cursor?: string
  validation?: LeadTaskValidationV2
  review?: LeadTaskReviewV2
  replay?: ReplayDescriptor
  stepIndex?: number
  secrets?: readonly string[]
}

export type LeadTransitionResultV2 =
  | { ok: true; board: LeadBoardV2; task: LeadTaskV2; reason: "applied"; message: string }
  | { ok: false; reason: LeadTransitionReason; message: string }

export const leadBoardV1Key = leadBoardV1StorageKey

export function leadBoardV2StorageKey(location: LocationLike, sessionID: string): string {
  return `${LEAD_BOARD_V2_PREFIX}/${encodeURIComponent(location.project.id)}/${encodeURIComponent(sessionID)}`
}

export function leadBoardV2ProjectPrefix(projectID: string): string {
  return `${LEAD_BOARD_V2_PREFIX}/${encodeURIComponent(projectID)}/`
}

export async function leadBoardV2KeyedLocation(storage: StorageLike, location: LocationLike, sessionID: string): Promise<LocationLike> {
  return { ...location, project: { id: await stableProjectID(storage, location, sessionID) } }
}

export function parseLeadBoardV2(value: unknown): LeadBoardV2 | undefined {
  const parsed = leadBoardV2Schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * Migrate a serialized V1 board without upgrading any proof. Lifecycle state
 * that is not independently proven remains readable. V1 validation/review or
 * completion state is conservatively returned to awaiting-validation with a
 * bounded note, and completed historical boards remain historical only.
 */
export function migrateLeadBoardV1(value: unknown, now = Date.now()): LeadBoardV2 | undefined {
  const legacy = parseLeadBoardV1(value)
  if (!legacy) return undefined
  if (verifyLeadBoardV1(legacy, {}).length > 0) return undefined
  const historical = legacy.status === "complete" && legacy.tasks.length > 0 && legacy.tasks.every((task) => task.status === "completed")
  if (legacy.status === "complete" && !historical) return undefined
  const tasks: LeadTaskV2[] = legacy.tasks.map((task) => {
    const proofBearing = task.validation !== undefined || task.review !== undefined || task.status === "awaiting-review" || task.status === "completed"
    const retainHistoricalCompletion = historical && task.status === "completed"
    const requiresRevalidation = !retainHistoricalCompletion && (task.status === "awaiting-review" || task.status === "completed")
    const nextStatus = requiresRevalidation ? "awaiting-validation" : task.status
    return {
      ...task,
      version: 2,
      status: nextStatus,
      ...(proofBearing
        ? { migrationNote: "V1 validation or completion was not upgraded; re-run observed validation and start a V2 review" }
        : {}),
    } as LeadTaskV2
  })
  const migrated: LeadBoardV2 = {
    version: 2,
    boardID: legacy.boardID,
    leadSessionID: legacy.leadSessionID,
    projectID: legacy.projectID,
    goalGeneration: legacy.goalGeneration,
    objective: legacy.objective,
    status: legacy.status,
    boardRevision: legacy.boardRevision,
    tasks: tasks.map((task) => {
      // V1 proof fields are intentionally omitted rather than reinterpreted.
      const { validation: _validation, review: _review, ...withoutProof } = task
      return withoutProof
    }),
    ...(historical ? { historical: true } : {}),
    migration: {
      fromVersion: 1,
      migratedAt: now,
      note: historical
        ? "historical V1 completion remains readable; legacy validation and review proof cannot authorize new completion or publication"
        : "V1 lifecycle state migrated without upgrading caller-supplied validation or review proof",
    },
    createdAt: legacy.createdAt,
    updatedAt: now,
  }
  return parseLeadBoardV2(migrated)
}

/** Create a fresh V2 board; no V1 record is consulted. */
export function createLeadBoardV2(input: Parameters<typeof createLeadBoard>[0]): LeadBoardV2 {
  return fromLegacyBoard(createLeadBoard(input))
}

export function createLeadTaskV2(board: LeadBoardV2, input: Parameters<typeof createLeadTask>[1]): { ok: true; task: LeadTaskV2 } | { ok: false; issues: string[] } {
  const result = createLeadTask(toLegacyBoard(board), input)
  return result.ok ? { ok: true, task: fromLegacyTask(result.task) } : result
}

export function transitionLeadTaskV2(input: LeadTransitionInputV2): LeadTransitionResultV2 {
  const { board: _board, validation, review, ...rest } = input
  const result = transitionLeadTask({
    ...rest,
    board: toLegacyBoard(input.board),
    ...(validation ? { validation: toLegacyValidation(validation) } : {}),
    ...(review ? { review: toLegacyReview(review) } : {}),
  })
  if (!result.ok) return result
  const convertedBoard = fromLegacyBoard(result.board, input.board)
  const convertedTask = {
    ...fromLegacyTask(result.task, input.board.tasks.find((task) => task.taskID === result.task.taskID)),
    ...(review ? { review } : {}),
  }
  return {
    ...result,
    board: {
      ...convertedBoard,
      tasks: convertedBoard.tasks.map((task) => (task.taskID === convertedTask.taskID ? convertedTask : task)),
    },
    task: convertedTask,
  }
}

export function reserveNextLeadTaskV2(
  board: LeadBoardV2,
  input: Parameters<typeof reserveNextLeadTask>[1],
): { board: LeadBoardV2; reservation?: LeadReservation; reason?: "no-ready-task" | "scope-conflict" | "dependencies-pending" } {
  const result = reserveNextLeadTask(toLegacyBoard(board), input)
  return { ...result, board: fromLegacyBoard(result.board, board) }
}

export type LeadReleaseResultV2 =
  | { ok: true; board: LeadBoardV2 }
  | { ok: false; reason: "version-mismatch" | "not-reserved" | "board-not-active" }

export type LeadReleaseInputV2 = {
  board: LeadBoardV2
  taskID: string
  expectedLifecycleVersion: number
  expectedBoardRevision: number
  now?: number
  reason?: string
  secrets?: readonly string[]
}

export function releaseLeadReservationV2(input: LeadReleaseInputV2): LeadReleaseResultV2 {
  const result = releaseLeadReservation({ ...input, board: toLegacyBoard(input.board) })
  return result.ok ? { ...result, board: fromLegacyBoard(result.board, input.board) } : result
}

export type LeadAssignResultV2 =
  | { ok: true; board: LeadBoardV2; task: LeadTaskV2 }
  | { ok: false; reason: LeadTransitionReason; message: string }

export type LeadAssignInputV2 = {
  board: LeadBoardV2
  taskID: string
  expectedVersion: number
  actorSessionID: string
  owner: { sessionID: string; role: LeadRole }
  now?: number
}

export function assignLeadTaskOwnerV2(input: LeadAssignInputV2): LeadAssignResultV2 {
  const result = assignLeadTaskOwner({ ...input, board: toLegacyBoard(input.board) })
  return result.ok
    ? {
        ...result,
        board: fromLegacyBoard(result.board, input.board),
        task: fromLegacyTask(result.task, input.board.tasks.find((task) => task.taskID === result.task.taskID)),
      }
    : result
}

export function boardCompletionEligibleV2(board: LeadBoardV2): boolean {
  return !board.historical && boardCompletionEligible(toLegacyBoard(board)) && board.tasks.every((task) => task.validation && task.review)
}

/**
 * Validate the exact revision binding required by an aggregate completion.
 * Storage/schema validation cannot inspect receipts, but it can ensure that a
 * completed task's persisted proof is for the same head/base pair as the
 * aggregate completion proof.
 */
export function boardCompletionRevisionIssuesV2(
  board: LeadBoardV2,
  input: { revision: string; baseRevision: string },
): string[] {
  const issues: string[] = []
  if (board.historical) issues.push("historical-board")
  for (const task of board.tasks) {
    if (task.status !== "completed") {
      issues.push(`task-not-completed:${task.taskID}`)
      continue
    }
    if (!task.validation || !task.review) {
      issues.push(`task-proof-missing:${task.taskID}`)
      continue
    }
    if (task.validation.revision !== input.revision || task.review.revision !== input.revision) {
      issues.push(`task-head-mismatch:${task.taskID}`)
    }
    if (task.review.baseRevision !== input.baseRevision) {
      issues.push(`task-base-mismatch:${task.taskID}`)
    }
  }
  return issues
}

export function boardUnfinishedTasksV2(board: LeadBoardV2): LeadTaskV2[] {
  return board.tasks.filter((task) => task.status !== "completed")
}

export type BoardCompletionInputV2 = {
  revision: string
  reviewReference: string
  baseRevision: string
  validationActorSessionID: string
  receiptIDs: readonly string[]
  validatedAt?: number
  evidence?: readonly EvidenceRef[]
  secrets?: readonly string[]
}

export function completeLeadBoardV2(board: LeadBoardV2, input: BoardCompletionInputV2, now = Date.now()): LeadBoardV2 {
  const completed = completeLeadBoard(toLegacyBoard(board), input, now)
  const result = fromLegacyBoard(completed, board)
  result.completion = {
    leadSessionID: board.leadSessionID,
    validationActorSessionID: input.validationActorSessionID,
    validatedAt: input.validatedAt ?? now,
    revision: input.revision,
    baseRevision: input.baseRevision,
    receiptIDs: [...input.receiptIDs].slice(0, 64),
    reviewReference: input.reviewReference,
    evidence: result.completion?.evidence ?? [],
  }
  return result
}

export function pauseLeadBoardV2(board: LeadBoardV2, now = Date.now()): LeadBoardV2 {
  return fromLegacyBoard(pauseLeadBoard(toLegacyBoard(board), now), board)
}

export function resumeLeadBoardV2(board: LeadBoardV2, now = Date.now()): LeadBoardV2 {
  return fromLegacyBoard(resumeLeadBoard(toLegacyBoard(board), now), board)
}

export function reconcileLeadBoardV2(
  board: LeadBoardV2,
  input: Parameters<typeof reconcileLeadBoard>[1],
): { board: LeadBoardV2; changes: ReturnType<typeof reconcileLeadBoard>["changes"]; warnings: string[] } {
  const result = reconcileLeadBoard(toLegacyBoard(board), input)
  return { ...result, board: fromLegacyBoard(result.board, board) }
}

export function leadTaskPacketTextV2(task: LeadTaskV2): string {
  return leadTaskPacketText(toLegacyTask(task))
}

export type LeadBoardProjectionV2 = Omit<LeadBoardProjectionV1, "version" | "tasks"> & {
  version: 2
  tasks: Array<{
    taskID: string
    title: string
    status: LeadTaskV2["status"]
    owner: LeadTaskV2["owner"]
    attempt: number
    lifecycleVersion: number
    stepIndex?: number
    cursor?: string
    dependencies: string[]
    scope: ScopePacket
    replay: LeadBoardProjectionV1["tasks"][number]["replay"]
    evidenceCount: number
    validation?: LeadTaskValidationV2
    review?: LeadTaskReviewV2
    migrationNote?: string
    updatedAt: number
  }>
  historical?: boolean
  migration?: LeadBoardMigration
}

export function projectLeadBoardV2(board: LeadBoardV2): LeadBoardProjectionV2 {
  const legacy = projectLeadBoardLegacy(toLegacyBoard(board))
  return {
    ...legacy,
    version: 2,
    tasks: board.tasks.map((task) => {
      const { validation: _validation, review: _review, ...withoutProof } = legacy.tasks.find((candidate) => candidate.taskID === task.taskID)!
      return {
      ...withoutProof,
      ...(task.validation ? { validation: task.validation } : {}),
      ...(task.review ? { review: task.review } : {}),
      ...(task.migrationNote ? { migrationNote: task.migrationNote } : {}),
      }
    }),
    ...(board.historical ? { historical: true } : {}),
    ...(board.migration ? { migration: board.migration } : {}),
  }
}

/** Read only the V2 record. A V1 record is returned as `legacy` and is not written. */
export async function hydrateLeadBoardV2(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  expected: { goalGeneration?: number; boardID?: string } = {},
): Promise<LeadBoardV2Hydration> {
  let key = leadBoardV2StorageKey(location, sessionID)
  let keyed: LocationLike
  try {
    keyed = { ...location, project: { id: await stableProjectID(storage, location, sessionID) } }
    key = leadBoardV2StorageKey(keyed, sessionID)
    const rawV2 = await storage.get(key)
    if (rawV2 !== undefined) {
      const board = parseLeadBoardV2(rawV2)
      if (!board) return { status: "unavailable", key, issues: ["malformed"], warning: "V2 board record is malformed" }
      const issues = verifyLeadBoardV2(board, { projectID: keyed.project.id, leadSessionID: sessionID, ...expected })
      return issues.length > 0
        ? { status: "unavailable", key, board, issues, warning: `V2 board record failed verification: ${issues.slice(0, 4).join(", ")}` }
        : { status: "ok", key, board, issues: [] }
    }
    const legacyKey = leadBoardV1StorageKey(keyed, sessionID)
    const rawV1 = await storage.get(legacyKey)
    if (rawV1 === undefined) return { status: "missing", key, legacyKey, issues: [] }
    const legacy = parseLeadBoardV1(rawV1)
    if (!legacy) return { status: "unavailable", key, legacyKey, issues: ["legacy-malformed"], warning: "V1 board record is malformed" }
    const migrated = migrateLeadBoardV1(legacy)
    if (!migrated) return { status: "unavailable", key, legacyKey, issues: ["migration-failed"], warning: "V1 board record could not be migrated conservatively" }
    const issues = verifyLeadBoardV2(migrated, { projectID: keyed.project.id, leadSessionID: sessionID, ...expected })
    return issues.length > 0
      ? { status: "unavailable", key, legacyKey, board: migrated, issues, warning: `V1 board migration failed verification: ${issues.slice(0, 4).join(", ")}` }
      : { status: "legacy", key, legacyKey, board: migrated, issues: [], warning: "V1 board is readable but requires explicit migration before dispatch" }
  } catch {
    return { status: "unavailable", key, issues: ["unreadable"], warning: "lead board record could not be read" }
  }
}

export function verifyLeadBoardV2(
  board: LeadBoardV2,
  expected: { projectID?: string; leadSessionID?: string; boardID?: string; goalGeneration?: number },
): string[] {
  return verifyLeadBoardV1(toLegacyBoard(board), expected)
}

export async function writeLeadBoardV2(storage: StorageLike, location: LocationLike, board: LeadBoardV2): Promise<LeadBoardV2> {
  const parsed = leadBoardV2Schema.parse(board)
  const projectID = await stableProjectID(storage, location, parsed.leadSessionID)
  const keyed = { ...location, project: { id: projectID } }
  await storage.set(leadBoardV2StorageKey(keyed, parsed.leadSessionID), parsed)
  return parsed
}

export async function removeLeadBoardV2(storage: StorageLike, location: LocationLike, sessionID: string): Promise<void> {
  const projectID = await stableProjectID(storage, location, sessionID)
  const keyed = { ...location, project: { id: projectID } }
  await storage.remove(leadBoardV2StorageKey(keyed, sessionID))
  // Explicit cleanup also removes the legacy record so it cannot reappear as a
  // migration candidate after a goal is cleared.
  await storage.remove(leadBoardV1StorageKey(keyed, sessionID))
}

/** Explicit, idempotent migration used by board_action init and operator recovery. */
export async function migrateLeadBoardV1Storage(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  expected: { goalGeneration?: number } = {},
): Promise<{ status: "migrated" | "exists" | "missing" | "unavailable"; board?: LeadBoardV2; message: string }> {
  const hydration = await hydrateLeadBoardV2(storage, location, sessionID, expected)
  if (hydration.status === "ok") return { status: "exists", board: hydration.board, message: "V2 lead board already exists" }
  if (hydration.status === "missing") return { status: "missing", message: "no V1 lead board exists to migrate" }
  if (hydration.status === "unavailable") return { status: "unavailable", message: hydration.warning ?? "lead board is unavailable" }
  if (!hydration.board) return { status: "unavailable", message: "V1 lead board migration produced no board" }
  const board = await writeLeadBoardV2(storage, location, hydration.board)
  return { status: "migrated", board, message: "V1 lead board migrated conservatively; validation and review proof must be rebuilt" }
}

export {
  LEAD_BOARD_LIMITATIONS,
  LEAD_CHECK_ID_MAX_LENGTH,
  LEAD_MAX_CHECK_IDS,
  LEAD_ROLES,
  LEAD_SHA_PATTERN,
  boundedBoardText,
  normalizeEvidenceRef,
  normalizeScopePacket,
  parseReplayDescriptor,
  leadTaskStepIdempotencyKey,
} from "./lead-board.js"
export type { EvidenceRef, LeadRole, LeadStepObservation, LeadTransitionAction }

function fromLegacyTask(task: LeadTaskV1, source?: LeadTaskV2): LeadTaskV2 {
  return {
    ...task,
    version: 2,
    ...(task.validation
      ? {
          validation: {
            actorSessionID: task.validation.leadSessionID,
            validatedAt: task.validation.validatedAt,
            revision: task.validation.revision,
            checkIDs: [...task.validation.checkIDs],
            receiptIDs: [...(task.validation.receiptIDs ?? [])],
          },
        }
      : {}),
    ...(task.review
      ? {
          review: {
            reference: task.review.reference,
            revision: task.review.revision,
            baseRevision: source?.review?.baseRevision ?? "0".repeat(40),
            approvedAt: task.review.approvedAt,
            reviewVersion: 2 as const,
          },
        }
      : {}),
  } as LeadTaskV2
}

function toLegacyValidation(validation: LeadTaskValidationV2): LeadTaskValidationV1 {
  return {
    leadSessionID: validation.actorSessionID,
    validatedAt: validation.validatedAt,
    revision: validation.revision,
    checkIDs: [...validation.checkIDs],
    receiptIDs: [...validation.receiptIDs],
  }
}

function toLegacyReview(review: LeadTaskReviewV2): LeadTaskReviewV1 {
  return {
    reference: review.reference,
    revision: review.revision,
    approvedAt: review.approvedAt,
  }
}

function fromLegacyBoard(board: LeadBoardV1, source?: LeadBoardV2): LeadBoardV2 {
  return {
    ...board,
    version: 2,
    tasks: board.tasks.map((task) => {
      const prior = source?.tasks.find((candidate) => candidate.taskID === task.taskID)
      const converted = fromLegacyTask(task, prior)
      return {
        ...converted,
        ...(prior?.migrationNote ? { migrationNote: prior.migrationNote } : {}),
      }
    }),
    ...(source?.historical ? { historical: true } : {}),
    ...(source?.migration ? { migration: source.migration } : {}),
    ...(source?.completion
      ? { completion: source.completion }
      : board.completion
      ? {
          completion: {
            ...board.completion,
            validationActorSessionID: board.completion.leadSessionID,
            baseRevision: "0".repeat(40),
            receiptIDs: [],
          },
        }
      : {}),
  } as LeadBoardV2
}

function toLegacyTask(task: LeadTaskV2): LeadTaskV1 {
  const { migrationNote: _migrationNote, ...rest } = task
  return {
    ...rest,
    version: 1,
    ...(task.validation
      ? {
          validation: {
            leadSessionID: task.validation.actorSessionID,
            validatedAt: task.validation.validatedAt,
            revision: task.validation.revision,
            checkIDs: [...task.validation.checkIDs],
            receiptIDs: [...task.validation.receiptIDs],
          } satisfies LeadTaskValidationV1,
        }
      : {}),
    ...(task.review
      ? {
          review: {
            reference: task.review.reference,
            revision: task.review.revision,
            approvedAt: task.review.approvedAt,
          } satisfies LeadTaskReviewV1,
        }
      : {}),
  } as LeadTaskV1
}

function toLegacyBoard(board: LeadBoardV2): LeadBoardV1 {
  const { migration: _migration, historical: _historical, completion: completionV2, ...rest } = board
  return {
    ...rest,
    version: 1,
    tasks: board.tasks.map(toLegacyTask),
    ...(completionV2
      ? {
          completion: {
            leadSessionID: completionV2.leadSessionID,
            validatedAt: completionV2.validatedAt,
            revision: completionV2.revision,
            reviewReference: completionV2.reviewReference,
            evidence: completionV2.evidence,
          },
        }
      : {}),
  } as LeadBoardV1
}
