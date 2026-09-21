import { describe, expect, test } from "bun:test"
import {
  canonicalVerificationCommand,
  matchVerificationReceipts,
  verificationCommandDigest,
  verificationCommandLabel,
  VERIFICATION_MAX_AGE_MS,
  verificationReceiptID,
} from "../../src/core/verification.js"

const HEAD = "a".repeat(40)

describe("verification receipt identity", () => {
  test("canonicalizes only line endings and outer whitespace", () => {
    expect(canonicalVerificationCommand("  bun test\r\n")).toBe('{"tool":"shell","command":"bun test"}')
    expect(canonicalVerificationCommand("bun  test")).not.toBe(canonicalVerificationCommand("bun test"))
    expect(canonicalVerificationCommand(" ")).toBeUndefined()
    expect(canonicalVerificationCommand("x".repeat(501))).toBeUndefined()
  })

  test("produces deterministic opaque IDs and bounded redacted labels", () => {
    const digest = verificationCommandDigest("bun test")!
    expect(digest).toHaveLength(64)
    expect(digest).toBe(verificationCommandDigest("bun test")!)
    expect(verificationReceiptID({ rootSessionID: "root", sessionID: "child", callID: "call", commandDigest: digest })).toBe(
      verificationReceiptID({ rootSessionID: "root", sessionID: "child", callID: "call", commandDigest: digest }),
    )
    expect(verificationCommandLabel("bun\n test", (value) => value.replace("bun", "[redacted]"))).toBe("[redacted] test")
    expect(verificationCommandLabel("x".repeat(500), (value) => value)?.length).toBe(256)
  })

  test("requires distinct pass receipts from the lead and exact revision", () => {
    const first = {
      receiptID: "r1",
      rootSessionID: "lead",
      sessionID: "lead",
      agentID: "orchestrator",
      commandDigest: verificationCommandDigest("bun test")!,
      status: "pass" as const,
      completedAt: 20,
      headSha: HEAD,
    }
    const second = { ...first, receiptID: "r2", commandDigest: verificationCommandDigest("bun run typecheck")! }
    expect(
      matchVerificationReceipts({
        requiredCommands: ["bun test", "bun run typecheck"],
        receiptIDs: ["r1", "r2"],
        receipts: [first, second],
        rootSessionID: "lead",
        orchestratorAgentID: "orchestrator",
        revision: HEAD,
        minimumCompletedAt: 10,
        now: 20,
      }),
    ).toMatchObject({ ok: true })
    expect(
      matchVerificationReceipts({
        requiredCommands: ["bun test"],
        receiptIDs: ["r1"],
        receipts: [{ ...first, status: "fail" }],
        rootSessionID: "lead",
        orchestratorAgentID: "orchestrator",
        revision: HEAD,
        now: 20,
      }),
    ).toMatchObject({ ok: false })
    expect(
      matchVerificationReceipts({
        requiredCommands: ["bun test"],
        receiptIDs: ["r1"],
        receipts: [{ ...first, headSha: "b".repeat(40) }],
        rootSessionID: "lead",
        orchestratorAgentID: "orchestrator",
        revision: HEAD,
        now: 20,
      }),
    ).toMatchObject({ ok: false })
    expect(
      matchVerificationReceipts({
        requiredCommands: ["bun test"],
        receiptIDs: ["r1"],
        receipts: [first],
        rootSessionID: "lead",
        orchestratorAgentID: "orchestrator",
        revision: HEAD,
        now: 20 + VERIFICATION_MAX_AGE_MS + 1,
      }),
    ).toMatchObject({ ok: false })
  })
})
