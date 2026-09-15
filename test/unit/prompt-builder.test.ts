import { describe, expect, test } from "bun:test"
import { buildOrchestrationPrompt } from "../../src/core/prompt-builder.js"

const COORDINATION_SENTENCE =
  "Coordinate this task end to end. Start with repository facts, prefer the smallest coherent end-to-end slice over a file-by-file or layer-by-layer split, delegate independent work in parallel only with exact disjoint write scopes, integrate the results, and verify the final state directly."

const SLICE_PREFERENCE_PHRASE = "prefer the smallest coherent end-to-end slice over a file-by-file or layer-by-layer split"
const SERIALIZATION_PHRASE = "split only at a verified boundary and serialize unknown coupling"

const CLARIFICATION_PHRASES = [
  "use the native ask tool",
  "clarifying questions",
  "before decomposing",
  "concrete answer options",
]

const FORBIDDEN_STRINGS = [
  "inspect the tool catalog",
  "Never request, resolve, log, paste, or copy",
  "automatically create",
  "callable/advisory, not automatic hooks",
  "/cd",
]

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe("buildOrchestrationPrompt", () => {
  test("embeds the objective verbatim with the Task: label", () => {
    const prompt = buildOrchestrationPrompt({ objective: "refactor the storage layer and keep tests green" })
    expect(prompt).toContain("refactor the storage layer and keep tests green")
    expect(prompt).toContain("Task: refactor the storage layer and keep tests green")
  })

  test("starts with the exact coordination sentence", () => {
    const prompt = buildOrchestrationPrompt({ objective: "fix the login flow" })
    expect(prompt.startsWith(COORDINATION_SENTENCE)).toBe(true)
    expect(prompt).toContain(COORDINATION_SENTENCE)
  })

  test("uses a placeholder when the trimmed objective is empty", () => {
    const prompt = buildOrchestrationPrompt({ objective: "   " })
    expect(prompt).toContain("Task: (no arguments)")
  })

  test("instructs fact gathering before decomposition", () => {
    const prompt = buildOrchestrationPrompt({ objective: "migrate the store" })
    expect(prompt).toContain("Gather repository facts before decomposition")
    expect(prompt).toContain("separate established facts from assumptions")
  })

  test("prefers a coherent end-to-end slice before delegating parallel work", () => {
    const prompt = buildOrchestrationPrompt({ objective: "add pagination to /api/items with tests" })
    expect(prompt).toContain(SLICE_PREFERENCE_PHRASE)
    expect(prompt).toContain(SERIALIZATION_PHRASE)
    // The slice preference precedes the parallel-delegation instruction, so
    // the prompt never invites a file-by-file split before checking cohesion.
    expect(prompt.indexOf(SLICE_PREFERENCE_PHRASE)).toBeGreaterThan(-1)
    expect(prompt.indexOf(SLICE_PREFERENCE_PHRASE)).toBeLessThan(
      prompt.indexOf("delegate independent work in parallel only with exact disjoint write scopes"),
    )
    // The builder itself states the preference and the serialization rule; the
    // shared no-isolation caveat is asserted on the composed command prompt in
    // the policy suite. Never a positive isolation or scheduling claim here.
    expect(prompt).not.toMatch(/provid(?:e|ed).{0,40}isolat/i)
    expect(prompt).not.toMatch(/scheduler|semaphore|automatic(?:ally)? enforc/i)
  })

  test("includes the clarification section when clarifyEnabled is true", () => {
    const prompt = buildOrchestrationPrompt({ objective: "audit the auth flow", clarifyEnabled: true })
    for (const phrase of CLARIFICATION_PHRASES) {
      expect(prompt).toContain(phrase)
    }
  })

  test("omits the clarification section when clarifyEnabled is false or undefined", () => {
    const disabled = buildOrchestrationPrompt({ objective: "audit the auth flow", clarifyEnabled: false })
    const absent = buildOrchestrationPrompt({ objective: "audit the auth flow" })
    for (const phrase of CLARIFICATION_PHRASES) {
      expect(disabled).not.toContain(phrase)
      expect(absent).not.toContain(phrase)
    }
  })

  test("is deterministic for identical input", () => {
    const input = { objective: "parallelize the build pipeline", clarifyEnabled: true }
    expect(buildOrchestrationPrompt(input)).toBe(buildOrchestrationPrompt(input))
  })

  test("key phrases occur exactly once", () => {
    const prompt = buildOrchestrationPrompt({ objective: "triage the failures", clarifyEnabled: true })
    expect(countOccurrences(prompt, COORDINATION_SENTENCE)).toBe(1)
    expect(countOccurrences(prompt, "Task:")).toBe(1)
    expect(countOccurrences(prompt, SLICE_PREFERENCE_PHRASE)).toBe(1)
    expect(countOccurrences(prompt, SERIALIZATION_PHRASE)).toBe(1)
    for (const phrase of CLARIFICATION_PHRASES) {
      expect(countOccurrences(prompt, phrase)).toBe(1)
    }
  })

  test("forbidden content is absent with and without clarification", () => {
    const prompts = [
      buildOrchestrationPrompt({ objective: "harden the service", clarifyEnabled: true }),
      buildOrchestrationPrompt({ objective: "harden the service" }),
    ]
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/github\.[a-z_]+/i)
      expect(prompt).not.toMatch(/claude/i)
      // Never a positive isolation or runtime-scheduling claim.
      expect(prompt).not.toMatch(/provid(?:e|ed).{0,40}isolat/i)
      expect(prompt).not.toMatch(/scheduler|semaphore|\bisolated\b/i)
      for (const forbidden of FORBIDDEN_STRINGS) {
        expect(prompt).not.toContain(forbidden)
      }
    }
  })
})