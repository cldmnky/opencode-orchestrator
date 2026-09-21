import { describe, expect, test } from "bun:test"
import { createLeadBoard, leadBoardStorageKey } from "../../src/opencode-v2/orchestration/lead-board.js"
import {
  activeBoardVerificationReceiptIDs,
  evictVerificationReceipts,
  listVerificationReceipts,
  verificationStorageKey,
} from "../../src/opencode-v2/verification/state.js"
import { verificationCommandDigest } from "../../src/core/verification.js"

const location = { directory: "/workspace", project: { id: "project" } }
const rootSessionID = "root"
const headSha = "a".repeat(40)

function storage(values: Map<string, unknown>) {
  return {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => void values.set(key, value),
    remove: async (key: string) => void values.delete(key),
    scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => ({
      entries: [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit)
        .map(([key, value]) => ({ key, value })),
    }),
  }
}

function receipt(index: number) {
  const receiptID = `receipt-${index}`
  return {
    version: 1,
    receiptID,
    rootSessionID,
    sessionID: rootSessionID,
    agentID: "orchestrator",
    messageID: `message-${index}`,
    commandDigest: verificationCommandDigest(`echo ${index}`),
    commandLabel: `echo ${index}`,
    status: "pass",
    exitCode: 0,
    startedAt: index,
    completedAt: index,
    repository: { rootDigest: "c".repeat(64), headSha },
  }
}

describe("verification receipt state", () => {
  test("keeps active-board receipt references while bounding unreferenced history", async () => {
    const values = new Map<string, unknown>()
    for (let index = 0; index < 65; index += 1) {
      values.set(verificationStorageKey("project", rootSessionID, `receipt-${index}`), receipt(index))
    }
    const board = createLeadBoard({ projectID: "project", leadSessionID: rootSessionID, goalGeneration: 1, objective: "test", now: 1 })
    board.tasks[0] = {
      ...board.tasks[0]!,
      status: "awaiting-validation",
      validation: { leadSessionID: rootSessionID, validatedAt: 1, revision: headSha, checkIDs: ["c4:pass"], receiptIDs: ["receipt-0"] },
    }
    values.set(leadBoardStorageKey(location, rootSessionID), board)
    const deps = storage(values)
    const protectedIDs = await activeBoardVerificationReceiptIDs(deps, location, rootSessionID)
    expect(protectedIDs).toEqual(new Set(["receipt-0"]))
    await evictVerificationReceipts(deps, location, rootSessionID, protectedIDs)
    const receipts = await listVerificationReceipts(deps, location, rootSessionID)
    expect(receipts).toHaveLength(64)
    expect(receipts.some((candidate) => candidate.receiptID === "receipt-0")).toBe(true)
    expect(receipts.some((candidate) => candidate.receiptID === "receipt-1")).toBe(false)
  })

  test("retains all receipts when active-board state cannot be inspected", async () => {
    const values = new Map<string, unknown>()
    for (let index = 0; index < 65; index += 1) {
      values.set(verificationStorageKey("project", rootSessionID, `receipt-${index}`), receipt(index))
    }
    const deps = storage(values)
    await evictVerificationReceipts(deps, location, rootSessionID)
    expect(await listVerificationReceipts(deps, location, rootSessionID)).toHaveLength(65)
  })
})
