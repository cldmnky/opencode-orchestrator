import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectConfig } from "../../src/cli/doctor.js"
import { installConfig } from "../../src/cli/install.js"

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
})
