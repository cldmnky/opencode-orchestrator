import { describe, expect, test } from "bun:test"
import {
  archiveSessionState,
  countLegacyState,
  exportSessionState,
  resetSessionState,
  validateSessionState,
  StateRecoveryError,
  type RecoveryStorage,
} from "../../src/opencode-v2/state-recovery.js"

type StorageHooks = {
  failSet?: (key: string, value: unknown) => boolean
  failRemove?: (key: string) => boolean
  scan?: RecoveryStorage["scan"]
}

function storage(initial: Record<string, unknown> = {}, hooks: StorageHooks = {}): RecoveryStorage & { values: Map<string, unknown> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => {
      if (hooks.failSet?.(key, value)) throw new Error("injected set failure")
      values.set(key, value)
    },
    remove: async (key) => {
      if (hooks.failRemove?.(key)) throw new Error("injected remove failure")
      values.delete(key)
    },
    scan:
      hooks.scan ??
      (async ({ prefix }) => ({
        entries: [...values.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => ({ key, value })),
      })),
  }
}

describe("operator state recovery", () => {
  test("exports bounded metadata and reports exact schema paths without exposing records", async () => {
    const state = storage({
      "goal/v1/project/session-one": {
        version: 1,
        sessionID: "session-one",
        objective: "do not export this objective",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
        continuationCount: 0,
      },
      "goal/v1/project/session-bad": { version: 9, sessionID: "session-bad" },
      "goal/v1/project/other": { version: 1, sessionID: "other" },
      "worktree/v2/sessions/session-one": {
        version: 1,
        sessionID: "session-one",
        projectID: "project",
        originProjectID: "project",
        directory: "/workspace",
        updatedAt: 1,
      },
    })

    const exported = await exportSessionState(state, "session-one")
    expect(exported.complete).toBe(true)
    expect(exported.records.map((record) => record.key)).toEqual([
      "goal/v1/project/session-one",
      "worktree/v2/sessions/session-one",
    ])
    expect(JSON.stringify(exported)).not.toContain("do not export this objective")

    const validated = await validateSessionState(state, "session-bad")
    expect(validated.records).toHaveLength(1)
    expect(validated.records[0]?.valid).toBe(false)
    expect(validated.records[0]?.issues.some((issue) => issue.path === "version")).toBe(true)
  })

  test("archives before removal and reset is scoped to one explicit family", async () => {
    const state = storage({
      "goal/v1/project/session-one": {
        version: 1,
        sessionID: "session-one",
        objective: "bounded",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        continuationCount: 0,
      },
      "run/v1/project/session-one": {
        version: 1,
        sessionID: "session-one",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const reset = await resetSessionState(state, "session-one", "goal", true, 100)
    expect(reset.archived).toBe(1)
    expect(reset.removed).toBe(1)
    expect(state.values.has("goal/v1/project/session-one")).toBe(false)
    expect(state.values.has("run/v1/project/session-one")).toBe(true)
    expect([...state.values.keys()].some((key) => key.startsWith("orchestrator-state-archive/v1/100/"))).toBe(true)

    const archived = await archiveSessionState(state, "session-one", 200)
    expect(archived.archived).toBe(1)
    expect(archived.removed).toBe(1)
    expect(state.values.has("run/v1/project/session-one")).toBe(false)
  })

  test("fails closed when scanning is unavailable and counts legacy records without returning values", async () => {
    const values = new Map<string, unknown>([["review/v1/project/session-one", { version: 1 }]])
    const noScan: RecoveryStorage = {
      get: async (key) => values.get(key),
      set: async (key, value) => void values.set(key, value),
      remove: async (key) => void values.delete(key),
    }
    const exported = await exportSessionState(noScan, "session-one")
    expect(exported.complete).toBe(false)
    await expect(resetSessionState(noScan, "session-one", "review-v1", true)).rejects.toThrow(/incomplete/)

    const withScan = storage({ "review/v1/project/session-one": { version: 1 } })
    expect(await countLegacyState(withScan)).toBe(1)
  })

  test("does not remove live state when an archive write fails", async () => {
    const state = storage(
      {
        "goal/v1/project/session-one": {
          version: 1,
          sessionID: "session-one",
          objective: "keep me",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          continuationCount: 0,
        },
      },
      { failSet: (key) => key.startsWith("orchestrator-state-archive/") },
    )

    await expect(archiveSessionState(state, "session-one", 300)).rejects.toBeInstanceOf(StateRecoveryError)
    expect(state.values.has("goal/v1/project/session-one")).toBe(true)
    expect([...state.values.keys()].filter((key) => key.startsWith("orchestrator-state-archive/")).length).toBe(0)
  })

  test("restores live state when removal fails after archiving", async () => {
    const state = storage(
      {
        "goal/v1/project/session-one": {
          version: 1,
          sessionID: "session-one",
          objective: "goal",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          continuationCount: 0,
        },
        "run/v1/project/session-one": {
          version: 1,
          sessionID: "session-one",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        },
      },
      { failRemove: (key) => key === "run/v1/project/session-one" },
    )

    await expect(archiveSessionState(state, "session-one", 301)).rejects.toThrow(/live state was restored/)
    expect(state.values.has("goal/v1/project/session-one")).toBe(true)
    expect(state.values.has("run/v1/project/session-one")).toBe(true)
    expect([...state.values.keys()].some((key) => key.startsWith("orchestrator-state-archive/v1/301/"))).toBe(true)
  })

  test("chooses a fresh archive namespace when a timestamp namespace already exists", async () => {
    const state = storage({
      "goal/v1/project/session-one": {
        version: 1,
        sessionID: "session-one",
        objective: "goal",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        continuationCount: 0,
      },
      "orchestrator-state-archive/v1/302/existing": { version: 1 },
    })

    const result = await archiveSessionState(state, "session-one", 302)
    expect(result.archiveNamespace).toBe("orchestrator-state-archive/v1/302-1")
    expect(state.values.has("orchestrator-state-archive/v1/302/existing")).toBe(true)
  })

  test("fails closed on malformed, oversized, and repeated scan pages", async () => {
    const malformed = storage({}, { scan: async () => null as never })
    const malformedExport = await exportSessionState(malformed, "session-one")
    expect(malformedExport.complete).toBe(false)
    expect(await countLegacyState(malformed)).toBeUndefined()
    await expect(resetSessionState(malformed, "session-one", "goal", true)).rejects.toThrow(/incomplete/)

    const oversized = storage({}, { scan: async () => ({ entries: Array.from({ length: 65 }, (_, index) => ({ key: `x/${index}`, value: {} })) }) })
    const oversizedExport = await exportSessionState(oversized, "session-one")
    expect(oversizedExport.complete).toBe(false)
    await expect(resetSessionState(oversized, "session-one", "goal", true)).rejects.toThrow(/incomplete/)

    let calls = 0
    const repeated = storage(
      {},
      {
        scan: async () => {
          calls += 1
          return calls === 1 ? { entries: [], next: "cursor" } : { entries: [], next: "cursor" }
        },
      },
    )
    const repeatedExport = await exportSessionState(repeated, "session-one")
    expect(repeatedExport.complete).toBe(false)
    expect(repeatedExport.limitations.some((limitation) => limitation.includes("repeated"))).toBe(true)
    await expect(resetSessionState(repeated, "session-one", "goal", true)).rejects.toThrow(/incomplete/)
  })
})
