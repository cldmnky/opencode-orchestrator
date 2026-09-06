import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import {
  ADMISSION_ACTIONS,
  ADMISSION_STATES,
  transitionAdmission,
} from "../../src/core/admission.js"
import { D2_REVIEW_STATES } from "../../src/core/contracts.js"
import {
  REVIEW_V1_ACTIONS,
  REVIEW_V1_CHECK_KEYS,
  REVIEW_V1_REASONS,
  REVIEW_V1_SIGNAL_SCHEMA,
  REVIEW_V1_STATES,
  reviewStorageKey,
  reviewV1RecordSchema,
  transitionReviewV1,
  validateApprovedReviewRevision,
  type ReviewV1Record,
  type ReviewV1Signal,
} from "../../src/opencode-v2/observability/review.js"
import {
  createDispatchGate,
  readReviewRecord,
  setReviewRecord,
} from "../../src/opencode-v2/observability/runtime.js"

const location = { directory: "/workspace", project: { id: "project" } }

function memStorage(values = new Map<string, unknown>()) {
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => void values.set(key, value),
    remove: async (key: string) => void values.delete(key),
  }
}

const NOW = 10_000

function pendingRecord(overrides: Partial<ReviewV1Record> = {}): ReviewV1Record {
  return {
    version: 1,
    taskId: "task-1",
    runId: "run-1",
    maker: "implementer",
    checker: "reviewer",
    state: "pending",
    round: 1,
    maxRounds: 2,
    reason: "manual-start",
    requiresHuman: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function startSignal(overrides: Record<string, unknown> = {}): ReviewV1Signal {
  return {
    action: "start",
    taskId: "task-1",
    runId: "run-1",
    maker: "implementer",
    checker: "reviewer",
    admissionState: "review-pending",
    ...overrides,
  } as ReviewV1Signal
}

function allChecksTrue(): { action: "approve"; checks: { diff: boolean; scope: boolean; verification: boolean } } {
  return { action: "approve", checks: { diff: true, scope: true, verification: true } }
}

describe("V1 review schema separation", () => {
  test("uses a separate version-1 schema: no D2 reviewState field and no free-form text", () => {
    // The review record schema is strict and metadata-only: a free-form
    // reviewer comment is rejected, and the D2 reviewState axis is untouched.
    const parsed = reviewV1RecordSchema.safeParse({ ...pendingRecord(), reviewerComment: "looks good to me" })
    expect(parsed.success).toBe(false)
    expect(Object.keys(pendingRecord())).not.toContain("reviewState")

    // The record vocabulary and the admission vocabulary are unchanged: the
    // review module defines its own states/actions/reasons and never imports
    // the admission signals or D2 states.
    expect(REVIEW_V1_STATES).toEqual(["pending", "approved", "changes-requested", "blocked", "tripped"])
    expect(REVIEW_V1_ACTIONS).toEqual(["start", "approve", "request-changes", "block"])
    expect(D2_REVIEW_STATES).not.toContain("tripped")
    expect(REVIEW_V1_REASONS).not.toContain("reviewer-free-form")
    expect(ADMISSION_STATES).toContain("review-pending")
    expect(ADMISSION_ACTIONS).toContain("review-approve")
  })

  test("admission transitions are unchanged and never read the V1 review record", () => {
    // The admission machine still treats D2 reviewState as self-declared and
    // accepts only explicit reviewer admission actions.
    const before = transitionAdmission({ from: "review-pending", signal: { action: "review-approve" } })
    expect(before).toMatchObject({ accepted: true, to: "admitted" })
    const afterSame = transitionAdmission({ from: "review-pending", signal: { action: "review-approve" } })
    expect(afterSame).toEqual(before)
  })
})

describe("deterministic review transitions", () => {
  test("absent + start creates a pending round-1 record", () => {
    const transition = transitionReviewV1({ record: undefined, signal: startSignal(), maxRounds: 2, now: NOW })
    expect(transition).toMatchObject({
      accepted: true,
      reason: "manual-start",
      requiresHuman: false,
      terminal: false,
    })
    expect(transition.record).toMatchObject({ taskId: "task-1", runId: "run-1", state: "pending", round: 1, maxRounds: 2 })
    expect(REVIEW_V1_SIGNAL_SCHEMA.safeParse(startSignal()).success).toBe(true)
  })

  test("pending + approve with every fixed check true -> approved (terminal)", () => {
    const transition = transitionReviewV1({
      record: pendingRecord(),
      signal: allChecksTrue(),
      maxRounds: 2,
      now: NOW,
    })
    expect(transition).toMatchObject({ accepted: true, reason: "approval-complete", terminal: true, requiresHuman: false })
    expect(transition.record?.state).toBe("approved")
  })

  test("pending + approve with a failing fixed check is rejected", () => {
    const transition = transitionReviewV1({
      record: pendingRecord(),
      signal: { action: "approve", checks: { diff: true, scope: false, verification: true } },
      maxRounds: 2,
      now: NOW,
    })
    expect(transition).toMatchObject({ accepted: false, reason: "checks-failed" })
  })

  test("pending + request-changes with rounds remaining -> changes-requested", () => {
    const transition = transitionReviewV1({
      record: pendingRecord(),
      signal: { action: "request-changes" },
      maxRounds: 2,
      now: NOW,
    })
    expect(transition).toMatchObject({ accepted: true, reason: "changes-requested", terminal: false, requiresHuman: false })
    expect(transition.record?.state).toBe("changes-requested")
  })

  test("pending + request-changes at max rounds -> tripped (open, requires human)", () => {
    const atMax = pendingRecord({ round: 2, maxRounds: 2 })
    const transition = transitionReviewV1({ record: atMax, signal: { action: "request-changes" }, maxRounds: 2, now: NOW })
    expect(transition).toMatchObject({
      accepted: true,
      reason: "rounds-exhausted",
      requiresHuman: true,
      terminal: true,
    })
    expect(transition.record?.state).toBe("tripped")
    expect(transition.record?.requiresHuman).toBe(true)
  })

  test("pending + block -> blocked (open, requires human)", () => {
    const transition = transitionReviewV1({ record: pendingRecord(), signal: { action: "block" }, maxRounds: 2, now: NOW })
    expect(transition).toMatchObject({ accepted: true, reason: "checker-blocked", requiresHuman: true, terminal: true })
    expect(transition.record?.state).toBe("blocked")
  })

  test("changes-requested + start -> next pending round", () => {
    const changesRequested = pendingRecord({ state: "changes-requested", reason: "changes-requested" })
    const transition = transitionReviewV1({ record: changesRequested, signal: startSignal(), maxRounds: 2, now: NOW })
    expect(transition).toMatchObject({ accepted: true, reason: "round-reopened", requiresHuman: false })
    expect(transition.record).toMatchObject({ state: "pending", round: 2 })
  })

  test("start on an already-pending same task is rejected", () => {
    const transition = transitionReviewV1({ record: pendingRecord(), signal: startSignal(), maxRounds: 2, now: NOW })
    expect(transition).toMatchObject({ accepted: false, reason: "already-pending" })
  })

  test("a pending different task cannot be overwritten", () => {
    const transition = transitionReviewV1({
      record: pendingRecord(),
      signal: startSignal({ taskId: "task-2", runId: "run-2" }),
      maxRounds: 2,
      now: NOW,
    })
    expect(transition).toMatchObject({ accepted: false, reason: "pending-task-locked" })
  })

  test("the same task with a new run is a different identity: rejected while open, allowed after terminal", () => {
    // Record identity is taskId + runId together: task-1/run-1 is open.
    const open = transitionReviewV1({
      record: pendingRecord(),
      signal: startSignal({ taskId: "task-1", runId: "run-2" }),
      maxRounds: 2,
      now: NOW,
    })
    expect(open).toMatchObject({ accepted: false, reason: "pending-task-locked" })
    expect(open.message).toContain("task-1")
    expect(open.message).toContain("run-1")

    // The same taskId with a NEW run is allowed once the old record is terminal.
    for (const state of ["approved", "blocked", "tripped"] as const) {
      const replaced = transitionReviewV1({
        record: pendingRecord({ state, requiresHuman: state !== "approved" }),
        signal: startSignal({ taskId: "task-1", runId: "run-2" }),
        maxRounds: 2,
        now: NOW,
      })
      expect(replaced.accepted).toBe(true)
      expect(replaced.record).toMatchObject({ taskId: "task-1", runId: "run-2", state: "pending", round: 1 })
    }
  })

  test("a terminal old task may be replaced by a new start", () => {
    for (const state of ["approved", "blocked", "tripped"] as const) {
      const transition = transitionReviewV1({
        record: pendingRecord({ state, requiresHuman: state !== "approved" }),
        signal: startSignal({ taskId: "task-2", runId: "run-2" }),
        maxRounds: 2,
        now: NOW,
      })
      expect(transition.accepted).toBe(true)
      expect(transition.record).toMatchObject({ taskId: "task-2", state: "pending", round: 1 })
    }
  })

  test("reopening changes-requested rejects maker/checker identity drift", () => {
    const changesRequested = pendingRecord({ state: "changes-requested", reason: "changes-requested" })
    const driftedMaker = transitionReviewV1({
      record: changesRequested,
      signal: startSignal({ maker: "implementer-2" }),
      maxRounds: 2,
      now: NOW,
    })
    expect(driftedMaker).toMatchObject({ accepted: false, reason: "identity-drift" })
    expect(driftedMaker.message).toContain("maker implementer")

    const driftedChecker = transitionReviewV1({
      record: changesRequested,
      signal: startSignal({ checker: "reviewer-2" }),
      maxRounds: 2,
      now: NOW,
    })
    expect(driftedChecker).toMatchObject({ accepted: false, reason: "identity-drift" })
    expect(driftedChecker.message).toContain("checker reviewer")

    // The unchanged identities reopen the next round as before.
    const reopened = transitionReviewV1({ record: changesRequested, signal: startSignal(), maxRounds: 2, now: NOW })
    expect(reopened).toMatchObject({ accepted: true, reason: "round-reopened" })
    expect(reopened.record).toMatchObject({ state: "pending", round: 2, maker: "implementer", checker: "reviewer" })
  })

  test("terminal states reject decisions and further starts for the same task and run", () => {
    for (const state of ["approved", "blocked", "tripped"] as const) {
      const record = pendingRecord({ state, requiresHuman: state !== "approved" })
      const start = transitionReviewV1({ record, signal: startSignal(), maxRounds: 2, now: NOW })
      expect(start).toMatchObject({ accepted: false, reason: "terminal-for-task" })
      const approve = transitionReviewV1({ record, signal: allChecksTrue(), maxRounds: 2, now: NOW })
      expect(approve.accepted).toBe(false)
    }
  })

  test("decisions require a pending record and never invent one", () => {
    const noRecord = transitionReviewV1({ record: undefined, signal: allChecksTrue(), maxRounds: 2, now: NOW })
    expect(noRecord).toMatchObject({ accepted: false, reason: "no-record" })
    const onChanges = transitionReviewV1({
      record: pendingRecord({ state: "changes-requested" }),
      signal: allChecksTrue(),
      maxRounds: 2,
      now: NOW,
    })
    expect(onChanges).toMatchObject({ accepted: false, reason: "invalid-signal" })
  })

  test("maker/checker constraints are enforced: same identity and wrong role are rejected", () => {
    const same = transitionReviewV1({
      record: undefined,
      signal: startSignal({ maker: "implementer", checker: "implementer" }),
      maxRounds: 2,
      now: NOW,
    })
    expect(same).toMatchObject({ accepted: false, reason: "checker-must-differ" })

    const wrongRole = transitionReviewV1({
      record: undefined,
      signal: startSignal({ checker: "planner" }),
      maxRounds: 2,
      checkerRole: "reviewer",
      now: NOW,
    })
    expect(wrongRole).toMatchObject({ accepted: false, reason: "checker-role-mismatch" })
  })

  test("approve requires exactly the three fixed checks, all true, with no extras", () => {
    // The check set is fixed: diff, scope, verification. Empty, missing,
    // arbitrary, and extra check keys are rejected by the runtime schema.
    const invalidChecks = [
      { action: "approve", checks: {} },
      { action: "approve" },
      { action: "approve", checks: { diff: true } },
      { action: "approve", checks: { diff: true, scope: true, verification: true, extra: true } },
      { action: "approve", checks: { ratio: true, scope: true, verification: true } },
      { action: "approve", checks: { diff: "yes", scope: true, verification: true } },
    ]
    for (const candidate of invalidChecks) {
      expect(REVIEW_V1_SIGNAL_SCHEMA.safeParse(candidate).success, JSON.stringify(candidate)).toBe(false)
    }
    // The exact fixed shape parses, and only all-true approves.
    expect(REVIEW_V1_SIGNAL_SCHEMA.safeParse(allChecksTrue()).success).toBe(true)
    expect(REVIEW_V1_CHECK_KEYS).toEqual(["diff", "scope", "verification"])

    // Pure transition stays defensive against malformed checks at runtime.
    const empty = transitionReviewV1({
      record: pendingRecord(),
      signal: { action: "approve", checks: {} } as unknown as ReviewV1Signal,
      maxRounds: 2,
      now: NOW,
    })
    expect(empty).toMatchObject({ accepted: false, reason: "checks-failed" })
  })
})

describe("bounded durable review storage and breaker", () => {
  test("one record per session under the versioned stable key, serialized through the tools layer", async () => {
    const storage = memStorage()
    await setReviewRecord(storage, location, "s1", pendingRecord())
    const read = await readReviewRecord(storage, location, "s1")
    expect(read).toMatchObject({ taskId: "task-1", state: "pending" })
    expect(storage.values.has(reviewStorageKey(location, "s1"))).toBe(true)
    expect(storage.values.size).toBe(1)
    // Malformed records are ignored, never guessed.
    storage.values.set(reviewStorageKey(location, "s1"), { version: 1, taskId: "x" })
    expect(await readReviewRecord(storage, location, "s1")).toBeUndefined()
  })

  test("the circuit breaker stops auto dispatch on blocked/tripped and resumes after a new terminal replacement", async () => {
    const options = parseOptions({ review: { mode: "bounded", max_rounds: 2 } })
    const storage = memStorage()
    await setReviewRecord(storage, location, "s1", pendingRecord({ state: "tripped", requiresHuman: true }))
    const gate = createDispatchGate({ options, storage, location })

    const blocked = await gate.allowDispatch("s1", "auto")
    expect(blocked.allow).toBe(false)
    expect(blocked.reason).toContain("review circuit is open")

    // A new task start replaces the terminal old record (pending), which reopens the breaker.
    await setReviewRecord(storage, location, "s1", pendingRecord({ taskId: "task-2", state: "pending" }))
    const opened = await gate.allowDispatch("s1", "auto")
    expect(opened.allow).toBe(true)
  })
})

function recordWorkflowWithRounds(rounds: number): Array<{ state: string; reason: string }> {
  const history: Array<{ state: string; reason: string }> = []
  let record: ReviewV1Record | undefined = undefined
  const now = NOW
  record = transitionReviewV1({ record, signal: startSignal(), maxRounds: rounds, now }).record
  history.push({ state: record!.state, reason: record!.reason ?? "" })
  for (let round = 1; round <= rounds; round += 1) {
    const rejected = transitionReviewV1({ record, signal: { action: "request-changes" }, maxRounds: rounds, now })
    if (!rejected.accepted || !rejected.record) {
      history.push({ state: "no-change-record", reason: rejected.reason })
      break
    }
    record = rejected.record
    history.push({ state: record.state, reason: record.reason ?? "" })
    if (record.state === "tripped") break
    const reopened = transitionReviewV1({ record, signal: startSignal(), maxRounds: rounds, now })
    if (!reopened.accepted || !reopened.record) {
      history.push({ state: "no-reopen-record", reason: reopened.reason })
      break
    }
    record = reopened.record
    history.push({ state: record.state, reason: record.reason ?? "" })
  }
  return history
}

test("a bounded review loop terminates deterministically at max rounds instead of looping forever", () => {
  const history = recordWorkflowWithRounds(2)
  expect(history[history.length - 1].state).toBe("tripped")
  expect(history.filter((entry) => entry.state === "pending").length).toBeGreaterThanOrEqual(2)
  expect(history.filter((entry) => entry.state === "tripped")).toHaveLength(1)
})

describe("exact-revision review receipts", () => {
  const HEAD = "a".repeat(40)
  const BASE = "b".repeat(40)
  const HEAD256 = "c".repeat(64)

  test("a start may pin a head/base receipt and it survives the approve transition", () => {
    const signal = startSignal({ headSha: HEAD, baseSha: BASE })
    expect(REVIEW_V1_SIGNAL_SCHEMA.safeParse(signal).success).toBe(true)
    const started = transitionReviewV1({ record: undefined, signal, maxRounds: 2, now: NOW })
    expect(started.accepted).toBe(true)
    expect(started.record).toMatchObject({ state: "pending", headSha: HEAD, baseSha: BASE })

    const approved = transitionReviewV1({ record: started.record, signal: allChecksTrue(), maxRounds: 2, now: NOW })
    expect(approved.record).toMatchObject({ state: "approved", headSha: HEAD, baseSha: BASE })
    // The receipt-carrying approved record round-trips through the strict schema.
    expect(reviewV1RecordSchema.safeParse(approved.record).success).toBe(true)
  })

  test("a 64-character SHA-256 object ID is accepted alongside 40-character SHA-1", () => {
    const signal = startSignal({ headSha: HEAD256, baseSha: BASE })
    const started = transitionReviewV1({ record: undefined, signal, maxRounds: 2, now: NOW })
    expect(started.accepted).toBe(true)
    expect(started.record).toMatchObject({ headSha: HEAD256, baseSha: BASE })
  })

  test("malformed or partial SHAs never parse as a start signal", () => {
    const invalid = [
      { headSha: "a".repeat(39), baseSha: BASE },
      { headSha: "a".repeat(41), baseSha: BASE },
      { headSha: "A".repeat(40), baseSha: BASE },
      { headSha: "abcdef", baseSha: BASE },
      { headSha: `${HEAD}g`, baseSha: BASE },
      { headSha: HEAD },
      { baseSha: BASE },
      { headSha: undefined, baseSha: BASE },
      { headSha: HEAD, baseSha: undefined },
    ]
    for (const revision of invalid) {
      expect(REVIEW_V1_SIGNAL_SCHEMA.safeParse(startSignal(revision)).success, JSON.stringify(revision)).toBe(false)
    }
  })

  test("the receipt is preserved across a rework round and replaced with a new start", () => {
    const changesRequested = pendingRecord({ state: "changes-requested", reason: "changes-requested", headSha: HEAD, baseSha: BASE })
    expect(reviewV1RecordSchema.safeParse(changesRequested).success).toBe(true)
    const reopened = transitionReviewV1({ record: changesRequested, signal: startSignal(), maxRounds: 2, now: NOW })
    expect(reopened.record).toMatchObject({ state: "pending", round: 2, headSha: HEAD, baseSha: BASE })

    // A terminal old receipt is replaced wholesale by the new start's receipt.
    const newHead = "d".repeat(40)
    const newBase = "e".repeat(40)
    const replaced = transitionReviewV1({
      record: pendingRecord({ state: "approved", headSha: HEAD, baseSha: BASE }),
      signal: startSignal({ taskId: "task-2", runId: "run-2", headSha: newHead, baseSha: newBase }),
      maxRounds: 2,
      now: NOW,
    })
    expect(replaced.accepted).toBe(true)
    expect(replaced.record).toMatchObject({ taskId: "task-2", state: "pending", headSha: newHead, baseSha: newBase })
  })

  test("the record schema refuses a partial receipt and accepts revision-less legacy records", () => {
    expect(reviewV1RecordSchema.safeParse(pendingRecord({ headSha: HEAD })).success).toBe(false)
    expect(reviewV1RecordSchema.safeParse(pendingRecord({ baseSha: BASE })).success).toBe(false)
    // Legacy records without any revision fields still parse (backward compatible).
    expect(reviewV1RecordSchema.safeParse(pendingRecord()).success).toBe(true)
    expect(reviewV1RecordSchema.safeParse(pendingRecord({ state: "approved" })).success).toBe(true)
  })

  test("approved-state validation for an exact revision fails closed on every gap", () => {
    const approved = pendingRecord({ state: "approved", headSha: HEAD, baseSha: BASE })

    // Matching approved record: the only valid outcome.
    expect(validateApprovedReviewRevision({ record: approved, headSha: HEAD, baseSha: BASE })).toEqual({
      valid: true,
      verdict: "valid",
      message: `approved review for task task-1 run run-1 matches the requested exact revision`,
    })

    // No record at all.
    const noRecord = validateApprovedReviewRevision({ record: undefined, headSha: HEAD, baseSha: BASE })
    expect(noRecord).toMatchObject({ valid: false, verdict: "no-record" })

    // Every non-approved state fails closed even with matching SHAs.
    for (const state of ["pending", "changes-requested", "blocked", "tripped"] as const) {
      const result = validateApprovedReviewRevision({
        record: pendingRecord({ state, headSha: HEAD, baseSha: BASE }),
        headSha: HEAD,
        baseSha: BASE,
      })
      expect(result, state).toMatchObject({ valid: false, verdict: "not-approved" })
    }

    // Approved but receipt absent (legacy record or one side missing).
    for (const record of [
      pendingRecord({ state: "approved" }),
      pendingRecord({ state: "approved", headSha: HEAD }),
      pendingRecord({ state: "approved", baseSha: BASE }),
    ]) {
      const result = validateApprovedReviewRevision({ record, headSha: HEAD, baseSha: BASE })
      expect(result).toMatchObject({ valid: false, verdict: "missing-revision" })
      expect(result.message).toContain("no exact head/base revision")
    }

    // Approved but the receipt points at a different revision.
    const mismatched = validateApprovedReviewRevision({ record: approved, headSha: `${HEAD.slice(0, 39)}d`, baseSha: BASE })
    expect(mismatched).toMatchObject({ valid: false, verdict: "revision-mismatch" })
    const baseMismatched = validateApprovedReviewRevision({ record: approved, headSha: HEAD, baseSha: `${"f".repeat(40)}` })
    expect(baseMismatched).toMatchObject({ valid: false, verdict: "revision-mismatch" })

    // Malformed requested SHAs are never a valid expectation.
    for (const [headSha, baseSha] of [
      ["a".repeat(39), BASE],
      [HEAD, "B".repeat(40)],
      ["", ""],
      ["nope", "nope"],
    ]) {
      const result = validateApprovedReviewRevision({ record: approved, headSha, baseSha })
      expect(result, headSha).toMatchObject({ valid: false, verdict: "invalid-expectation" })
    }
  })
})