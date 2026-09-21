import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const fixturePaths = [
  "../../docs/phase-1/d2-handoff.schema.json",
  "../../docs/phase-1/d2-handoff.example.json",
  "../../docs/phase-1/d4-task-corpus.json",
] as const

describe("repository contract fixtures", () => {
  test("all runtime-loaded phase-1 fixtures exist", () => {
    for (const relativePath of fixturePaths) {
      const path = fileURLToPath(new URL(relativePath, import.meta.url))
      expect(existsSync(path)).toBe(true)
      expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow()
    }
  })

  test("the state migration inventory is shipped with the fixtures", () => {
    const path = fileURLToPath(new URL("../../docs/state-migrations.md", import.meta.url))
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, "utf8")
    for (const family of ["Goal", "Plan run", "Lead board", "Review", "Worktree", "Session anchor"]) {
      expect(text).toContain(`| ${family} |`)
    }
  })
})
