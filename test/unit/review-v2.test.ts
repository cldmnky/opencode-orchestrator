import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { REVIEW_SUBMIT_TOOL_PERMISSION } from "../../src/core/permissions.js"
import { addObservabilityTools } from "../../src/opencode-v2/observability/tools.js"
import { readReviewRecordV2 } from "../../src/opencode-v2/observability/runtime.js"
import {
  reviewV2RecordSchema,
  reviewV2StorageKey,
  startReviewV2,
  submitReviewV2,
  validateApprovedReviewV2Revision,
  type ReviewV2Record,
} from "../../src/opencode-v2/observability/review-v2.js"

const location = { directory: "/workspace", project: { id: "project" } }
const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)

function storage(values = new Map<string, unknown>()) {
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => void values.set(key, value),
    remove: async (key: string) => void values.delete(key),
  }
}

function collect(options = parseOptions({ review: { mode: "bounded", max_rounds: 2 } }), values = new Map<string, unknown>()) {
  const entries = new Map<string, any>()
  const deps = {
    options,
    storage: storage(values),
    location,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === "review-child") return { id: sessionID, parentID: "lead" }
        if (sessionID === "nested-review-child") return { id: sessionID, parentID: "review-child" }
        if (sessionID === "unrelated") return { id: sessionID, parentID: "other-lead" }
        return { id: sessionID }
      },
    },
  }
  addObservabilityTools({ add: (tool) => entries.set(tool.name, tool) }, deps)
  return { entries, deps }
}

function startRecord(overrides: Partial<ReviewV2Record> = {}): ReviewV2Record {
  return {
    version: 2,
    taskId: "task-1",
    runId: "run-1",
    leadSessionID: "lead",
    reviewerAgentID: "reviewer",
    headSha: HEAD,
    baseSha: BASE,
    state: "pending",
    round: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("review V2 pure provenance transitions", () => {
  test("starts with the expected reviewer role and binds the exact revision", () => {
    const result = startReviewV2({
      taskId: "task-1",
      runId: "run-1",
      leadSessionID: "lead",
      expectedReviewerAgentID: "reviewer",
      headSha: HEAD,
      baseSha: BASE,
      maxRounds: 2,
      now: 10,
    })
    expect(result).toMatchObject({ accepted: true, reason: "manual-start" })
    expect(result.record).toMatchObject({ version: 2, state: "pending", headSha: HEAD, baseSha: BASE })
    expect(result.record).toHaveProperty("reviewerAgentID", "reviewer")
    expect(result.record).not.toHaveProperty("reviewerSessionID")
    expect(reviewV2RecordSchema.safeParse(result.record).success).toBe(true)
  })

  test("requires the actual configured reviewer child and exactly one decision", () => {
    const record = startRecord()
    const self = submitReviewV2({
      record,
      leadSessionID: "lead",
      expectedRound: 1,
      maxRounds: 2,
      expectedReviewerAgentID: "reviewer",
      actorSessionID: "lead",
      actorAgentID: "orchestrator",
      isChildSession: false,
      decision: { action: "approve", checks: { diff: true, scope: true, verification: true } },
      now: 20,
    })
    expect(self).toMatchObject({ accepted: false, reason: "reviewer-role-mismatch" })

    const unrelated = submitReviewV2({
      ...selfInput(record),
      actorSessionID: "unrelated",
      actorAgentID: "reviewer",
      isChildSession: false,
    })
    expect(unrelated).toMatchObject({ accepted: false, reason: "reviewer-session-mismatch" })

    const approved = submitReviewV2({
      ...selfInput(record),
      actorSessionID: "review-child",
      actorAgentID: "reviewer",
      isChildSession: true,
    })
    expect(approved).toMatchObject({ accepted: true, reason: "approval-complete" })
    expect(approved.record).toMatchObject({ state: "approved", reviewerSessionID: "review-child", reviewerAgentID: "reviewer", submittedAt: 20 })
    expect(submitReviewV2({ ...selfInput(approved.record!), actorSessionID: "review-child", actorAgentID: "reviewer", isChildSession: true })).toMatchObject({
      accepted: false,
      reason: "not-pending",
    })
  })

  test("request-changes requires a new lead-started round and trips at the configured bound", () => {
    const requested = submitReviewV2({
      ...selfInput(startRecord()),
      actorSessionID: "review-child",
      actorAgentID: "reviewer",
      isChildSession: true,
      decision: { action: "request-changes" },
    })
    expect(requested).toMatchObject({ accepted: true, reason: "changes-requested" })
    const reopened = startReviewV2({
      record: requested.record,
      taskId: "task-1",
      runId: "run-1",
      leadSessionID: "lead",
      expectedReviewerAgentID: "reviewer",
      headSha: "c".repeat(40),
      baseSha: BASE,
      maxRounds: 2,
      now: 30,
    })
    expect(reopened).toMatchObject({ accepted: true, reason: "round-reopened" })
    expect(reopened.record).toMatchObject({ state: "pending", round: 2, headSha: "c".repeat(40) })
    const tripped = submitReviewV2({
      ...selfInput(reopened.record!, 2),
      actorSessionID: "review-child",
      actorAgentID: "reviewer",
      isChildSession: true,
      decision: { action: "request-changes" },
    })
    expect(tripped).toMatchObject({ accepted: true, reason: "rounds-exhausted", terminal: true, requiresHuman: true })
    expect(tripped.record?.state).toBe("tripped")
  })

  test("V1 records are legacy-unproven and cannot satisfy the V2 revision validator", () => {
    const legacy = {
      version: 1 as const,
      taskId: "task-1",
      runId: "run-1",
      maker: "implementer",
      checker: "reviewer",
      state: "approved" as const,
      round: 1,
      maxRounds: 2,
      requiresHuman: false,
      createdAt: 1,
      updatedAt: 1,
      headSha: HEAD,
      baseSha: BASE,
    }
    expect(validateApprovedReviewV2Revision({ legacyRecord: legacy, leadSessionID: "lead", expectedReviewerAgentID: "reviewer", headSha: HEAD, baseSha: BASE })).toMatchObject({
      valid: false,
      verdict: "legacy-unproven",
    })
  })
})

describe("review V2 model tools", () => {
  test("registers separate lead-start and reviewer-submit tools", () => {
    const { entries } = collect()
    expect([...entries.keys()].sort()).toEqual(["review_get", "review_start", "review_submit"])
    expect(entries.get("review_start").options.permission).not.toBe(REVIEW_SUBMIT_TOOL_PERMISSION)
    expect(entries.get("review_submit").options.permission).toBe(REVIEW_SUBMIT_TOOL_PERMISSION)
  })

  test("review_get labels a readable V1 record as legacy-unproven", async () => {
    const legacy = {
      version: 1,
      taskId: "task-1",
      runId: "run-1",
      maker: "implementer",
      checker: "reviewer",
      state: "approved",
      round: 1,
      maxRounds: 2,
      requiresHuman: false,
      createdAt: 1,
      updatedAt: 2,
      headSha: HEAD,
      baseSha: BASE,
    }
    const { entries } = collect(undefined, new Map([["review/v1/project/lead", legacy]]))
    const result = await entries.get("review_get").execute({ sessionID: "lead" }, { sessionID: "lead", agent: "orchestrator" })
    expect(JSON.parse(result.content)).toMatchObject({ version: 1, state: "legacy-unproven", record: legacy })
  })

  test("lead starts and verified reviewer child submits without caller identity fields", async () => {
    const { entries, deps } = collect()
    const start = await entries.get("review_start").execute({ taskId: "task-1", runId: "run-1", headSha: HEAD, baseSha: BASE }, { sessionID: "lead", agent: "orchestrator" })
    expect(JSON.parse(start.content)).toMatchObject({ version: 2, accepted: true, record: { state: "pending" } })
    expect(deps.storage.values.has(reviewV2StorageKey(location, "lead"))).toBe(true)

    const submit = await entries.get("review_submit").execute(
      { leadSessionID: "lead", round: 1, decision: { action: "approve", checks: { diff: true, scope: true, verification: true } } },
      { sessionID: "review-child", agent: "reviewer" },
    )
    const output = JSON.parse(submit.content)
    expect(output).toMatchObject({ version: 2, accepted: true, reason: "approval-complete", record: { reviewerSessionID: "review-child", reviewerAgentID: "reviewer" } })
    expect(output.record).not.toHaveProperty("maker")
    expect(output.record).not.toHaveProperty("checker")
    expect((await readReviewRecordV2(deps.storage, location, "lead"))?.state).toBe("approved")
  })

  test("orchestrator self-approval and unrelated sessions are refused", async () => {
    const { entries } = collect()
    await entries.get("review_start").execute({ taskId: "task-1", runId: "run-1", headSha: HEAD, baseSha: BASE }, { sessionID: "lead", agent: "orchestrator" })
    const self = await entries.get("review_submit").execute(
      { leadSessionID: "lead", round: 1, decision: { action: "approve", checks: { diff: true, scope: true, verification: true } } },
      { sessionID: "lead", agent: "orchestrator" },
    )
    expect(JSON.parse(self.content)).toMatchObject({ accepted: false, reason: "reviewer-role-mismatch" })
    const unrelated = await entries.get("review_submit").execute(
      { leadSessionID: "lead", round: 1, decision: { action: "block" } },
      { sessionID: "unrelated", agent: "reviewer" },
    )
    expect(JSON.parse(unrelated.content)).toMatchObject({ accepted: false, reason: "reviewer-session-mismatch" })
  })
})

function selfInput(record: ReviewV2Record, expectedRound = record.round) {
  return {
    record,
    leadSessionID: record.leadSessionID,
    expectedRound,
    maxRounds: 2,
    expectedReviewerAgentID: record.reviewerAgentID,
    actorSessionID: "review-child",
    actorAgentID: "reviewer",
    isChildSession: true,
    decision: { action: "approve" as const, checks: { diff: true, scope: true, verification: true } },
    now: 20,
  }
}
