import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { z } from "zod"
import type { ModelReference } from "../../core/model-reference.js"
import type { ProcessRunner } from "../process/runner.js"
import type { StorageLike } from "../goal/state.js"

export type WorkerModelLocation = {
  directory: string
  project: { id: string }
}

export type WorkerModelOverrides = Map<string, ModelReference>

const modelReferenceSchema = z
  .object({
    providerID: z.string().trim().min(1),
    id: z.string().trim().min(1),
    variant: z.string().trim().min(1).optional(),
  })
  .strict()

const workerModelRecordSchema = z
  .object({
    version: z.literal(1),
    overrides: z.record(z.string().trim().min(1), modelReferenceSchema),
  })
  .strict()

export const WORKER_MODEL_STORAGE_PREFIX = "worker-models/v1/"

export function workerModelStorageKey(scope: string): string {
  return `${WORKER_MODEL_STORAGE_PREFIX}${encodeURIComponent(scope)}`
}

export function workerModelScopeKey(projectID: string, gitCommonDirectory?: string): string {
  if (gitCommonDirectory) {
    const digest = createHash("sha256").update(`git-common:${gitCommonDirectory}`).digest("hex")
    return `git-${digest}`
  }
  return `project-${encodeURIComponent(projectID)}`
}

export async function readWorkerModelOverrides(storage: StorageLike, key: string): Promise<WorkerModelOverrides> {
  const value = await storage.get(key)
  if (value === undefined) return new Map()
  const parsed = workerModelRecordSchema.safeParse(value)
  if (!parsed.success) {
    console.warn(`Ignoring malformed worker model state at ${key}`)
    return new Map()
  }
  return new Map(Object.entries(parsed.data.overrides).map(([agentID, model]) => [agentID, { ...model }]))
}

export async function writeWorkerModelOverrides(
  storage: StorageLike,
  key: string,
  overrides: ReadonlyMap<string, ModelReference>,
): Promise<void> {
  if (overrides.size === 0) {
    await storage.remove(key)
    return
  }
  const value = {
    version: 1 as const,
    overrides: Object.fromEntries([...overrides].map(([agentID, model]) => [agentID, { ...model }])),
  }
  const parsed = workerModelRecordSchema.parse(value)
  await storage.set(key, parsed)
}

/**
 * Resolve the shared Git common directory so linked worktrees use one model
 * override record. Only the hash derived from this path is persisted.
 */
export async function resolveGitCommonDirectory(
  runner: ProcessRunner,
  location: WorkerModelLocation,
): Promise<string | undefined> {
  try {
    const result = await runner.run("git", ["rev-parse", "--git-common-dir"], {
      cwd: location.directory,
      timeoutMs: 5_000,
    })
    if (result.exitCode !== 0) return undefined
    const raw = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim()
    if (!raw || raw.includes("\0")) return undefined
    const absolute = isAbsolute(raw) ? raw : resolve(location.directory, raw)
    try {
      return await realpath(absolute)
    } catch {
      return resolve(absolute)
    }
  } catch {
    return undefined
  }
}
