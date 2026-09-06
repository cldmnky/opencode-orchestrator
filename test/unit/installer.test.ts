import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { inspectConfig, mergeStatus, runtimeChecks, type DoctorRunner } from "../../src/cli/doctor.js"
import { configRelativePluginReference, installConfig, isLocalPluginReference, pluginEntryForRuntimeFile } from "../../src/cli/install.js"
import { DISTRIBUTION_NAME, LEGACY_DISTRIBUTION_NAME, SCOPED_DISTRIBUTION_NAME } from "../../src/core/package-identity.js"
import { GOAL_TOOL_PERMISSION, OBSERVABILITY_TOOL_PERMISSION, ORCHESTRATION_TOOL_PERMISSION } from "../../src/core/permissions.js"

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
    expect(configRelativePluginReference(join(project, "opencode.jsonc"), join(project, "node_modules", "opencode-v2-agent-orchestrator", "dist", "index.js"))).toBe(
      "./node_modules/opencode-v2-agent-orchestrator/dist/index.js",
    )
    expect(configRelativePluginReference(join(project, "config", "opencode.jsonc"), join(project, "src", "index.ts"))).toBe("../src/index.ts")
  })

  test.skipIf(process.platform !== "win32")("keeps a cross-volume reference absolute instead of ./ -prefixing it", () => {
    expect(configRelativePluginReference("C:\\proj\\opencode.jsonc", "D:\\proj\\dist\\index.js")).toBe("D:/proj/dist/index.js")
  })

  test("recognizes local plugin references", () => {
    expect(isLocalPluginReference("./node_modules/opencode-v2-agent-orchestrator/dist/index.js")).toBe(true)
    expect(isLocalPluginReference("../src/index.ts")).toBe(true)
    expect(isLocalPluginReference("/absolute/path/index.ts")).toBe(true)
    expect(isLocalPluginReference("file:///absolute/path/dist/index.js")).toBe(true)
    expect(isLocalPluginReference("opencode-v2-agent-orchestrator")).toBe(false)
    expect(isLocalPluginReference("opencode-orchestrator")).toBe(false)
    expect(isLocalPluginReference("@cldmnky/opencode-orchestrator")).toBe(false)
    expect(isLocalPluginReference("@cldmnky/opencode-v2-agent-orchestrator")).toBe(false)
  })
})

describe("legacy plugin migration", () => {
  const reference = "./node_modules/opencode-v2-agent-orchestrator/dist/index.js"

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

  test("preserves a canonical bare entry instead of duplicating a local reference", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: [{ package: "opencode-v2-agent-orchestrator", options: { max_parallel: 2 } }] }))

    installConfig(path, {}, reference)
    installConfig(path, {}, reference)

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.plugins).toHaveLength(1)
    expect(document.plugins[0].package).toBe("opencode-v2-agent-orchestrator")
    expect(document.plugins[0].options.max_parallel).toBe(2)
  })

  test("keeps a canonical bare entry and drops a coexisting legacy duplicate", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["opencode-orchestrator", { package: DISTRIBUTION_NAME }] }))

    installConfig(path, {}, reference)

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.plugins).toHaveLength(1)
    expect(document.plugins[0].package).toBe(DISTRIBUTION_NAME)
  })

  test("preserves a canonical scoped entry instead of duplicating a local reference", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: [{ package: SCOPED_DISTRIBUTION_NAME, options: { max_parallel: 2 } }] }))

    installConfig(path, {}, reference)
    installConfig(path, {}, reference)

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.plugins).toHaveLength(1)
    expect(document.plugins[0].package).toBe(SCOPED_DISTRIBUTION_NAME)
    expect(document.plugins[0].options.max_parallel).toBe(2)
  })

  test("migrates a legacy bare entry in place when explicitly installing the bare canonical reference", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: [LEGACY_DISTRIBUTION_NAME] }))

    installConfig(path, {}, DISTRIBUTION_NAME)
    installConfig(path, {}, DISTRIBUTION_NAME)

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.plugins).toHaveLength(1)
    expect(document.plugins[0].package).toBe(DISTRIBUTION_NAME)
  })

  test("migrates a legacy object entry in place when explicitly installing the scoped canonical reference", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: [{ package: LEGACY_DISTRIBUTION_NAME, options: { max_parallel: 2 }, tui: true }] }))

    installConfig(path, {}, SCOPED_DISTRIBUTION_NAME)

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.plugins).toHaveLength(1)
    expect(document.plugins[0].package).toBe(SCOPED_DISTRIBUTION_NAME)
    expect(document.plugins[0].options.max_parallel).toBe(2)
    expect(document.plugins[0].tui).toBe(true)
  })

  test("removes legacy duplicates when a canonical entry already exists and a canonical reference is passed explicitly", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: [LEGACY_DISTRIBUTION_NAME, { package: DISTRIBUTION_NAME }] }))

    installConfig(path, {}, DISTRIBUTION_NAME)

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.plugins).toHaveLength(1)
    expect(document.plugins[0].package).toBe(DISTRIBUTION_NAME)
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
    expect(reference).not.toBe("opencode-v2-agent-orchestrator")
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

  test("doctor accepts config-relative local entries, normalized separators, canonical bare, and scoped names", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const cases = [
      "./src/index.ts",
      "./node_modules/opencode-v2-agent-orchestrator/dist/index.js",
      ".\\node_modules\\opencode-v2-agent-orchestrator\\dist\\index.js",
      DISTRIBUTION_NAME,
      SCOPED_DISTRIBUTION_NAME,
    ]
    for (const packageValue of cases) {
      const path = join(directory, `config-${cases.indexOf(packageValue)}.jsonc`)
      writeFileSync(path, JSON.stringify({ plugins: [{ package: packageValue }], agents: {} }))
      const report = inspectConfig(path)
      expect(report.checks.find((check) => check.name === "plugin")?.status, packageValue).toBeUndefined()
      expect(report.checks.find((check) => check.name === "options")?.status, packageValue).toBe("pass")
    }
  })

  test("doctor treats the legacy distribution name as an actionable failure without owner/conflict wording", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["opencode-orchestrator"], agents: {} }))

    const report = inspectConfig(path)

    const pluginCheck = report.checks.find((check) => check.name === "plugin")
    expect(pluginCheck?.status).toBe("fail")
    expect(pluginCheck?.message).toContain("legacy")
    expect(pluginCheck?.message).toContain("opencode-orchestrator")
    expect(pluginCheck?.message).not.toContain("agnusdei1207")
    expect(pluginCheck?.message).not.toContain("unrelated")
    const optionsCheck = report.checks.find((check) => check.name === "options")
    expect(optionsCheck?.status).not.toBe("pass")
    expect(report.status).toBe("error")
  })

  test("doctor accepts safe V2 string entries (source, dist, canonical bare, and scoped)", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const stringCases = [
      "./src/index.ts",
      "./node_modules/opencode-v2-agent-orchestrator/dist/index.js",
      DISTRIBUTION_NAME,
      SCOPED_DISTRIBUTION_NAME,
    ]
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
    writeFileSync(path, JSON.stringify({ plugins: ["opencode-orchestrator", "./node_modules/opencode-v2-agent-orchestrator/dist/index.js"], agents: doctorAgents }))

    const report = inspectConfig(path)

    const pluginCheck = report.checks.find((check) => check.name === "plugin")
    expect(pluginCheck?.status).toBe("warn")
    expect(pluginCheck?.status).not.toBe("fail")
    expect(pluginCheck?.message).toContain("legacy")
    expect(report.status).toBe("warning")
  })

  test("doctor rejects scoped package names it does not recognize (including the old scoped spelling)", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const rejects = ["@unrelated-scope/opencode-orchestrator", "@cldmnky/opencode-orchestrator"]
    for (const [index, packageValue] of rejects.entries()) {
      const path = join(directory, `scoped-${index}.jsonc`)
      writeFileSync(path, JSON.stringify({ plugins: [packageValue], agents: {} }))

      const report = inspectConfig(path)

      expect(report.checks.find((check) => check.name === "plugin")?.status, packageValue).toBe("fail")
    }
  })

  test("doctor accepts the canonical bare distribution name as this plugin", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: [{ package: "opencode-v2-agent-orchestrator", options: { max_parallel: 2 } }], agents: doctorAgents }))

    const report = inspectConfig(path)

    expect(report.checks.find((check) => check.name === "plugin")?.status).toBeUndefined()
    expect(report.checks.find((check) => check.name === "options")?.status).toBe("pass")
    expect(report.status).not.toBe("error")
  })

  test("doctor reports a static GitHub MCP limitation note without printing credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["opencode-v2-agent-orchestrator"], agents: doctorAgents }))

    const report = inspectConfig(path)

    const check = report.checks.find((item) => item.name === "mcp-github")
    expect(check?.status).toBe("warn")
    expect(check?.message).toContain("cannot prove")
    expect(check?.message).toContain("merged")
    expect(check?.message).toContain("authentication")
    expect(check?.message).toContain("permission grants")
    expect(check?.message).toContain("server-side `gh` tools")
    expect(check?.message).toContain("github_capabilities")
    expect(check?.message).toContain("No headers, environment values, OAuth tokens, or other credentials are read or printed by doctor")
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

  test("allows the orchestration validation permission for the orchestrator and denies it to workers", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    const orchestratorPermissions = document.agents.orchestrator.permissions as Rule[]
    expect(orchestratorPermissions.filter((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toEqual([
      { action: ORCHESTRATION_TOOL_PERMISSION, resource: "*", effect: "allow" },
    ])
    const denyAllIndex = orchestratorPermissions.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny")
    expect(orchestratorPermissions.findIndex((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toBeGreaterThan(denyAllIndex)

    for (const id of ["planner", "explore", "implementer", "reviewer"]) {
      const workerPermissions = document.agents[id].permissions as Rule[]
      expect(workerPermissions.filter((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toEqual([
        { action: ORCHESTRATION_TOOL_PERMISSION, resource: "*", effect: "deny" },
      ])
      expect(workerPermissions.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny")).toBeGreaterThanOrEqual(0)
      expect(workerPermissions.findIndex((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toBeGreaterThan(
        workerPermissions.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny"),
      )
    }
  })

  test("reinstall never duplicates the orchestration validation permission rule", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    const orchestratorPermissions = document.agents.orchestrator.permissions as Rule[]
    expect(orchestratorPermissions.filter((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toHaveLength(1)
    const workerPermissions = document.agents.explore.permissions as Rule[]
    expect(workerPermissions.filter((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toHaveLength(1)
  })

  test("preserves a user's exact rule for the orchestration validation permission across installs", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const first = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    const permissions = first.agents.orchestrator.permissions as Rule[]
    const validationIndex = permissions.findIndex((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)
    permissions[validationIndex] = { action: ORCHESTRATION_TOOL_PERMISSION, resource: "*", effect: "ask" }
    writeFileSync(path, JSON.stringify(first))

    installConfig(path, {})

    const second = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    const rules = second.agents.orchestrator.permissions as Rule[]
    expect(rules.filter((rule) => rule.action === ORCHESTRATION_TOOL_PERMISSION)).toEqual([
      { action: ORCHESTRATION_TOOL_PERMISSION, resource: "*", effect: "ask" },
    ])
  })

  test("installs the bounded nested-delegation graph as exact subagent allows after a broad deny", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    // The exact graph: orchestrator→all roles; implementation→planning+research;
    // planning→research; review→research; research→no delegation at all.
    const graph: Record<string, string[]> = {
      orchestrator: ["planner", "explore", "implementer", "reviewer"],
      planner: ["explore"],
      explore: [],
      implementer: ["planner", "explore"],
      reviewer: ["explore"],
    }
    for (const [id, targets] of Object.entries(graph)) {
      const rules = document.agents[id].permissions as Rule[]
      const subagentRules = rules.filter((rule) => rule.action === "subagent")

      // Exactly one broad deny, first among the subagent rules.
      const denies = subagentRules.filter((rule) => rule.resource === "*" && rule.effect === "deny")
      expect(denies, id).toEqual([{ action: "subagent", resource: "*", effect: "deny" }])

      // Only the role-graph edges are allowed, each exactly once, in graph order.
      const allows = subagentRules.filter((rule) => rule.effect === "allow")
      expect(allows.map((rule) => rule.resource), id).toEqual(targets)

      // Every allow comes after the broad deny so last-match-wins resolves to
      // the exact edge set, and no rule targets any other agent.
      const denyIndex = rules.findIndex((rule) => rule.action === "subagent" && rule.resource === "*" && rule.effect === "deny")
      for (const rule of allows) {
        expect(rules.indexOf(rule), `${id}:${rule.resource}`).toBeGreaterThan(denyIndex)
        expect(targets).toContain(rule.resource)
      }
    }
  })

  test("denies every non-graph nested delegation edge", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    // Simulates the V2 core decision: the last matching rule wins.
    const effective = (rules: Rule[], resource: string): string | undefined =>
      [...rules].reverse().find((rule) => rule.action === "subagent" && (rule.resource === "*" || rule.resource === resource))?.effect

    const forbidden: Array<[string, string]> = [
      ["planner", "implementer"],
      ["planner", "reviewer"],
      ["planner", "orchestrator"],
      ["explore", "planner"],
      ["explore", "orchestrator"],
      ["implementer", "reviewer"],
      ["implementer", "orchestrator"],
      ["reviewer", "planner"],
      ["reviewer", "implementer"],
      ["reviewer", "orchestrator"],
    ]
    for (const [worker, target] of forbidden) {
      const rules = document.agents[worker].permissions as Rule[]
      expect(effective(rules, target), `${worker}->${target}`).toBe("deny")
    }
    // The orchestrator may reach every configured role.
    const orchestratorRules = document.agents.orchestrator.permissions as Rule[]
    for (const target of ["planner", "explore", "implementer", "reviewer"]) {
      expect(effective(orchestratorRules, target), `orchestrator->${target}`).toBe("allow")
    }
  })

  test("keeps research web tools directly allowed while nested delegation stays denied", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    const explore = document.agents.explore.permissions as Rule[]
    expect(explore.filter((rule) => rule.action === "webfetch")).toEqual([{ action: "webfetch", resource: "*", effect: "allow" }])
    expect(explore.filter((rule) => rule.action === "websearch")).toEqual([{ action: "websearch", resource: "*", effect: "allow" }])
    expect(explore.filter((rule) => rule.action === "subagent" && rule.effect === "allow")).toEqual([])

    // Research behavior is stated in the installed system prompt too.
    const exploreSystem = document.agents.explore.system as string
    expect(exploreSystem).toContain("webfetch and websearch directly")
    expect(exploreSystem).toContain("never launch subagents")
    const implementerSystem = document.agents.implementer.system as string
    expect(implementerSystem).toContain("only the planning and research roles")
    const orchestratorSystem = document.agents.orchestrator.system as string
    expect(orchestratorSystem).toContain("Bounded nested delegation graph")
    expect(orchestratorSystem).toContain("orchestrator→all configured roles")
  })

  test("sets experimental.subagent_depth to 3 on a fresh install", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    // Native V2 subagent depth defaults to 1, which would block the approved
    // deepest path orchestrator -> implementation -> planning -> research.
    expect(document.experimental).toEqual({ subagent_depth: 3 })
  })

  test("adds subagent_depth to an existing experimental object and preserves unrelated keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ experimental: { something: true, nested: { a: 1 } }, agents: {} }))

    installConfig(path, {})

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.experimental).toEqual({ subagent_depth: 3, something: true, nested: { a: 1 } })
  })

  test("preserves explicit subagent_depth values, lower, higher, or otherwise", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    for (const [index, depth] of [1, 2, 8, "3", null, false].entries()) {
      const path = join(directory, `depth-${index}.jsonc`)
      writeFileSync(path, JSON.stringify({ experimental: { subagent_depth: depth } }))

      installConfig(path, {})

      const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
      expect(document.experimental.subagent_depth, String(depth)).toBe(depth)
      // Nothing else was added inside the user's experimental object.
      expect(Object.keys(document.experimental), String(depth)).toEqual(["subagent_depth"])
    }
  })

  test("rejects a non-object experimental entry without writing any change", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    for (const [index, invalid] of [[1, 2], "deep", 42, null].entries()) {
      const path = join(directory, `invalid-${index}.jsonc`)
      const source = JSON.stringify({ experimental: invalid })
      writeFileSync(path, source)

      expect(() => installConfig(path, {}), JSON.stringify(invalid)).toThrow(
        /Invalid experimental entry at .*: expected an object/,
      )
      // The rejection is consistent with the other installer validation: the
      // file is left exactly as authored instead of being overwritten.
      expect(readFileSync(path, "utf8")).toBe(source)
    }
  })

  test("depth insertion is idempotent and leaves the config byte-identical on reinstall", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const first = readFileSync(path, "utf8")

    const second = installConfig(path, {})
    expect(second.addedAgents).toEqual([])
    expect(readFileSync(path, "utf8")).toBe(first)

    const document = JSON.parse(first) as Record<string, any>
    expect(document.experimental).toEqual({ subagent_depth: 3 })
  })

  test("an older install without experimental gains the depth on reinstall without re-adding agents", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const withoutDepth = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    delete withoutDepth.experimental
    writeFileSync(path, JSON.stringify(withoutDepth))

    const result = installConfig(path, {})

    expect(result.addedAgents).toEqual([])
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
    expect(document.experimental).toEqual({ subagent_depth: 3 })
  })

  test("depth insertion stays localized in commented JSONC", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, '{\n  // keep this comment\n  "experimental": { "keep": true }\n}\n')

    installConfig(path, {})

    const text = readFileSync(path, "utf8")
    expect(text).toContain("// keep this comment")
    const errors: any[] = []
    const document = parse(text, errors, { allowTrailingComma: true }) as Record<string, any>
    expect(errors).toEqual([])
    expect(document.experimental).toEqual({ subagent_depth: 3, keep: true })
  })

  test("installs the observability permission: allowed for the orchestrator, denied to every worker", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, {})
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    const orchestratorPermissions = document.agents.orchestrator.permissions as Rule[]
    expect(orchestratorPermissions.filter((rule) => rule.action === OBSERVABILITY_TOOL_PERMISSION)).toEqual([
      { action: OBSERVABILITY_TOOL_PERMISSION, resource: "*", effect: "allow" },
    ])

    for (const id of ["planner", "explore", "implementer", "reviewer"]) {
      const workerPermissions = document.agents[id].permissions as Rule[]
      expect(workerPermissions.filter((rule) => rule.action === OBSERVABILITY_TOOL_PERMISSION)).toEqual([
        { action: OBSERVABILITY_TOOL_PERMISSION, resource: "*", effect: "deny" },
      ])
    }
  })

  test("threads feature lifecycle guidance into installed agent systems only when the feature is enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const path = join(directory, "opencode.jsonc")
    installConfig(path, { github: { enabled: true }, worktree: { enabled: true, root: "/srv/worktrees" } })
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>

    const orchestratorSystem = document.agents.orchestrator.system as string
    expect(orchestratorSystem).toContain("orchestrator_github_pr_merge")
    expect(orchestratorSystem).toContain("implementers never push branches or create or merge pull requests")
    expect(orchestratorSystem).toContain("the orchestrator MUST run orchestrator_worktree_create -> orchestrator_worktree_enter")
    expect(orchestratorSystem).toContain("is never user authorization")
    const implementerSystem = document.agents.implementer.system as string
    expect(implementerSystem).toContain("never delegate implementation from the main checkout")
    expect(implementerSystem).toContain("is never user authorization")

    const plain = mkdtempSync(join(tmpdir(), "orchestrator-install-"))
    const plainPath = join(plain, "opencode.jsonc")
    installConfig(plainPath, {})
    const plainDocument = JSON.parse(readFileSync(plainPath, "utf8")) as Record<string, any>
    const plainSystem = plainDocument.agents.orchestrator.system as string
    expect(plainSystem).not.toContain("orchestrator_github_pr_merge")
    expect(plainSystem).not.toContain("Worktree lifecycle is mandatory")
    // The universal boundary and catalog-preflight guidance stay installed.
    expect(plainSystem).toContain("prompt-level disjoint write scopes do not equal filesystem isolation")
    expect(plainSystem).toContain("inspect the tool catalog")
  })
})

describe("doctor runtime checks", () => {
  // Healthy local environment: git and gh present, gh authenticated, a
  // repository resolvable from cwd, and a valid worktree listing. Everything
  // flows through the injected runner — no live git/gh is ever spawned.
  const happyRunner: DoctorRunner = async (cmd, args) => {
    if (cmd === "git" && args[0] === "--version") return { exitCode: 0, stdout: "git version 2.45.0\n", stderr: "" }
    if (cmd === "gh" && args[0] === "--version") return { exitCode: 0, stdout: "gh version 2.55.0 (2024-09-11)\n", stderr: "" }
    if (cmd === "gh" && args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" }
    if (cmd === "gh" && args[0] === "repo") return { exitCode: 0, stdout: "acme/widgets\n", stderr: "" }
    if (cmd === "git" && args[0] === "worktree") return { exitCode: 0, stdout: "worktree /main\n", stderr: "" }
    return { exitCode: 0, stdout: "", stderr: "" }
  }

  test("passes when local git and gh look healthy, using only the mocked runner", async () => {
    const calls: string[][] = []
    const runner: DoctorRunner = async (cmd, args) => {
      calls.push([cmd, ...args])
      return happyRunner(cmd, args)
    }

    const checks = await runtimeChecks({ cwd: "/tmp/project", runner })

    const byName = new Map(checks.map((check) => [check.name, check]))
    expect(byName.get("git")?.status).toBe("pass")
    expect(byName.get("gh")?.status).toBe("pass")
    expect(byName.get("gh-auth")?.status).toBe("pass")
    expect(byName.get("gh-repo-view")?.status).toBe("pass")
    expect(byName.get("git-worktree-list")?.status).toBe("pass")
    expect(checks.some((check) => check.status === "fail")).toBe(false)
    expect(calls).toContainEqual(["git", "--version"])
    expect(calls).toContainEqual(["gh", "auth", "status"])
    expect(calls).toContainEqual(["git", "worktree", "list", "--porcelain"])
  })

  test("warns (never fails) when git or gh are missing and skips cascading gh checks", async () => {
    const runner: DoctorRunner = async (cmd, args) => {
      if (cmd === "git" && args[0] === "--version") return { exitCode: -1, stdout: "", stderr: "spawn git ENOENT" }
      if (cmd === "gh" && args[0] === "--version") return { exitCode: -1, stdout: "", stderr: "spawn gh ENOENT" }
      if (cmd === "git" && args[0] === "worktree") return { exitCode: -1, stdout: "", stderr: "not a git repository" }
      return happyRunner(cmd, args)
    }

    const checks = await runtimeChecks({ cwd: "/tmp/project", runner })

    const byName = new Map(checks.map((check) => [check.name, check]))
    expect(byName.get("git")?.status).toBe("warn")
    expect(byName.get("gh")?.status).toBe("warn")
    expect(byName.get("git-worktree-list")?.status).toBe("warn")
    // No cascading auth/repo checks when the gh binary is absent.
    expect(byName.get("gh-auth")).toBeUndefined()
    expect(byName.get("gh-repo-view")).toBeUndefined()
    expect(checks.some((check) => check.status === "fail")).toBe(false)

    const note = byName.get("runtime-authority")
    expect(note?.status).toBe("warn")
    expect(note?.message).toContain("authoritative")
    expect(note?.message).toContain("No headers, environment values, OAuth tokens")
  })

  test("reports gh auth by exit code only and never leaks its output", async () => {
    const runner: DoctorRunner = async (cmd, args) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { exitCode: 1, stdout: "gh auth status: not logged in\npat_github_secret_value would never be printed", stderr: "" }
      }
      return happyRunner(cmd, args)
    }

    const checks = await runtimeChecks({ cwd: "/tmp/project", runner })

    const auth = checks.find((check) => check.name === "gh-auth")
    expect(auth?.status).toBe("warn")
    expect(auth?.message).toContain("exited 1")
    expect(auth?.message).not.toContain("not logged in")
    expect(auth?.message).not.toContain("pat_github_secret")
    // The repo probe is skipped when authentication did not pass.
    expect(checks.find((check) => check.name === "gh-repo-view")).toBeUndefined()
  })

  test("runtime checks never escalate a static config failure to a different status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-runtime-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["opencode-orchestrator"], agents: {} }))

    const report = inspectConfig(path)
    expect(report.status).toBe("error")

    const runtime = await runtimeChecks({ cwd: directory, runner: happyRunner })
    const checks = [...report.checks, ...runtime]
    expect(mergeStatus(checks)).toBe("error")
    expect(runtime.some((check) => check.status === "fail")).toBe(false)
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
