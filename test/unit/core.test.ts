import { describe, expect, test } from "bun:test"
import {
  buildCommandPrompt,
  buildContinuationPrompt,
  buildOrchestratorSystem,
  buildWorkerSystem,
} from "../../src/core/prompts.js"
import { parseOptions } from "../../src/core/config.js"

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
