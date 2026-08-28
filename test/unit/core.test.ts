import { describe, expect, test } from "bun:test"
import {
  buildCommandPrompt,
  buildContinuationPrompt,
  buildOrchestratorSystem,
  buildWorkerSystem,
} from "../../src/core/prompts.js"
import { parseOptions } from "../../src/core/config.js"
import {
  DELEGATION_RULES,
  MANAGED_WORKTREE_GUIDANCE,
  REMOTE_ORCHESTRATION_GUIDANCE,
  SECRET_HANDLING_GUIDANCE,
  TOOL_AVAILABILITY_GUIDANCE,
  WORKTREE_BOUNDARY_GUIDANCE,
  orchestrationRules,
} from "../../src/core/policy.js"

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

  test("renders complete command arguments", () => {
    expect(buildCommandPrompt("goal", "pause")).toContain("pause")
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
    "cd",
  ]

  function allPromptKinds(): Array<[string, string]> {
    const prompts: Array<[string, string]> = [
      ["orchestrator system", buildOrchestratorSystem(parseOptions({}))],
      ["worker system", buildWorkerSystem("implementation")],
      ["continuation", buildContinuationPrompt("objective", 2)],
    ]
    for (const name of COMMAND_NAMES) {
      prompts.push([`command ${name}`, buildCommandPrompt(name, "scope")])
    }
    return prompts
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
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt).toContain("orchestrator_worktree_create")
      expect(prompt).toContain("owned by the current session")
      expect(prompt).toContain("not atomic child isolation")
      expect(prompt).toContain("/cd moves the current session while preserving its ID and history")
    }
    // The remote GitHub guidance is still present alongside the worktree text.
    expect(MANAGED_WORKTREE_GUIDANCE).toContain("orchestrator_worktree_cleanup")
    expect(MANAGED_WORKTREE_GUIDANCE).toContain("current session only")
    expect(REMOTE_ORCHESTRATION_GUIDANCE).toContain("inspect the tool catalog")
    expect(REMOTE_ORCHESTRATION_GUIDANCE).toContain(MANAGED_WORKTREE_GUIDANCE)
  })

  test("the cd command prompt requires a real session move and rejects shell-shaped input", () => {
    const prompt = buildCommandPrompt("cd", "subdir")
    expect(prompt).toContain("session ID and history")
    expect(prompt).toContain("existing directory")
    expect(prompt).toContain("flag-shaped or shell-metacharacter")
    expect(prompt).toContain("Do not run a shell or create a worktree")
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

  test("the guidance appears exactly once per prompt, not duplicated per section", () => {
    for (const [, prompt] of allPromptKinds()) {
      expect(prompt.split("inspect the tool catalog").length - 1).toBe(1)
      expect(prompt.split("Never request, resolve, log, paste, or copy").length - 1).toBe(1)
      expect(prompt.split("advisory").length - 1).toBe(1)
    }
  })
})
