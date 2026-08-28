import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { parseOptions } from "../../src/core/config.js"
import { runCommand } from "../../src/opencode-v2/commands/runtime.js"
import { goalStorageKey, runStorageKey, stopStorageKey } from "../../src/opencode-v2/goal/state.js"

describe("runtime commands", () => {
  test("selects and includes a plan before prompting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    mkdirSync(join(directory, ".orchestrator", "plans"), { recursive: true })
    writeFileSync(join(directory, ".orchestrator", "plans", "release.md"), "# Release\n\n- Verify the build\n")
    const fixture = runtimeFixture(directory)

    await runCommand(fixture.context, parseOptions({}), "run-plan", invocation("release"), undefined)

    expect(fixture.prompts).toHaveLength(1)
    expect(fixture.prompts[0].text).toContain(".orchestrator/plans/release.md")
    expect(fixture.prompts[0].text).toContain("Verify the build")
    expect(fixture.values.get(runStorageKey(fixture.context.location, "session"))).toMatchObject({
      plan: ".orchestrator/plans/release.md",
      status: "active",
    })
  })

  test("rejects ambiguous plans and unsafe restructure or polish paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    mkdirSync(join(directory, ".orchestrator", "plans"), { recursive: true })
    writeFileSync(join(directory, ".orchestrator", "plans", "one.md"), "# One\n")
    writeFileSync(join(directory, ".orchestrator", "plans", "two.md"), "# Two\n")
    const fixture = runtimeFixture(directory)
    const options = parseOptions({})

    await runCommand(fixture.context, options, "run-plan", invocation(""), undefined)
    await runCommand(fixture.context, options, "restructure", invocation("../outside"), undefined)
    await runCommand(fixture.context, options, "polish", invocation("/outside"), undefined)

    expect(fixture.prompts).toHaveLength(0)
    expect(fixture.statuses).toHaveLength(3)
    expect(fixture.statuses[0]).toContain("no sole incomplete plan")
    expect(fixture.statuses[1]).toContain("relative path")
    expect(fixture.statuses[2]).toContain("relative paths")
  })

  test("builds a factual handover without prompting a model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    const fixture = runtimeFixture(directory)
    ;(fixture.context as any).session.context = async () => [
      { type: "user", text: "keep the API stable" },
      { type: "assistant", content: [{ type: "text", text: "Implemented the change." }] },
    ]
    ;(fixture.context as any).vcs.status = async () => [{ file: "src/index.ts", status: "modified" }]
    ;(fixture.context as any).vcs.diff = async () => [{ file: "src/index.ts", patch: "+API_KEY=hidden" }]

    await runCommand(fixture.context, parseOptions({}), "handover", invocation("continue API work"), undefined)

    expect(fixture.prompts).toHaveLength(0)
    expect(fixture.statuses[0]).toContain("keep the API stable")
    expect(fixture.statuses[0]).toContain("src/index.ts")
    expect(fixture.statuses[0]).toContain("API_KEY=[redacted]")
  })

  test("halts a stored plan run without deleting it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    const fixture = runtimeFixture(directory)
    const key = runStorageKey(fixture.context.location, "session")
    fixture.values.set(key, {
      version: 1,
      sessionID: "session",
      plan: ".orchestrator/plans/release.md",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    })

    await runCommand(fixture.context, parseOptions({}), "halt", invocation("run"), undefined)

    expect(fixture.values.get(key)).toMatchObject({ status: "paused" })
    expect(fixture.statuses[0]).toContain("plan run paused")
  })

  test("clears the automation stop flag when a goal is cleared", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    const fixture = runtimeFixture(directory)
    const goalKey = goalStorageKey(fixture.context.location, "session")
    const stopKey = stopStorageKey(fixture.context.location, "session")
    fixture.values.set(goalKey, {
      version: 1,
      sessionID: "session",
      objective: "finish the work",
      status: "paused",
      createdAt: 1,
      updatedAt: 1,
      continuationCount: 0,
    })
    fixture.values.set(stopKey, { version: 1, sessionID: "session", stoppedAt: 1 })

    await runCommand(fixture.context, parseOptions({}), "goal", invocation("clear"), undefined)

    expect(fixture.values.has(goalKey)).toBe(false)
    expect(fixture.values.has(stopKey)).toBe(false)
  })
})

function invocation(text: string) {
  return { sessionID: "session", prompt: { text }, delivery: "queue" as const }
}

function runtimeFixture(directory: string) {
  const values = new Map<string, unknown>()
  const prompts: Array<{ text: string }> = []
  const statuses: string[] = []
  const context = {
    location: { directory, project: { id: "project" } },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => void values.set(key, value),
      remove: async (key: string) => void values.delete(key),
    },
    agent: {
      get: async () => ({ model: { id: "model", providerID: "provider" } }),
    },
    session: {
      context: async () => [],
      prompt: async (input: { text: string }) => void prompts.push(input),
      synthetic: async (input: { text: string }) => void statuses.push(input.text),
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
    },
    vcs: {
      status: async () => [],
      diff: async () => [],
    },
  } as unknown as Context & { values: Map<string, unknown> }
  return { context, values, prompts, statuses }
}
