/**
 * Phase A runtime authority — opt-in N1 admission/permission enforcement plus
 * N2 child-only containment (`authority.mode: "enforce"`; default is `off`,
 * where this module is never started and no hook is registered).
 *
 * N1 prompt admission (plugin-owned dispatches only):
 *   - Plugin-created command and goal-continuation prompts carry a bounded,
 *     namespaced metadata marker (`opencode-orchestrator.authority`).
 *   - At admission time the prompt hook consults the shared dispatch gate
 *     (bounded-review breaker + stop-between-steps budget) for a tagged
 *     dispatch with the same check kind the pre-delivery gate uses
 *     (`command` for slash commands, `auto` for goal continuation).
 *   - A refusal fails closed: the hook throws a bounded truthful error before
 *     admission and never rewrites the prompt into a model-executable refusal.
 *     The pinned host wraps hook failures (`UnexpectedStatus`); the thrown
 *     message is bounded and truthful in the hook error itself.
 *   - Allowed dispatches append bounded authority metadata without replacing
 *     unrelated metadata keys.
 *   - Prompt hooks are NOT an exactly-once boundary (concurrent submissions
 *     can run hooks more than once). Every path here is idempotent: the gate
 *     is re-consulted, no counter is mutated, and the same metadata is
 *     recomputed.
 *
 * The two surfaces are independent, and the N1 boundary is marker-based:
 * untagged prompts (arbitrary user prompts and other plugins' dispatches)
 * never invoke N1 gate enforcement and never gain N1 metadata. In enforce mode
 * the same admission still reads session info (`session.get`) for N2 child
 * classification, and for a configured-role child it may append containment
 * rules; that classification is not an N1 inspection and never blocks a
 * parent or non-role child on its own.
 *
 * N1 permission enforcement (selected plugin-owned actions only):
 *   - `AUTHORITY_ENFORCED_PERMISSION_ACTIONS` selects the families; every
 *     other action (native tools included) is left untouched.
 *   - A gate refusal downgrades `allow`/`ask` to `deny` with a bounded
 *     truthful `message`.
 *   - An explicit configured `deny` is final: the pinned host does not invoke
 *     this hook for it, and the hook itself never rewrites an already-denied
 *     decision.
 *   - A gate-lookup failure for a selected action is a fail-closed deny with a
 *     bounded safe message.
 *
 * N2 containment (configured-role child sessions only):
 *   - A prompt is a child when the session carries a `parentID` AND its agent
 *     ID is one of the configured role agent IDs. Parent sessions and
 *     non-role children are never touched.
 *   - The child's existing rules are preserved verbatim; only missing exact
 *     deny rules for the full orchestrator-only tool family plus the goal
 *     tools are appended (deterministic order, no duplicate exact deny rules).
 *     Later admissions are idempotent: no rule is written again when the rules
 *     are already present (the snapshot record is refreshed instead).
 *   - Child lookup or rule installation failure fails closed before admission.
 *   - This is tool-action containment only — not filesystem, process,
 *     worktree, or atomic child isolation. No parent rule is ever installed or
 *     cleared, and there is no worktree lifecycle install/clear logic here.
 *
 * Durable effective-authority snapshots (Phase C):
 *   - After the containment rules are ensured for a configured-role child, the
 *     same admission records one bounded snapshot under `authority/v1/...`:
 *     parent rules, the plugin's static worker policy, the child's installed
 *     rules, and their per-action intersection with explicit unknown states.
 *   - Snapshot recording is best-effort and NEVER changes the admission
 *     decision: a failed read, write, or build is logged and admission
 *     proceeds. Nothing in the admission or permission path reads snapshots.
 *   - On runtime disposal (plugin teardown), every snapshot this runtime had
 *     recorded by disposal time is cleared under the same session lock, so no
 *     recorded authority outlives the process that enforced it. Clearing is
 *     best-effort and idempotent.
 */
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { SessionPrompt } from "@opencode/plugin/promise/session"
import type { OrchestratorOptions } from "../../core/config.js"
import {
  childContainmentDenyRules,
  isAuthorityEnforcedPermissionAction,
  type PermissionRule,
} from "../../core/permissions.js"
import { RUNTIME_PLUGIN_ID } from "../../core/package-identity.js"
import type { DispatchCheck, DispatchDecision, DispatchGate } from "../observability/runtime.js"
import type { LocationLike, StorageLike } from "../goal/state.js"
import { buildAuthoritySnapshot, clearAuthoritySnapshot, writeAuthoritySnapshot } from "./state.js"

/** Namespaced metadata key for the bounded authority dispatch marker. */
export const AUTHORITY_METADATA_KEY = "opencode-orchestrator.authority"
/** Marker schema version; an unknown version is not a recognized dispatch. */
export const AUTHORITY_METADATA_VERSION = 1
export const AUTHORITY_DISPATCH_KINDS = ["command", "continuation"] as const
export type AuthorityDispatchKind = (typeof AUTHORITY_DISPATCH_KINDS)[number]
/** Hard cap for any authority message surfaced to a hook error or denial. */
export const AUTHORITY_MESSAGE_MAX_LENGTH = 400

/** JSON-compatible metadata values (the prompt metadata schema is JSON). */
export type AuthorityMetadataValue =
  | null
  | boolean
  | number
  | string
  | AuthorityMetadataValue[]
  | { [key: string]: AuthorityMetadataValue }

export type AuthorityDispatchMarker = {
  version: 1
  dispatch: AuthorityDispatchKind
  /** Set only when this dispatch passed the admission-time gate check. */
  admitted?: true
}

export type AuthorityRegistration = { dispose(): Promise<void> }

/** The subset of `Session.Info` the containment classifier reads. */
export type AuthoritySessionInfo = {
  parentID?: string
  agent?: string
  permissions?: readonly PermissionRule[]
}

export type AuthorityDeps = {
  options: OrchestratorOptions
  gate: DispatchGate
  session: {
    get(input: { sessionID: string }): Promise<unknown>
    hook(name: "prompt", callback: (event: SessionPrompt) => Promise<void> | void): Promise<AuthorityRegistration>
  }
  permission: {
    hook(
      name: "evaluate",
      callback: (event: PermissionEvaluation) => Promise<void> | void,
    ): Promise<AuthorityRegistration>
    rules(input: { sessionID: string; permissions: readonly PermissionRule[] }): Promise<void>
  }
  /**
   * Durable sink for effective-authority snapshots (Phase C). When either is
   * absent, snapshots are not recorded: the runtime still enforces rules but
   * records nothing, and the read surface reports unknown.
   */
  storage?: StorageLike
  location?: LocationLike
}

export type AuthorityRuntime = { dispose(): Promise<void> }

export function shouldStartAuthority(options: OrchestratorOptions): boolean {
  return options.authority.mode === "enforce"
}

/** The configured role agent IDs that mark a child session as role-owned. */
export function authorityRoleAgentIDs(options: OrchestratorOptions): Set<string> {
  return new Set(Object.values(options.roles))
}

/**
 * Bounded marker for a plugin-created dispatch. The marker carries only the
 * schema version and the dispatch kind, so no prompt content, session data, or
 * user input travels through it.
 */
export function authorityDispatchMetadata(dispatch: AuthorityDispatchKind): { [key: string]: AuthorityMetadataValue } {
  return { [AUTHORITY_METADATA_KEY]: { version: AUTHORITY_METADATA_VERSION, dispatch } }
}

/**
 * Merge the dispatch marker into caller metadata without dropping unrelated
 * keys. Only the namespaced authority key is replaced.
 */
export function withAuthorityDispatchMetadata(
  metadata: Readonly<Record<string, AuthorityMetadataValue>> | undefined,
  dispatch: AuthorityDispatchKind,
): { [key: string]: AuthorityMetadataValue } {
  return { ...(metadata ?? {}), ...authorityDispatchMetadata(dispatch) }
}

/**
 * Parse the bounded marker from prompt metadata. Malformed or unknown-version
 * markers are not tagged dispatches: the queue/metadata is untrusted input and
 * only the exact plugin-written shape enables enforcement.
 */
export function parseAuthorityDispatchMarker(metadata: unknown): AuthorityDispatchMarker | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
  const marker = (metadata as Record<string, unknown>)[AUTHORITY_METADATA_KEY]
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return undefined
  const record = marker as Record<string, unknown>
  if (record.version !== AUTHORITY_METADATA_VERSION) return undefined
  if (record.dispatch !== "command" && record.dispatch !== "continuation") return undefined
  return { version: 1, dispatch: record.dispatch, ...(record.admitted === true ? { admitted: true as const } : {}) }
}

/**
 * Append the admission marker for an allowed tagged dispatch, preserving every
 * unrelated metadata key (and any unrelated value under other keys).
 */
export function withAuthorityAdmissionMetadata(metadata: unknown, marker: AuthorityDispatchMarker): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {}
  return {
    ...base,
    [AUTHORITY_METADATA_KEY]: {
      version: AUTHORITY_METADATA_VERSION,
      dispatch: marker.dispatch,
      admitted: true,
    },
  }
}

/** Exact rule identity used for duplicate detection (no resource globbing). */
export function exactRuleKey(rule: PermissionRule): string {
  return `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`
}

/**
 * Preserve `existing` rules and append only the exact deny rules that are not
 * already present. Deterministic: `denies` order is preserved and a second
 * merge over its own output adds nothing.
 */
export function mergeContainmentRules(
  existing: readonly PermissionRule[],
  denies: readonly PermissionRule[] = childContainmentDenyRules(),
): { permissions: PermissionRule[]; added: PermissionRule[] } {
  const present = new Set(existing.map((rule) => exactRuleKey(rule)))
  const added = denies.filter((rule) => !present.has(exactRuleKey(rule)))
  return { permissions: [...existing, ...added], added }
}

/**
 * A child session is role-owned only when it has a parent AND its agent ID is a
 * configured role agent. Root sessions, the orchestrator itself, and arbitrary
 * non-role children never qualify.
 */
export function classifyConfiguredRoleChild(
  session: AuthoritySessionInfo | undefined,
  roleAgentIDs: ReadonlySet<string>,
): string | undefined {
  if (!session) return undefined
  if (typeof session.parentID !== "string" || session.parentID.length === 0) return undefined
  if (typeof session.agent !== "string" || !roleAgentIDs.has(session.agent)) return undefined
  return session.agent
}

/** Bounded, single-line, truthful authority message (never a raw payload). */
export function boundedAuthorityMessage(prefix: string, reason: string | undefined): string {
  const detail = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : ""
  const message = detail ? `${prefix}: ${detail}` : prefix
  if (message.length <= AUTHORITY_MESSAGE_MAX_LENGTH) return message
  return `${message.slice(0, AUTHORITY_MESSAGE_MAX_LENGTH - 1)}…`
}

/**
 * Start the opt-in runtime authority hooks. The returned runtime owns exactly
 * the two registrations it created and disposes both exactly once (evaluate
 * registration first, then prompt registration); concurrent and repeated
 * dispose calls await the same disposal promise and never dispose a
 * registration again. A partial registration failure cleans up what it did
 * register before rethrowing.
 */
export async function startAuthority(deps: AuthorityDeps): Promise<AuthorityRuntime> {
  const registrations: AuthorityRegistration[] = []
  // Sessions whose snapshots this runtime wrote; cleared on dispose so no
  // authority record outlives the enforcing process.
  const recordedSnapshotSessions = new Set<string>()
  try {
    registrations.push(await deps.session.hook("prompt", (event) => onPrompt(event)))
    registrations.push(await deps.permission.hook("evaluate", (event) => onEvaluate(event)))
  } catch (error) {
    for (const registration of [...registrations].reverse()) await registration.dispose()
    throw error
  }

  // Idempotent disposal: the first call starts the reverse-order disposal and
  // every later or concurrent call shares that same promise instead of
  // re-disposing a registration. A failed disposal is shared too; it is never
  // silently retried.
  let closing: Promise<void> | undefined
  return {
    dispose(): Promise<void> {
      closing ??= (async () => {
        for (const registration of [...registrations].reverse()) await registration.dispose()
        await clearRecordedSnapshots()
      })()
      return closing
    },
  }

  async function onPrompt(event: SessionPrompt): Promise<void> {
    const marker = parseAuthorityDispatchMarker(event.metadata)
    if (marker) {
      const check: DispatchCheck = marker.dispatch === "command" ? "command" : "auto"
      const decision = await dispatchDecision(event.sessionID, check)
      if (!decision.allow) {
        throw new Error(
          boundedAuthorityMessage(
            `${RUNTIME_PLUGIN_ID} authority blocked this ${marker.dispatch} dispatch before admission`,
            decision.reason,
          ),
        )
      }
      event.metadata = withAuthorityAdmissionMetadata(event.metadata, marker)
    }

    const child = await configuredRoleChild(event.sessionID)
    if (!child) return
    const merged = mergeContainmentRules(child.permissions ?? [])
    if (merged.added.length > 0) {
      try {
        await deps.permission.rules({ sessionID: event.sessionID, permissions: merged.permissions })
      } catch (error) {
        throw new Error(
          boundedAuthorityMessage(
            `${RUNTIME_PLUGIN_ID} authority could not install child containment rules for session ${event.sessionID}`,
            `the rule installation failed and this admission fails closed: ${errorMessage(error)}`,
          ),
        )
      }
    }
    // After the rules are ensured, record the effective-authority snapshot.
    // Best-effort: it never gates and never changes this admission.
    await recordAuthoritySnapshot(event.sessionID, child)
  }

  async function onEvaluate(event: PermissionEvaluation): Promise<void> {
    if (!isAuthorityEnforcedPermissionAction(event.action)) return
    // An explicit configured deny is final. The pinned host does not invoke
    // this hook for it (verified in the phase-a contract suite); this guard
    // keeps the invariant if a future host routes it here.
    if (event.effect === "deny") return
    // The permission layer applies the same `auto` dispatch-gate decision the
    // goal-continuation path uses: the bounded-review breaker and the
    // stop-between-steps budget both participate. Command dispatches are
    // already checked before delivery.
    const decision = await dispatchDecision(event.sessionID, "auto")
    if (decision.allow) return
    event.effect = "deny"
    event.message = boundedAuthorityMessage(`${RUNTIME_PLUGIN_ID} authority denied ${event.action}`, decision.reason)
  }

  /**
   * Resolve the owning session of a prompt and return it only when it is a
   * configured-role child. A failed or unreadable lookup fails closed: the
   * runtime cannot prove the session is not a role child, so admission is
   * blocked instead of silently skipping containment.
   */
  async function configuredRoleChild(sessionID: string): Promise<AuthoritySessionInfo | undefined> {
    const roleAgentIDs = authorityRoleAgentIDs(deps.options)
    if (roleAgentIDs.size === 0) return undefined
    let value: unknown
    try {
      value = await deps.session.get({ sessionID })
    } catch (error) {
      throw new Error(
        boundedAuthorityMessage(
          `${RUNTIME_PLUGIN_ID} authority could not read session ${sessionID} before admission`,
          `the child classification lookup failed: ${errorMessage(error)}`,
        ),
      )
    }
    const session = unwrapSessionInfo(value)
    if (!session) {
      throw new Error(
        boundedAuthorityMessage(
          `${RUNTIME_PLUGIN_ID} authority could not classify session ${sessionID} before admission`,
          "the session lookup returned no readable session; this admission fails closed",
        ),
      )
    }
    return classifyConfiguredRoleChild(session, roleAgentIDs) ? session : undefined
  }

  /**
   * Record one bounded effective-authority snapshot for a configured-role
   * child AFTER its containment rules were ensured. Best-effort by design:
   * missing storage wiring skips recording, and any build/read/write failure
   * is logged and swallowed so it can never change the admission decision.
   */
  async function recordAuthoritySnapshot(sessionID: string, child: AuthoritySessionInfo): Promise<void> {
    if (!deps.storage || !deps.location) return
    const storage = deps.storage
    const location = deps.location
    try {
      const parentRead = child.parentID ? await readRules(child.parentID) : { readable: false }
      const installedRead = await readRules(sessionID)
      const snapshot = buildAuthoritySnapshot({
        sessionID,
        ...(child.parentID !== undefined ? { parentSessionID: child.parentID } : {}),
        roleAgent: child.agent ?? "unknown",
        capturedAt: Date.now(),
        parentRules: parentRead.rules,
        parentReadable: parentRead.readable,
        installedRules: installedRead.rules,
        installedReadable: installedRead.readable,
      })
      await writeAuthoritySnapshot(storage, location, sessionID, snapshot)
      recordedSnapshotSessions.add(sessionID)
    } catch (error) {
      console.warn(
        `${RUNTIME_PLUGIN_ID} authority could not record the effective-authority snapshot for session ${sessionID}`,
        error,
      )
    }
  }

  /** Read a session's family-wide rules; unreadable and unclassified are distinct. */
  async function readRules(
    sessionID: string,
  ): Promise<{ readable: boolean; rules?: readonly PermissionRule[] }> {
    try {
      const session = unwrapSessionInfo(await deps.session.get({ sessionID }))
      if (!session) return { readable: false }
      return { readable: true, rules: session.permissions ?? [] }
    } catch {
      return { readable: false }
    }
  }

  /** Clear every snapshot this runtime wrote; best-effort and idempotent. */
  async function clearRecordedSnapshots(): Promise<void> {
    if (!deps.storage || !deps.location) return
    const storage = deps.storage
    const location = deps.location
    for (const sessionID of recordedSnapshotSessions) {
      try {
        await clearAuthoritySnapshot(storage, location, sessionID)
      } catch (error) {
        console.warn(`${RUNTIME_PLUGIN_ID} authority could not clear the snapshot for session ${sessionID}`, error)
      }
    }
    recordedSnapshotSessions.clear()
  }

  /** A gate refusal, or a gate failure folded to a fail-closed refusal. */
  async function dispatchDecision(
    sessionID: string,
    check: DispatchCheck,
  ): Promise<{ allow: true } | { allow: false; reason: string }> {
    let decision: DispatchDecision
    try {
      decision = await deps.gate.allowDispatch(sessionID, check)
    } catch (error) {
      return {
        allow: false,
        reason: `the control check is unavailable and this dispatch fails closed: ${errorMessage(error)}`,
      }
    }
    if (decision.allow) return { allow: true }
    return { allow: false, reason: decision.reason?.trim() || "the configured controls refused this dispatch" }
  }
}

function unwrapSessionInfo(value: unknown): AuthoritySessionInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const source =
    "data" in value && (value as { data?: unknown }).data && typeof (value as { data?: unknown }).data === "object"
      ? (value as { data: unknown }).data
      : value
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined
  const session = source as { id?: unknown; parentID?: unknown; agent?: unknown; permissions?: unknown }
  // A readable session always carries an id. Without one the lookup cannot be
  // trusted, so the caller fails closed instead of skipping containment.
  if (typeof session.id !== "string" || session.id.length === 0) return undefined
  return {
    ...(typeof session.parentID === "string" ? { parentID: session.parentID } : {}),
    ...(typeof session.agent === "string" ? { agent: session.agent } : {}),
    ...(Array.isArray(session.permissions) ? { permissions: session.permissions as PermissionRule[] } : {}),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
