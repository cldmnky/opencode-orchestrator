import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { GOAL_TOOL_PERMISSION } from "../../src/core/permissions.js"
import { applyAgentTransform, type AgentDraftLike } from "../../src/opencode-v2/agents.js"

const options = parseOptions({})

type MutableAgent = {
  id: string
  mode: string
  system?: string
  description?: string
  permissions?: Array<{ action: string; resource: string; effect: string }>
}

describe("agent transform goal-tool permissions", () => {
  test("appends the goal allow rule to a preserved orchestrator without permissions", () => {
    const draft = draftWith({ orchestrator: { mode: "primary" } })
    applyAgentTransform(draft, options)
    const orchestrator = draft.get("orchestrator")!
    expect(orchestrator.permissions?.find((rule) => rule.action === GOAL_TOOL_PERMISSION)).toEqual({
      action: GOAL_TOOL_PERMISSION,
      resource: "*",
      effect: "allow",
    })
  })

  test("appends the goal deny rule to every preserved worker without permissions", () => {
    const draft = draftWith({
      orchestrator: { mode: "primary" },
      planner: { mode: "subagent" },
      explore: { mode: "subagent" },
      implementer: { mode: "subagent" },
      reviewer: { mode: "subagent" },
    })
    applyAgentTransform(draft, options)
    for (const id of ["planner", "explore", "implementer", "reviewer"]) {
      expect(draft.get(id)!.permissions?.find((rule) => rule.action === GOAL_TOOL_PERMISSION)).toEqual({
        action: GOAL_TOOL_PERMISSION,
        resource: "*",
        effect: "deny",
      })
    }
    expect(draft.get("orchestrator")!.permissions?.find((rule) => rule.action === GOAL_TOOL_PERMISSION)).toEqual({
      action: GOAL_TOOL_PERMISSION,
      resource: "*",
      effect: "allow",
    })
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
    // The augmentation never moves the existing rules around.
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
  })

  test("respects an explicit user ask or deny for the goal action", () => {
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
      { id, mode: "subagent" as const, ...value, permissions: value.permissions ? [...value.permissions] : undefined },
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