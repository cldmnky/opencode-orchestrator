import { z } from "zod"

export type GoalStatus = "active" | "paused" | "complete"

export type GoalRecord = {
  version: 1
  sessionID: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  continuationCount: number
  lastContinuationAt?: number
  completedAt?: number
  completionEvidence?: string
}

export type PlanRunStatus = "active" | "paused" | "complete"

export type PlanRunRecord = {
  version: 1
  sessionID: string
  plan?: string
  status: PlanRunStatus
  createdAt: number
  updatedAt: number
}

export type AutomationStop = {
  version: 1
  sessionID: string
  stoppedAt: number
}

export type StorageLike = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan?: (options: { prefix: string; after?: string; limit?: number }) => Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }>
}

export type LocationLike = {
  directory: string
  workspaceID?: string
  project: {
    id: string
  }
}

const goalSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1),
    objective: z.string().min(1),
    status: z.enum(["active", "paused", "complete"]),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    continuationCount: z.number().int().nonnegative(),
    lastContinuationAt: z.number().finite().optional(),
    completedAt: z.number().finite().optional(),
    completionEvidence: z.string().min(1).optional(),
  })
  .strict()

const planRunSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1),
    plan: z.string().min(1).optional(),
    status: z.enum(["active", "paused", "complete"]),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .strict()

const automationStopSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1),
    stoppedAt: z.number().finite(),
  })
  .strict()

export function goalStorageKey(location: LocationLike, sessionID: string): string {
  return `goal/v1/${segment(location.project.id)}/${segment(sessionID)}`
}

export function runStorageKey(location: LocationLike, sessionID: string): string {
  return `run/v1/${segment(location.project.id)}/${segment(sessionID)}`
}

export function stopStorageKey(location: LocationLike, sessionID: string): string {
  return `halt/v1/${segment(location.project.id)}/${segment(sessionID)}`
}

const sessionLocks = new Map<string, Promise<void>>()

export async function withSessionLock<T>(location: LocationLike, sessionID: string, action: () => Promise<T>): Promise<T> {
  const key = `${location.project.id}:${sessionID}`
  const previous = sessionLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  sessionLocks.set(key, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (sessionLocks.get(key) === tail) sessionLocks.delete(key)
  }
}

export async function readGoal(storage: StorageLike, key: string): Promise<GoalRecord | undefined> {
  return readVersioned(storage, key, goalSchema, "goal")
}

export async function readPlanRun(storage: StorageLike, key: string): Promise<PlanRunRecord | undefined> {
  return readVersioned(storage, key, planRunSchema, "plan run")
}

export async function readAutomationStop(storage: StorageLike, key: string): Promise<AutomationStop | undefined> {
  return readVersioned(storage, key, automationStopSchema, "halt")
}

export function newGoal(sessionID: string, objective: string, now = Date.now()): GoalRecord {
  return {
    version: 1,
    sessionID,
    objective: objective.trim(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    continuationCount: 0,
  }
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

async function readVersioned<T>(
  storage: StorageLike,
  key: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T | undefined> {
  const value = await storage.get(key)
  if (value === undefined) return undefined
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    console.warn(`Ignoring malformed ${label} state at ${key}`)
    return undefined
  }
  return parsed.data
}
