import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectConfig } from "../../src/cli/doctor.js"
import { installConfig } from "../../src/cli/install.js"
import { GOAL_TOOL_PERMISSION } from "../../src/core/permissions.js"

describe("installer", () => {
  test("adds missing entries and preserves existing agent configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    const result = installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    expect(result.addedAgents).toContain("orchestrator")
    expect(result.addedCommands).toEqual([])
    expect(result.preservedCommands).toEqual([])
    expect(document.plugins).toHaveLength(1)
    expect(document.agents.orchestrator.mode).toBe("primary")
    expect(document.commands).toBeUndefined()
  })

  test("is idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const second = installConfig(path, {})
    expect(second.addedAgents).toEqual([])
    expect(second.addedCommands).toEqual([])
  })

  test("recognizes source and built local plugin entrypoints", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const path = join(directory, "opencode.jsonc")
    const config = {
      plugins: [{ package: "../../dist/index.js" }],
      agents: {},
    }
    writeFileSync(path, JSON.stringify(config))

    const report = inspectConfig(path)

    expect(report.checks.find((check) => check.name === "plugin")?.status).toBeUndefined()
  })

  test("allows the shared goal-tool permission for the orchestrator after deny-all", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    const permissions = document.agents.orchestrator.permissions as Array<{ action: string; resource: string; effect: string }>
    const goalRules = permissions.filter((rule) => rule.action === GOAL_TOOL_PERMISSION)
    const denyAllIndex = permissions.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny")
    const goalIndex = permissions.findIndex((rule) => rule.action === GOAL_TOOL_PERMISSION)

    expect(goalRules).toHaveLength(1)
    expect(goalRules[0]).toEqual({ action: GOAL_TOOL_PERMISSION, resource: "*", effect: "allow" })
    expect(denyAllIndex).toBeGreaterThanOrEqual(0)
    // The allow rule must come after the deny-all so last-match-wins keeps the goal tools visible.
    expect(goalIndex).toBeGreaterThan(denyAllIndex)
  })

  test("denies the shared goal-tool permission to every worker", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    const workerIds = ["planner", "explore", "implementer", "reviewer"]
    for (const id of workerIds) {
      const permissions = document.agents[id].permissions as Array<{ action: string; resource: string; effect: string }>
      const goalRules = permissions.filter((rule) => rule.action === GOAL_TOOL_PERMISSION)
      const denyAllIndex = permissions.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny")
      expect(goalRules).toHaveLength(1)
      expect(goalRules[0]).toEqual({ action: GOAL_TOOL_PERMISSION, resource: "*", effect: "deny" })
      expect(denyAllIndex).toBeGreaterThanOrEqual(0)
      expect(permissions.findIndex((rule) => rule.action === GOAL_TOOL_PERMISSION)).toBeGreaterThan(denyAllIndex)
    }
  })

  test("reinstall keeps a single goal-tool rule instead of duplicating it", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    const orchestratorPermissions = document.agents.orchestrator.permissions as Array<{ action: string }>
    expect(orchestratorPermissions.filter((rule: { action: string }) => rule.action === GOAL_TOOL_PERMISSION)).toHaveLength(1)
    expect((document.agents.explore.permissions as Array<{ action: string }>).filter((rule: { action: string }) => rule.action === GOAL_TOOL_PERMISSION)).toHaveLength(1)
  })

  test("keeps the goal-tool rules from hiding under deny-all (V2 tool visibility semantics)", () => {
    // Replicates how the pinned V2 core decides tool visibility: the last rule
    // whose action matches, with a deny on resource "*", removes the tool from
    // the model's toolset. The goal tools declare one shared permission action.
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    const orchestratorRules = document.agents.orchestrator.permissions as Rule[]
    const workerRules = document.agents.explore.permissions as Rule[]

    expect(whollyDisabled(GOAL_TOOL_PERMISSION, orchestratorRules)).toBe(false)
    expect(whollyDisabled(GOAL_TOOL_PERMISSION, workerRules)).toBe(true)
    // The denial is not limited to the visibility filter: workers stay hidden
    // even if a later rule for a different action is appended.
    expect(whollyDisabled(GOAL_TOOL_PERMISSION, [...workerRules, { action: "read", resource: "*", effect: "allow" }])).toBe(true)
  })

  test("preserves a user's explicit goal-tool ask across installs", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const first = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    const permissions = first.agents.orchestrator.permissions as Rule[]
    const askIndex = permissions.findIndex((rule) => rule.action === GOAL_TOOL_PERMISSION)
    permissions[askIndex] = { action: GOAL_TOOL_PERMISSION, resource: "*", effect: "ask" }
    writeFileSync(path, JSON.stringify(first))

    installConfig(path, {})

    const second = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    const rules = second.agents.orchestrator.permissions as Rule[]
    expect(rules.filter((rule) => rule.action === GOAL_TOOL_PERMISSION)).toEqual([
      { action: GOAL_TOOL_PERMISSION, resource: "*", effect: "ask" },
    ])
  })
})

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

// Mirrors the V2 core `whollyDisabled` visibility gate: a rule whose action
// matches and whose resource is exactly "*" with effect "deny" removes the
// tool from the agent's toolset entirely.
function whollyDisabled(action: string, rules: readonly Rule[]): boolean {
  const rule = [...rules].reverse().find((candidate) => wildcardMatch(action, candidate.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s").test(value)
}
