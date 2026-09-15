import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { parseOptions } from "../../src/core/config.js"
import { HANDOFF_SUMMARY_FIELDS } from "../../src/core/policy.js"
import type { CommandInvocationLike } from "../../src/opencode-v2/commands/index.js"
import { formatHandoverSummary, runCommand, statusMessage } from "../../src/opencode-v2/commands/runtime.js"
import type { DispatchGate } from "../../src/opencode-v2/observability/runtime.js"
import { goalStorageKey, runStorageKey, stopStorageKey } from "../../src/opencode-v2/goal/state.js"
import { publishStorageKey, type PublishRecord } from "../../src/opencode-v2/publish/state.js"
import { gatesStorageKey, type GatesRecord } from "../../src/opencode-v2/gates/state.js"
import type { WorkerModelRuntime } from "../../src/opencode-v2/worker-models/runtime.js"

describe("runtime commands", () => {
  test("updates worker model overrides without dispatching a model prompt", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    const changes: string[] = []
    const workerModels: WorkerModelRuntime = {
      overrides: new Map(),
      workerIDs: ["planner", "explore", "implementer", "reviewer"],
      scope: "project-project",
      set: async (agentID, model) => void changes.push(`${agentID}=${model.providerID}/${model.id}`),
      clear: async (agentID) => void changes.push(`${agentID}=default`),
      reset: async () => void changes.push("reset"),
      list: async () => [{ agentID: "planner", effective: { providerID: "configured", id: "planner" } }],
    }

    await runCommand(fixture.context, parseOptions({}), "worker-models", invocation("planner=provider/model"), undefined, undefined, workerModels)
    expect(changes).toEqual(["planner=provider/model"])
    expect(fixture.prompts).toHaveLength(0)
    expect(fixture.statuses[0]).toContain("applies to children spawned after this point")

    await runCommand(fixture.context, parseOptions({}), "worker-models", invocation("planner=default"), undefined, undefined, workerModels)
    await runCommand(fixture.context, parseOptions({}), "worker-models", invocation("reset"), undefined, undefined, workerModels)
    expect(changes).toEqual(["planner=provider/model", "planner=default", "reset"])
  })

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
    expect(fixture.statuses[0]).toContain("API_KEY: [redacted]")
    expect(fixture.statuses[0]).not.toContain("hidden")
  })

  test("redacts central known secret shapes across every handover section", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    const fixture = runtimeFixture(directory)
    // Synthetic fake shapes only: API key, bearer credential, GitHub token,
    // Slack token, and a credential query parameter spread over history,
    // assistant, shell, compaction, and VCS diff content.
    ;(fixture.context as any).session.context = async () => [
      { type: "user", text: "rotate the API_KEY=sk_test_12345 now" },
      { type: "assistant", content: [{ type: "text", text: "Authorization: Bearer faketoken12345 recorded" }] },
      { type: "shell", output: { output: "pushed ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK for review" } },
      { type: "compaction", summary: "slack token xoxb-FAKE-TOKEN-FOR-TEST-EXAMPLE rotated" },
    ]
    ;(fixture.context as any).vcs.status = async () => [{ file: "src/client.ts", status: "modified" }]
    ;(fixture.context as any).vcs.diff = async () => [
      { file: "src/client.ts", patch: "+curl 'https://example.com/cb?access_token=secret123&state=ok'" },
    ]

    await runCommand(fixture.context, parseOptions({}), "handover", invocation("ship the release"), undefined)

    const output = fixture.statuses[0]
    expect(output).toContain("[redacted]")
    expect(output).not.toContain("sk_test_12345")
    expect(output).not.toContain("faketoken12345")
    expect(output).not.toContain("ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK")
    expect(output).not.toContain("xoxb-FAKE-TOKEN-FOR-TEST-EXAMPLE")
    expect(output).not.toContain("secret123")
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

  test("a blocked dispatch gate stops a slash command before any prompt or plan run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    mkdirSync(join(directory, ".orchestrator", "plans"), { recursive: true })
    writeFileSync(join(directory, ".orchestrator", "plans", "release.md"), "# Release\n\n- Verify the build\n")
    const fixture = runtimeFixture(directory)
    const switches: string[] = []
    fixture.session.switchAgent = async () => void switches.push("agent")
    const gate: DispatchGate = {
      allowDispatch: async () => ({
        allow: false,
        reason: "stop-between-steps: max_steps exceeded (observed 12, configured 10)",
        evaluation: { version: 1, mode: "stop-between-steps", verdict: "exceeded", limits: [] },
      }),
    }

    await runCommand(fixture.context, parseOptions({}), "run-plan", invocation("release"), undefined, gate)

    expect(fixture.prompts).toHaveLength(0)
    expect(fixture.statuses[0]).toContain("Dispatch blocked by configured controls")
    expect(fixture.values.has(runStorageKey(fixture.context.location, "session"))).toBe(false)
    // The blocked command must not have activated the orchestrator either.
    expect(switches).toEqual([])
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
    // `moved` via a session move: plan selection must use the session's current location.
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

  test("/publish status reports the durable policy and static gates without prompting a model", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))

    await runCommand(fixture.context, parseOptions({}), "publish", invocation(""), undefined)

    expect(fixture.prompts).toHaveLength(0)
    const output = fixture.statuses[0]
    expect(output).toContain("Publication capability — project \"project\"")
    expect(output).toContain("Durable policy: disabled")
    expect(output).toContain("Authorized capabilities (when enabled): push, pr-draft-create, pr-ready-transition, approve-after-review, merge")
    expect(output).toContain("Never authorized: issue creation (still requires the static github gates plus confirm: true).")
    expect(output).toContain("publish.enabled=false; github.enabled=false; github.allow_mutations=false; worktree.enabled=false; worktree.allow_mutations=false")
    expect(output).toContain("not caller authentication")
    expect(output).toContain("never mutates Git or GitHub")
  })

  test("/publish enable writes a durable project-scoped authorization record", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    const options = parseOptions({ publish: { enabled: true } })

    await runCommand(fixture.context, options, "publish", invocation("enable"), undefined)

    expect(fixture.prompts).toHaveLength(0)
    const output = fixture.statuses[0]
    expect(output).toContain("Publication enabled for project \"project\"")
    expect(output).toContain("authorized capabilities: push, pr-draft-create, pr-ready-transition, approve-after-review, merge")
    expect(output).toContain("This is a capability toggle, not caller authentication")
    expect(output).toContain("Issue creation is never authorized")
    expect(output).toContain("No Git or GitHub mutation happened")

    const record = fixture.values.get(publishStorageKey("project")) as PublishRecord
    expect(record?.version).toBe(1)
    expect(record?.enabled).toBe(true)
    expect(record?.capabilities).toEqual(["push", "pr-draft-create", "pr-ready-transition", "approve-after-review", "merge"])
    expect(record?.updatedBy).toBe("session")
    expect(record?.updatedAt).toBeTypeOf("number")
  })

  test("/publish disable revokes the capabilities and keeps the durable record", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    const options = parseOptions({ publish: { enabled: true } })
    fixture.values.set(publishStorageKey("project"), {
      version: 1,
      projectID: "project",
      enabled: true,
      capabilities: ["push", "pr-draft-create", "pr-ready-transition", "approve-after-review"],
      updatedAt: 1,
      updatedBy: "session",
    })

    await runCommand(fixture.context, options, "publish", invocation("disable"), undefined)

    const record = fixture.values.get(publishStorageKey("project")) as PublishRecord
    expect(record?.enabled).toBe(false)
    expect(record?.capabilities).toEqual([])
    expect(fixture.statuses[0]).toContain("Publication disabled for project \"project\"")
    expect(fixture.statuses[0]).toContain("no longer authorized")
  })

  test("/publish enable is refused while publish.enabled is false, but status and disable still work", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    const options = parseOptions({}) // publish.enabled defaults to false
    // A stale durable authorization can still exist after a config change.
    fixture.values.set(publishStorageKey("project"), {
      version: 1,
      projectID: "project",
      enabled: true,
      capabilities: ["push"],
      updatedAt: 1,
      updatedBy: "session",
    })

    await runCommand(fixture.context, options, "publish", invocation("enable"), undefined)
    expect(fixture.statuses[0]).toContain("/publish enable refused")
    expect(fixture.statuses[0]).toContain("publish.enabled: false")
    expect((fixture.values.get(publishStorageKey("project")) as PublishRecord).enabled).toBe(true)

    // Status reports the stale durable authorization even while the config
    // master switch is off.
    await runCommand(fixture.context, options, "publish", invocation("status"), undefined)
    expect(fixture.statuses[1]).toContain("Durable policy: enabled")
    expect(fixture.statuses[1]).toContain("publish.enabled=false")

    // Disabling a stale durable authorization is always allowed.
    await runCommand(fixture.context, options, "publish", invocation("disable"), undefined)
    expect((fixture.values.get(publishStorageKey("project")) as PublishRecord).enabled).toBe(false)
  })

  test("/publish enable and disable are idempotent with no rewrite on an unchanged record", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    const options = parseOptions({ publish: { enabled: true } })
    await runCommand(fixture.context, options, "publish", invocation("enable"), undefined)
    const first = fixture.values.get(publishStorageKey("project")) as PublishRecord
    const firstUpdatedAt = first.updatedAt

    await runCommand(fixture.context, options, "publish", invocation("enable"), undefined)
    expect(fixture.statuses[1]).toContain("already enabled")
    expect(fixture.statuses[1]).toContain("no change written")
    expect((fixture.values.get(publishStorageKey("project")) as PublishRecord).updatedAt).toBe(firstUpdatedAt)

    await runCommand(fixture.context, options, "publish", invocation("disable"), undefined)
    await runCommand(fixture.context, options, "publish", invocation("disable"), undefined)
    expect(fixture.statuses[3]).toContain("already disabled")
    expect((fixture.values.get(publishStorageKey("project")) as PublishRecord).enabled).toBe(false)
  })

  test("/publish rejects unknown verbs with usage text", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    await runCommand(fixture.context, parseOptions({}), "publish", invocation("frobnicate"), undefined)
    expect(fixture.prompts).toHaveLength(0)
    expect(fixture.statuses[0].startsWith("What happened: /publish did not run")).toBe(true)
    expect(fixture.statuses[0]).toContain("What it means:")
    expect(fixture.statuses[0]).toContain("Usage: /publish [status|enable|disable]")
  })
})

describe("session gate command", () => {
  const enabledOptions = () =>
    parseOptions({
      publish: { enabled: true },
      github: { enabled: true, allow_mutations: true },
      worktree: { enabled: true, allow_mutations: true, root: "/srv/worktrees" },
    })

  test("/gates lists every gate with its effective state and source", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    const options = enabledOptions()
    await runCommand(fixture.context, options, "publish", invocation("enable"), undefined)
    fixture.statuses.length = 0

    await runCommand(fixture.context, options, "gates", invocation(""), undefined)

    expect(fixture.prompts).toHaveLength(0)
    const output = fixture.statuses[0]
    expect(output).toContain("Session gates — session")
    expect(output).toContain("[on ] push — allowed by the project capability")
    expect(output).toContain("[on ] merge — allowed by the project capability")
    expect(output).toContain("[on ] github-mutations — allowed by the config")
    expect(output).toContain("[on ] worktree-mutations — allowed by the config")
    expect(output).toContain("can only narrow")
  })

  test("/gates <gate>=off narrows the session, =on restores it, and reset clears the record", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    const options = enabledOptions()
    await runCommand(fixture.context, options, "publish", invocation("enable"), undefined)
    fixture.statuses.length = 0

    await runCommand(fixture.context, options, "gates", invocation("merge=off"), undefined)
    expect(fixture.statuses[0]).toContain("'merge' is now off for this session")
    expect(fixture.statuses[0]).toContain("[off] merge — disabled for this session")
    expect((fixture.values.get(gatesStorageKey("session")) as GatesRecord).disabled).toEqual(["merge"])

    await runCommand(fixture.context, options, "gates", invocation("merge=on"), undefined)
    expect(fixture.statuses[1]).toContain("'merge' is now on for this session")
    expect((fixture.values.get(gatesStorageKey("session")) as GatesRecord).disabled).toEqual([])

    await runCommand(fixture.context, options, "gates", invocation("reset"), undefined)
    expect(fixture.statuses[2]).toContain("reset to the project ceiling")
    expect(fixture.values.has(gatesStorageKey("session"))).toBe(false)
  })

  test("/gates <gate>=on clears a narrowing or follows the ceiling; unknown gates are rejected", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    // No narrowing and no ceiling: =on is a no-op that truthfully reports the
    // gate follows the project ceiling, and nothing is persisted.
    await runCommand(fixture.context, parseOptions({}), "gates", invocation("github-mutations=on"), undefined)
    expect(fixture.statuses[0]).toContain("now follows the project ceiling")
    expect(fixture.statuses[0]).toContain("github.enabled is off")
    expect(fixture.values.has(gatesStorageKey("session"))).toBe(false)

    // A narrowing recorded while the ceiling was off is cleared by =on and
    // still truthfully reports the ceiling, never claiming the gate is on.
    await runCommand(fixture.context, parseOptions({}), "gates", invocation("merge=off"), undefined)
    expect((fixture.values.get(gatesStorageKey("session")) as GatesRecord).disabled).toEqual(["merge"])
    await runCommand(fixture.context, parseOptions({}), "gates", invocation("merge=on"), undefined)
    expect(fixture.statuses[2]).toContain("now follows the project ceiling")

    await runCommand(fixture.context, parseOptions({}), "gates", invocation("frobnicate=off"), undefined)
    expect(fixture.statuses[3]).toContain("Usage: /gates")
    expect(fixture.statuses[3]).toContain("merge")
  })

  test("/gates <gate>=off narrows even when the ceiling is already off", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    await runCommand(fixture.context, parseOptions({}), "gates", invocation("merge=off"), undefined)
    expect(fixture.statuses[0]).toContain("'merge' is now off for this session")
    expect((fixture.values.get(gatesStorageKey("session")) as GatesRecord).disabled).toEqual(["merge"])
  })
})

describe("G3 plain-language status and handover", () => {
  const SENTENCE_WORD_LIMIT = 25

  const TEMPLATE_LABELS = ["What happened: ", "What it means: ", "What's next: ", "What you can do: "]

  function sentences(text: string): string[] {
    return text
      .split("\n")
      .flatMap((line) => {
        const trimmed = line.trim()
        const label = TEMPLATE_LABELS.find((candidate) => trimmed.startsWith(candidate))
        return (label ? trimmed.slice(label.length) : trimmed).split(/(?<=[.!?])\s+/)
      })
      .map((sentence) => sentence.trim())
      .filter(Boolean)
  }

  function assertShortSentences(text: string, label: string): void {
    for (const sentence of sentences(text)) {
      expect(sentence.split(/\s+/).filter(Boolean).length, `${label}: ${sentence}`).toBeLessThanOrEqual(SENTENCE_WORD_LIMIT)
    }
  }

  test("statusMessage renders the what-happened/what-it-means/what's-next template", () => {
    expect(statusMessage({ happened: "The command ran.", means: "It changed one file.", next: "Review the diff." })).toBe(
      "What happened: The command ran.\nWhat it means: It changed one file.\nWhat's next: Review the diff.",
    )
    expect(statusMessage({ happened: "The command ran.", means: "It changed one file." })).toBe(
      "What happened: The command ran.\nWhat it means: It changed one file.",
    )
    assertShortSentences(
      statusMessage({ happened: "The command ran.", means: "It changed one file.", next: "Review the diff." }),
      "status template",
    )
  })

  test("emitted command statuses use the template and short sentences", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    const options = parseOptions({ publish: { enabled: true } })
    const workerModels: WorkerModelRuntime = {
      overrides: new Map(),
      workerIDs: ["planner", "explore", "implementer", "reviewer"],
      scope: "project-project",
      set: async () => undefined,
      clear: async () => undefined,
      reset: async () => undefined,
      list: async () => [{ agentID: "planner", effective: { providerID: "configured", id: "planner" } }],
    }

    await runCommand(fixture.context, options, "goal", invocation("ship the release"), undefined)
    await runCommand(fixture.context, options, "halt", invocation("all"), undefined)
    await runCommand(fixture.context, options, "publish", invocation("enable"), undefined)
    await runCommand(fixture.context, options, "gates", invocation("merge=off"), undefined)
    await runCommand(fixture.context, options, "worker-models", invocation("planner=provider/model"), undefined, undefined, workerModels)

    expect(fixture.statuses.length).toBeGreaterThanOrEqual(5)
    for (const status of fixture.statuses) {
      const lines = status.split("\n")
      expect(lines[0].startsWith("What happened:")).toBe(true)
      expect(lines[1].startsWith("What it means:")).toBe(true)
      assertShortSentences(status, "command status")
    }
  })

  test("a blocked dispatch keeps the raw reason and frames it plainly", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    const gate: DispatchGate = {
      allowDispatch: async () => ({
        allow: false,
        reason: "stop-between-steps: max_steps exceeded (observed 12, configured 10)",
        evaluation: { version: 1, mode: "stop-between-steps", verdict: "exceeded", limits: [] },
      }),
    }

    await runCommand(fixture.context, parseOptions({}), "orchestrate", invocation("fix the bug"), undefined, gate)

    const status = fixture.statuses[0]
    expect(status.startsWith("What happened: Dispatch blocked by configured controls")).toBe(true)
    expect(status).toContain("stop-between-steps: max_steps exceeded (observed 12, configured 10)")
    expect(status).toContain("What it means:")
    assertShortSentences(status, "blocked dispatch")
  })

  test("handover summary follows the D2 five-field skeleton and stays readable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-runtime-"))
    const fixture = runtimeFixture(directory)
    ;(fixture.context as any).session.context = async () => [
      { type: "user", text: "keep the API stable" },
      { type: "assistant", content: [{ type: "text", text: "Implemented the change." }] },
    ]
    ;(fixture.context as any).vcs.status = async () => []
    ;(fixture.context as any).vcs.diff = async () => []

    await runCommand(fixture.context, parseOptions({}), "handover", invocation("continue API work"), undefined)

    const output = fixture.statuses[0]
    expect(output).toContain("keep the API stable")
    expect(output).toContain("Working copy is clean.")
    let cursor = -1
    for (const field of HANDOFF_SUMMARY_FIELDS) {
      const index = output.indexOf(`${field} —`)
      expect(index, field).toBeGreaterThan(cursor)
      cursor = index
    }
    assertShortSentences(output, "handover summary")
  })

  test("handover summary reports unavailable reads instead of omitting them", () => {
    const summary = formatHandoverSummary({
      focus: "wrap up",
      contextError: "session context unavailable",
      filesError: "vcs status unavailable",
      diffError: "vcs diff unavailable",
    })
    expect(summary).toContain("Unavailable: session context unavailable")
    expect(summary).toContain("Unavailable: vcs status unavailable")
    expect(summary).toContain("Unavailable: vcs diff unavailable")
    assertShortSentences(summary, "handover errors")
  })

  test("report-style statuses keep a short template header before their details", async () => {
    const fixture = runtimeFixture(mkdtempSync(join(tmpdir(), "orchestrator-runtime-")))
    const options = parseOptions({
      publish: { enabled: true },
      github: { enabled: true, allow_mutations: true },
      worktree: { enabled: true, allow_mutations: true, root: "/srv/worktrees" },
    })

    await runCommand(fixture.context, options, "publish", invocation("status"), undefined)
    await runCommand(fixture.context, options, "gates", invocation("status"), undefined)

    expect(fixture.statuses).toHaveLength(2)
    for (const status of fixture.statuses) {
      expect(status).toContain("What happened:")
      expect(status).toContain("What it means:")
      expect(status).toContain("What's next:")
      assertShortSentences(status, "report status")
    }
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
