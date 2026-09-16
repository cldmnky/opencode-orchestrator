import { describe, expect, test } from "bun:test"
import {
  STEP_COMPLETED_MESSAGE_MAX_LENGTH,
  STEP_ERROR_MESSAGE_MAX_LENGTH,
  STEP_LIST_LIMIT_MAX,
  STEP_RECORD_VERSION,
  boundedStepErrorMessage,
  continuationStepIdempotencyKey,
  lastCompletedStep,
  listStepRecords,
  markStepCompleted,
  markStepDispatched,
  markStepFailed,
  newPendingStepRecord,
  parseStepRecord,
  readStepRecord,
  removeSessionSteps,
  removeStepRecord,
  stepIndexFromKey,
  stepPrefix,
  stepRecordSchema,
  stepStorageKey,
  writeStepRecord,
  type StepRecord,
  type StepStatus,
} from "../../src/opencode-v2/orchestration/step-state.js"
import type { LocationLike, StorageLike } from "../../src/opencode-v2/goal/state.js"

const LOCATION: LocationLike = { directory: "/workspace", project: { id: "project" } }
const SESSION = "session"
const STEP_KEY = stepStorageKey(LOCATION, SESSION, 1)

function memStorage(entries: Iterable<[string, unknown]> = []): StorageLike & { values: Map<string, unknown> } {
  const values = new Map(entries)
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    scan: async ({ prefix, after, limit }) => {
      const matches = [...values.keys()].sort().filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      const page = matches.slice(0, limit)
      const next = matches.length > page.length ? page[page.length - 1] : undefined
      return { entries: page.map((key) => ({ key, value: values.get(key) })), ...(next !== undefined ? { next } : {}) }
    },
  }
}

/** Storage whose scan always returns at most `pageSize` entries, forcing multi-page loops. */
function pagedStorage(entries: Iterable<[string, unknown]> = [], pageSize = 1): StorageLike & { values: Map<string, unknown> } {
  const values = new Map(entries)
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    scan: async ({ prefix, after }) => {
      const matches = [...values.keys()].sort().filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      const page = matches.slice(0, pageSize)
      const next = matches.length > page.length ? page[page.length - 1] : undefined
      return { entries: page.map((key) => ({ key, value: values.get(key) })), ...(next !== undefined ? { next } : {}) }
    },
  }
}

function noScanStorage(entries: Iterable<[string, unknown]> = []): StorageLike & { values: Map<string, unknown> } {
  const values = new Map(entries)
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  }
}

function pending(sessionID = SESSION, stepIndex = 1, now = 100): StepRecord {
  return newPendingStepRecord({
    sessionID,
    stepIndex,
    idempotencyKey: continuationStepIdempotencyKey(sessionID, 1, stepIndex),
    now,
  })
}

function recordWithStatus(status: StepStatus, stepIndex = 1, sessionID = SESSION): StepRecord {
  const base = pending(sessionID, stepIndex)
  switch (status) {
    case "pending":
      return base
    case "dispatched":
      return { ...base, status, dispatchedAt: base.createdAt + 1, updatedAt: base.createdAt + 1 }
    case "completed":
      return { ...base, status, completedAt: base.createdAt + 2, updatedAt: base.createdAt + 2 }
    case "failed":
      return {
        ...base,
        status,
        failedAt: base.createdAt + 3,
        updatedAt: base.createdAt + 3,
        errorClass: "transient",
        errorMessage: "connection reset",
      }
  }
}

describe("step record schema", () => {
  test("accepts a pending record and every lifecycle status", () => {
    for (const status of ["pending", "dispatched", "completed", "failed"] as const) {
      const parsed = stepRecordSchema.safeParse(recordWithStatus(status))
      expect(parsed.success, status).toBe(true)
    }
    const full = pending()
    expect(full.version).toBe(STEP_RECORD_VERSION)
    expect(full.status).toBe("pending")
    expect(full.attempt).toBe(1)

    const noted = stepRecordSchema.safeParse({ ...recordWithStatus("completed"), completedMessage: "observed idle" })
    expect(noted.success).toBe(true)
    expect(noted.success && noted.data.completedMessage).toBe("observed idle")
  })

  test("rejects unknown fields, unknown statuses, and out-of-range values", () => {
    expect(parseStepRecord({ ...pending(), extra: true })).toBeUndefined()
    expect(parseStepRecord({ ...pending(), status: "running" })).toBeUndefined()
    expect(parseStepRecord({ ...pending(), stepIndex: -1 })).toBeUndefined()
    expect(parseStepRecord({ ...pending(), stepIndex: 1.5 })).toBeUndefined()
    expect(parseStepRecord({ ...pending(), attempt: 0 })).toBeUndefined()
    expect(parseStepRecord({ ...pending(), errorClass: "very-bad" })).toBeUndefined()
    expect(parseStepRecord({ ...pending(), version: 2 })).toBeUndefined()
    expect(parseStepRecord({ ...pending(), errorMessage: "x".repeat(STEP_ERROR_MESSAGE_MAX_LENGTH + 1) })).toBeUndefined()
    expect(
      parseStepRecord({ ...pending(), completedMessage: "x".repeat(STEP_COMPLETED_MESSAGE_MAX_LENGTH + 1) }),
    ).toBeUndefined()
    expect(parseStepRecord({ ...pending(), completedAt: Number.NaN })).toBeUndefined()
  })

  test("treats non-record values as malformed instead of throwing", () => {
    expect(parseStepRecord(undefined)).toBeUndefined()
    expect(parseStepRecord(null)).toBeUndefined()
    expect(parseStepRecord([pending()])).toBeUndefined()
    expect(parseStepRecord("step")).toBeUndefined()
    expect(parseStepRecord({})).toBeUndefined()
  })

  test("boundedStepErrorMessage redacts known patterns, collapses whitespace, and truncates", () => {
    const message = boundedStepErrorMessage("push failed\n\tAuthorization: Bearer ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK")
    expect(message).not.toContain("ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK")
    expect(message).toContain("[redacted]")
    expect(message).toContain("push failed")
    expect(message).not.toContain("\n")

    const exact = boundedStepErrorMessage("token=super-secret-value rejected", ["super-secret-value"])
    expect(exact).not.toContain("super-secret-value")
    expect(exact).toContain("[redacted]")

    const long = boundedStepErrorMessage("x".repeat(2_000))
    expect(long.length).toBe(STEP_ERROR_MESSAGE_MAX_LENGTH)
    expect(long.endsWith("…")).toBe(true)

    expect(boundedStepErrorMessage("   \n  ")).toBe("")
  })

  test("newPendingStepRecord is deterministic and validates the step index", () => {
    const record = newPendingStepRecord({
      sessionID: SESSION,
      stepIndex: 3,
      idempotencyKey: continuationStepIdempotencyKey(SESSION, 7, 3),
      cursor: "opaque-cursor",
      now: 42,
    })
    expect(record).toEqual({
      version: 1,
      sessionID: SESSION,
      stepIndex: 3,
      status: "pending",
      idempotencyKey: "goal-continuation/session/7/3",
      attempt: 1,
      createdAt: 42,
      updatedAt: 42,
      cursor: "opaque-cursor",
    })
    expect(() => newPendingStepRecord({ sessionID: SESSION, stepIndex: -1, idempotencyKey: "k" })).toThrow()
    expect(() => newPendingStepRecord({ sessionID: SESSION, stepIndex: 1.5, idempotencyKey: "k" })).toThrow()
  })

  test("continuationStepIdempotencyKey is stable per goal generation and step", () => {
    expect(continuationStepIdempotencyKey("s/1", 10, 2)).toBe("goal-continuation/s%2F1/10/2")
    expect(continuationStepIdempotencyKey("s", 10, 2)).toBe(continuationStepIdempotencyKey("s", 10, 2))
    expect(continuationStepIdempotencyKey("s", 10, 2)).not.toBe(continuationStepIdempotencyKey("s", 11, 2))
    expect(continuationStepIdempotencyKey("s", 10, 2)).not.toBe(continuationStepIdempotencyKey("s", 10, 3))
  })
})

describe("step keys", () => {
  test("keys use the versioned stable-project/session/index shape", () => {
    expect(stepPrefix(LOCATION, SESSION)).toBe("step/v1/project/session/")
    expect(stepStorageKey(LOCATION, SESSION, 0)).toBe("step/v1/project/session/0")
    expect(stepStorageKey(LOCATION, SESSION, 12)).toBe("step/v1/project/session/12")
    expect(stepStorageKey({ ...LOCATION, project: { id: "a/b" } }, "c d", 1)).toBe("step/v1/a%2Fb/c%20d/1")
  })

  test("stepStorageKey refuses invalid indexes", () => {
    expect(() => stepStorageKey(LOCATION, SESSION, -1)).toThrow()
    expect(() => stepStorageKey(LOCATION, SESSION, 1.5)).toThrow()
    expect(() => stepStorageKey(LOCATION, SESSION, Number.MAX_SAFE_INTEGER + 1)).toThrow()
  })

  test("stepIndexFromKey is the exact inverse of stepStorageKey", () => {
    for (const index of [0, 1, 9, 10, 12345]) {
      expect(stepIndexFromKey(stepStorageKey(LOCATION, SESSION, index), LOCATION, SESSION)).toBe(index)
    }
  })

  test("stepIndexFromKey rejects foreign, nested, and non-canonical keys", () => {
    const prefix = stepPrefix(LOCATION, SESSION)
    expect(stepIndexFromKey(`${prefix}01`, LOCATION, SESSION)).toBeUndefined()
    expect(stepIndexFromKey(`${prefix}-1`, LOCATION, SESSION)).toBeUndefined()
    expect(stepIndexFromKey(`${prefix}1/2`, LOCATION, SESSION)).toBeUndefined()
    expect(stepIndexFromKey(`${prefix}x`, LOCATION, SESSION)).toBeUndefined()
    expect(stepIndexFromKey(`${prefix}`, LOCATION, SESSION)).toBeUndefined()
    expect(stepIndexFromKey(`${prefix}99999999999999999999`, LOCATION, SESSION)).toBeUndefined()
    expect(stepIndexFromKey("step/v1/other/session/1", LOCATION, SESSION)).toBeUndefined()
    expect(stepIndexFromKey(stepStorageKey(LOCATION, "other", 1), LOCATION, SESSION)).toBeUndefined()
  })
})

describe("step storage helpers", () => {
  test("writes and reads a record round-trip", async () => {
    const storage = memStorage()
    const record = pending()
    const written = await writeStepRecord(storage, LOCATION, record)
    expect(written).toEqual(record)
    expect(storage.values.get(STEP_KEY)).toEqual(record)
    expect(await readStepRecord(storage, LOCATION, SESSION, 1)).toEqual(record)
    expect(await readStepRecord(storage, LOCATION, SESSION, 2)).toBeUndefined()
  })

  test("write validates the record before storing anything", async () => {
    const storage = memStorage()
    const invalid = { ...pending(), idempotencyKey: "" } as StepRecord
    await expect(writeStepRecord(storage, LOCATION, invalid)).rejects.toThrow()
    expect(storage.values.size).toBe(0)
  })

  test("read ignores malformed stored values", async () => {
    const storage = memStorage([[STEP_KEY, { version: 1, sessionID: SESSION, stepIndex: 1 }]])
    expect(await readStepRecord(storage, LOCATION, SESSION, 1)).toBeUndefined()
  })

  test("receipts resolve the session's stable origin project", async () => {
    const anchorKey = "session/v1/project/session"
    const storage = memStorage([
      [
        anchorKey,
        {
          version: 1,
          sessionID: SESSION,
          originProjectID: "origin",
          originDirectory: "/origin",
          currentProjectID: "project",
          currentDirectory: "/workspace",
          updatedAt: 1,
        },
      ],
    ])
    await writeStepRecord(storage, LOCATION, pending())
    expect(storage.values.has("step/v1/origin/session/1")).toBe(true)
    expect(storage.values.has(STEP_KEY)).toBe(false)
    expect(await readStepRecord(storage, LOCATION, SESSION, 1)).toBeDefined()
  })

  test("removeStepRecord removes exactly one receipt", async () => {
    const storage = memStorage([
      [STEP_KEY, pending()],
      [stepStorageKey(LOCATION, SESSION, 2), pending(SESSION, 2)],
    ])
    await removeStepRecord(storage, LOCATION, SESSION, 1)
    expect(storage.values.has(STEP_KEY)).toBe(false)
    expect(storage.values.has(stepStorageKey(LOCATION, SESSION, 2))).toBe(true)
    // Removing a missing record is a no-op.
    await removeStepRecord(storage, LOCATION, SESSION, 9)
  })

  test("markStepDispatched moves pending to dispatched and never regresses", async () => {
    const storage = memStorage([[STEP_KEY, pending()]])
    const dispatched = await markStepDispatched(storage, LOCATION, SESSION, 1, 500)
    expect(dispatched?.status).toBe("dispatched")
    expect(dispatched?.dispatchedAt).toBe(500)
    expect(dispatched?.updatedAt).toBe(500)
    // Idempotent: a second call returns the same record unchanged.
    const again = await markStepDispatched(storage, LOCATION, SESSION, 1, 900)
    expect(again).toEqual(dispatched)
    expect(await markStepDispatched(storage, LOCATION, SESSION, 42)).toBeUndefined()

    const completed = recordWithStatus("completed")
    const completedStorage = memStorage([[STEP_KEY, completed]])
    expect(await markStepDispatched(completedStorage, LOCATION, SESSION, 1, 700)).toEqual(completed)
  })

  test("markStepFailed stores a bounded, redacted failure and never downgrades completed", async () => {
    const storage = memStorage([[STEP_KEY, pending()]])
    const failed = await markStepFailed(
      storage,
      LOCATION,
      SESSION,
      1,
      { errorClass: "ambiguous", errorMessage: "merge response lost Authorization: Bearer ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK", secrets: [] },
      600,
    )
    expect(failed?.status).toBe("failed")
    expect(failed?.failedAt).toBe(600)
    expect(failed?.errorClass).toBe("ambiguous")
    expect(failed?.errorMessage).not.toContain("ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK")
    expect(failed?.errorMessage).toContain("[redacted]")
    expect((failed?.errorMessage ?? "").length).toBeLessThanOrEqual(STEP_ERROR_MESSAGE_MAX_LENGTH)
    expect(await markStepFailed(storage, LOCATION, SESSION, 42, { errorClass: "unknown" })).toBeUndefined()

    const completed = recordWithStatus("completed")
    const completedStorage = memStorage([[STEP_KEY, completed]])
    expect(await markStepFailed(completedStorage, LOCATION, SESSION, 1, { errorClass: "permanent" })).toEqual(completed)
  })

  test("markStepCompleted completes pending and dispatched records and never rewrites terminal ones", async () => {
    const storage = memStorage([[STEP_KEY, pending()]])
    const completed = await markStepCompleted(storage, LOCATION, SESSION, 1, {}, 500)
    expect(completed?.status).toBe("completed")
    expect(completed?.completedAt).toBe(500)
    expect(completed?.updatedAt).toBe(500)
    expect(storage.values.get(STEP_KEY)).toEqual(completed)

    // Idempotent: a repeated call returns the same record and keeps the first
    // completion timestamp instead of rewriting the receipt.
    const again = await markStepCompleted(storage, LOCATION, SESSION, 1, {}, 900)
    expect(again).toEqual(completed)
    expect(storage.values.get(STEP_KEY)).toEqual(completed)

    const dispatchedStorage = memStorage([[STEP_KEY, recordWithStatus("dispatched")]])
    const fromDispatched = await markStepCompleted(dispatchedStorage, LOCATION, SESSION, 1, {}, 700)
    expect(fromDispatched?.status).toBe("completed")
    expect(fromDispatched?.dispatchedAt).toBe(101)
    expect(fromDispatched?.completedAt).toBe(700)
    expect(fromDispatched?.updatedAt).toBe(700)

    // Missing records stay missing instead of being created.
    expect(await markStepCompleted(storage, LOCATION, SESSION, 42)).toBeUndefined()
    expect(storage.values.has(stepStorageKey(LOCATION, SESSION, 42))).toBe(false)

    // A failed receipt is terminal evidence: completion never silently replaces it.
    const failed = recordWithStatus("failed")
    const failedStorage = memStorage([[STEP_KEY, failed]])
    expect(await markStepCompleted(failedStorage, LOCATION, SESSION, 1, {}, 800)).toEqual(failed)
    expect(failedStorage.values.get(STEP_KEY)).toEqual(failed)
  })

  test("markStepCompleted bounds and redacts an optional completion message", async () => {
    const completed = await markStepCompleted(
      memStorage([[STEP_KEY, pending()]]),
      LOCATION,
      SESSION,
      1,
      { message: "idle observed\nAuthorization: Bearer ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK", secrets: [] },
      600,
    )
    expect(completed?.completedMessage).toContain("idle observed")
    expect(completed?.completedMessage).not.toContain("ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK")
    expect(completed?.completedMessage).toContain("[redacted]")
    expect(completed?.completedMessage).not.toContain("\n")

    const exact = await markStepCompleted(
      memStorage([[STEP_KEY, pending()]]),
      LOCATION,
      SESSION,
      1,
      { message: "token=super-secret-value done", secrets: ["super-secret-value"] },
      600,
    )
    expect(exact?.completedMessage).not.toContain("super-secret-value")
    expect(exact?.completedMessage).toContain("[redacted]")

    // A long message is truncated to the completion bound.
    const long = await markStepCompleted(
      memStorage([[STEP_KEY, pending()]]),
      LOCATION,
      SESSION,
      1,
      { message: "x".repeat(2_000) },
      600,
    )
    expect(long?.completedMessage?.length).toBe(STEP_COMPLETED_MESSAGE_MAX_LENGTH)
    expect(long?.completedMessage?.endsWith("…")).toBe(true)

    // Blank messages are omitted instead of stored.
    const blankStorage = memStorage([[STEP_KEY, pending()]])
    const blank = await markStepCompleted(blankStorage, LOCATION, SESSION, 1, { message: "   \n  " }, 600)
    expect(blank?.completedMessage).toBeUndefined()
    expect(parseStepRecord(blankStorage.values.get(STEP_KEY))).toEqual(blank)
  })

  test("listStepRecords returns one parsed, sorted scan page with a cursor", async () => {
    const storage = memStorage([
      [stepStorageKey(LOCATION, SESSION, 3), pending(SESSION, 3)],
      [stepStorageKey(LOCATION, SESSION, 1), pending(SESSION, 1)],
      [stepStorageKey(LOCATION, SESSION, 2), pending(SESSION, 2)],
      [stepStorageKey(LOCATION, SESSION, 4), { status: "nope" }],
      [`${stepPrefix(LOCATION, SESSION)}bad`, pending(SESSION, 5)],
      [stepStorageKey(LOCATION, SESSION, 6), pending("other", 6)],
      [stepStorageKey(LOCATION, "other-session", 1), pending("other-session", 1)],
    ])
    const first = await listStepRecords(storage, LOCATION, SESSION, { limit: 2 })
    expect(first.entries.map((entry) => entry.stepIndex)).toEqual([1, 2])
    expect(first.complete).toBe(false)
    expect(first.next).toBe(stepStorageKey(LOCATION, SESSION, 2))
    expect(first.skipped).toBe(0)

    const second = await listStepRecords(storage, LOCATION, SESSION, { after: first.next, limit: 2 })
    expect(second.entries.map((entry) => entry.stepIndex)).toEqual([3])
    expect(second.complete).toBe(false)
    expect(second.next).toBe(stepStorageKey(LOCATION, SESSION, 4))
    expect(second.skipped).toBe(1)

    const third = await listStepRecords(storage, LOCATION, SESSION, { after: second.next })
    expect(third.entries).toEqual([])
    expect(third.complete).toBe(true)
    expect(third.skipped).toBe(2)
  })

  test("listStepRecords reports incomplete without scan and clamps oversized limits", async () => {
    const noScan = noScanStorage()
    expect(await listStepRecords(noScan, LOCATION, SESSION)).toEqual({
      version: 1,
      sessionID: SESSION,
      entries: [],
      complete: false,
      skipped: 0,
    })

    const storage = memStorage(
      Array.from({ length: STEP_LIST_LIMIT_MAX + 5 }, (_, index) => [stepStorageKey(LOCATION, SESSION, index), pending(SESSION, index)]),
    )
    const page = await listStepRecords(storage, LOCATION, SESSION, { limit: 10_000 })
    expect(page.entries).toHaveLength(STEP_LIST_LIMIT_MAX)
    expect(page.complete).toBe(false)
  })

  test("lastCompletedStep returns the highest completed index across scan pages", async () => {
    const storage = pagedStorage([
      [stepStorageKey(LOCATION, SESSION, 1), recordWithStatus("completed", 1)],
      [stepStorageKey(LOCATION, SESSION, 2), recordWithStatus("failed", 2)],
      [stepStorageKey(LOCATION, SESSION, 3), recordWithStatus("completed", 3)],
      [stepStorageKey(LOCATION, SESSION, 4), recordWithStatus("pending", 4)],
      [stepStorageKey(LOCATION, SESSION, 5), { status: "nope" }],
      [stepStorageKey(LOCATION, "other-session", 5), recordWithStatus("completed", 5, "other-session")],
    ])
    const last = await lastCompletedStep(storage, LOCATION, SESSION)
    expect(last?.stepIndex).toBe(3)
    expect(last?.status).toBe("completed")
    expect(await lastCompletedStep(noScanStorage(), LOCATION, SESSION)).toBeUndefined()
    expect(await lastCompletedStep(pagedStorage([[STEP_KEY, pending()]]), LOCATION, SESSION)).toBeUndefined()
  })

  test("removeSessionSteps removes every receipt of one session and nothing else", async () => {
    const otherSessionKey = stepStorageKey(LOCATION, "other-session", 1)
    const otherSessionCompletedKey = stepStorageKey(LOCATION, "other-session", 2)
    const foreignProjectKey = stepStorageKey({ ...LOCATION, project: { id: "other-project" } }, SESSION, 1)
    const completedKey = stepStorageKey(LOCATION, SESSION, 4)
    const storage = pagedStorage([
      [stepStorageKey(LOCATION, SESSION, 1), pending()],
      [stepStorageKey(LOCATION, SESSION, 2), pending(SESSION, 2)],
      [stepStorageKey(LOCATION, SESSION, 3), pending(SESSION, 3)],
      [completedKey, recordWithStatus("completed", 4)],
      [otherSessionKey, pending("other-session", 1)],
      [otherSessionCompletedKey, recordWithStatus("completed", 2, "other-session")],
      [foreignProjectKey, pending(SESSION, 1)],
    ])
    expect(await removeSessionSteps(storage, LOCATION, SESSION)).toBe(4)
    expect(storage.values.has(stepStorageKey(LOCATION, SESSION, 1))).toBe(false)
    expect(storage.values.has(stepStorageKey(LOCATION, SESSION, 2))).toBe(false)
    expect(storage.values.has(stepStorageKey(LOCATION, SESSION, 3))).toBe(false)
    expect(storage.values.has(completedKey)).toBe(false)
    expect(storage.values.get(otherSessionKey)).toBeDefined()
    expect(storage.values.get(otherSessionCompletedKey)).toBeDefined()
    expect(storage.values.get(foreignProjectKey)).toBeDefined()
    // Missing scan removes nothing instead of claiming a scalable prefix delete.
    expect(await removeSessionSteps(noScanStorage(storage.values), LOCATION, SESSION)).toBe(0)
  })

  test("removeSessionSteps stops at the bounded scan cap instead of claiming completeness", async () => {
    const total = 2_100
    const beyondCap = 100
    const storage = memStorage(
      Array.from({ length: total }, (_, index) => [stepStorageKey(LOCATION, SESSION, index), pending(SESSION, index)]),
    )
    expect(await removeSessionSteps(storage, LOCATION, SESSION)).toBe(total - beyondCap)
    expect(storage.values.size).toBe(beyondCap)
  })
})
