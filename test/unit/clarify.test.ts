import { describe, expect, test } from "bun:test"
import {
  CLARIFY_GUIDANCE,
  HANDOFF_FORMAT,
  REMOTE_ORCHESTRATION_GUIDANCE,
  TOOL_AVAILABILITY_GUIDANCE,
} from "../../src/core/policy.js"

describe("policy regression guards", () => {
  test("preserves the five-field handoff format byte-for-byte", () => {
    expect(HANDOFF_FORMAT).toBe(
      [
        "Outcome: what was achieved or discovered",
        "Files: files read or changed, with scope",
        "Verification: commands run and their results",
        "Risks: known uncertainty or regression risk",
        "Follow-up: the next concrete action",
      ].join("\n"),
    )
  })

  test("remote orchestration guidance still embeds tool availability guidance", () => {
    expect(REMOTE_ORCHESTRATION_GUIDANCE).toContain(TOOL_AVAILABILITY_GUIDANCE)
  })
})

describe("clarify guidance", () => {
  test("carries the ask-tool clarification policy phrases", () => {
    for (const phrase of [
      "Clarify mode is enabled",
      "native ask tool",
      "before decomposing",
      "Workers never ask",
      "clarification is owned by the orchestrator",
      "Do not ask what repository facts can answer",
      "Record the user's answers in the task ledger",
    ]) {
      expect(CLARIFY_GUIDANCE).toContain(phrase)
    }
  })

  test("stays free of forbidden literal strings", () => {
    expect(CLARIFY_GUIDANCE).not.toMatch(/github\.[a-z_]+/i)
    expect(CLARIFY_GUIDANCE).not.toContain("/cd")
    expect(CLARIFY_GUIDANCE).not.toContain("automatically create")
    expect(CLARIFY_GUIDANCE).not.toMatch(/claude/i)
  })

  test("is between 4 and 6 lines long", () => {
    const lineCount = CLARIFY_GUIDANCE.split("\n").length
    expect(lineCount).toBeGreaterThanOrEqual(4)
    expect(lineCount).toBeLessThanOrEqual(6)
  })
})