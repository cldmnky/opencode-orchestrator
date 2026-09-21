import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { STRICT_DECOMPOSITION_GUIDANCE } from "../../src/core/policy.js"
import {
  GH_TOOL_PERMISSION,
  GOAL_TOOL_PERMISSION,
  ORCHESTRATION_TOOL_PERMISSION,
  PEER_TOOL_PERMISSION,
  PUBLISH_TOOL_PERMISSION,
  REVIEW_SUBMIT_TOOL_PERMISSION,
  WORKTREE_TOOL_PERMISSION,
  orchestratorOnlyPermissionRules,
} from "../../src/core/permissions.js"
import { applyAgentTransform, type AgentDraftLike } from "../../src/opencode-v2/agents.js"
import type { ModelReference } from "../../src/core/model-reference.js"

const options = parseOptions({})

const FEATURE_ACTIONS = [
  GH_TOOL_PERMISSION,
  WORKTREE_TOOL_PERMISSION,
  ORCHESTRATION_TOOL_PERMISSION,
  PUBLISH_TOOL_PERMISSION,
  PEER_TOOL_PERMISSION,
] as const

type MutableAgent = {
  id: string
  mode: string
  model?: { providerID: string; id: string; variant?: string }
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
    expect(draft.get("orchestrator")!.permissions).toEqual([
      GOAL_ALLOW,
      ...FEATURE_ALLOWS,
      { action: REVIEW_SUBMIT_TOOL_PERMISSION, resource: "*", effect: "deny" },
    ])
    expect(draft.get("planner")!.permissions).toEqual([
      GOAL_DENY,
      ...FEATURE_DENIES,
      { action: REVIEW_SUBMIT_TOOL_PERMISSION, resource: "*", effect: "deny" },
    ])
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
        { action: REVIEW_SUBMIT_TOOL_PERMISSION, resource: "*", effect: "deny" },
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
      { action: REVIEW_SUBMIT_TOOL_PERMISSION, resource: "*", effect: "deny" },
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
      { action: REVIEW_SUBMIT_TOOL_PERMISSION, resource: "*", effect: "deny" },
    ])
  })

  test("never adds, removes, or overrides subagent rules in transforms", () => {
    // Nested delegation permissions are user-authored policy: the installer
    // writes the bounded role-graph edges only for agents it creates, and the
    // transform must not grant, revoke, or rewrite `subagent` rules on
    // preserved agents.
    const plannerRules = [
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "explore", effect: "allow" },
    ]
    const draft = draftWith({
      orchestrator: { mode: "primary", permissions: [{ action: "subagent", resource: "planner", effect: "allow" }] },
      planner: { mode: "subagent", permissions: [...plannerRules] },
      explore: { mode: "subagent" },
    })
    applyAgentTransform(draft, options)

    expect(draft.get("orchestrator")!.permissions!.filter((rule) => rule.action === "subagent")).toEqual([
      { action: "subagent", resource: "planner", effect: "allow" },
    ])
    // The user's exact subagent rules survive verbatim and in order, with only
    // the goal/feature families appended after them.
    const plannerResult = draft.get("planner")!.permissions!
    expect(plannerResult.slice(0, plannerRules.length)).toEqual(plannerRules)
    expect(plannerResult.filter((rule) => rule.action === "subagent")).toEqual(plannerRules)
    // A worker missing permissions gets the deny-all seeding, and that seeding
    // carries no subagent rules either: delegation stays entirely user-owned.
    const seeded = draft.get("explore")!.permissions!
    expect(seeded[0]).toEqual(DENY_ALL)
    expect(seeded.filter((rule) => rule.action === "subagent")).toEqual([])
  })

  test("reports missing agents without touching their absence", () => {
    const draft = draftWith({ orchestrator: { mode: "primary" } })
    const missing = applyAgentTransform(draft, options)
    expect(missing).toEqual(["planner", "explore", "implementer", "reviewer"])
  })

  test("applies runtime model overrides only to configured workers", () => {
    const draft = draftWith({
      orchestrator: { mode: "primary", model: { providerID: "configured", id: "orchestrator" } },
      planner: { mode: "subagent", model: { providerID: "configured", id: "planner" } },
      explore: { mode: "subagent", model: { providerID: "configured", id: "explore" } },
    })
    const overrides = new Map<string, ModelReference>([["planner", { providerID: "runtime", id: "fast" }]])
    applyAgentTransform(draft, options, overrides)
    expect(draft.get("planner")!.model).toEqual({ providerID: "runtime", id: "fast" })
    expect(draft.get("explore")!.model).toEqual({ providerID: "configured", id: "explore" })
    expect(draft.get("orchestrator")!.model).toEqual({ providerID: "configured", id: "orchestrator" })
  })

  test("worker system prompts embed feature lifecycle guidance only when features are enabled", () => {
    const enabled = parseOptions({ github: { enabled: true }, worktree: { enabled: true } })
    const draft = draftWith({ orchestrator: { mode: "primary" }, implementer: { mode: "subagent" } })
    applyAgentTransform(draft, enabled)
    const system = draft.get("implementer")!.system!
    expect(system).toContain("orchestrator_github_pr_merge")
    expect(system).toContain("implementers never push branches or create or merge pull requests")
    expect(system).toContain("the orchestrator MUST run orchestrator_worktree_create -> orchestrator_worktree_enter")
    // The rewritten policy makes merge autonomous and drops the old "separate
    // explicit user request" framing: no user merge instruction is required.
    expect(system).toContain("Merge is autonomous when the durable publish capability 'merge' and the per-session gates allow it")
    expect(system).toContain("no separate user merge instruction is required")
    expect(system).not.toContain("separate explicit user request")
    // With github (or publish) enabled the feature guidance also carries the
    // terminal-drive Definition of Done for ship-shaped work.
    expect(system).toContain("Definition of Done (terminal drive)")
    expect(system).toContain("Run the terminal chain in order as soon as the work is verified")

    const draft2 = draftWith({ orchestrator: { mode: "primary" }, implementer: { mode: "subagent" } })
    applyAgentTransform(draft2, options)
    const plain = draft2.get("implementer")!.system!
    expect(plain).not.toContain("orchestrator_github_pr_merge")
    expect(plain).not.toContain("Worktree lifecycle is mandatory")
    // Terminal drive is feature-gated too, and the old authorization framing is
    // gone from the disabled-feature prompt entirely.
    expect(plain).not.toContain("Definition of Done (terminal drive)")
    expect(plain).not.toContain("no separate user merge instruction is required")
    // The universal boundary stays present with or without the features.
    expect(plain).toContain("prompt-level disjoint write scopes do not equal filesystem isolation")
  })

  test("worker and orchestrator prompts carry coherent-slice guidance with the safeguards intact", () => {
    const draft = draftWith({
      orchestrator: { mode: "primary" },
      planner: { mode: "subagent" },
      explore: { mode: "subagent" },
      implementer: { mode: "subagent" },
      reviewer: { mode: "subagent" },
    })
    applyAgentTransform(draft, options)

    // The implementer description and system prompt prefer coherent
    // end-to-end slices over file-sized edits.
    expect(draft.get("implementer")!.description).toContain("coherent end-to-end slices with focused ownership")
    const implementer = draft.get("implementer")!.system!
    expect(implementer).toContain("coherent end-to-end slices with focused ownership")
    expect(implementer).toContain("Prefer the smallest coherent end-to-end implementation slice over the smallest file or layer")
    expect(implementer).toContain(
      "Unavoidable coupling between files is resolved by sequencing or serialization with integrated parent verification — never by concurrent overlapping writes.",
    )
    expect(implementer).toContain("A slice is a coordination unit, never a permission or filesystem boundary")
    expect(implementer).toContain("unknown coupling fails closed and serializes")

    // Safety wording is unchanged: the disjoint child-scope rule and the
    // parent-accountability contract stay verbatim, and the slice invariant
    // adds no isolation claim.
    expect(implementer).toContain("keep child write scopes disjoint")
    expect(implementer).toContain("disjoint from other children")
    expect(implementer).toContain("files that must change together for one outcome stay with one owner in the same child")
    expect(implementer).toContain("prompt-level disjoint write scopes do not equal filesystem isolation")
    expect(implementer).not.toMatch(/provid(?:e|ed).{0,40}isolat/i)

    // The orchestrator system prompt and worker prompts all restate the same
    // slice invariant; no slice claims isolation or a scheduler.
    const orchestrator = draft.get("orchestrator")!.system!
    expect(orchestrator).toContain("prefer coherent end-to-end slices")
    expect(orchestrator).toContain("never by concurrent overlapping writes")
    expect(orchestrator).toContain("The parent stays accountable for every delegated child")
    expect(orchestrator).toContain("Require an exact disjoint write scope from every child before any parallel write")
    expect(orchestrator).toContain("Serialize implementation tasks when file ownership overlaps")
    for (const prompt of [orchestrator, implementer, draft.get("reviewer")!.system!]) {
      expect(prompt).not.toMatch(/scheduler|semaphore/i)
      expect(prompt).not.toMatch(/provid(?:e|ed).{0,40}isolat/i)
    }
  })

  test("strict decomposition threads prompt emphasis into agent systems while the default stays byte-identical", () => {
    const strict = parseOptions({ decomposition: { strategy: "strict" } })
    const draft = draftWith({ orchestrator: { mode: "primary" }, implementer: { mode: "subagent" } })
    applyAgentTransform(draft, strict)

    // The strict emphasis reaches the orchestrator and worker systems...
    const implementer = draft.get("implementer")!.system!
    expect(implementer).toContain(STRICT_DECOMPOSITION_GUIDANCE)
    expect(implementer).toContain("Prefer the smallest coherent end-to-end implementation slice over the smallest file or layer")
    const orchestrator = draft.get("orchestrator")!.system!
    expect(orchestrator).toContain(STRICT_DECOMPOSITION_GUIDANCE)
    expect(orchestrator).toContain("never by concurrent overlapping writes")

    // ...and the semantics stay prompt-preference only: the slice caveats,
    // disjoint-scope rules, and permission rules are untouched.
    expect(implementer).toContain("prompt-level disjoint write scopes do not equal filesystem isolation")
    expect(implementer).not.toMatch(/provid(?:e|ed).{0,40}isolat/i)
    expect(orchestrator).toContain("Require an exact disjoint write scope from every child before any parallel write")
    expect(orchestrator).toContain("Serialize implementation tasks when file ownership overlaps")

    // Omitting the key and an explicit `mvp` value produce identical systems.
    const defaultDraft = draftWith({ orchestrator: { mode: "primary" }, implementer: { mode: "subagent" } })
    applyAgentTransform(defaultDraft, options)
    // The strategy changes prompt emphasis only: permissions are identical.
    expect(draft.get("implementer")!.permissions).toEqual(defaultDraft.get("implementer")!.permissions)
    const explicitMvpDraft = draftWith({ orchestrator: { mode: "primary" }, implementer: { mode: "subagent" } })
    applyAgentTransform(explicitMvpDraft, parseOptions({ decomposition: { strategy: "mvp" } }))
    expect(explicitMvpDraft.get("implementer")!.system).toBe(defaultDraft.get("implementer")!.system)
    expect(defaultDraft.get("implementer")!.system).not.toContain(STRICT_DECOMPOSITION_GUIDANCE)
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
