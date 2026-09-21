import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import {
  AUTHORITY_ENFORCED_PERMISSION_ACTIONS,
  GATES_TOOL_PERMISSION,
  GH_TOOL_PERMISSION,
  GOAL_TOOL_PERMISSION,
  OBSERVABILITY_TOOL_PERMISSION,
  ORCHESTRATION_TOOL_PERMISSION,
  PEER_TOOL_PERMISSION,
  PUBLISH_TOOL_PERMISSION,
  WORKTREE_TOOL_PERMISSION,
  childContainmentDenyRules,
  isAuthorityEnforcedPermissionAction,
  orchestratorOnlyPermissionRules,
  type PermissionRule,
} from "../../src/core/permissions.js"
import {
  AUTHORITY_METADATA_KEY,
  AUTHORITY_MESSAGE_MAX_LENGTH,
  authorityDispatchMetadata,
  authorityRoleAgentIDs,
  boundedAuthorityMessage,
  classifyConfiguredRoleChild,
  exactRuleKey,
  mergeContainmentRules,
  parseAuthorityDispatchMarker,
  shouldStartAuthority,
  startAuthority,
  withAuthorityAdmissionMetadata,
  withAuthorityDispatchMetadata,
  type AuthorityDeps,
} from "../../src/opencode-v2/authority/runtime.js"
import {
  AUTHORITY_SNAPSHOT_ACTIONS,
  AUTHORITY_SNAPSHOT_VERSION,
  authoritySnapshotSchema,
  authorityStorageKey,
  buildAuthoritySnapshot,
  clearAuthoritySnapshot,
  familyAuthorityEffect,
  intersectAuthorityEffects,
  parseAuthoritySnapshot,
  readAuthoritySnapshot,
  writeAuthoritySnapshot,
} from "../../src/opencode-v2/authority/state.js"
import {
  AUTHORITY_TOOL_LIMITATIONS,
  addAuthorityTools,
  type AuthorityToolsDeps,
} from "../../src/opencode-v2/authority/tools.js"
import type { LocationLike, StorageLike } from "../../src/opencode-v2/goal/state.js"
import type { DispatchCheck, DispatchDecision } from "../../src/opencode-v2/observability/runtime.js"

const LOCATION: LocationLike = { directory: "/workspace", project: { id: "project" } }
const GATE_REFUSAL = "budget exceeded: limit max_tokens is exceeded (observed unknown); stop-between-steps fails closed"

function memStorage(overrides: { getFailure?: Error; setFailure?: Error; removeFailure?: Error } = {}) {
  const values = new Map<string, unknown>()
  const storage: StorageLike & { values: Map<string, unknown> } = {
    values,
    get: async (key) => {
      if (overrides.getFailure) throw overrides.getFailure
      return values.get(key)
    },
    set: async (key, value) => {
      if (overrides.setFailure) throw overrides.setFailure
      values.set(key, value)
    },
    remove: async (key) => {
      if (overrides.removeFailure) throw overrides.removeFailure
      values.delete(key)
    },
  }
  return storage
}

function allowDecision(): DispatchDecision {
  return { allow: true, evaluation: { version: 1, mode: "advisory", verdict: "within", limits: [] } }
}

function refuseDecision(reason = GATE_REFUSAL): DispatchDecision {
  return { allow: false, reason, evaluation: { version: 1, mode: "stop-between-steps", verdict: "exceeded", limits: [] } }
}

type HarnessOverrides = {
  options?: Record<string, unknown>
  allowDispatch?: (sessionID: string, check: DispatchCheck) => Promise<DispatchDecision>
  sessions?: Record<string, unknown | Error>
  rulesFailure?: Error
  /** Full session lookup override, called with the 1-based call count per session. */
  sessionGet?: (sessionID: string, call: number) => unknown
  storage?: StorageLike
  location?: LocationLike
}

function createHarness(overrides: HarnessOverrides = {}) {
  const state = {
    promptHook: undefined as ((event: any) => Promise<void> | void) | undefined,
    evaluateHook: undefined as ((event: any) => Promise<void> | void) | undefined,
    gateCalls: [] as Array<{ sessionID: string; check: DispatchCheck }>,
    rulesCalls: [] as Array<{ sessionID: string; permissions: readonly PermissionRule[] }>,
    sessionGets: [] as string[],
    disposed: [] as string[],
  }
  const getCalls = new Map<string, number>()
  const deps = {
    options: parseOptions(overrides.options ?? { authority: { mode: "enforce" } }),
    gate: {
      async allowDispatch(sessionID: string, check: DispatchCheck): Promise<DispatchDecision> {
        state.gateCalls.push({ sessionID, check })
        return overrides.allowDispatch ? overrides.allowDispatch(sessionID, check) : allowDecision()
      },
    },
    session: {
      async get({ sessionID }: { sessionID: string }): Promise<unknown> {
        state.sessionGets.push(sessionID)
        const call = (getCalls.get(sessionID) ?? 0) + 1
        getCalls.set(sessionID, call)
        if (overrides.sessionGet) {
          const value = overrides.sessionGet(sessionID, call)
          if (value instanceof Error) throw value
          return value
        }
        const value = overrides.sessions?.[sessionID]
        if (value instanceof Error) throw value
        return value
      },
      async update(input: { sessionID: string; permissions: readonly PermissionRule[] }) {
        if (overrides.rulesFailure) throw overrides.rulesFailure
        state.rulesCalls.push(input)
        // Model the host: a session permission update is observable on the
        // session immediately after the call.
        const session = overrides.sessions?.[input.sessionID]
        if (session && typeof session === "object") {
          ;(session as { permissions?: readonly PermissionRule[] }).permissions = [...input.permissions]
        }
      },
      async hook(name: string, callback: (event: any) => Promise<void> | void) {
        state.promptHook = callback
        return { dispose: async () => void state.disposed.push(`prompt:${name}`) }
      },
    },
    permission: {
      async hook(name: string, callback: (event: any) => Promise<void> | void) {
        state.evaluateHook = callback
        return { dispose: async () => void state.disposed.push(`evaluate:${name}`) }
      },
    },
    ...(overrides.storage ? { storage: overrides.storage } : {}),
    ...(overrides.location ? { location: overrides.location } : {}),
  } as unknown as AuthorityDeps
  return { deps, state }
}

function promptEvent(overrides: { sessionID?: string; metadata?: Record<string, unknown> } = {}) {
  return {
    sessionID: overrides.sessionID ?? "ses_parent",
    messageID: "msg_phase_a",
    prompt: { text: "phase-a prompt" },
    metadata: overrides.metadata,
    delivery: "queue",
  }
}

function permissionEvent(overrides: { action?: string; effect?: "allow" | "ask" | "deny"; sessionID?: string }) {
  return {
    sessionID: overrides.sessionID ?? "ses_parent",
    action: overrides.action ?? ORCHESTRATION_TOOL_PERMISSION,
    resources: ["target"],
    effect: overrides.effect ?? "allow",
    message: undefined as string | undefined,
  }
}

/** Invoke a registered hook and return the thrown error (if any). */
async function invokeCatching(
  hook: ((event: any) => Promise<void> | void) | undefined,
  event: unknown,
): Promise<Error | undefined> {
  try {
    await hook?.(event)
    return undefined
  } catch (error) {
    return error as Error
  }
}

function childSession() {
  return {
    id: "ses_child",
    parentID: "ses_parent",
    agent: "implementer",
    permissions: [{ action: "phase-a.keep", resource: "*", effect: "allow" as const }],
  }
}

describe("phase A authority configuration and selection", () => {
  test("authority enforcement starts only in enforce mode", () => {
    expect(shouldStartAuthority(parseOptions({}))).toBe(false)
    expect(shouldStartAuthority(parseOptions({ authority: { mode: "off" } }))).toBe(false)
    expect(shouldStartAuthority(parseOptions({ authority: { mode: "enforce" } }))).toBe(true)
  })

  test("selects only the explicitly enforced plugin-owned action families", () => {
    expect([...AUTHORITY_ENFORCED_PERMISSION_ACTIONS]).toEqual([
      GOAL_TOOL_PERMISSION,
      GH_TOOL_PERMISSION,
      WORKTREE_TOOL_PERMISSION,
      ORCHESTRATION_TOOL_PERMISSION,
      PUBLISH_TOOL_PERMISSION,
    ])
    for (const action of AUTHORITY_ENFORCED_PERMISSION_ACTIONS) {
      expect(isAuthorityEnforcedPermissionAction(action)).toBe(true)
    }
    // Untouched: native tools and the read-only/recovery plugin surfaces.
    for (const action of [
      "edit",
      "bash",
      "read",
      "phase-a.probe.untouched",
      OBSERVABILITY_TOOL_PERMISSION,
      GATES_TOOL_PERMISSION,
      PEER_TOOL_PERMISSION,
    ]) {
      expect(isAuthorityEnforcedPermissionAction(action)).toBe(false)
    }
  })

  test("containment denies cover the full orchestrator-only family plus the goal tools", () => {
    const denies = childContainmentDenyRules()
    expect(denies).toHaveLength(8)
    for (const deny of denies) {
      expect(deny.resource).toBe("*")
      expect(deny.effect).toBe("deny")
    }
    expect([...new Set(denies.map((rule) => rule.action))].sort()).toEqual(
      [
        GOAL_TOOL_PERMISSION,
        GH_TOOL_PERMISSION,
        WORKTREE_TOOL_PERMISSION,
        ORCHESTRATION_TOOL_PERMISSION,
        OBSERVABILITY_TOOL_PERMISSION,
        PUBLISH_TOOL_PERMISSION,
        PEER_TOOL_PERMISSION,
        GATES_TOOL_PERMISSION,
      ].sort(),
    )
    // Deterministic order: identical output for repeated calls.
    expect(childContainmentDenyRules()).toEqual(denies)
  })

  test("default role configuration yields the four configured role agent IDs", () => {
    expect([...authorityRoleAgentIDs(parseOptions({}))].sort()).toEqual([
      "explore",
      "implementer",
      "planner",
      "reviewer",
    ])
    const custom = parseOptions({ roles: { research: "finder", planning: "architect" } })
    expect([...authorityRoleAgentIDs(custom)].sort()).toEqual(["architect", "finder", "implementer", "reviewer"])
    expect(authorityRoleAgentIDs(custom).has("orchestrator")).toBe(false)
  })
})

describe("phase A authority metadata", () => {
  test("builds a bounded namespaced dispatch marker", () => {
    const marker = authorityDispatchMetadata("command")
    expect(marker).toEqual({ [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "command" } })
    expect(AUTHORITY_METADATA_KEY).toBe("opencode-orchestrator.authority")
    expect(JSON.parse(JSON.stringify(marker))).toEqual(marker)
  })

  test("merges caller metadata without dropping unrelated keys", () => {
    const merged = withAuthorityDispatchMetadata({ caller: "kept", count: 2 }, "continuation")
    expect(merged).toEqual({
      caller: "kept",
      count: 2,
      [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "continuation" },
    })
    expect(withAuthorityDispatchMetadata(undefined, "command")).toEqual(authorityDispatchMetadata("command"))
  })

  test("parses only the exact bounded marker shape", () => {
    expect(parseAuthorityDispatchMarker({ [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "command" } })).toEqual({
      version: 1,
      dispatch: "command",
    })
    expect(
      parseAuthorityDispatchMarker({ [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "continuation", admitted: true } }),
    ).toEqual({ version: 1, dispatch: "continuation", admitted: true })
    // Malformed or unknown markers are not tagged dispatches.
    for (const value of [
      undefined,
      null,
      "marker",
      [],
      {},
      { [AUTHORITY_METADATA_KEY]: null },
      { [AUTHORITY_METADATA_KEY]: [] },
      { [AUTHORITY_METADATA_KEY]: { version: 2, dispatch: "command" } },
      { [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "unknown" } },
      { [AUTHORITY_METADATA_KEY]: { dispatch: "command" } },
      { [AUTHORITY_METADATA_KEY]: "command" },
    ]) {
      expect(parseAuthorityDispatchMarker(value)).toBeUndefined()
    }
  })

  test("appends the admission marker while preserving unrelated metadata", () => {
    const updated = withAuthorityAdmissionMetadata(
      { caller: "kept", [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "command" } },
      { version: 1, dispatch: "command" },
    )
    expect(updated).toEqual({
      caller: "kept",
      [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "command", admitted: true },
    })
    // Non-object metadata is never copied into the admitted record.
    expect(withAuthorityAdmissionMetadata("junk", { version: 1, dispatch: "continuation" })).toEqual({
      [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "continuation", admitted: true },
    })
  })

  test("bounded messages stay single-line and capped", () => {
    expect(boundedAuthorityMessage("prefix", undefined)).toBe("prefix")
    expect(boundedAuthorityMessage("prefix", "  a\n b\tc  ")).toBe("prefix: a b c")
    const long = boundedAuthorityMessage("prefix", "x".repeat(AUTHORITY_MESSAGE_MAX_LENGTH * 2))
    expect(long.length).toBe(AUTHORITY_MESSAGE_MAX_LENGTH)
    expect(long.endsWith("…")).toBe(true)
    expect(long.startsWith("prefix: x")).toBe(true)
  })
})

describe("phase A authority child classification and rule merging", () => {
  const roleAgentIDs = new Set(["planner", "explore", "implementer", "reviewer"])

  test("classifies only a parented configured-role child", () => {
    expect(classifyConfiguredRoleChild(childSession(), roleAgentIDs)).toBe("implementer")
    expect(classifyConfiguredRoleChild({ ...childSession(), parentID: undefined }, roleAgentIDs)).toBeUndefined()
    expect(classifyConfiguredRoleChild({ ...childSession(), parentID: "" }, roleAgentIDs)).toBeUndefined()
    expect(classifyConfiguredRoleChild({ ...childSession(), agent: "phase-a-child" }, roleAgentIDs)).toBeUndefined()
    expect(classifyConfiguredRoleChild({ ...childSession(), agent: "orchestrator" }, roleAgentIDs)).toBeUndefined()
    expect(classifyConfiguredRoleChild(undefined, roleAgentIDs)).toBeUndefined()
  })

  test("preserves existing rules, appends only missing exact denies, and is idempotent", () => {
    const denies = childContainmentDenyRules()
    const existing: PermissionRule[] = [
      { action: "phase-a.keep", resource: "*", effect: "allow" },
      { action: GH_TOOL_PERMISSION, resource: "*", effect: "deny" },
      { action: GH_TOOL_PERMISSION, resource: "/somewhere", effect: "allow" },
    ]
    const merged = mergeContainmentRules(existing, denies)
    expect(merged.permissions.slice(0, existing.length)).toEqual(existing)
    expect(merged.added).toHaveLength(denies.length - 1)
    expect(merged.added.some((rule) => rule.action === GH_TOOL_PERMISSION && rule.resource === "*")).toBe(false)
    // A different-resource rule is not an exact duplicate, so the exact deny is
    // still appended exactly once.
    expect(
      merged.permissions.filter((rule) => exactRuleKey(rule) === exactRuleKey({ action: GH_TOOL_PERMISSION, resource: "*", effect: "deny" })),
    ).toHaveLength(1)
    for (const deny of denies) {
      expect(merged.permissions.filter((rule) => exactRuleKey(rule) === exactRuleKey(deny))).toHaveLength(1)
    }
    // Idempotent: merging the result again adds nothing.
    expect(mergeContainmentRules(merged.permissions, denies).added).toEqual([])
    expect(mergeContainmentRules(merged.permissions, denies).permissions).toEqual(merged.permissions)
  })

  test("merges an empty child rule set into the full containment set", () => {
    const merged = mergeContainmentRules([])
    expect(merged.added).toEqual(childContainmentDenyRules())
    expect(merged.permissions).toEqual(childContainmentDenyRules())
  })
})

describe("phase A N1 prompt admission", () => {
  test("consults the gate only for tagged dispatches and appends admission metadata when allowed", async () => {
    const { deps, state } = createHarness({
      sessions: { ses_parent: { id: "ses_parent", agent: "build" } },
    })
    const runtime = await startAuthority(deps)

    const tagged = promptEvent({
      metadata: { caller: "kept", [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "command" } },
    })
    await state.promptHook?.(tagged)
    expect(state.gateCalls).toEqual([{ sessionID: "ses_parent", check: "command" }])
    expect(tagged.metadata).toEqual({
      caller: "kept",
      [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "command", admitted: true },
    })

    const continuation = promptEvent({
      metadata: { [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "continuation" } },
    })
    await state.promptHook?.(continuation)
    expect(state.gateCalls[1]).toEqual({ sessionID: "ses_parent", check: "auto" })

    // Untagged prompts never consult the gate and never gain authority metadata.
    const untagged = promptEvent({ metadata: { caller: "kept" } })
    await state.promptHook?.(untagged)
    expect(state.gateCalls).toHaveLength(2)
    expect(untagged.metadata).toEqual({ caller: "kept" })
    await runtime.dispose()
  })

  test("fails closed before admission when the gate refuses a tagged dispatch", async () => {
    const { deps, state } = createHarness({
      allowDispatch: async () => refuseDecision(),
      sessions: { ses_parent: { id: "ses_parent", agent: "build" } },
    })
    const runtime = await startAuthority(deps)

    const tagged = promptEvent({ metadata: authorityDispatchMetadata("command") })
    const error = await invokeCatching(state.promptHook, tagged)
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain("blocked this command dispatch before admission")
    expect(error?.message).toContain("budget exceeded")
    expect(error?.message.length).toBeLessThanOrEqual(AUTHORITY_MESSAGE_MAX_LENGTH)
    // The refusal never rewrites the prompt or its metadata.
    expect(tagged.metadata).toEqual(authorityDispatchMetadata("command"))
    await runtime.dispose()
  })

  test("fails closed when the gate lookup itself fails for a tagged dispatch", async () => {
    const { deps, state } = createHarness({
      allowDispatch: async () => {
        throw new Error("gate storage unavailable")
      },
      sessions: { ses_parent: { id: "ses_parent", agent: "build" } },
    })
    const runtime = await startAuthority(deps)

    const error = await invokeCatching(state.promptHook, promptEvent({ metadata: authorityDispatchMetadata("continuation") }))
    expect(error?.message).toContain("blocked this continuation dispatch before admission")
    expect(error?.message).toContain("fails closed")
    expect(error?.message).toContain("gate storage unavailable")
    await runtime.dispose()
  })
})

describe("phase A N1 permission enforcement", () => {
  test("downgrades selected actions to deny with a truthful bounded message on a gate refusal", async () => {
    const { deps, state } = createHarness({ allowDispatch: async () => refuseDecision() })
    const runtime = await startAuthority(deps)

    const event = permissionEvent({ action: ORCHESTRATION_TOOL_PERMISSION })
    await state.evaluateHook?.(event)
    expect(event.effect).toBe("deny")
    expect(event.message).toContain(`denied ${ORCHESTRATION_TOOL_PERMISSION}`)
    expect(event.message).toContain("budget exceeded")
    expect((event.message ?? "").length).toBeLessThanOrEqual(AUTHORITY_MESSAGE_MAX_LENGTH)
    expect(state.gateCalls).toEqual([{ sessionID: "ses_parent", check: "auto" }])
    await runtime.dispose()
  })

  test("enforces a bounded-review refusal for selected actions and continuation dispatches", async () => {
    const reviewRefusal = "review circuit is open: tripped for task ship-it (run 2); a human decision is required"
    const { deps, state } = createHarness({
      // Mirror the gate's real semantics: the bounded-review breaker only
      // applies to `auto` (continuation) checks, not command checks.
      allowDispatch: async (_sessionID, check) => (check === "auto" ? refuseDecision(reviewRefusal) : allowDecision()),
      sessions: { ses_parent: { id: "ses_parent", agent: "build" } },
    })
    const runtime = await startAuthority(deps)

    // Selected permission action: deny with the truthful review reason.
    const event = permissionEvent({ action: ORCHESTRATION_TOOL_PERMISSION })
    await state.evaluateHook?.(event)
    expect(event.effect).toBe("deny")
    expect(event.message).toContain("review circuit is open")
    expect(event.message).toContain("human decision is required")

    // Continuation dispatch: the review breaker refuses it before admission.
    const blocked = await invokeCatching(state.promptHook, promptEvent({ metadata: authorityDispatchMetadata("continuation") }))
    expect(blocked?.message).toContain("blocked this continuation dispatch before admission")
    expect(blocked?.message).toContain("review circuit is open")

    // Command dispatch: still checked with the `command` kind, so the review
    // breaker does not apply and the dispatch is admitted with its marker.
    const command = promptEvent({ metadata: authorityDispatchMetadata("command") })
    await state.promptHook?.(command)
    expect(command.metadata).toEqual({
      [AUTHORITY_METADATA_KEY]: { version: 1, dispatch: "command", admitted: true },
    })
    expect(state.gateCalls.map((call) => call.check)).toEqual(["auto", "auto", "command"])
    await runtime.dispose()
  })

  test("fails closed with a bounded safe message when the gate lookup fails", async () => {
    const { deps, state } = createHarness({
      allowDispatch: async () => {
        throw new Error("review storage read failed")
      },
    })
    const runtime = await startAuthority(deps)

    const event = permissionEvent({ action: WORKTREE_TOOL_PERMISSION })
    await state.evaluateHook?.(event)
    expect(event.effect).toBe("deny")
    expect(event.message).toContain("fails closed")
    expect(event.message).toContain("review storage read failed")
    await runtime.dispose()
  })

  test("leaves allowed decisions, unrelated actions, and existing denies untouched", async () => {
    // Refusing gate: a selected action is denied...
    const refusing = createHarness({ allowDispatch: async () => refuseDecision() })
    const refusingRuntime = await startAuthority(refusing.deps)

    const enforced = permissionEvent({ action: GH_TOOL_PERMISSION })
    await refusing.state.evaluateHook?.(enforced)
    expect(enforced.effect).toBe("deny")
    expect(refusing.state.gateCalls).toHaveLength(1)

    // ...while unrelated actions never reach the gate.
    const unrelated = permissionEvent({ action: "phase-a.probe.untouched" })
    await refusing.state.evaluateHook?.(unrelated)
    expect(unrelated.effect).toBe("allow")
    expect(refusing.state.gateCalls).toHaveLength(1)

    // A configured deny is final and is never rewritten (and never checked).
    const denied = permissionEvent({ action: PUBLISH_TOOL_PERMISSION, effect: "deny" })
    await refusing.state.evaluateHook?.(denied)
    expect(denied.effect).toBe("deny")
    expect(denied.message).toBeUndefined()
    expect(refusing.state.gateCalls).toHaveLength(1)

    // The read-only recovery/inspection surfaces are deliberately not selected.
    for (const action of [OBSERVABILITY_TOOL_PERMISSION, GATES_TOOL_PERMISSION, PEER_TOOL_PERMISSION]) {
      const event = permissionEvent({ action })
      await refusing.state.evaluateHook?.(event)
      expect(event.effect, action).toBe("allow")
    }
    expect(refusing.state.gateCalls).toHaveLength(1)
    await refusingRuntime.dispose()

    // Allowing gate: a selected action stays untouched.
    const allowing = createHarness({ allowDispatch: async () => allowDecision() })
    const allowingRuntime = await startAuthority(allowing.deps)
    const allowEvent = permissionEvent({ action: ORCHESTRATION_TOOL_PERMISSION })
    await allowing.state.evaluateHook?.(allowEvent)
    expect(allowEvent.effect).toBe("allow")
    expect(allowEvent.message).toBeUndefined()
    expect(allowing.state.gateCalls).toEqual([{ sessionID: "ses_parent", check: "auto" }])
    await allowingRuntime.dispose()
  })
})

describe("phase A N2 child containment", () => {
  test("installs the containment denies on a role child once and never on parents or non-role children", async () => {
    const { deps, state } = createHarness({
      sessions: {
        ses_parent: { id: "ses_parent", agent: "build", permissions: [] },
        ses_child: childSession(),
        ses_other: { id: "ses_other", parentID: "ses_parent", agent: "phase-a-child", permissions: [] },
      },
    })
    const runtime = await startAuthority(deps)

    await state.promptHook?.(promptEvent({ sessionID: "ses_parent" }))
    expect(state.rulesCalls).toEqual([])

    await state.promptHook?.(promptEvent({ sessionID: "ses_child" }))
    expect(state.rulesCalls).toHaveLength(1)
    expect(state.rulesCalls[0]?.sessionID).toBe("ses_child")
    expect(state.rulesCalls[0]?.permissions.slice(0, 1)).toEqual([
      { action: "phase-a.keep", resource: "*", effect: "allow" },
    ])
    expect(state.rulesCalls[0]?.permissions).toHaveLength(9)

    // A later new message on the same child writes nothing (idempotent).
    await state.promptHook?.(promptEvent({ sessionID: "ses_child" }))
    expect(state.rulesCalls).toHaveLength(1)

    // Non-role children are never touched.
    await state.promptHook?.(promptEvent({ sessionID: "ses_other" }))
    expect(state.rulesCalls).toHaveLength(1)
    await runtime.dispose()
  })

  test("fails closed before admission when the child lookup fails", async () => {
    const { deps, state } = createHarness({
      sessions: { ses_child: new Error("session store unavailable") },
    })
    const runtime = await startAuthority(deps)

    const error = await invokeCatching(state.promptHook, promptEvent({ sessionID: "ses_child" }))
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain("could not read session ses_child")
    expect(error?.message).toContain("session store unavailable")
    expect(state.rulesCalls).toEqual([])
    await runtime.dispose()
  })

  test("fails closed before admission when the session lookup returns no readable session", async () => {
    const { deps, state } = createHarness({ sessions: { ses_child: null } })
    const runtime = await startAuthority(deps)

    const error = await invokeCatching(state.promptHook, promptEvent({ sessionID: "ses_child" }))
    expect(error?.message).toContain("could not classify session ses_child")
    expect(error?.message).toContain("fails closed")
    await runtime.dispose()
  })

  test("fails closed when the session lookup returns an object without a session id", async () => {
    const { deps, state } = createHarness({ sessions: { ses_child: { agent: "implementer", parentID: "ses_parent" } } })
    const runtime = await startAuthority(deps)

    const error = await invokeCatching(state.promptHook, promptEvent({ sessionID: "ses_child" }))
    expect(error?.message).toContain("could not classify session ses_child")
    await runtime.dispose()
  })

  test("fails closed before admission when rule installation fails", async () => {
    const { deps, state } = createHarness({
      sessions: { ses_child: childSession() },
      rulesFailure: new Error("rules write rejected"),
    })
    const runtime = await startAuthority(deps)

    const error = await invokeCatching(state.promptHook, promptEvent({ sessionID: "ses_child" }))
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain("could not install child containment rules")
    expect(error?.message).toContain("rules write rejected")
    await runtime.dispose()
  })
})

describe("phase A authority registration and cleanup", () => {
  test("registers exactly the prompt and evaluate hooks and disposes both once (idempotent)", async () => {
    const { deps, state } = createHarness()
    const runtime = await startAuthority(deps)
    expect(state.promptHook).toBeFunction()
    expect(state.evaluateHook).toBeFunction()

    // First disposal order is evaluate registration, then prompt registration.
    // Concurrent calls share the same disposal work...
    const first = runtime.dispose()
    const second = runtime.dispose()
    await Promise.all([first, second])
    expect(state.disposed).toEqual(["evaluate:evaluate", "prompt:prompt"])

    // ...and repeated calls never dispose a registration again.
    await runtime.dispose()
    await runtime.dispose()
    expect(state.disposed).toEqual(["evaluate:evaluate", "prompt:prompt"])
  })

  test("cleans up a partial registration failure and rethrows", async () => {
    const { deps, state } = createHarness()
    const failing = {
      ...deps,
      permission: {
        hook: async () => {
          throw new Error("evaluate hook registration failed")
        },
        rules: async () => {},
      },
    } as unknown as AuthorityDeps
    await expect(startAuthority(failing)).rejects.toThrow("evaluate hook registration failed")
    expect(state.disposed).toEqual(["prompt:prompt"])
  })
})

function validSnapshot() {
  return buildAuthoritySnapshot({
    sessionID: "ses_child",
    parentSessionID: "ses_parent",
    roleAgent: "implementer",
    capturedAt: 1000,
    parentRules: [],
    parentReadable: true,
    installedRules: [],
    installedReadable: true,
  })
}

describe("phase C effective-authority snapshot schema and intersection", () => {
  test("keys records under authority/v1 with encoded project and session segments", () => {
    expect(authorityStorageKey({ directory: "/workspace", project: { id: "proj" } }, "ses_child")).toBe(
      "authority/v1/proj/ses_child",
    )
    expect(authorityStorageKey({ directory: "/workspace", project: { id: "proj/one" } }, "ses/child")).toBe(
      "authority/v1/proj%2Fone/ses%2Fchild",
    )
  })

  test("strict schema rejects malformed and unknown-shaped records", () => {
    const valid = validSnapshot()
    expect(parseAuthoritySnapshot(valid)).toEqual(valid)
    expect(authoritySnapshotSchema.safeParse(valid).success).toBe(true)
    for (const malformed of [
      undefined,
      null,
      "snapshot",
      [],
      { ...valid, version: 2 },
      { ...valid, extra: true },
      { ...valid, entries: [] },
      { ...valid, entries: [{ ...valid.entries[0], effective: "maybe" }] },
      { ...valid, unknownDimensions: ["parent", "mystery"] },
      { ...valid, entries: undefined },
    ]) {
      expect(parseAuthoritySnapshot(malformed)).toBeUndefined()
    }
  })

  test("family effects are family-wide last-match-wins and ignore scoped resources", () => {
    const rules: PermissionRule[] = [
      { action: "a", resource: "*", effect: "allow" },
      { action: "a", resource: "/scoped", effect: "deny" },
      { action: "a", resource: "*", effect: "ask" },
    ]
    expect(familyAuthorityEffect(rules, "a")).toBe("ask")
    expect(familyAuthorityEffect([{ action: "a", resource: "/scoped", effect: "deny" }], "a")).toBe("unconstrained")
    expect(familyAuthorityEffect([{ action: "a", resource: "*", effect: "deny" }], "b")).toBe("unconstrained")
    expect(familyAuthorityEffect(undefined, "a")).toBe("unconstrained")
  })

  test("intersection takes the strictest effect and unknown always wins", () => {
    expect(intersectAuthorityEffects(["unconstrained", "unconstrained", "unconstrained"])).toBe("unconstrained")
    expect(intersectAuthorityEffects(["allow", "unconstrained", "allow"])).toBe("allow")
    expect(intersectAuthorityEffects(["allow", "ask", "unconstrained"])).toBe("ask")
    expect(intersectAuthorityEffects(["allow", "deny", "ask"])).toBe("deny")
    expect(intersectAuthorityEffects(["deny", "unknown", "unconstrained"])).toBe("unknown")
  })

  test("builds one deterministic entry per tracked action with explicit unknowns", () => {
    const actions = AUTHORITY_SNAPSHOT_ACTIONS
    expect(actions).toHaveLength(8)
    const snapshot = buildAuthoritySnapshot({
      sessionID: "ses_child",
      parentSessionID: "ses_parent",
      roleAgent: "implementer",
      capturedAt: 42,
      parentRules: [{ action: actions[0], resource: "*", effect: "allow" }],
      parentReadable: true,
      installedRules: [{ action: actions[0], resource: "*", effect: "allow" }],
      installedReadable: true,
    })
    expect(snapshot.version).toBe(AUTHORITY_SNAPSHOT_VERSION)
    expect(snapshot.entries.map((entry) => entry.action)).toEqual([...actions])
    expect(snapshot.entries[0]).toEqual({
      action: actions[0],
      parent: "allow",
      workerPolicy: "deny",
      installed: "allow",
      effective: "deny",
    })
    expect(snapshot.unknownDimensions).toEqual([])

    const unknown = buildAuthoritySnapshot({
      sessionID: "ses_child",
      roleAgent: "implementer",
      capturedAt: 42,
      parentReadable: false,
      installedRules: [],
      installedReadable: true,
    })
    expect(unknown.parentSessionID).toBeUndefined()
    expect(unknown.unknownDimensions).toEqual(["parent"])
    for (const entry of unknown.entries) {
      expect(entry.parent).toBe("unknown")
      expect(entry.workerPolicy).toBe("deny")
      expect(entry.effective).toBe("unknown")
    }
  })

  test("write/read/clear round-trips and missing records are unknown", async () => {
    const storage = memStorage()
    const snapshot = validSnapshot()
    await writeAuthoritySnapshot(storage, LOCATION, "ses_child", snapshot)
    expect(storage.values.has(authorityStorageKey(LOCATION, "ses_child"))).toBe(true)
    expect(await readAuthoritySnapshot(storage, LOCATION, "ses_child")).toEqual({ state: "found", snapshot })
    await clearAuthoritySnapshot(storage, LOCATION, "ses_child")
    expect(await readAuthoritySnapshot(storage, LOCATION, "ses_child")).toEqual({ state: "unknown", reason: "missing" })
  })

  test("read treats malformed, mismatched, and unreadable records as unknown", async () => {
    const malformed = memStorage()
    await malformed.set(authorityStorageKey(LOCATION, "ses_child"), { version: 1, sessionID: "ses_child" })
    expect(await readAuthoritySnapshot(malformed, LOCATION, "ses_child")).toEqual({ state: "unknown", reason: "malformed" })

    const mismatch = memStorage()
    await mismatch.set(authorityStorageKey(LOCATION, "ses_child"), { ...validSnapshot(), sessionID: "ses_other" })
    expect(await readAuthoritySnapshot(mismatch, LOCATION, "ses_child")).toEqual({ state: "unknown", reason: "malformed" })

    expect(await readAuthoritySnapshot(memStorage({ getFailure: new Error("storage down") }), LOCATION, "ses_child")).toEqual({
      state: "unknown",
      reason: "unreadable",
    })
  })
})

describe("phase C authority snapshot recording during admission", () => {
  test("records parent scopes, worker policy, installed rules, and the intersection after rule install", async () => {
    const storage = memStorage()
    const parent = {
      id: "ses_parent",
      agent: "build",
      permissions: [
        { action: GH_TOOL_PERMISSION, resource: "*", effect: "allow" as const },
        { action: GH_TOOL_PERMISSION, resource: "/scoped-only", effect: "deny" as const },
      ],
    }
    const child = childSession()
    const { deps, state } = createHarness({
      sessions: { ses_parent: parent, ses_child: child },
      storage,
      location: LOCATION,
    })
    const runtime = await startAuthority(deps)

    await state.promptHook?.(promptEvent({ sessionID: "ses_child" }))
    expect(state.rulesCalls).toHaveLength(1)
    const snapshot = parseAuthoritySnapshot(storage.values.get(authorityStorageKey(LOCATION, "ses_child")))
    expect(snapshot).toBeDefined()
    expect(snapshot?.sessionID).toBe("ses_child")
    expect(snapshot?.parentSessionID).toBe("ses_parent")
    expect(snapshot?.roleAgent).toBe("implementer")
    expect(snapshot?.authorityMode).toBe("enforce")
    expect(snapshot?.ruleScope).toBe("family-wide")
    expect(snapshot?.unknownDimensions).toEqual([])
    expect(snapshot?.entries).toHaveLength(AUTHORITY_SNAPSHOT_ACTIONS.length)
    const gh = snapshot?.entries.find((entry) => entry.action === GH_TOOL_PERMISSION)
    // The scoped parent rule is not family-wide: the `*` allow is the parent value.
    expect(gh).toEqual({
      action: GH_TOOL_PERMISSION,
      parent: "allow",
      workerPolicy: "deny",
      installed: "deny",
      effective: "deny",
    })
    for (const entry of snapshot?.entries ?? []) expect(entry.effective).toBe("deny")

    // A later admission refreshes the single record; rule writes stay idempotent.
    await state.promptHook?.(promptEvent({ sessionID: "ses_child" }))
    expect(state.rulesCalls).toHaveLength(1)
    const refreshed = parseAuthoritySnapshot(storage.values.get(authorityStorageKey(LOCATION, "ses_child")))
    expect(refreshed?.capturedAt).toBeGreaterThanOrEqual(snapshot?.capturedAt ?? 0)
    expect(storage.values.size).toBe(1)
    await runtime.dispose()
  })

  test("keeps unreadable parent and installed rule sets explicitly unknown", async () => {
    const storage = memStorage()
    const parent = { id: "ses_parent", agent: "build", permissions: [] }
    const child = childSession()
    // Call 1 of each session is the child classification; later calls are the
    // snapshot rule reads, which fail here.
    const failures = new Set(["ses_parent:1", "ses_child:2"])
    const { deps, state } = createHarness({
      storage,
      location: LOCATION,
      sessionGet: (sessionID, call) => {
        if (failures.has(`${sessionID}:${call}`)) return new Error("session store unavailable")
        if (sessionID === "ses_parent") return parent
        if (sessionID === "ses_child") return child
        return undefined
      },
    })
    const runtime = await startAuthority(deps)

    await state.promptHook?.(promptEvent({ sessionID: "ses_child" }))
    const snapshot = parseAuthoritySnapshot(storage.values.get(authorityStorageKey(LOCATION, "ses_child")))
    expect(snapshot?.unknownDimensions).toEqual(["parent", "installed"])
    const gh = snapshot?.entries.find((entry) => entry.action === GH_TOOL_PERMISSION)
    expect(gh).toEqual({
      action: GH_TOOL_PERMISSION,
      parent: "unknown",
      workerPolicy: "deny",
      installed: "unknown",
      effective: "unknown",
    })
    await runtime.dispose()
  })

  test("snapshot failures never block admission and never change a gate decision", async () => {
    const storage = memStorage({ setFailure: new Error("snapshot write failed") })
    const child = childSession()
    const { deps, state } = createHarness({
      sessions: { ses_parent: { id: "ses_parent", agent: "build" }, ses_child: child },
      storage,
      location: LOCATION,
    })
    const runtime = await startAuthority(deps)
    // A failed snapshot write is reported, never thrown: admission still succeeds.
    await state.promptHook?.(promptEvent({ sessionID: "ses_child" }))
    expect(state.rulesCalls).toHaveLength(1)
    expect(storage.values.size).toBe(0)

    // A refusing gate still refuses; a seeded garbage snapshot is never consulted.
    const seeded = memStorage()
    seeded.values.set(authorityStorageKey(LOCATION, "ses_child"), "garbage")
    const refusing = createHarness({
      sessions: { ses_parent: { id: "ses_parent", agent: "build" }, ses_child: childSession() },
      storage: seeded,
      location: LOCATION,
      allowDispatch: async () => refuseDecision(),
    })
    const refusingRuntime = await startAuthority(refusing.deps)
    const error = await invokeCatching(
      refusing.state.promptHook,
      promptEvent({ sessionID: "ses_child", metadata: authorityDispatchMetadata("command") }),
    )
    expect(error?.message).toContain("blocked this command dispatch before admission")
    await refusingRuntime.dispose()
    await runtime.dispose()
  })

  test("dispose clears every recorded snapshot, best-effort and idempotent", async () => {
    const storage = memStorage()
    const { deps, state } = createHarness({
      sessions: { ses_parent: { id: "ses_parent", agent: "build" }, ses_child: childSession() },
      storage,
      location: LOCATION,
    })
    const runtime = await startAuthority(deps)
    await state.promptHook?.(promptEvent({ sessionID: "ses_child" }))
    const key = authorityStorageKey(LOCATION, "ses_child")
    expect(storage.values.has(key)).toBe(true)
    await runtime.dispose()
    expect(storage.values.has(key)).toBe(false)
    await runtime.dispose()
    expect(storage.values.has(key)).toBe(false)

    // A failing clear is reported, never thrown, and disposal still resolves.
    const failing = memStorage({ removeFailure: new Error("remove failed") })
    const second = createHarness({
      sessions: { ses_parent: { id: "ses_parent", agent: "build" }, ses_child: childSession() },
      storage: failing,
      location: LOCATION,
    })
    const secondRuntime = await startAuthority(second.deps)
    await second.state.promptHook?.(promptEvent({ sessionID: "ses_child" }))
    expect(failing.values.has(key)).toBe(true)
    await expect(secondRuntime.dispose()).resolves.toBeUndefined()
  })
})

describe("phase C authority snapshot lookup tool", () => {
  type ToolLike = {
    name: string
    input?: unknown
    options?: { namespace?: string; permission?: string }
    execute(input: unknown, tool: { sessionID: string; agent: string }): Promise<{ content: string }>
  }

  function collectTools(overrides: Partial<AuthorityToolsDeps> = {}): Map<string, ToolLike> {
    const tools = new Map<string, ToolLike>()
    addAuthorityTools(
      {
        add(tool) {
          tools.set(tool.name, tool as ToolLike)
        },
      },
      {
        options: parseOptions({ authority: { mode: "enforce" } }),
        storage: memStorage(),
        location: LOCATION,
        ...overrides,
      },
    )
    return tools
  }

  const orchestrator = { sessionID: "session-1", agent: "orchestrator" }

  test("is registered only in enforce mode with the read-only observability permission", () => {
    expect(collectTools({ options: parseOptions({}) }).size).toBe(0)
    const tools = collectTools()
    expect([...tools.keys()]).toEqual(["authority_get"])
    expect(tools.get("authority_get")?.options?.namespace).toBe("orchestrator")
    expect(tools.get("authority_get")?.options?.permission).toBe(OBSERVABILITY_TOOL_PERMISSION)
    expect(tools.get("authority_get")?.input).toEqual({
      type: "object",
      properties: { sessionID: { type: "string", minLength: 1 } },
      required: ["sessionID"],
      additionalProperties: false,
    })
  })

  test("returns the stored snapshot and unknown for missing, malformed, or unreadable records", async () => {
    const storage = memStorage()
    const snapshot = validSnapshot()
    await writeAuthoritySnapshot(storage, LOCATION, "ses_child", snapshot)
    const tools = collectTools({ storage })

    const found = JSON.parse((await tools.get("authority_get")!.execute({ sessionID: "ses_child" }, orchestrator)).content)
    expect(found.state).toBe("found")
    expect(found.snapshot).toEqual(snapshot)

    const missing = JSON.parse((await tools.get("authority_get")!.execute({ sessionID: "ses_missing" }, orchestrator)).content)
    expect(missing).toEqual({
      version: 1,
      sessionID: "ses_missing",
      snapshot: null,
      state: "unknown",
      reason: "missing",
      limitations: AUTHORITY_TOOL_LIMITATIONS,
    })

    const malformedStorage = memStorage()
    malformedStorage.values.set(authorityStorageKey(LOCATION, "ses_child"), { version: 1 })
    const malformed = JSON.parse(
      (await collectTools({ storage: malformedStorage }).get("authority_get")!.execute({ sessionID: "ses_child" }, orchestrator))
        .content,
    )
    expect(malformed.state).toBe("unknown")
    expect(malformed.reason).toBe("malformed")
    expect(malformed.snapshot).toBeNull()

    const unreadable = JSON.parse(
      (
        await collectTools({ storage: memStorage({ getFailure: new Error("storage down") }) })
          .get("authority_get")!
          .execute({ sessionID: "ses_child" }, orchestrator)
      ).content,
    )
    expect(unreadable.state).toBe("unknown")
    expect(unreadable.reason).toBe("unreadable")

    const empty = JSON.parse((await tools.get("authority_get")!.execute({}, orchestrator)).content)
    expect(empty.state).toBe("unknown")
    expect(empty.message).toBe("sessionID is required")
  })

  test("rejects worker agents and discloses its limits plainly", async () => {
    const tools = collectTools()
    await expect(
      tools.get("authority_get")!.execute({ sessionID: "ses_child" }, { sessionID: "s", agent: "explore" }),
    ).rejects.toThrow(/only to the orchestrator/)
    const text = AUTHORITY_TOOL_LIMITATIONS.join("\n")
    expect(text).toContain("not filesystem, process, worktree, or atomic child isolation")
    expect(text).toContain("never decisions")
    expect(text).toContain("unknown, never assumed permissive or restrictive")
    expect(text).toContain("process-local session lock")
    // Reuse of the read-only observability permission means no new permission
    // action and no installer/agent-transform change.
    const actions = orchestratorOnlyPermissionRules("allow").map((rule) => rule.action)
    expect(actions).toContain(OBSERVABILITY_TOOL_PERMISSION)
  })
})
