import { describe, expect, test } from "bun:test"
import {
  CAPABILITY_LEVELS,
  CAPABILITY_VOCABULARY,
  CURRENT_CAPABILITY_STATEMENTS,
  renderCapabilityGuidance,
} from "../../src/core/capabilities.js"
import { parseOptions } from "../../src/core/config.js"
import { buildContinuationPrompt, buildOrchestratorSystem, buildWorkerSystem } from "../../src/core/prompts.js"

describe("capability vocabulary", () => {
  test("defines the four claim levels in increasing evidence order", () => {
    expect(CAPABILITY_LEVELS).toEqual(["guidance", "recorded", "observed", "enforced"])
    expect(CAPABILITY_VOCABULARY).toContain("guidance means prompt-only preference")
    expect(CAPABILITY_VOCABULARY).toContain("recorded means strict state")
    expect(CAPABILITY_VOCABULARY).toContain("observed means the plugin received")
    expect(CAPABILITY_VOCABULARY).toContain("enforced means a runtime operation refuses")
  })

  test("renders every current claim with its named level", () => {
    const rendered = renderCapabilityGuidance()
    for (const statement of CURRENT_CAPABILITY_STATEMENTS) {
      expect(rendered).toContain(`${statement.id} (${statement.level}): ${statement.statement}`)
    }
  })

  test("prompt variants do not overstate advisory claims", () => {
    const options = parseOptions({})
    const prompts = [
      buildOrchestratorSystem(options),
      buildWorkerSystem("implementation", options),
      buildContinuationPrompt("objective", 1, options),
    ]
    for (const prompt of prompts) {
      expect(prompt).toContain("Capability vocabulary:")
      expect(prompt).toContain("parallel-dispatch (guidance)")
      expect(prompt).toContain("lead-command-checks (recorded)")
      expect(prompt).toContain("bounded-review-identity (recorded)")
      expect(prompt).not.toMatch(/runtime concurrency cap/i)
      expect(prompt).not.toMatch(/reviewer[- ]proven/i)
      expect(prompt).not.toMatch(/command was rerun/i)
    }
  })
})
