import { describe, expect, test } from "bun:test"
import type { LocationLike, StorageLike } from "../../src/opencode-v2/goal/state.js"
import {
  boardCompletionEligibleV2,
  completeLeadBoardV2,
  createLeadBoardV2,
  hydrateLeadBoardV2,
  leadBoardV2StorageKey,
  migrateLeadBoardV1,
  migrateLeadBoardV1Storage,
  pauseLeadBoardV2,
  parseLeadBoardV2,
  transitionLeadTaskV2,
  type LeadBoardV2,
} from "../../src/opencode-v2/orchestration/lead-board-v2.js"
import { createLeadBoard, leadBoardStorageKey } from "../../src/opencode-v2/orchestration/lead-board.js"

const location: LocationLike = { directory: "/workspace", project: { id: "project" } }
const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)

function storage(values = new Map<string, unknown>()): StorageLike & { values: Map<string, unknown> } {
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  }
}

function board(): LeadBoardV2 {
  return createLeadBoardV2({
    projectID: "project",
    leadSessionID: "lead",
    goalGeneration: 1,
    objective: "ship the change",
    now: 1,
  })
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe("lead board V2", () => {
  test("creates a strict V2 record under the V2 key", () => {
    const current = board()
    expect(current.version).toBe(2)
    expect(leadBoardV2StorageKey(location, "lead")).toBe("lead-board/v2/project/lead")
    expect(parseLeadBoardV2(plain(current))).toEqual(current)
    expect(parseLeadBoardV2({ ...plain(current), version: 1 })).toBeUndefined()
  })

  test("rejects completed or review-ready tasks without V2 proof", () => {
    const current = board()
    const awaitingReview = {
      ...current,
      tasks: [{ ...current.tasks[0]!, status: "awaiting-review" as const }],
    }
    expect(parseLeadBoardV2(awaitingReview)).toBeUndefined()

    const completed = {
      ...current,
      tasks: [{ ...current.tasks[0]!, status: "completed" as const }],
    }
    expect(parseLeadBoardV2(completed)).toBeUndefined()

    const duplicateScope = {
      ...current,
      tasks: [{ ...current.tasks[0]!, scope: { ...current.tasks[0]!.scope, readPaths: ["src/a.ts", "src/a.ts"] } }],
    }
    expect(parseLeadBoardV2(duplicateScope)).toBeUndefined()
  })

  test("migrates V1 proof conservatively without upgrading it", () => {
    const legacy = createLeadBoard({
      projectID: "project",
      leadSessionID: "lead",
      goalGeneration: 1,
      objective: "ship the change",
      now: 1,
    })
    const legacyWithProof = {
      ...legacy,
      tasks: [
        {
          ...legacy.tasks[0]!,
          status: "awaiting-review" as const,
          lifecycleVersion: 4,
          validation: { leadSessionID: "lead", validatedAt: 2, revision: HEAD, checkIDs: ["caller:pass"] },
          review: { reference: "review/v1/claimed", revision: HEAD, approvedAt: 3 },
        },
      ],
    }

    const migrated = migrateLeadBoardV1(plain(legacyWithProof), 9)
    expect(migrated).toBeDefined()
    expect(migrated!.version).toBe(2)
    expect(migrated!.tasks[0]!.status).toBe("awaiting-validation")
    expect(migrated!.tasks[0]!.validation).toBeUndefined()
    expect(migrated!.tasks[0]!.review).toBeUndefined()
    expect(migrated!.tasks[0]!.migrationNote).toContain("was not upgraded")
    expect(migrated!.migration?.fromVersion).toBe(1)
    expect(legacyWithProof.tasks[0]!.validation).toBeDefined()
  })

  test("keeps a fully completed V1 board readable as historical state", () => {
    const legacy = createLeadBoard({
      projectID: "project",
      leadSessionID: "lead",
      goalGeneration: 1,
      objective: "historical",
      now: 1,
    })
    const historical = {
      ...legacy,
      status: "complete" as const,
      tasks: [{ ...legacy.tasks[0]!, status: "completed" as const }],
    }
    const migrated = migrateLeadBoardV1(plain(historical), 9)
    expect(migrated?.historical).toBe(true)
    expect(migrated?.status).toBe("complete")
    expect(migrated?.tasks[0]?.status).toBe("completed")
    expect(migrated?.tasks[0]?.migrationNote).toContain("was not upgraded")
    expect(parseLeadBoardV2(migrated)).toBeDefined()
    expect(boardCompletionEligibleV2(migrated!)).toBe(false)
  })

  test("preserves safe nonterminal V1 lifecycle states and rejects malformed graphs", () => {
    const legacy = createLeadBoard({
      projectID: "project",
      leadSessionID: "lead",
      goalGeneration: 1,
      objective: "recover",
      now: 1,
    })
    const states = ["planned", "ready", "reserved", "in-progress", "awaiting-validation", "changes-requested", "ambiguous", "failed", "blocked"] as const
    for (const status of states) {
      const migrated = migrateLeadBoardV1(
        plain({
          ...legacy,
          tasks: [{ ...legacy.tasks[0]!, status, validation: { leadSessionID: "lead", validatedAt: 2, revision: HEAD, checkIDs: ["caller:pass"] } }],
        }),
        9,
      )
      expect(migrated?.tasks[0]?.status).toBe(status)
      expect(migrated?.tasks[0]?.validation).toBeUndefined()
      expect(migrated?.tasks[0]?.migrationNote).toContain("was not upgraded")
    }

    const malformed = {
      ...legacy,
      tasks: [{ ...legacy.tasks[0]!, dependencies: ["missing"] }],
    }
    expect(migrateLeadBoardV1(plain(malformed), 9)).toBeUndefined()
  })

  test("storage migration is explicit and idempotent", async () => {
    const values = new Map<string, unknown>()
    const store = storage(values)
    const legacy = createLeadBoard({
      projectID: "project",
      leadSessionID: "lead",
      goalGeneration: 1,
      objective: "migrate",
      now: 1,
    })
    values.set(leadBoardStorageKey(location, "lead"), legacy)

    expect((await hydrateLeadBoardV2(store, location, "lead")).status).toBe("legacy")
    const first = await migrateLeadBoardV1Storage(store, location, "lead", { goalGeneration: 1 })
    expect(first.status).toBe("migrated")
    expect(values.has(leadBoardV2StorageKey(location, "lead"))).toBe(true)
    expect((await hydrateLeadBoardV2(store, location, "lead", { goalGeneration: 1 })).status).toBe("ok")

    const second = await migrateLeadBoardV1Storage(store, location, "lead", { goalGeneration: 1 })
    expect(second.status).toBe("exists")
    expect(second.board).toEqual(first.board)
  })

  test("uses plugin-context validation and review proof for completion", () => {
    let current = board()
    for (const input of [
      { action: "ready" as const, expectedVersion: 1 },
      { action: "reserve" as const, expectedVersion: 2, stepIndex: 1 },
      { action: "deliver" as const, expectedVersion: 3 },
      {
        action: "report" as const,
        expectedVersion: 4,
        evidence: [{ kind: "command" as const, reference: "bun test", description: "worker reported completion", observedAt: 5 }],
      },
      {
        action: "validate" as const,
        expectedVersion: 5,
        validation: { actorSessionID: "lead", validatedAt: 6, revision: HEAD, checkIDs: ["observed:pass"], receiptIDs: ["receipt-1"] },
      },
    ]) {
      const result = transitionLeadTaskV2({ board: current, taskID: "root", actorSessionID: "lead", ...input })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      current = result.board
    }

    expect(current.tasks[0]!.status).toBe("awaiting-review")
    const completed = transitionLeadTaskV2({
      board: current,
      taskID: "root",
      expectedVersion: 6,
      actorSessionID: "lead",
      action: "complete",
      review: { reference: "review/v2/task/run", revision: HEAD, baseRevision: BASE, approvedAt: 7, reviewVersion: 2 },
    })
    expect(completed.ok).toBe(true)
    if (!completed.ok) return
    expect(boardCompletionEligibleV2(completed.board)).toBe(true)

    const finished = completeLeadBoardV2(completed.board, {
      revision: HEAD,
      baseRevision: BASE,
      reviewReference: "review/v2/task/run",
      validationActorSessionID: "lead",
      receiptIDs: ["receipt-1"],
      evidence: [],
    })
    expect(finished.status).toBe("complete")
    expect(finished.completion?.baseRevision).toBe(BASE)
    expect(parseLeadBoardV2(finished)).toBeDefined()

    const roundTripped = pauseLeadBoardV2(finished, 8)
    expect(roundTripped.completion).toEqual(finished.completion)
  })
})
