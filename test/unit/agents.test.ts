import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import {
  GH_TOOL_PERMISSION,
  GOAL_TOOL_PERMISSION,
  ORCHESTRATION_TOOL_PERMISSION,
  WORKTREE_TOOL_PERMISSION,
  orchestratorOnlyPermissionRules,
} from "../../src/core/permissions.js"
import { applyAgentTransform, type AgentDraftLike } from "../../src/opencode-v2/agents.js"

const options = parseOptions({})

const FEATURE_ACTIONS = [
  GH_TOOL_PERMISSION,
  WORKTREE_TOOL_PERMISSION,
  ORCHESTRATION_TOOL_PERMISSION,
] as const

type MutableAgent = {
  id: string
  mode: string
  system?: string
  description?: string
  permissions?: Array<{ action: string; resource: string; effect: string }>
}

const DENY_ALL = { action: "*", resource: "*", effect: "deny" as const }
const GOAL_ALLOW = { action: GOAL_TOOL_PERMISSION, resource: "*", effect: "allow" as const }
const GOAL_DENY = { action: GOAL_TOOL_PERMISSION, resource: "*", effect: "deny" as const }
const FEATURE_ALLOWS = orchestratorOnlyPermissionRules("allow")
const FEATURE_DENIES = orchestratorOnlyPermissionRules("deny")

describe("agent transform feature permissions", () => {
  test("appends the goal and feature allow rules to a preserved orchestrator without permissions", () => {
    const draft = draftWith({ orchestrator: { mode: "primary" } })
    applyAgentTransform(draft, options)
    const rules = draft.get("orchestrator")!.permissions!
    expect(rules.find((rule) => rule.action === GOAL_TOOL_PERMISSION)).toEqual(GOAL_ALLOW)
    for (const action of FEATURE_ACTIONS) {
      expect(rules.find((rule) => rule.action === action)).toEqual({ action, resource: "*", effect: "allow" })
    }
    // Regression: an agent with no `permissions` field gets an explicit
    // deny-all seeded before the goal and feature rules so the appended rules
    // do not widen every other action.
    expect(rules[0]).toEqual(DENY_ALL)
    expect(rules.filter((r) => FEATURE_ACTIONS.includes(r.action as any))).toHaveLength(FEATURE_ACTIONS.length)
  })

  test("appends the goal and feature deny rules to every preserved worker without permissions", () => {
    const draft = draftWith({
      orchestrator: { mode: "primary" },
      planner: { mode: "subagent" },
      explore: { mode: "subagent" },
      implementer: { mode: "subagent" },
      reviewer: { mode: "subagent" },
    })
    applyAgentTransform(draft, options)
    for (const id of ["planner", "explore", "implementer", "reviewer"]) {
      const rules = draft.get(id)!.permissions!
      // Every worker missing a permissions field is seeded with a deny-all
      // before the goal and feature denies, so the sparse array never widens
      // other actions.
      expect(rules[0]).toEqual(DENY_ALL)
      expect(rules.find((rule) => rule.action === GOAL_TOOL_PERMISSION)).toEqual(GOAL_DENY)
      for (const action of FEATURE_ACTIONS) {
        expect(rules.find((rule) => rule.action === action)).toEqual({ action, resource: "*", effect: "deny" })
      }
    }
    const orchestratorRules = draft.get("orchestrator")!.permissions!
    expect(orchestratorRules[0]).toEqual(DENY_ALL)
    expect(orchestratorRules.find((rule) => rule.action === GOAL_TOOL_PERMISSION)).toEqual(GOAL_ALLOW)
    for (const action of FEATURE_ACTIONS) {
      expect(orchestratorRules.find((rule) => rule.action === action)).toEqual({ action, resource: "*", effect: "allow" })
    }
  })

  test("treats an explicit empty permissions array as user policy, appending only the goal and feature rules", () => {
    // An explicit `[]` is a present, real permissions field; it must stay
    // distinguishable from an absent field (undefined). V2's built-in deny-all
    // fallback applies only when the field is *missing*, so an explicit empty
    // array is the user's policy and must NOT be seeded with a deny-all — the
    // transform only adds the appropriate goal and feature rules on top.
    const draft = draftWith({
      orchestrator: { mode: "primary", permissions: [] },
      planner: { mode: "subagent", permissions: [] },
    })
    applyAgentTransform(draft, options)
    expect(draft.get("orchestrator")!.permissions).toEqual([GOAL_ALLOW, ...FEATURE_ALLOWS])
    expect(draft.get("planner")!.permissions).toEqual([GOAL_DENY, ...FEATURE_DENIES])
  })

  test("keeps an existing explicit orchestrator allow instead of duplicating it", () => {
    const draft = draftWith({
      orchestrator: {
        mode: "primary",
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: GOAL_TOOL_PERMISSION, resource: "*", effect: "allow" },
        ],
      },
    })
    applyAgentTransform(draft, options)
    const rules = draft.get("orchestrator")!.permissions!
    expect(rules.filter((rule) => rule.action === GOAL_TOOL_PERMISSION)).toHaveLength(1)
    for (const action of FEATURE_ACTIONS) {
      expect(rules.filter((rule) => rule.action === action)).toHaveLength(1)
    }
    // The augmentation never moves the existing rules around.
    expect(rules[0]).toEqual(DENY_ALL)
  })

  test("respects an explicit user ask or deny for the goal action", () => {
    // An exact rule (including `ask`) affects visibility only: it controls
    // whether the model can see and invoke the goal tools. V2's public
    // Promise plugin API does not expose `permission.assert`, so the goal
    // tools cannot trigger interactive runtime "ask" prompting. We only
    // preserve the user's rule verbatim; we neither invent prompting nor
    // claim enforcement the plugin API cannot deliver. The feature family is
    // still appended unless the user already wrote an exact rule for it.
    for (const effect of ["ask", "deny"] as const) {
      const draft = draftWith({
        orchestrator: {
          mode: "primary",
          permissions: [{ action: GOAL_TOOL_PERMISSION, resource: "*", effect }],
        },
      })
      applyAgentTransform(draft, options)
      expect(draft.get("orchestrator")!.permissions).toEqual([
        { action: GOAL_TOOL_PERMISSION, resource: "*", effect },
        ...FEATURE_ALLOWS,
      ])
    }
  })

  test("respects an explicit user allow for the goal action on a worker", () => {
    const draft = draftWith({
      orchestrator: { mode: "primary" },
      explore: {
        mode: "subagent",
        permissions: [{ action: GOAL_TOOL_PERMISSION, resource: "*", effect: "allow" }],
      },
    })
    applyAgentTransform(draft, options)
    expect(draft.get("explore")!.permissions).toEqual([
      { action: GOAL_TOOL_PERMISSION, resource: "*", effect: "allow" },
      ...FEATURE_DENIES,
    ])
  })

  test("grants and denies the orchestration validation family with the shared action", () => {
    const draft = draftWith({
      orchestrator: { mode: "primary" },
      planner: { mode: "subagent" },
      explore: { mode: "subagent" },
    })
    applyAgentTransform(draft, options)

    const orchestratorRules = draft.get("orchestrator")!.permissions!
    expect(orchestratorRules.find((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toEqual({
      action: ORCHESTRATION_TOOL_PERMISSION,
      resource: "*",
      effect: "allow",
    })
    // Deny-all is seeded first; the family rule lands after it so
    // last-match-wins keeps the tools visible to the orchestrator.
    expect(orchestratorRules[0]).toEqual(DENY_ALL)
    expect(orchestratorRules.findIndex((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toBeGreaterThan(0)

    for (const id of ["planner", "explore"]) {
      const workerRules = draft.get(id)!.permissions!
      expect(workerRules.find((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toEqual({
        action: ORCHESTRATION_TOOL_PERMISSION,
        resource: "*",
        effect: "deny",
      })
      expect(workerRules[0]).toEqual(DENY_ALL)
      expect(workerRules.findIndex((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toBeGreaterThan(0)
    }
  })

  test("preserves an exact user rule for the orchestration validation permission", () => {
    const draft = draftWith({
      orchestrator: {
        mode: "primary",
        permissions: [{ action: ORCHESTRATION_TOOL_PERMISSION, resource: "*", effect: "ask" }],
      },
    })
    applyAgentTransform(draft, options)
    const rules = draft.get("orchestrator")!.permissions!
    expect(rules.filter((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toEqual([
      { action: ORCHESTRATION_TOOL_PERMISSION, resource: "*", effect: "ask" },
    ])
    // The augmentation never duplicates or moves the user's rule; the rest of
    // the family is still appended unless an exact rule already exists.
    expect(rules).toEqual([
      { action: ORCHESTRATION_TOOL_PERMISSION, resource: "*", effect: "ask" },
      GOAL_ALLOW,
      ...orchestratorOnlyPermissionRules("allow").filter((rule) => rule.action !== ORCHESTRATION_TOOL_PERMISSION),
    ])
  })

  test("reports missing agents without touching their absence", () => {
    const draft = draftWith({ orchestrator: { mode: "primary" } })
    const missing = applyAgentTransform(draft, options)
    expect(missing).toEqual(["planner", "explore", "implementer", "reviewer"])
  })
})

function draftWith(agents: Record<string, Partial<MutableAgent>>): AgentDraftLike {
  const store = new Map(
    Object.entries(agents).map(([id, value]) => [
      id,
      { id, mode: "subagent" as const, ...value, permissions: value.permissions !== undefined ? [...value.permissions] : undefined },
    ]),
  )
  return {
    list: () => [...store.values()],
    get: (id) => store.get(id),
    update: (id, update) => {
      const agent = store.get(id)
      if (agent) update(agent as any)
    },
  }
}