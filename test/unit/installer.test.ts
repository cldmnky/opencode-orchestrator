import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectConfig } from "../../src/cli/doctor.js"
import { configRelativePluginReference, installConfig, isLocalPluginReference, pluginEntryForRuntimeFile } from "../../src/cli/install.js"
import { GOAL_TOOL_PERMISSION } from "../../src/core/permissions.js"

describe("plugin reference helpers", () => {
  test("derives the source entrypoint from src/cli/index.ts", () => {
    const root = join(tmpdir(), "helper-root")
    expect(pluginEntryForRuntimeFile(join(root, "src", "cli", "index.ts"))).toBe(join(root, "src", "index.ts"))
  })

  test("derives the source entrypoint from src/cli/install.ts", () => {
    const root = join(tmpdir(), "helper-root")
    expect(pluginEntryForRuntimeFile(join(root, "src", "cli", "install.ts"))).toBe(join(root, "src", "index.ts"))
  })

  test("derives the built entrypoint from dist/cli/index.js", () => {
    const root = join(tmpdir(), "helper-root")
    expect(pluginEntryForRuntimeFile(join(root, "dist", "cli", "index.js"))).toBe(join(root, "dist", "index.js"))
  })

  test("derives the built entrypoint from the exported dist/installer.js", () => {
    const root = join(tmpdir(), "helper-root")
    expect(pluginEntryForRuntimeFile(join(root, "dist", "installer.js"))).toBe(join(root, "dist", "index.js"))
  })

  test("throws for unsupported layouts instead of guessing", () => {
    expect(() => pluginEntryForRuntimeFile(join(tmpdir(), "unexpected", "cli.js"))).toThrow(/Unsupported installer layout/)
    expect(() => pluginEntryForRuntimeFile(join(tmpdir(), "src", "index.ts"))).toThrow(/Unsupported installer layout/)
  })

  test("makes config-relative POSIX references and dot-prefixes them", () => {
    const project = mkdtempSync(join(tmpdir(), "orchestrator-helpers-"))
    expect(configRelativePluginReference(join(project, "opencode.jsonc"), join(project, "src", "index.ts"))).toBe("./src/index.ts")
    expect(configRelativePluginReference(join(project, "opencode.jsonc"), join(project, "node_modules", "opencode-orchestrator", "dist", "index.js"))).toBe(
      "./node_modules/opencode-orchestrator/dist/index.js",
    )
    expect(configRelativePluginReference(join(project, "config", "opencode.jsonc"), join(project, "src", "index.ts"))).toBe("../src/index.ts")
  })

  test.skipIf(process.platform !== "win32")("keeps a cross-volume reference absolute instead of ./ -prefixing it", () => {
    expect(configRelativePluginReference("C:\\proj\\opencode.jsonc", "D:\\proj\\dist\\index.js")).toBe("D:/proj/dist/index.js")
  })

  test("recognizes local plugin references", () => {
    expect(isLocalPluginReference("./node_modules/opencode-orchestrator/dist/index.js")).toBe(true)
    expect(isLocalPluginReference("../src/index.ts")).toBe(true)
    expect(isLocalPluginReference("/absolute/path/index.ts")).toBe(true)
    expect(isLocalPluginReference("file:///absolute/path/dist/index.js")).toBe(true)
    expect(isLocalPluginReference("opencode-orchestrator")).toBe(false)
    expect(isLocalPluginReference("@cldmnky/opencode-orchestrator")).toBe(false)
  })
})

describe("legacy plugin migration", () => {
  const reference = "./node_modules/opencode-orchestrator/dist/index.js"

  test("migrates a legacy bare string in place with normal options", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["opencode-orchestrator"] }))

    installConfig(path, {}, reference)

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.plugins).toHaveLength(1)
    expect(document.plugins[0].package).toBe(reference)
    expect(document.plugins[0].options.orchestrator).toBe("orchestrator")
    expect(document.plugins[0].options.roles.planning).toBe("planner")
    expect(document.plugins).not.toContain("opencode-orchestrator")
  })

  test("migrates a legacy bare object preserving options and other fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: [{ package: "opencode-orchestrator", options: { max_parallel: 2 }, tui: true }] }))

    installConfig(path, {}, reference)

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.plugins).toHaveLength(1)
    expect(document.plugins[0].package).toBe(reference)
    expect(document.plugins[0].options.max_parallel).toBe(2)
    expect(document.plugins[0].tui).toBe(true)
  })

  test("legacy migration is idempotent and does not duplicate", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["opencode-orchestrator"] }))

    installConfig(path, {}, reference)
    const second = installConfig(path, {}, reference)

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(second.addedAgents).toEqual([])
    expect(document.plugins).toHaveLength(1)
    expect(document.plugins[0].package).toBe(reference)
  })

  test("keeps an existing local entry and removes a duplicate legacy one", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["opencode-orchestrator", { package: reference }] }))

    installConfig(path, {}, reference)

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.plugins).toHaveLength(1)
    expect(document.plugins[0].package).toBe(reference)
  })
})

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

  test("default output is a local, doctor-safe reference (no bare registry name)", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.plugins).toHaveLength(1)
    const entry = document.plugins[0]
    const reference = typeof entry === "string" ? entry : entry.package
    expect(reference).toMatch(/^(\.\/|\.\.\/|\/|file:\/\/)/)
    expect(reference).not.toBe("opencode-orchestrator")
    expect(reference).toMatch(/(\/src\/index\.ts|\/dist\/index\.js)$/)

    const report = inspectConfig(path)
    expect(report.checks.find((check) => check.name === "plugin")?.status).toBeUndefined()
    expect(report.status).not.toBe("error")
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

  test("doctor accepts config-relative local entries, normalized separators, and scoped names", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const cases = [
      "./src/index.ts",
      "./node_modules/opencode-orchestrator/dist/index.js",
      ".\\node_modules\\opencode-orchestrator\\dist\\index.js",
      "@cldmnky/opencode-orchestrator",
    ]
    for (const packageValue of cases) {
      const path = join(directory, `config-${cases.indexOf(packageValue)}.jsonc`)
      writeFileSync(path, JSON.stringify({ plugins: [{ package: packageValue }], agents: {} }))
      const report = inspectConfig(path)
      expect(report.checks.find((check) => check.name === "plugin")?.status, packageValue).toBeUndefined()
      expect(report.checks.find((check) => check.name === "options")?.status, packageValue).toBe("pass")
    }
  })

  test("doctor treats the legacy bare registry name as an actionable failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["opencode-orchestrator"], agents: {} }))

    const report = inspectConfig(path)

    const pluginCheck = report.checks.find((check) => check.name === "plugin")
    expect(pluginCheck?.status).toBe("fail")
    expect(pluginCheck?.message).toContain("registry")
    expect(pluginCheck?.message).toContain("opencode-orchestrator")
    const optionsCheck = report.checks.find((check) => check.name === "options")
    expect(optionsCheck?.status).not.toBe("pass")
    expect(report.status).toBe("error")
  })

  test("doctor accepts safe V2 string entries (source, dist, and scoped)", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const stringCases = ["./src/index.ts", "./node_modules/opencode-orchestrator/dist/index.js", "@cldmnky/opencode-orchestrator"]
    for (const [index, packageValue] of stringCases.entries()) {
      const path = join(directory, `string-${index}.jsonc`)
      writeFileSync(path, JSON.stringify({ plugins: [packageValue], agents: doctorAgents }))
      const report = inspectConfig(path)
      expect(report.checks.find((check) => check.name === "plugin")?.status, packageValue).toBeUndefined()
      expect(report.checks.find((check) => check.name === "options")?.status, packageValue).toBe("pass")
      expect(report.status, packageValue).not.toBe("error")
    }
  })

  test("doctor warns (not fails) when a legacy bare entry coexists with a safe string", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["opencode-orchestrator", "./node_modules/opencode-orchestrator/dist/index.js"], agents: doctorAgents }))

    const report = inspectConfig(path)

    const pluginCheck = report.checks.find((check) => check.name === "plugin")
    expect(pluginCheck?.status).toBe("warn")
    expect(pluginCheck?.status).not.toBe("fail")
    expect(pluginCheck?.message).toContain("legacy")
    expect(report.status).toBe("warning")
  })

  test("doctor rejects arbitrary scoped package names", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["@unrelated-scope/opencode-orchestrator"], agents: {} }))

    const report = inspectConfig(path)

    expect(report.checks.find((check) => check.name === "plugin")?.status).toBe("fail")
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

// Complete agent set matching installer defaults so doctor's agent checks pass
// and the overall report status reflects only the plugin-related checks.
const doctorAgents: Record<string, { mode: string; model: string }> = {
  orchestrator: { mode: "primary", model: "provider/model" },
  planner: { mode: "subagent", model: "provider/model" },
  explore: { mode: "subagent", model: "provider/model" },
  implementer: { mode: "subagent", model: "provider/model" },
  reviewer: { mode: "subagent", model: "provider/model" },
}

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
