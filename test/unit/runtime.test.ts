import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { parseOptions } from "../../src/core/config.js"
import type { CommandInvocationLike } from "../../src/opencode-v2/commands/index.js"
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

  test("rebuilds the prompt without explicit undefined attachments", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    await runCommand(
      fixture.context,
      parseOptions({}),
      "orchestrate",
      invocation("fix the bug", { files: undefined, agents: undefined, skills: undefined }),
      undefined,
    )

    expect(fixture.prompts).toHaveLength(1)
    const prompt = fixture.prompts[0]
    expect(prompt.sessionID).toBe("session")
    expect(prompt.delivery).toBe("queue")
    expect(prompt.text).toContain("fix the bug")
    expect("files" in prompt).toBe(false)
    expect("agents" in prompt).toBe(false)
    expect("skills" in prompt).toBe(false)
  })

  test("preserves attachment identities and metadata while dropping stale mentions", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    await runCommand(
      fixture.context,
      parseOptions({}),
      "orchestrate",
      invocation("fix src/index.ts", {
        files: [
          {
            uri: "file:///workspace/src/index.ts",
            name: "index.ts",
            description: "Entry point",
            mention: { start: 0, end: 10, text: "@src/index.ts" },
          },
        ],
        agents: [{ name: "reviewer", mention: { start: 5, end: 8, text: "@reviewer" } }],
        skills: [{ id: "skill-id", mention: { start: 9, end: 12, text: "@skill" } }],
      }),
      undefined,
    )

    expect(fixture.prompts).toHaveLength(1)
    const prompt = fixture.prompts[0]
    expect(prompt.files).toEqual([{ uri: "file:///workspace/src/index.ts", name: "index.ts", description: "Entry point" }])
    expect(prompt.agents).toEqual([{ name: "reviewer" }])
    expect(prompt.skills).toEqual([{ id: "skill-id" }])
    // No stale mention offsets survive the rewritten text.
    expect(JSON.stringify(prompt)).not.toContain("mention")
  })

  test("keeps empty attachment arrays that are present", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    await runCommand(
      fixture.context,
      parseOptions({}),
      "orchestrate",
      invocation("clean up", { files: [], agents: [], skills: [] }),
      undefined,
    )

    expect(fixture.prompts).toHaveLength(1)
    expect(fixture.prompts[0].files).toEqual([])
    expect(fixture.prompts[0].agents).toEqual([])
    expect(fixture.prompts[0].skills).toEqual([])
  })

  test("resumes a stored paused or active plan when multiple incomplete plans exist", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    mkdirSync(join(directory, ".orchestrator", "plans"), { recursive: true })
    writeFileSync(join(directory, ".orchestrator", "plans", "alpha.md"), "# Alpha\n\n- Step\n")
    writeFileSync(join(directory, ".orchestrator", "plans", "beta.md"), "# Beta\n\n- Step\n")
    writeFileSync(join(directory, ".orchestrator", "plans", "gamma.md"), "# Gamma\n\n- Step\n")
    const fixture = runtimeFixture(directory)
    const key = runStorageKey(fixture.context.location, "session")

    // A stored paused run is resumed even though three incomplete plans exist.
    fixture.values.set(key, {
      version: 1,
      sessionID: "session",
      plan: ".orchestrator/plans/alpha.md",
      status: "paused",
      createdAt: 1,
      updatedAt: 1,
    })
    await runCommand(fixture.context, parseOptions({}), "run-plan", invocation(""), undefined)
    expect(fixture.prompts[0].text).toContain(".orchestrator/plans/alpha.md")
    expect(fixture.values.get(key)).toMatchObject({ plan: ".orchestrator/plans/alpha.md", status: "active" })

    // A stored active run is likewise resumed rather than re-selected.
    fixture.values.set(key, {
      version: 1,
      sessionID: "session",
      plan: ".orchestrator/plans/gamma.md",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    })
    await runCommand(fixture.context, parseOptions({}), "run-plan", invocation(""), undefined)
    expect(fixture.prompts[1].text).toContain(".orchestrator/plans/gamma.md")
    expect(fixture.values.get(key)).toMatchObject({ plan: ".orchestrator/plans/gamma.md", status: "active" })
  })

  test("pauses the selected run when orchestrator activation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    mkdirSync(join(directory, ".orchestrator", "plans"), { recursive: true })
    writeFileSync(join(directory, ".orchestrator", "plans", "release.md"), "# Release\n\n- Verify the build\n")
    const fixture = runtimeFixture(directory)
    ;(fixture.context as any).session.switchAgent = async () => {
      throw new Error("agent unavailable")
    }
    const key = runStorageKey(fixture.context.location, "session")

    await expect(
      runCommand(fixture.context, parseOptions({}), "run-plan", invocation("release"), undefined),
    ).rejects.toThrow("agent unavailable")

    expect(fixture.prompts).toHaveLength(0)
    expect(fixture.values.get(key)).toMatchObject({ plan: ".orchestrator/plans/release.md", status: "paused" })
    expect(fixture.statuses[0]).toContain("Plan run paused")
  })

  test("pauses the selected run when prompt delivery fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    mkdirSync(join(directory, ".orchestrator", "plans"), { recursive: true })
    writeFileSync(join(directory, ".orchestrator", "plans", "release.md"), "# Release\n\n- Verify the build\n")
    const fixture = runtimeFixture(directory)
    ;(fixture.context as any).session.prompt = async () => {
      throw new Error("delivery failed")
    }
    const key = runStorageKey(fixture.context.location, "session")

    await expect(
      runCommand(fixture.context, parseOptions({}), "run-plan", invocation("release"), undefined),
    ).rejects.toThrow("delivery failed")

    expect(fixture.values.get(key)).toMatchObject({ plan: ".orchestrator/plans/release.md", status: "paused" })
    expect(fixture.statuses[0]).toContain("Plan run paused")
  })

  test("rejects explicitly selected plans whose symlink escapes the plans directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    mkdirSync(join(directory, ".orchestrator", "plans"), { recursive: true })
    // A symlink inside plans that points at a file outside of plans.
    writeFileSync(join(directory, "outside.md"), "# Outside\n\n- Step\n")
    const evilLink = join(directory, ".orchestrator", "plans", "evil.md")
    try {
      symlinkSync(join(directory, "outside.md"), evilLink)
    } catch (error) {
      if (!isUnsupportedSymlinkError(error)) throw error
      // Platforms that document symlink-creation as unsupported cannot
      // exercise the escape; skip instead of passing vacuously.
      return
    }
    // Prove the symlink genuinely exists on supported platforms: otherwise the
    // test would pass merely because the plan file is absent.
    expect(existsSync(evilLink)).toBe(true)
    const fixture = runtimeFixture(directory)

    await runCommand(fixture.context, parseOptions({}), "run-plan", invocation("evil"), undefined)

    expect(fixture.prompts).toHaveLength(0)
    expect(fixture.statuses).toHaveLength(1)
    expect(fixture.values.has(runStorageKey(fixture.context.location, "session"))).toBe(false)
  })

  test("allows plan symlinks that stay inside the plans directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    mkdirSync(join(directory, ".orchestrator", "plans"), { recursive: true })
    writeFileSync(join(directory, ".orchestrator", "plans", "real.md"), "# Real\n\n- Step\n")
    try {
      symlinkSync(join(directory, ".orchestrator", "plans", "real.md"), join(directory, ".orchestrator", "plans", "alias.md"))
    } catch (error) {
      if (!isUnsupportedSymlinkError(error)) throw error
      // Skip the positive case where symlinks are unavailable.
      return
    }
    const fixture = runtimeFixture(directory)

    await runCommand(fixture.context, parseOptions({}), "run-plan", invocation("alias"), undefined)

    expect(fixture.prompts).toHaveLength(1)
    expect(fixture.prompts[0].text).toContain(".orchestrator/plans/alias.md")
    expect(fixture.prompts[0].text).toContain("Real")
  })

  test("treats quoted YAML frontmatter status values as complete plans", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    mkdirSync(join(directory, ".orchestrator", "plans"), { recursive: true })
    writeFileSync(join(directory, ".orchestrator", "plans", "double.md"), '---\nstatus: "complete"\n---\n# Double quoted\n')
    writeFileSync(join(directory, ".orchestrator", "plans", "single.md"), "---\nstatus: 'done'\n---\n# Single quoted\n")
    const fixture = runtimeFixture(directory)

    await runCommand(fixture.context, parseOptions({}), "run-plan", invocation("double"), undefined)
    await runCommand(fixture.context, parseOptions({}), "run-plan", invocation("single"), undefined)
    // Auto-selection must also ignore quoted complete plans.
    await runCommand(fixture.context, parseOptions({}), "run-plan", invocation(""), undefined)

    expect(fixture.prompts).toHaveLength(0)
    expect(fixture.statuses).toHaveLength(3)
    expect(fixture.statuses.every((status) => status.includes("no sole incomplete plan"))).toBe(true)
  })

  test("run-plan selects plans from the session's current location after a move", async () => {
    // The plugin loads in `directory` (no plans), but the session has moved to
    // `moved` via /cd: plan selection must use the session's current location.
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    const moved = mkdtempSync(join(tmpdir(), "orchestrator-runtime-moved-"))
    mkdirSync(join(moved, ".orchestrator", "plans"), { recursive: true })
    writeFileSync(join(moved, ".orchestrator", "plans", "release.md"), "# Release\n\n- Verify the build\n")
    const fixture = runtimeFixture(directory)
    fixture.session.get = async () => ({ id: "session", projectID: "moved", location: { directory: moved } })

    await runCommand(fixture.context, parseOptions({}), "run-plan", invocation("release"), undefined)

    expect(fixture.prompts).toHaveLength(1)
    expect(fixture.prompts[0].text).toContain(".orchestrator/plans/release.md")
    expect(fixture.prompts[0].text).toContain("Verify the build")
  })

  test("handover reads VCS state at the session's current location after a move", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    const moved = mkdtempSync(join(tmpdir(), "orchestrator-runtime-moved-"))
    const fixture = runtimeFixture(directory)
    fixture.session.get = async () => ({ id: "session", projectID: "moved", location: { directory: moved, workspaceID: "ws-9" } })
    const seenLocations: Array<{ directory: string; workspace?: string }> = []
    ;(fixture.context as any).vcs.status = async (input: { location: { directory: string; workspace?: string } }) => {
      seenLocations.push(input.location)
      return []
    }

    await runCommand(fixture.context, parseOptions({}), "handover", invocation("wrap up"), undefined)

    expect(seenLocations.length).toBeGreaterThan(0)
    expect(seenLocations[0]).toEqual({ directory: moved, workspace: "ws-9" })
    expect(fixture.statuses[0]).toContain("Working copy is clean.")
  })
})

function invocation(text: string, prompt: Record<string, unknown> = {}): CommandInvocationLike {
  return { sessionID: "session", prompt: { text, ...prompt }, delivery: "queue" } as CommandInvocationLike
}

// True only for the error codes platforms document when symlink creation is
// unsupported (e.g. Windows without developer mode / elevation). Any other
// failure is a real test-environment problem and must not be swallowed.
function isUnsupportedSymlinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "EPERM" || code === "EACCES" || code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS"
}

function runtimeFixture(directory: string) {
  const values = new Map<string, unknown>()
  const prompts: Array<Record<string, unknown>> = []
  const statuses: string[] = []
  const session = {
    get: async () => ({ id: "session", projectID: "project", location: { directory } }),
    context: async () => [],
    prompt: async (input: Record<string, unknown>) => void prompts.push(input),
    synthetic: async (input: { text: string }) => void statuses.push(input.text),
    switchAgent: async () => undefined,
    switchModel: async () => undefined,
  }
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
    session,
    vcs: {
      status: async () => [],
      diff: async () => [],
    },
  } as unknown as Context & { values: Map<string, unknown> }
  return { context, values, prompts, statuses, session }
}
