import { describe, expect, test } from "bun:test"
import {
  buildCommandPrompt,
  buildContinuationPrompt,
  buildOrchestratorSystem,
  buildWorkerSystem,
} from "../../src/core/prompts.js"
import { COMMAND_NAMES, parseOptions, type OrchestratorOptions } from "../../src/core/config.js"
import { commandDefinitions } from "../../src/opencode-v2/commands/index.js"
import {
  DELEGATION_GRAPH_GUIDANCE,
  DELEGATION_RULES,
  GITHUB_LIFECYCLE_GUIDANCE,
  HANDOFF_FORMAT,
  MANAGED_WORKTREE_GUIDANCE,
  PROMPTING_POLICY_GUIDANCE,
  REMOTE_ORCHESTRATION_GUIDANCE,
  SECRET_HANDLING_GUIDANCE,
  STRUCTURED_HANDOFF_GUIDANCE,
  TOOL_AVAILABILITY_GUIDANCE,
  WORKTREE_BOUNDARY_GUIDANCE,
  WORKTREE_LIFECYCLE_GUIDANCE,
  orchestrationCapabilities,
  orchestrationRules,
} from "../../src/core/policy.js"
import { ROLE_DELEGATION, ROLE_GUIDANCE, delegationGraphSummary } from "../../src/core/roles.js"

describe("configuration", () => {
  test("fills role defaults and preserves per-agent options", () => {
    const options = parseOptions({ max_parallel: 3, roles: { research: "finder" } })
    expect(options.max_parallel).toBe(3)
    expect(options.roles.research).toBe("finder")
    expect(options.roles.review).toBe("reviewer")
  })

  test("rejects an unsafe parallelism limit", () => {
    expect(() => parseOptions({ max_parallel: 9 })).toThrow()
  })

  test("strict top-level options reject typos instead of silently stripping them", () => {
    expect(() => parseOptions({ tracer: { mode: "memory" } })).toThrow()
    expect(() => parseOptions({ budgt: { mode: "advisory" } })).toThrow()
    expect(() => parseOptions({ max_paralel: 4 })).toThrow()
    expect(() => parseOptions({ review_mode: "bounded" })).toThrow()
    // Valid top-level keys still parse and fill defaults.
    expect(parseOptions({ max_parallel: 3 }).max_parallel).toBe(3)
  })

  test("S3/V1 controls default to the strict backward-compatible behavior", () => {
    const options = parseOptions({})
    expect(options.trace).toEqual({ mode: "off" })
    expect(options.budget).toEqual({ mode: "advisory" })
    expect(options.budget.max_steps).toBeUndefined()
    expect(options.budget.max_tokens).toBeUndefined()
    expect(options.budget.max_cost_usd).toBeUndefined()
    expect(options.budget.max_wall_clock_ms).toBeUndefined()
    expect(options.budget.max_retries).toBeUndefined()
    expect(options.review).toEqual({ mode: "prompt", max_rounds: 2 })
  })

  test("S3/V1 opt-in blocks accept every mode and nullable strict limits", () => {
    const options = parseOptions({
      trace: { mode: "snapshot" },
      budget: {
        mode: "stop-between-steps",
        max_steps: 12,
        max_tokens: 10_000,
        max_cost_usd: 5.5,
        max_wall_clock_ms: 3_600_000,
        max_retries: 3,
      },
      review: { mode: "bounded", max_rounds: 8 },
    })
    expect(options.trace.mode).toBe("snapshot")
    expect(options.budget).toMatchObject({
      mode: "stop-between-steps",
      max_steps: 12,
      max_tokens: 10_000,
      max_cost_usd: 5.5,
      max_wall_clock_ms: 3_600_000,
      max_retries: 3,
    })
    expect(options.review).toEqual({ mode: "bounded", max_rounds: 8 })
    // Explicit null limits are accepted as "no limit".
    expect(parseOptions({ budget: { mode: "advisory", max_tokens: null, max_steps: null } }).budget.max_tokens).toBe(null)
  })

  test("S3/V1 strict blocks reject unknown keys, bad modes, and bad limits", () => {
    expect(() => parseOptions({ trace: { mode: "log" } })).toThrow()
    expect(() => parseOptions({ trace: { retention: 5 } })).toThrow()
    expect(() => parseOptions({ budget: { mode: "block" } })).toThrow()
    expect(() => parseOptions({ budget: { max_tokens: -0.01 } })).toThrow()
    expect(() => parseOptions({ budget: { max_tokens: Number.NaN } })).toThrow()
    expect(() => parseOptions({ budget: { max_steps: 1.5 } })).toThrow()
    expect(() => parseOptions({ review: { mode: "circle" } })).toThrow()
    expect(() => parseOptions({ review: { max_rounds: 0 } })).toThrow()
    expect(() => parseOptions({ review: { max_rounds: 9 } })).toThrow()
    expect(() => parseOptions({ review: { max_rounds: 2.5 } })).toThrow()
  })

  test("accepts legacy commands.cd but ignores it completely", () => {
    // Strict option parsing keeps accepting `commands: { cd: true|false }` for
    // backward compatibility, but the parsed legacy key never surfaces in
    // COMMAND_NAMES, command definitions, or registered commands.
    for (const value of [true, false]) {
      const options = parseOptions({ commands: { cd: value } })
      expect(options.commands.cd).toBe(value)
      expect(COMMAND_NAMES).not.toContain("cd")
    }
    const definitions = commandDefinitions(parseOptions({ commands: { cd: true } }))
    expect(definitions.map((definition) => definition.name)).toEqual([
      "orchestrate",
      "worker-models",
      "goal",
      "restructure",
      "run-plan",
      "halt",
      "handover",
      "polish",
      "stress-plan",
    ])
    expect(definitions.map((definition) => definition.name)).not.toContain("cd")
    // An unknown command key is still rejected by the strict schema.
    expect(() => parseOptions({ commands: { not_a_command: true } })).toThrow()
  })

  test("clarify defaults to auto and validates its strict block", () => {
    expect(parseOptions({}).clarify).toEqual({ mode: "auto" })
    expect(parseOptions({ clarify: {} }).clarify).toEqual({ mode: "auto" })
    expect(parseOptions({ clarify: { mode: "off" } }).clarify).toEqual({ mode: "off" })
    expect(() => parseOptions({ clarify: { mode: "maybe" } })).toThrow()
    expect(() => parseOptions({ clarify: { extra: true } })).toThrow()
  })
})

describe("prompts", () => {
  test("contains orchestration invariants without model names", () => {
    const prompt = buildOrchestratorSystem(parseOptions({}))
    expect(prompt).toContain("disjoint write scopes")
    expect(prompt).toContain("planner")
    expect(prompt).not.toContain("claude")
  })

  test("embeds the child-task contract with its required sections", () => {
    const prompt = buildOrchestratorSystem(parseOptions({}))
    for (const section of [
      "Task:",
      "Expected outcome",
      "Scope/file ownership",
      "Must do",
      "Must not do",
      "Verification:",
      "Handoff:",
    ]) {
      expect(prompt).toContain(section)
    }
    expect(prompt).toContain("exact disjoint write scope")
    expect(prompt).toContain("assumption")
    expect(prompt).toContain("directly")
  })

  test("names only namespaced goal tools in system, command, and continuation prompts", () => {
    const system = buildOrchestratorSystem(parseOptions({}))
    const goal = buildCommandPrompt("goal", "pause")
    const continuation = buildContinuationPrompt("objective", 2)
    for (const prompt of [system, goal, continuation]) {
      expect(prompt).toContain("orchestrator_goal_get")
      expect(prompt).toContain("orchestrator_goal_set")
      expect(prompt).toContain("orchestrator_goal_update")
      expect(prompt).not.toMatch(/\bgoal_(get|set|update)\b/)
    }
  })

  test("worker prompts carry the child-task contract and handoff format", () => {
    const prompt = buildWorkerSystem("implementation")
    expect(prompt).toContain("Expected outcome")
    expect(prompt).toContain("Must not do")
    expect(prompt).toContain("Worker handoff format:")
  })

  test("structured handoff guidance lists the version-1 envelope and the callable validation tools", () => {
    expect(STRUCTURED_HANDOFF_GUIDANCE).toContain("version: 1")
    for (const field of [
      "taskId",
      "outcome",
      "facts",
      "assumptions",
      "filesRead and filesChanged",
      "verification",
      "risks",
      "followUp",
      "artifactRefs",
      "reviewState",
    ]) {
      expect(STRUCTURED_HANDOFF_GUIDANCE).toContain(field)
    }
    expect(STRUCTURED_HANDOFF_GUIDANCE).toContain("orchestrator_handoff_validate")
    expect(STRUCTURED_HANDOFF_GUIDANCE).toContain("orchestrator_task_complexity_classify")
    expect(STRUCTURED_HANDOFF_GUIDANCE).toContain("callable/advisory, not automatic hooks")
    expect(STRUCTURED_HANDOFF_GUIDANCE).toContain("after collecting all eight structured facts")
  })

  test("renders complete command arguments", () => {
    expect(buildCommandPrompt("goal", "pause")).toContain("pause")
  })

  test("bounded review and stop-between-steps guidance appear only when enabled", () => {
    const defaults = buildOrchestratorSystem(parseOptions({}))
    expect(defaults).not.toContain("Bounded review mode is configured")
    expect(defaults).not.toContain("stop-between-steps budget mode is configured")

    const bounded = parseOptions({ review: { mode: "bounded" }, budget: { mode: "stop-between-steps" } })
    const system = buildOrchestratorSystem(bounded)
    expect(system).toContain("Bounded review mode is configured")
    expect(system).toContain("orchestrator_review_transition")
    expect(system).toContain("Reach admission state review-pending")
    expect(system).toContain("stop-between-steps budget mode is configured")
    expect(system).toContain("in-flight provider and tool calls are never interrupted")
    expect(system).toContain("not an automatic completion gate")

    const command = buildCommandPrompt("orchestrate", "scope", bounded)
    expect(command).toContain("orchestrator_review_transition")
    expect(command).toContain("stop-between-steps budget mode is configured")
    const continuation = buildContinuationPrompt("objective", 1, bounded)
    expect(continuation).toContain("orchestrator_review_transition")
    expect(continuation).toContain("Bounded review mode is configured")
    expect(continuation).toContain("stop-between-steps budget mode is configured")
    expect(continuation).not.toContain("automatic gate is enforced")

    // Default continuation and command prompts carry none of the guidance.
    const plainContinuation = buildContinuationPrompt("objective", 1)
    expect(plainContinuation).not.toContain("Bounded review mode is configured")
    expect(plainContinuation).not.toContain("stop-between-steps budget mode is configured")
    const plainCommand = buildCommandPrompt("orchestrate", "scope")
    expect(plainCommand).not.toContain("Bounded review mode is configured")
    expect(plainCommand).not.toContain("stop-between-steps budget mode is configured")
  })

  test("clarify guidance is embedded by default and omitted when off", () => {
    const defaults = buildOrchestratorSystem(parseOptions({}))
    expect(defaults).toContain("Clarify mode is enabled")
    expect(defaults).toContain("native ask tool")
    expect(defaults).toContain("Workers never ask")
    expect(defaults.split("Clarify mode is enabled").length - 1).toBe(1)

    const off = buildOrchestratorSystem(parseOptions({ clarify: { mode: "off" } }))
    expect(off).not.toContain("Clarify mode is enabled")
    expect(off).not.toContain("native ask tool")
  })

  test("the orchestrate prompt is built from the initial prompt by the prompt builder", () => {
    const enabled = buildCommandPrompt("orchestrate", "add pagination to /api/items")
    expect(enabled).toContain("Coordinate this task end to end.")
    expect(enabled).toContain("Task: add pagination to /api/items")
    expect(enabled).toContain("use the native ask tool")
    expect(enabled.split("use the native ask tool").length - 1).toBe(1)

    const off = buildCommandPrompt("orchestrate", "scope", parseOptions({ clarify: { mode: "off" } }))
    expect(off).toContain("Task: scope")
    expect(off).not.toContain("use the native ask tool")
    expect(off).not.toContain("Clarify mode is enabled")

    // Commands other than orchestrate never carry the builder's clarification.
    expect(buildCommandPrompt("goal", "pause")).not.toContain("use the native ask tool")
  })

  test("clarify off composes with bounded review and empty objectives", () => {
    const mixed = parseOptions({ clarify: { mode: "off" }, review: { mode: "bounded" } })
    const system = buildOrchestratorSystem(mixed)
    expect(system).toContain("Bounded review mode is configured")
    expect(system).not.toContain("Clarify mode is enabled")

    const command = buildCommandPrompt("orchestrate", "   ", mixed)
    expect(command).toContain("Task: (no arguments)")
    expect(command).not.toContain("use the native ask tool")
    expect(command).toContain("orchestrator_review_transition")

    // An empty objective with the default clarify mode still asks when ambiguous.
    expect(buildCommandPrompt("orchestrate", "   ")).toContain("use the native ask tool")
  })
})

describe("remote orchestration policy", () => {
  const COMMAND_NAMES = [
    "orchestrate",
    "goal",
    "restructure",
    "run-plan",
    "halt",
    "handover",
    "polish",
    "stress-plan",
  ]

  // Universal guidance is asserted on the default (all-disabled) options;
  // feature-specific lifecycle guidance is asserted per enabled feature.
  const DEFAULT = parseOptions({})
  const WORKTREE = parseOptions({ worktree: { enabled: true } })
  const GITHUB = parseOptions({ github: { enabled: true } })
  const BOTH = parseOptions({ github: { enabled: true }, worktree: { enabled: true } })

  function promptKinds(options: OrchestratorOptions): Array<[string, string]> {
    const prompts: Array<[string, string]> = [
      ["orchestrator system", buildOrchestratorSystem(options)],
      ["worker system", buildWorkerSystem("implementation", options)],
      ["continuation", buildContinuationPrompt("objective", 2, options)],
    ]
    for (const name of COMMAND_NAMES) {
      prompts.push([`command ${name}`, buildCommandPrompt(name, "scope", options)])
    }
    return prompts
  }

  function allPromptKinds(): Array<[string, string]> {
    return promptKinds(DEFAULT)
  }

  test("every prompt kind uses only exposed host-configured GitHub tools and requires preflight", () => {
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).toContain("inspect the tool catalog")
      expect(prompt).toContain("never infer availability from MCP server names or status")
      expect(prompt).toContain("Use only GitHub tools the host has already configured and exposed")
      expect(prompt).toContain("never assume, register, or invent tools")
    }
  })

  test("every prompt kind requires direct evidence for issue/branch/PR/review/merge/closure mutations", () => {
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).toContain("direct evidence")
      expect(prompt).toContain("issue, branch, pull request, review, merge, or closure")
      expect(prompt).toContain("before reporting completion")
    }
  })

  test("every prompt kind stops instead of claiming unavailable issue/PR automation", () => {
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).toContain("stop and ask the user")
      expect(prompt).toContain("do not silently claim the work")
      expect(prompt).not.toContain("automatically create")
    }
  })

  test("every prompt kind protects raw secrets and redacts credentials", () => {
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).toContain("Never request, resolve, log, paste, or copy raw tokens, authorization headers, environment secrets, or OAuth credentials")
      expect(prompt).toContain("Redact credentials")
    }
    expect(buildCommandPrompt("handover", "wrap up")).toContain("redact secrets")
  })

  test("every prompt kind states the truthful worktree boundary without claiming isolation", () => {
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).toContain("advisory")
      expect(prompt).toContain("plugin-controlled atomic worktree or location boundary")
      expect(prompt).toContain("prompt-level disjoint write scopes do not equal filesystem isolation")
      expect(prompt).toContain("safe delegation is allowed whenever isolation is not required")
      expect(prompt).not.toMatch(/provid(?:e|ed).{0,40}isolat/i)
    }
  })

  test("every prompt kind distinguishes managed current-session worktrees from unavailable atomic child isolation", () => {
    for (const [, prompt] of promptKinds(WORKTREE)) {
      expect(prompt).toContain("orchestrator_worktree_create")
      expect(prompt).toContain("orchestrator_worktree_enter")
      expect(prompt).toContain("owned by the current session")
      expect(prompt).toContain("not atomic child isolation")
      expect(prompt).toContain("required order is orchestrator_worktree_create -> orchestrator_worktree_enter -> delegate to the implementer")
      expect(prompt).toContain("moves only the current session")
      expect(prompt).toContain("children delegated afterward inherit or start from that context")
      expect(prompt).not.toMatch(/\/cd/)
    }
    // The default (feature-disabled) prompts keep the universal boundary but
    // drop the feature-specific managed-worktree lifecycle entirely.
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).not.toContain("orchestrator_worktree_enter")
    }
    // The remote GitHub guidance is still present alongside the worktree text.
    expect(MANAGED_WORKTREE_GUIDANCE).toContain("orchestrator_worktree_cleanup")
    expect(MANAGED_WORKTREE_GUIDANCE).toContain("current session only")
    expect(REMOTE_ORCHESTRATION_GUIDANCE).toContain("inspect the tool catalog")
    // The universal constant no longer embeds the feature lifecycle; the
    // worktree feature guidance composes it conditionally instead.
    expect(REMOTE_ORCHESTRATION_GUIDANCE).not.toContain(MANAGED_WORKTREE_GUIDANCE)
    expect(WORKTREE_LIFECYCLE_GUIDANCE).toContain(MANAGED_WORKTREE_GUIDANCE)
  })

  test("no command prompt renders /cd and no default prompt mentions the slash command", () => {
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).not.toMatch(/\/cd/)
    }
    expect(buildCommandPrompt("orchestrate", "use a managed worktree", WORKTREE)).toContain("orchestrator_worktree_enter")
  })

  test("never hard-codes deployment-specific GitHub tool names", () => {
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).not.toMatch(/github\.[a-z_]+/i)
      expect(prompt).not.toMatch(/\bgh (pr|issue|api|auth)\b/i)
    }
    expect(REMOTE_ORCHESTRATION_GUIDANCE).not.toMatch(/github\.[a-z_]+/i)
    expect(REMOTE_ORCHESTRATION_GUIDANCE).not.toMatch(/\bgh (pr|issue|api|auth)\b/i)
  })

  test("policy constants carry the full remote orchestration guidance", () => {
    expect(TOOL_AVAILABILITY_GUIDANCE).toContain("inspect the tool catalog")
    expect(TOOL_AVAILABILITY_GUIDANCE).toContain("direct evidence")
    expect(TOOL_AVAILABILITY_GUIDANCE).toContain("stop and ask the user")
    expect(SECRET_HANDLING_GUIDANCE).toContain("OAuth credentials")
    expect(WORKTREE_BOUNDARY_GUIDANCE).toContain("advisory")
    expect(WORKTREE_BOUNDARY_GUIDANCE).toContain("safe delegation is allowed whenever isolation is not required")
    expect(REMOTE_ORCHESTRATION_GUIDANCE.split("\n").length).toBeGreaterThan(
      TOOL_AVAILABILITY_GUIDANCE.split("\n").length,
    )
    // The capabilities helper derives the flags from the parsed options, so
    // prompt builders and rules never duplicate the option shape.
    expect(orchestrationCapabilities(DEFAULT)).toEqual({ worktree: false, github: false })
    expect(orchestrationCapabilities(BOTH)).toEqual({ worktree: true, github: true })
  })

  test("worktree lifecycle guidance appears only when worktree is enabled", () => {
    for (const [, prompt] of promptKinds(WORKTREE)) {
      expect(prompt).toContain("Worktree lifecycle is mandatory for implementation when worktree support is enabled")
      expect(prompt).toContain("the orchestrator MUST run orchestrator_worktree_create -> orchestrator_worktree_enter")
      expect(prompt).toContain("only the orchestrator creates, enters, pushes, and cleans up managed worktrees")
      expect(prompt).toContain("stop and ask the user")
      expect(prompt).toContain("never delegate implementation from the main checkout")
    }
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).not.toContain("Worktree lifecycle is mandatory")
      expect(prompt).not.toContain("preceded by orchestrator_worktree_create")
    }
  })

  test("github lifecycle guidance appears only when github is enabled", () => {
    for (const [, prompt] of promptKinds(GITHUB)) {
      expect(prompt).toContain("implementers never push branches or create or merge pull requests")
      expect(prompt).toContain("orchestrator_github_pr_create")
      expect(prompt).toContain("orchestrator_github_pr_merge")
      expect(prompt).toContain("separate explicit user request")
      expect(prompt).toContain("expected head SHA")
      expect(prompt).toContain("literal confirm: true")
      expect(prompt).toContain("is never user authorization")
      expect(prompt).toContain("stop truthfully")
    }
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).not.toContain("orchestrator_github_pr_merge")
      expect(prompt).not.toContain("is never user authorization")
    }
  })

  test("worktree-only and github-only options compose without leaking the other feature's guidance", () => {
    for (const [, prompt] of promptKinds(WORKTREE)) {
      expect(prompt).not.toContain("orchestrator_github_pr_merge")
    }
    for (const [, prompt] of promptKinds(GITHUB)) {
      expect(prompt).not.toContain("Worktree lifecycle is mandatory")
      expect(prompt).not.toContain("preceded by orchestrator_worktree_create")
    }
    for (const [, prompt] of promptKinds(BOTH)) {
      expect(prompt).toContain("orchestrator_github_pr_merge")
      expect(prompt).toContain("the orchestrator MUST run orchestrator_worktree_create -> orchestrator_worktree_enter")
      expect(prompt).toContain("is never user authorization")
    }
  })

  test("github guidance keeps confirm:true and checker approval distinct from user authorization", () => {
    expect(GITHUB_LIFECYCLE_GUIDANCE).toContain(
      "A confirm: true flag or a checker's approval is never user authorization",
    )
    expect(GITHUB_LIFECYCLE_GUIDANCE).toContain("run orchestrator_github_pr_merge with a fresh")
    expect(GITHUB_LIFECYCLE_GUIDANCE).toContain("then verify merged:true again with a fresh orchestrator_github_pr_view")
    for (const [, prompt] of promptKinds(BOTH)) {
      expect(prompt).toContain("is never user authorization")
    }
  })

  test("role policy keeps native delegation and retains every configured role", () => {
    const rules = orchestrationRules(4, true)
    expect(rules).toContain("exact disjoint write scope")
    expect(rules).toContain("Route by the configured semantic role map")
    expect(rules).toContain("safe delegation is allowed whenever isolation is not required")
    expect(rules).toContain("Do not claim automated GitHub issue or pull request coordination")
    expect(Object.keys(DELEGATION_RULES)).toEqual(["planning", "research", "implementation", "review"])
    expect(DELEGATION_RULES.implementation.writes).toBe(true)
    expect(DELEGATION_RULES.review.writes).toBe(false)
  })

  test("preserves the five-field handoff format byte-for-byte in every handoff-bearing prompt", () => {
    expect(HANDOFF_FORMAT).toBe(
      [
        "Outcome: what was achieved or discovered",
        "Files: files read or changed, with scope",
        "Verification: commands run and their results",
        "Risks: known uncertainty or regression risk",
        "Follow-up: the next concrete action",
      ].join("\n"),
    )
    // The orchestrator and worker system prompts embed the literal format; the
    // command and continuation prompts carry the structured guidance only.
    for (const [name, prompt] of allPromptKinds()) {
      expect(prompt).toContain(STRUCTURED_HANDOFF_GUIDANCE)
      if (name === "orchestrator system" || name === "worker system") expect(prompt).toContain(HANDOFF_FORMAT)
    }
  })

  test("the guidance appears exactly once per prompt, not duplicated per section", () => {
    for (const options of [DEFAULT, WORKTREE, GITHUB, BOTH]) {
      for (const [, prompt] of promptKinds(options)) {
        expect(prompt.split("inspect the tool catalog").length - 1).toBe(1)
        expect(prompt.split("Never request, resolve, log, paste, or copy").length - 1).toBe(1)
        expect(prompt.split("plugin-controlled atomic worktree").length - 1).toBe(1)
        expect(prompt.split("callable/advisory, not automatic hooks").length - 1).toBe(1)
        expect(prompt.split("Bounded nested delegation graph").length - 1).toBe(1)
        expect(prompt.split("Follow through autonomously").length - 1).toBe(1)
        expect(prompt.split("Verify in proportion to risk").length - 1).toBe(1)
        // Feature lifecycle sections are embedded at most once each.
        expect(prompt.split("Worktree lifecycle is mandatory").length - 1).toBe(options.worktree.enabled ? 1 : 0)
        expect(prompt.split("preflight with orchestrator_github_capabilities").length - 1).toBe(
          options.github.enabled ? 1 : 0,
        )
      }
    }
  })
})

describe("nested delegation policy", () => {
  const DEFAULT = parseOptions({})

  test("the delegation graph matches the agreed bounded edges", () => {
    expect(ROLE_DELEGATION).toEqual({
      planning: ["research"],
      research: [],
      implementation: ["planning", "research"],
      review: ["research"],
    })
  })

  test("the graph summary renders every role exactly once with research as the only leaf", () => {
    expect(delegationGraphSummary()).toBe(
      "orchestrator→all configured roles; planning→research; research→no delegation; implementation→planning,research; review→research",
    )
  })

  test("delegation guidance states the exact edges, parent accountability, and the out-of-graph ban", () => {
    expect(DELEGATION_GRAPH_GUIDANCE).toContain("orchestrator→all configured roles")
    expect(DELEGATION_GRAPH_GUIDANCE).toContain("implementation→planning,research")
    expect(DELEGATION_GRAPH_GUIDANCE).toContain("review→research")
    expect(DELEGATION_GRAPH_GUIDANCE).toContain("research→no delegation")
    expect(DELEGATION_GRAPH_GUIDANCE).toContain("stays accountable for its children")
    expect(DELEGATION_GRAPH_GUIDANCE).toContain("Delegating outside your role graph is forbidden")
    expect(DELEGATION_GRAPH_GUIDANCE).toContain("stop and report honestly")
    // The guidance must not name concrete model or deployment tool names.
    expect(DELEGATION_GRAPH_GUIDANCE).not.toMatch(/claude|github\.[a-z_]+/i)
  })

  test("prompting policy guidance carries all five authorized behaviors", () => {
    expect(PROMPTING_POLICY_GUIDANCE).toContain("Follow through autonomously on exactly what the task authorizes")
    expect(PROMPTING_POLICY_GUIDANCE).toContain("take precedence over skill guidance and general defaults")
    expect(PROMPTING_POLICY_GUIDANCE).toContain("Inter-agent messages must be clear and legible")
    expect(PROMPTING_POLICY_GUIDANCE).toContain("Verify in proportion to risk")
    expect(PROMPTING_POLICY_GUIDANCE).toContain("Report to the user concisely with evidence")
    expect(PROMPTING_POLICY_GUIDANCE).not.toMatch(/claude|github\.[a-z_]+/i)
  })

  test("every prompt kind embeds the graph, the prompting policy, and parent accountability exactly once", () => {
    const kinds: Array<[string, string]> = [
      ["orchestrator system", buildOrchestratorSystem(DEFAULT)],
      ["worker planning", buildWorkerSystem("planning", DEFAULT)],
      ["worker research", buildWorkerSystem("research", DEFAULT)],
      ["worker implementation", buildWorkerSystem("implementation", DEFAULT)],
      ["worker review", buildWorkerSystem("review", DEFAULT)],
      ["continuation", buildContinuationPrompt("objective", 2, DEFAULT)],
      ...["orchestrate", "goal", "restructure", "run-plan", "halt", "handover", "polish", "stress-plan"].map(
        (name) => [`command ${name}`, buildCommandPrompt(name, "scope", DEFAULT)] as [string, string],
      ),
    ]
    for (const [name, prompt] of kinds) {
      expect(prompt.split("Bounded nested delegation graph").length - 1, name).toBe(1)
      expect(prompt.split("Follow through autonomously").length - 1, name).toBe(1)
      expect(prompt.split("Delegating outside your role graph is forbidden").length - 1, name).toBe(1)
      // The child-task contract (with parent accountability) is embedded in
      // the orchestrator and worker systems; command and continuation prompts
      // reference it through the runtime context hook instead.
      if (name.startsWith("worker") || name === "orchestrator system") {
        expect(prompt.split("The parent stays accountable for every delegated child").length - 1, name).toBe(1)
      }
    }
  })

  test("worker prompts name exactly their own role-graph delegations", () => {
    const planning = buildWorkerSystem("planning")
    expect(planning).toContain("only the research role")
    expect(planning).not.toContain("planning and research roles")

    const implementation = buildWorkerSystem("implementation")
    expect(implementation).toContain("only the planning and research roles")
    expect(implementation).not.toContain("review role;")

    const review = buildWorkerSystem("review")
    expect(review).toContain("only the research role")
    expect(review).not.toContain("planning and research roles")

    // The orchestrator keeps the unbounded top of the graph.
    expect(buildOrchestratorSystem(DEFAULT)).toContain("delegate to every configured role")
  })

  test("the research prompt forbids delegation and requires direct webfetch/websearch", () => {
    expect(ROLE_GUIDANCE.research).toContain("webfetch and websearch directly")
    expect(ROLE_GUIDANCE.research).toContain("never launch subagents")
    const prompt = buildWorkerSystem("research")
    expect(prompt).toContain("webfetch and websearch directly")
    expect(prompt).toContain("research→no delegation")
  })

  test("the child contract bounds delegation to the child's own role graph", () => {
    const prompt = buildOrchestratorSystem(DEFAULT)
    expect(prompt).toContain("delegating outside the child's own role graph")
    expect(prompt).not.toContain("or launching other agents.")
    expect(orchestrationRules(4, true)).toContain(DELEGATION_GRAPH_GUIDANCE)
    expect(orchestrationRules(4, true)).toContain(PROMPTING_POLICY_GUIDANCE)
  })
})
