import { z } from "zod"
import type { OrchestratorOptions } from "../../core/config.js"
import { stableProjectID, type LocationLike, type StorageLike } from "../goal/state.js"
import { readPublishRecord, type PublishCapability } from "../publish/state.js"

export type { LocationLike, StorageLike } from "../goal/state.js"

/**
 * Per-session orchestrator gates (foundation).
 *
 * The durable project publication capability and the static config switches
 * (`github.allow_mutations`, `worktree.allow_mutations`) are the *ceiling*:
 * they decide whether a step is possible at all. A session record can only
 * NARROW that ceiling — it lists the gates the user explicitly turned off for
 * one orchestrator session, typically through `/gates` or the TUI gate picker.
 * It can never widen: a gate whose ceiling is off stays off no matter what the
 * session record says.
 *
 * Session records are keyed by session ID only (`gates/v1/<sessionID>`) so the
 * choice follows the session across worktree moves, exactly like the session
 * itself. An absent record means "follow the project ceiling" for every gate.
 */

/** Publish capabilities that are also per-session gates, in publication order. */
export const CAPABILITY_GATES = [
  "push",
  "pr-draft-create",
  "pr-ready-transition",
  "approve-after-review",
  "merge",
] as const satisfies readonly PublishCapability[]

export const SESSION_GATES = [...CAPABILITY_GATES, "github-mutations", "worktree-mutations"] as const
export type SessionGate = (typeof SESSION_GATES)[number]

export type GatesRecord = {
  version: 1
  sessionID: string
  /** Gates explicitly turned off for this session; everything else follows the ceiling. */
  disabled: SessionGate[]
  updatedAt: number
}

export type GateCeilingSource = "project" | "config"

/** One gate's resolved state for a session. */
export type GateStatus = {
  gate: SessionGate
  /** Effective for this session: the ceiling allows it and the session did not turn it off. */
  enabled: boolean
  /** True when the project/config ceiling allows the gate before the session narrowing. */
  ceiling: boolean
  /** Where the ceiling comes from: the durable project capability or the static config. */
  ceilingSource: GateCeilingSource
  /** True when this session record explicitly turned the gate off. */
  sessionDisabled: boolean
  /** Human-readable reason the ceiling is off; absent when the ceiling allows the gate. */
  ceilingReason?: string
  /** Stable project the durable capability was resolved for (publish gates only). */
  projectID?: string
}

export const gatesSchema = z
  .object({
    version: z.literal(1),
    sessionID: z.string().min(1),
    disabled: z.array(z.enum(SESSION_GATES)),
    updatedAt: z.number().finite(),
  })
  .strict()

/** Durable per-session key for the gate narrowing record. */
export function gatesStorageKey(sessionID: string): string {
  return `gates/v1/${encodeURIComponent(sessionID)}`
}

export function isSessionGate(value: string): value is SessionGate {
  return (SESSION_GATES as readonly string[]).includes(value)
}

/**
 * Reads the per-session gate record. An absent record means "follow the
 * ceiling" for every gate; a malformed record is ignored with a warning and
 * counts as absent, never guessed from.
 */
export async function readGates(storage: StorageLike, sessionID: string): Promise<GatesRecord | undefined> {
  const value = await storage.get(gatesStorageKey(sessionID))
  if (value === undefined) return undefined
  const parsed = gatesSchema.safeParse(value)
  if (!parsed.success) {
    console.warn(`Ignoring malformed session gate state at ${gatesStorageKey(sessionID)}`)
    return undefined
  }
  return parsed.data
}

/**
 * Turns one gate off or back on for a session. Enabling removes the narrowing
 * entry (follow the ceiling); disabling adds it. Idempotent: when the record
 * already carries the requested state, nothing is written and the existing (or
 * canonical empty) record is returned. The disabled list is kept sorted.
 */
export async function setGateDisabled(
  storage: StorageLike,
  sessionID: string,
  gate: SessionGate,
  disabled: boolean,
  now = Date.now(),
): Promise<GatesRecord> {
  const current = await readGates(storage, sessionID)
  const next = new Set(current?.disabled ?? [])
  if (next.has(gate) === disabled) {
    return current ?? { version: 1, sessionID, disabled: [], updatedAt: now }
  }
  if (disabled) next.add(gate)
  else next.delete(gate)
  const record: GatesRecord = {
    version: 1,
    sessionID,
    disabled: [...next].sort(),
    updatedAt: now,
  }
  await storage.set(gatesStorageKey(sessionID), record)
  return record
}

/** Clears every session narrowing: all gates follow the project ceiling again. */
export async function clearGates(storage: StorageLike, sessionID: string): Promise<void> {
  await storage.remove(gatesStorageKey(sessionID))
}

/**
 * Resolves every gate for one session: the ceiling (durable project capability
 * or static config) combined with the session's narrowing record. Never
 * mutates anything.
 */
export async function gateStatuses(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  options: OrchestratorOptions,
): Promise<GateStatus[]> {
  const record = await readGates(storage, sessionID)
  const disabled = new Set<SessionGate>(record?.disabled ?? [])
  const projectID = await stableProjectID(storage, location, sessionID)
  const publish = await readPublishRecord(storage, projectID)
  const capabilities = new Set<PublishCapability>(publish?.enabled === true ? publish.capabilities : [])

  return SESSION_GATES.map((gate) => {
    const capabilityGate = (CAPABILITY_GATES as readonly string[]).includes(gate)
    const ceiling = capabilityGate ? capabilities.has(gate as PublishCapability) : mutationCeiling(gate, options)
    const ceilingReason = ceiling ? undefined : capabilityGate ? publishCeilingReason(publish) : mutationCeilingReason(gate, options)
    return {
      gate,
      enabled: ceiling && !disabled.has(gate),
      ceiling,
      ceilingSource: capabilityGate ? "project" : "config",
      sessionDisabled: disabled.has(gate),
      ...(ceilingReason !== undefined ? { ceilingReason } : {}),
      ...(capabilityGate ? { projectID } : {}),
    }
  })
}

/** Resolves one gate for one session. */
export async function gateStatus(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  options: OrchestratorOptions,
  gate: SessionGate,
): Promise<GateStatus> {
  const statuses = await gateStatuses(storage, location, sessionID, options)
  const match = statuses.find((status) => status.gate === gate)
  if (!match) throw new Error(`unknown session gate: ${gate}`)
  return match
}

/**
 * Safe check for tool guards: answers whether one gate is effective for the
 * session and, when it is not, a truthful reason distinguishing a session
 * narrowing from a disabled ceiling.
 */
export async function requireGateEnabled(
  storage: StorageLike,
  location: LocationLike,
  sessionID: string,
  options: OrchestratorOptions,
  gate: SessionGate,
): Promise<{ ok: true; status: GateStatus } | { ok: false; status: GateStatus; message: string }> {
  const status = await gateStatus(storage, location, sessionID, options, gate)
  if (status.enabled) return { ok: true, status }
  if (status.sessionDisabled) {
    return {
      ok: false,
      status,
      message: `'${gate}' is disabled for this session; re-enable it with /gates ${gate}=on or the TUI gate picker`,
    }
  }
  if (status.ceilingSource === "project") {
    return {
      ok: false,
      status,
      message: `publication capability '${gate}' is not authorized for project ${status.projectID ?? "unknown"}; enable it with /publish enable`,
    }
  }
  return {
    ok: false,
    status,
    message: `'${gate}' is unavailable: ${status.ceilingReason ?? "the project ceiling is off"}`,
  }
}

/**
 * Human-readable confirmation for a session gate change. Clearing a narrowing
 * can never widen the effective state (the ceiling still governs), so when the
 * ceiling is off the message says the gate follows the ceiling and names why
 * the ceiling is unavailable instead of pretending the gate is on.
 */
export function gateChangeMessage(status: GateStatus): string {
  if (status.sessionDisabled) return `'${status.gate}' is now off for this session`
  if (status.ceiling) return `'${status.gate}' is now on for this session`
  return `'${status.gate}' now follows the project ceiling (currently unavailable: ${status.ceilingReason ?? "the ceiling is off"})`
}

function mutationCeiling(gate: SessionGate, options: OrchestratorOptions): boolean {
  if (gate === "github-mutations") return options.github.enabled && options.github.allow_mutations
  if (gate === "worktree-mutations") return options.worktree.enabled && options.worktree.allow_mutations
  return false
}

function mutationCeilingReason(gate: SessionGate, options: OrchestratorOptions): string {
  if (gate === "github-mutations") {
    if (!options.github.enabled) return "github.enabled is off"
    return "github.allow_mutations is off"
  }
  if (gate === "worktree-mutations") {
    if (!options.worktree.enabled) return "worktree.enabled is off"
    return "worktree.allow_mutations is off"
  }
  return "the ceiling is off"
}

function publishCeilingReason(publish: { enabled: boolean } | undefined): string {
  if (!publish || !publish.enabled) {
    return "the durable project publication capability is off; enable it with /publish enable"
  }
  return "the durable project capability set does not include this step"
}
