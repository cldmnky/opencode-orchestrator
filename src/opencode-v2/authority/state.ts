import { z } from "zod"
import { childContainmentDenyRules, type PermissionRule } from "../../core/permissions.js"
import { stableProjectID, withSessionLock, type LocationLike, type StorageLike } from "../goal/state.js"

/**
 * Durable effective-authority snapshots (Phase C / V4b).
 *
 * One bounded record per configured-role child session, written during that
 * child's own prompt admission AFTER the N2 containment rules were installed
 * (opt-in `authority.mode: "enforce"`; default off). A snapshot records the
 * three observable authority dimensions and their intersection per tracked
 * tool-action family:
 *
 * - `parent` — the delegating parent session's family-wide rules as observed
 *   at snapshot time (the host inherits them into the child at creation).
 * - `worker-policy` — the plugin's static per-role containment policy: the
 *   exact deny rules `childContainmentDenyRules()` installs for a
 *   configured-role child.
 * - `installed` — the child's own rule set read back after the install.
 *
 * Only family-wide rules (`resource: "*"`) participate; scoped-resource rules
 * are outside this family-level record. The intersection is the strictest
 * effect across the three dimensions (`unknown` if any dimension is unknown,
 * else `deny` > `ask` > `allow` > `unconstrained`).
 *
 * Honest boundaries:
 * - This is tool-action containment only. It is NOT filesystem, process,
 *   worktree, or atomic child isolation.
 * - Snapshots are records, never decisions: no admission, permission, gate,
 *   review, or publication path reads them. A missing, malformed, or
 *   unreadable record is always `unknown`, never assumed permissive.
 * - One current record per session keyed under the session's stable project;
 *   writes serialize through the existing process-local `withSessionLock`
 *   (no CAS, transactions, or cross-process guarantee).
 */

export const AUTHORITY_SNAPSHOT_VERSION = 1
export const AUTHORITY_SNAPSHOT_DIMENSIONS = ["parent", "worker-policy", "installed"] as const
export type AuthoritySnapshotDimension = (typeof AUTHORITY_SNAPSHOT_DIMENSIONS)[number]

export const AUTHORITY_SNAPSHOT_EFFECTS = ["allow", "ask", "deny", "unconstrained", "unknown"] as const
export type AuthoritySnapshotEffect = (typeof AUTHORITY_SNAPSHOT_EFFECTS)[number]

/** Bound for the tracked action entries (the containment family has eight). */
export const AUTHORITY_SNAPSHOT_MAX_ENTRIES = 32

/**
 * The tracked action families: exactly the actions the plugin's child
 * containment denies cover (orchestrator-only families plus the goal tools).
 * Deterministic order, deduplicated.
 */
export const AUTHORITY_SNAPSHOT_ACTIONS: readonly string[] = [
  ...new Set(childContainmentDenyRules().map((rule) => rule.action)),
]

const effectSchema = z.enum(AUTHORITY_SNAPSHOT_EFFECTS)

const authoritySnapshotEntrySchema = z
  .object({
    action: z.string().min(1).max(200),
    parent: effectSchema,
    workerPolicy: effectSchema,
    installed: effectSchema,
    effective: effectSchema,
  })
  .strict()

export const authoritySnapshotSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1).max(512),
    parentSessionID: z.string().min(1).max(512).optional(),
    roleAgent: z.string().min(1).max(200),
    capturedAt: z.number().int().nonnegative(),
    authorityMode: z.literal("enforce"),
    ruleScope: z.literal("family-wide"),
    entries: z.array(authoritySnapshotEntrySchema).min(1).max(AUTHORITY_SNAPSHOT_MAX_ENTRIES),
    unknownDimensions: z.array(z.enum(AUTHORITY_SNAPSHOT_DIMENSIONS)).max(AUTHORITY_SNAPSHOT_DIMENSIONS.length),
  })
  .strict()
export type AuthoritySnapshot = z.infer<typeof authoritySnapshotSchema>

export type AuthoritySnapshotInput = {
  sessionID: string
  parentSessionID?: string
  roleAgent: string
  capturedAt: number
  /** Undefined when the parent rule set could not be read. */
  parentRules?: readonly PermissionRule[]
  parentReadable: boolean
  /** Undefined when the child's post-install rule set could not be read. */
  installedRules?: readonly PermissionRule[]
  installedReadable: boolean
}

/** Storage key for the single bounded authority snapshot per session. */
export function authorityStorageKey(location: LocationLike, sessionID: string): string {
  return `authority/v1/${segment(location.project.id)}/${segment(sessionID)}`
}

/**
 * Family-wide effect for one action: the last matching `resource: "*"` rule
 * wins (host semantics); `unconstrained` means no family-wide rule exists.
 */
export function familyAuthorityEffect(
  rules: readonly PermissionRule[] | undefined,
  action: string,
): AuthoritySnapshotEffect {
  let effect: AuthoritySnapshotEffect = "unconstrained"
  if (!rules) return effect
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue
    if (rule.action !== action) continue
    if (rule.resource !== "*") continue
    if (rule.effect === "allow" || rule.effect === "ask" || rule.effect === "deny") effect = rule.effect
  }
  return effect
}

/**
 * Intersection of the three dimensions: the strictest effect applies. Any
 * unknown dimension makes the intersection unknown (fail-closed as a record
 * value; it never changes a decision).
 */
export function intersectAuthorityEffects(
  effects: readonly AuthoritySnapshotEffect[],
): AuthoritySnapshotEffect {
  if (effects.some((effect) => effect === "unknown")) return "unknown"
  if (effects.some((effect) => effect === "deny")) return "deny"
  if (effects.some((effect) => effect === "ask")) return "ask"
  if (effects.some((effect) => effect === "allow")) return "allow"
  return "unconstrained"
}

/**
 * Deterministic snapshot builder. Pure: no storage, no time, no session reads.
 * The caller supplies what it could read (`readable` flags keep unknown
 * explicit instead of guessing).
 */
export function buildAuthoritySnapshot(input: AuthoritySnapshotInput): AuthoritySnapshot {
  const workerPolicyRules = childContainmentDenyRules()
  const unknownDimensions: AuthoritySnapshotDimension[] = []
  if (!input.parentReadable) unknownDimensions.push("parent")
  if (!input.installedReadable) unknownDimensions.push("installed")

  const entries = AUTHORITY_SNAPSHOT_ACTIONS.map((action) => {
    const parent = input.parentReadable ? familyAuthorityEffect(input.parentRules, action) : "unknown"
    const workerPolicy = familyAuthorityEffect(workerPolicyRules, action)
    const installed = input.installedReadable ? familyAuthorityEffect(input.installedRules, action) : "unknown"
    return {
      action,
      parent,
      workerPolicy,
      installed,
      effective: intersectAuthorityEffects([parent, workerPolicy, installed]),
    }
  })

  return authoritySnapshotSchema.parse({
    version: AUTHORITY_SNAPSHOT_VERSION,
    sessionID: input.sessionID,
    ...(input.parentSessionID !== undefined ? { parentSessionID: input.parentSessionID } : {}),
    roleAgent: input.roleAgent,
    capturedAt: input.capturedAt,
    authorityMode: "enforce",
    ruleScope: "family-wide",
    entries,
    unknownDimensions,
  })
}

/** Strict, bounded entry: returns the parsed record or undefined for malformed/unknown data. */
export function parseAuthoritySnapshot(value: unknown): AuthoritySnapshot | undefined {
  const parsed = authoritySnapshotSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export type AuthoritySnapshotRead =
  | { state: "found"; snapshot: AuthoritySnapshot }
  | { state: "unknown"; reason: "missing" | "malformed" | "unreadable" }

/**
 * Read one snapshot. Missing, malformed, non-object, mismatched-session, or
 * unreadable records all resolve to `unknown` — never to a permissive or
 * restrictive assumption.
 */
export async function readAuthoritySnapshot(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
): Promise<AuthoritySnapshotRead> {
  let value: unknown
  try {
    const keyed = await keyedLocation(storage, location, sessionID)
    value = await storage.get(authorityStorageKey(keyed, sessionID))
  } catch {
    return { state: "unknown", reason: "unreadable" }
  }
  if (value === undefined || value === null) return { state: "unknown", reason: "missing" }
  const snapshot = parseAuthoritySnapshot(value)
  if (!snapshot || snapshot.sessionID !== sessionID) return { state: "unknown", reason: "malformed" }
  return { state: "found", snapshot }
}

/**
 * Write one snapshot under the existing process-local session lock. Callers
 * own failure handling: a snapshot write is never allowed to change an
 * admission decision.
 */
export async function writeAuthoritySnapshot(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  snapshot: AuthoritySnapshot,
): Promise<void> {
  await withSessionLock(location, sessionID, async () => {
    const keyed = await keyedLocation(storage, location, sessionID)
    await storage.set(authorityStorageKey(keyed, sessionID), snapshot)
  })
}

/**
 * Clear one snapshot under the same lock (runtime cleanup/exit). Removing a
 * missing record is a no-op; a cleared record reads as `unknown/missing`.
 */
export async function clearAuthoritySnapshot(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
): Promise<void> {
  await withSessionLock(location, sessionID, async () => {
    const keyed = await keyedLocation(storage, location, sessionID)
    await storage.remove(authorityStorageKey(keyed, sessionID))
  })
}

async function keyedLocation(storage: StorageLike, location: LocationLike, sessionID: string): Promise<LocationLike> {
  const projectID = await stableProjectID(storage, location, sessionID)
  return { ...location, project: { id: projectID } }
}

function segment(value: string): string {
  return encodeURIComponent(value)
}
