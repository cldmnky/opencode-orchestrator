import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectConfig, liveChecks, type DoctorApiRunner } from "../../src/cli/doctor.js"
import { formatInstallDiff, migrateConfig, planInstallConfig } from "../../src/cli/install.js"

describe("Phase 8 installer modes", () => {
  test("check planning is deterministic and does not create the target", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-check-"))
    const path = join(directory, "nested", "opencode.jsonc")
    const first = planInstallConfig(path, {}, "./plugin.js")
    const second = planInstallConfig(path, {}, "./plugin.js")

    expect(existsSync(path)).toBe(false)
    expect(first.changed).toBe(true)
    expect(first.content).toBe(second.content)
  })

  test("migration creates a backup, refreshes generated permissions, and preserves an exact user rule", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(
      path,
      `{
  // user comment
  "plugins": [{ "package": "./plugin.js" }],
  "agents": {
    "orchestrator": {
      "mode": "primary",
      "permissions": [
        { "action": "orchestrator_goal", "resource": "*", "effect": "ask" },
        { "action": "orchestrator_cd", "resource": "*", "effect": "deny" }
      ],
       "system": "Parent: call orchestrator_task_complexity_classify only after collecting all eight structured facts (independent_subtasks, dependent_stages, files_modules, independent_review, external_side_effects, shared_mutable_state, security_compliance_risk, expected_parallelism_value)."
    }
  }
}
`,
    )

    const result = migrateConfig(path, {}, "./plugin.js")
    const migrated = readFileSync(path, "utf8")
    const backup = readFileSync(result.backupPath!, "utf8")
    expect(result.backupPath).toBeDefined()
    expect(backup).toContain("task_complexity_classify")
    expect(migrated).toContain("// user comment")
    expect(migrated).not.toContain("orchestrator_cd")
    expect(migrated).not.toContain("task_complexity_classify")
    expect(migrated).toContain('"effect": "ask"')
    expect(migrated).toContain("orchestrator_review_submit")
  })

  test("migration keeps custom prompt prose even when it mentions a removed name", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-prompt-"))
    const path = join(directory, "opencode.jsonc")
    const custom = "User documentation mentions task_complexity_classify as historical context."
    writeFileSync(
      path,
      JSON.stringify({
        plugins: [{ package: "./plugin.js" }],
        agents: { orchestrator: { mode: "primary", system: custom, permissions: [] } },
      }),
    )

    migrateConfig(path, {}, "./plugin.js")
    const migrated = readFileSync(path, "utf8")
    expect(migrated).toContain(custom)
    expect(migrated).toContain("You are the conductor, not a worker of last resort.")
  })

  test("migration rejects malformed JSONC without creating a backup or changing the file", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-migrate-invalid-"))
    const path = join(directory, "opencode.jsonc")
    const source = '{ "plugins": [ }\n'
    writeFileSync(path, source)

    expect(() => migrateConfig(path, {}, "./plugin.js")).toThrow(/Invalid JSONC configuration/)
    expect(readFileSync(path, "utf8")).toBe(source)
    expect(existsSync(`${path}.bak`)).toBe(false)
  })

  test("check diff output stays bounded for a large planned document", () => {
    const source = `{"value":"${"a".repeat(40_000)}"}`
    const content = `{"value":"${"b".repeat(40_000)}"}`
    const diff = formatInstallDiff("/workspace/opencode.jsonc", source, content)
    expect(diff.length).toBeLessThanOrEqual(32 * 1024 + 120)
    expect(diff).toContain("install diff truncated")
  })
})

describe("Phase 8 live doctor", () => {
  test("uses opencode api with deep-object location scope and parses bounded fields", async () => {
    const calls: string[][] = []
    const runner: DoctorApiRunner = async (args) => {
      calls.push([...args])
      const path = args[2] ?? ""
      if (path.startsWith("/api/plugin")) {
        return { exitCode: 0, stdout: JSON.stringify({ data: [{ id: "opencode-orchestrator", state: { status: "active" }, features: { tui: true } }] }), stderr: "secret header" }
      }
      if (path.startsWith("/api/command")) return { exitCode: 0, stdout: JSON.stringify({ data: [{ name: "goal" }] }), stderr: "" }
      if (path.startsWith("/api/agent")) return { exitCode: 0, stdout: JSON.stringify({ data: [{ id: "orchestrator" }] }), stderr: "" }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ output: { githubCapabilityProbe: { available: true }, worktreeTools: { available: false }, legacyStateCount: 0 } }),
        stderr: "secret token",
      }
    }

    const checks = await liveChecks({ directory: "/workspace/project", expectedAgents: ["orchestrator"], expectedCommands: ["goal"], runner })
    expect(checks.find((check) => check.name === "live-plugin")?.status).toBe("pass")
    expect(checks.find((check) => check.name === "live-github-capability")?.status).toBe("pass")
    expect(checks.find((check) => check.name === "live-worktree-tools")?.message).toContain("disabled")
    expect(checks.every((check) => !check.message.includes("secret"))).toBe(true)
    expect(calls).toHaveLength(4)
    expect(calls.every((args) => args.some((arg) => arg.includes("location[directory]=%2Fworkspace%2Fproject")))).toBe(true)
  })

  test("static doctor detects removed command entries and missing generated permission families without failing custom config", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"))
    const path = join(directory, "opencode.jsonc")
    writeFileSync(path, JSON.stringify({ plugins: ["./missing/dist/index.js"], commands: { restructure: {} }, agents: {} }))
    const report = inspectConfig(path)
    expect(report.checks.find((check) => check.name === "removed-commands")?.status).toBe("warn")
    expect(report.checks.find((check) => check.name === "plugin-entrypoint")?.status).toBe("warn")
  })

  test("live doctor turns thrown API runner failures into bounded checks", async () => {
    const checks = await liveChecks({
      directory: "/workspace/project",
      runner: async () => {
        throw new Error("secret response body")
      },
    })
    expect(checks).toEqual([{ name: "live-plugin", status: "fail", message: "opencode api plugin request exited -1" }])
    expect(JSON.stringify(checks)).not.toContain("secret")
  })

  test("live doctor refuses an oversized API response before parsing it", async () => {
    const checks = await liveChecks({
      directory: "/workspace/project",
      runner: async () => ({ exitCode: 0, stdout: "x".repeat(512 * 1024 + 1), stderr: "" }),
    })
    expect(checks).toEqual([{ name: "live-plugin", status: "fail", message: "opencode api plugin request exited -1" }])
  })
})
