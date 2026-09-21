import { z } from "zod"
import type { OrchestratorOptions } from "../../core/config.js"
import { stableProjectID, type LocationLike, type StorageLike } from "../goal/state.js"

export type { LocationLike, StorageLike } from "../goal/state.js"

/**
 * Durable publication authorization state (foundation stage).
 *
 * The publication capability is *authorization policy*, not authenticated
 * proof: the durable record records that the project-scoped capability is
 * enabled or disabled and what it authorizes, but nothing about it proves
 * which human (if any) invoked `/publish`. It never mutates Git or GitHub
 * itself, and it never weakens the static `github.enabled` /
 * `github.allow_mutations` / `worktree.enabled` / `worktree.allow_mutations`
 * gates — issue creation and PR merge remain outside this capability by
 * definition (see `PUBLISH_NEVER_AUTHORIZED`).
 *
 * Key namespace: `publish/v1/<projectID>` — one record per stable project
 * (resolved through the session anchor, exactly like goal/run/halt records),
 * so the authorization follows the repository across session moves.
 *
 * This module is free of filesystem/process/git calls: it only reads and
 * writes durable storage through a storage-like interface.
 */

/**
 * The precise autonomous steps enabling the capability authorizes. Nothing
 * is added here without a deliberate change to this constant set: enabling
 * grants exactly these capabilities, disabling revokes all of them.
 *
 * `merge` is included: once the capability is enabled, a PR this orchestrator
 * drove through the exact-revision review chain may be merged autonomously
 * after every merge precondition passes. Issue creation remains outside the
 * capability set by definition (see `PUBLISH_NEVER_AUTHORIZED`).
 */
export const PUBLISH_CAPABILITIES = [
  "push",
  "pr-draft-create",
  "pr-ready-transition",
  "approve-after-review",
  "merge",
] as const
export type PublishCapability = (typeof PUBLISH_CAPABILITIES)[number]

/** Fixed policy statement: what the capability can never authorize. */
export const PUBLISH_NEVER_AUTHORIZED = ["issue creation"]

export type PublishRecord = {
  version: 1
  /** Stable project (origin) the authorization is scoped to. */
  projectID: string
  enabled: boolean
  /** Exact capability set granted while enabled (empty when disabled). */
  capabilities: PublishCapability[]
  updatedAt: number
  /** Session that last toggled the record (bookkeeping only, never identity proof). */
  updatedBy: string
}

export type PublishToggleResult = {
  /** False when the durable record already carries the requested state. */
  changed: boolean
  record: PublishRecord
}

export type PublicationStatusView = {
  version: 1
  projectID: string
  durable: {
    enabled: boolean
    capabilities: readonly PublishCapability[]
    updatedAt?: number
    updatedBy?: string
  }
  config: {
    /** The `publish.enabled` master switch from plugin options. */
    enabled: boolean
  }
  staticGates: {
    githubEnabled: boolean
    githubAllowMutations: boolean
    worktreeEnabled: boolean
    worktreeAllowMutations: boolean
  }
}

const publishSchema = z
  .object({
    version: z.literal(1),
    projectID: z.string().min(1),
    enabled: z.boolean(),
    capabilities: z.array(z.enum(PUBLISH_CAPABILITIES)),
    updatedAt: z.number().finite(),
    updatedBy: z.string().min(1),
  })
  .strict()

/** Durable project-scoped key for the publication authorization record. */
export function publishStorageKey(projectID: string): string {
  return `publish/v1/${segment(projectID)}`
}

/**
 * Reads the durable publication record for a project. An absent record
 * means "disabled" (callers must treat undefined exactly like a disabled
 * record); a malformed record is ignored with a warning and counts as
 * disabled, never guessed from.
 *
 * A record written by an older plugin generation may carry a smaller
 * capability set (for example, before `merge` existed). An ENABLED record is
 * normalized to the current capability set on read: enabling authorizes the
 * capability family as it exists for the running plugin, so the durable grant
 * does not silently lose a new step. The narrowing that matters — a session
 * gate or an explicit `/publish disable` — is unaffected.
 */
export async function readPublishRecord(storage: StorageLike, projectID: string): Promise<PublishRecord | undefined> {
  const value = await storage.get(publishStorageKey(projectID))
  if (value === undefined) return undefined
  const parsed = publishSchema.safeParse(value)
  if (!parsed.success) {
    console.warn(`Ignoring malformed publish state at ${publishStorageKey(projectID)}`)
    return undefined
  }
  if (parsed.data.enabled && PUBLISH_CAPABILITIES.some((capability) => !parsed.data.capabilities.includes(capability))) {
    return { ...parsed.data, capabilities: [...PUBLISH_CAPABILITIES] }
  }
  return parsed.data
}

/**
 * Sets the durable project-scoped authorization through the session's
 * stable project identity. Idempotent: when the stored record already
 * carries the requested state, nothing is written and `changed` is false.
 * A malformed prior record is overwritten by the fresh authoritative write.
 */
export async function setPublicationEnabled(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  enabled: boolean,
  now = Date.now(),
): Promise<PublishToggleResult> {
  const projectID = await stableProjectID(storage, location, sessionID)
  const current = await readPublishRecord(storage, projectID)
  if (current?.enabled === enabled) {
    return { changed: false, record: current }
  }
  const record: PublishRecord = {
    version: 1,
    projectID,
    enabled,
    capabilities: enabled ? [...PUBLISH_CAPABILITIES] : [],
    updatedAt: now,
    updatedBy: sessionID,
  }
  await storage.set(publishStorageKey(projectID), record)
  return { changed: true, record }
}

/**
 * Safe read helper for later worktree/GitHub tools: answers whether one
 * specific publication capability is currently authorized for the session's
 * stable project. Returns the resolved project ID alongside the verdict so
 * callers can attribute the decision. Never mutates anything.
 */
export async function isPublishCapabilityAuthorized(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  capability: PublishCapability,
): Promise<{ projectID: string; authorized: boolean }> {
  const projectID = await stableProjectID(storage, location, sessionID)
  const record = await readPublishRecord(storage, projectID)
  const authorized = record?.enabled === true && record.capabilities.includes(capability)
  return { projectID, authorized }
}

/**
 * Builds the full status view used by `/publish status` and
 * `orchestrator_publish_policy_get`: the durable record (or the canonical
 * disabled default when absent), the config master switch, and the
 * unchanged static gates.
 */
export async function publicationStatus(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  options: OrchestratorOptions,
): Promise<PublicationStatusView> {
  const projectID = await stableProjectID(storage, location, sessionID)
  const record = await readPublishRecord(storage, projectID)
  return {
    version: 1,
    projectID,
    durable: {
      enabled: record?.enabled ?? false,
      capabilities: record?.capabilities ?? [],
      ...(record?.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
      ...(record?.updatedBy !== undefined ? { updatedBy: record.updatedBy } : {}),
    },
    config: { enabled: options.publish.enabled },
    staticGates: {
      githubEnabled: options.github.enabled,
      githubAllowMutations: options.github.allow_mutations,
      worktreeEnabled: options.worktree.enabled,
      worktreeAllowMutations: options.worktree.allow_mutations,
    },
  }
}

function segment(value: string): string {
  return encodeURIComponent(value)
}
