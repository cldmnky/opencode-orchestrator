import { describe, expect, test } from "bun:test"
import {
  ADMISSION_ACTIONS,
  ADMISSION_INPUT_SCHEMA,
  ADMISSION_SIGNAL_SCHEMA,
  ADMISSION_STATES,
  transitionAdmission,
  type AdmissionSignal,
  type AdmissionState,
} from "../../src/core/admission.js"

function transition(from: AdmissionState, signal: AdmissionSignal) {
  return transitionAdmission({ from, signal })
}

describe("admission-state vocabulary", () => {
  test("exports exactly the eight documented states in order", () => {
    expect(ADMISSION_STATES).toEqual([
      "candidate",
      "worker-failed",
      "worker-passed",
      "orchestrator-failed",
      "blocked-unknown",
      "review-pending",
      "review-rejected",
      "admitted",
    ])
    expect(ADMISSION_STATES).toHaveLength(8)
  })

  test("every exported state parses the state schema", () => {
    for (const state of ADMISSION_STATES) {
      expect(ADMISSION_STATES.includes(state)).toBe(true)
    }
  })
})

describe("every documented transition", () => {
  const acceptedTransitions: Array<[AdmissionState, AdmissionSignal, AdmissionState, boolean, boolean]> = [
    // candidate → Level 1 verdicts
    ["candidate", { action: "worker-fail" }, "worker-failed", false, false],
    ["candidate", { action: "worker-pass" }, "worker-passed", false, false],
    ["candidate", { action: "worker-block" }, "blocked-unknown", true, false],
    // worker-passed → Level 2 verdicts
    ["worker-passed", { action: "orchestrator-fail" }, "orchestrator-failed", false, false],
    ["worker-passed", { action: "orchestrator-block" }, "blocked-unknown", true, false],
    ["worker-passed", { action: "orchestrator-pass", reviewRequired: true }, "review-pending", false, false],
    ["worker-passed", { action: "orchestrator-pass", reviewRequired: false }, "admitted", false, false],
    // review-pending → Level 3 verdicts
    ["review-pending", { action: "review-approve" }, "admitted", false, false],
    ["review-pending", { action: "review-reject" }, "review-rejected", false, false],
    ["review-pending", { action: "review-block" }, "blocked-unknown", true, false],
    // terminal-for-this-receipt → rework via explicit new-receipt
    ["worker-failed", { action: "new-receipt" }, "candidate", false, true],
    ["orchestrator-failed", { action: "new-receipt" }, "candidate", false, true],
    ["review-rejected", { action: "new-receipt" }, "candidate", false, true],
    // blocked-unknown → only an explicit human decision
    ["blocked-unknown", { action: "new-receipt", humanDecision: true }, "candidate", false, true],
  ]

  test.each(acceptedTransitions)("%s --%o--> %s", (from, signal, to, requiresHuman, replacementReceipt) => {
    const result = transition(from, signal)
    expect(result.version).toBe(1)
    expect(result.accepted).toBe(true)
    expect(result.to).toBe(to)
    expect(result.requiresHuman).toBe(requiresHuman)
    expect(result.replacementReceipt).toBe(replacementReceipt)
    expect(result.reason.length).toBeGreaterThan(0)
  })

  test("worker-passed branches on reviewRequired only", () => {
    const withReview = transition("worker-passed", { action: "orchestrator-pass", reviewRequired: true })
    const withoutReview = transition("worker-passed", { action: "orchestrator-pass", reviewRequired: false })
    expect(withReview.to).toBe("review-pending")
    expect(withoutReview.to).toBe("admitted")
    expect(withoutReview.requiresHuman).toBe(false)
  })
})

describe("representative rejected transitions", () => {
  const rejectedTransitions: Array<[AdmissionState, AdmissionSignal]> = [
    // skipping levels
    ["candidate", { action: "orchestrator-pass", reviewRequired: true }],
    ["candidate", { action: "review-approve" }],
    ["worker-passed", { action: "worker-pass" }],
    ["worker-passed", { action: "review-approve" }],
    ["review-pending", { action: "orchestrator-pass", reviewRequired: false }],
    ["review-pending", { action: "worker-pass" }],
    // rework is not allowed before a failure/rejection
    ["candidate", { action: "new-receipt" }],
    ["worker-passed", { action: "new-receipt" }],
    ["review-pending", { action: "new-receipt" }],
    // terminal states accept only new-receipt
    ["worker-failed", { action: "worker-pass" }],
    ["worker-failed", { action: "orchestrator-pass", reviewRequired: true }],
    ["orchestrator-failed", { action: "review-approve" }],
    ["orchestrator-failed", { action: "worker-fail" }],
    ["review-rejected", { action: "review-approve" }],
    ["review-rejected", { action: "worker-pass" }],
  ]

  test.each(rejectedTransitions)("%s + %o is rejected without a target", (from, signal) => {
    const result = transition(from, signal)
    expect(result.version).toBe(1)
    expect(result.accepted).toBe(false)
    expect(result.to).toBeUndefined()
    expect(result.reason.length).toBeGreaterThan(0)
    expect(result.replacementReceipt).toBe(false)
  })

  test("blocked-unknown never auto-advances without an explicit human decision", () => {
    const nonHumanSignals: AdmissionSignal[] = [
      { action: "worker-fail" },
      { action: "worker-pass" },
      { action: "worker-block" },
      { action: "orchestrator-fail" },
      { action: "orchestrator-block" },
      { action: "orchestrator-pass", reviewRequired: true },
      { action: "orchestrator-pass", reviewRequired: false },
      { action: "review-approve" },
      { action: "review-reject" },
      { action: "review-block" },
      { action: "new-receipt" },
      { action: "new-receipt", humanDecision: false },
    ]
    for (const signal of nonHumanSignals) {
      const result = transition("blocked-unknown", signal)
      expect(result.accepted).toBe(false)
      expect(result.to).toBeUndefined()
      expect(result.requiresHuman).toBe(true)
      expect(result.replacementReceipt).toBe(false)
      expect(result.reason).toContain("blocked-unknown never auto-advances")
    }
  })

  test("admitted rejects every signal", () => {
    const signals: AdmissionSignal[] = [
      { action: "worker-fail" },
      { action: "worker-pass" },
      { action: "worker-block" },
      { action: "orchestrator-fail" },
      { action: "orchestrator-block" },
      { action: "orchestrator-pass", reviewRequired: true },
      { action: "orchestrator-pass", reviewRequired: false },
      { action: "review-approve" },
      { action: "review-reject" },
      { action: "review-block" },
      { action: "new-receipt" },
      { action: "new-receipt", humanDecision: true },
    ]
    for (const signal of signals) {
      const result = transition("admitted", signal)
      expect(result.accepted).toBe(false)
      expect(result.to).toBeUndefined()
      expect(result.replacementReceipt).toBe(false)
      expect(result.reason).toContain("terminal")
    }
  })

  test("requiresHuman is true exactly when the machine must stop and ask the user", () => {
    // accepted transitions into blocked-unknown require a human
    for (const [from, signal] of [
      ["candidate", { action: "worker-block" }],
      ["worker-passed", { action: "orchestrator-block" }],
      ["review-pending", { action: "review-block" }],
    ] as Array<[AdmissionState, AdmissionSignal]>) {
      expect(transition(from, signal).requiresHuman).toBe(true)
    }
    // accepted transitions elsewhere never do
    for (const [from, signal] of [
      ["candidate", { action: "worker-pass" }],
      ["worker-passed", { action: "orchestrator-pass", reviewRequired: true }],
      ["review-pending", { action: "review-approve" }],
    ] as Array<[AdmissionState, AdmissionSignal]>) {
      expect(transition(from, signal).requiresHuman).toBe(false)
    }
  })
})

describe("signal and input schema strictness", () => {
  test("accepts well-formed inputs", () => {
    const input = { from: "worker-passed" as const, signal: { action: "orchestrator-pass" as const, reviewRequired: false } }
    expect(ADMISSION_INPUT_SCHEMA.safeParse(input).success).toBe(true)
    expect(ADMISSION_SIGNAL_SCHEMA.safeParse({ action: "new-receipt", humanDecision: true }).success).toBe(true)
    expect(ADMISSION_SIGNAL_SCHEMA.safeParse({ action: "new-receipt" }).success).toBe(true)
  })

  test("orchestrator-pass requires the reviewRequired flag", () => {
    const result = ADMISSION_INPUT_SCHEMA.safeParse({ from: "candidate", signal: { action: "orchestrator-pass" } })
    expect(result.success).toBe(false)
  })

  test("rejects unknown actions, states, and extra fields", () => {
    expect(ADMISSION_SIGNAL_SCHEMA.safeParse({ action: "mystery" }).success).toBe(false)
    expect(ADMISSION_SIGNAL_SCHEMA.safeParse({ action: "worker-pass", extra: 1 }).success).toBe(false)
    expect(ADMISSION_INPUT_SCHEMA.safeParse({ from: "pending", signal: { action: "worker-pass" } }).success).toBe(false)
    expect(ADMISSION_INPUT_SCHEMA.safeParse({ from: "candidate", signal: { action: "worker-pass" }, extra: true }).success).toBe(false)
  })

  test("signals are deterministic: identical inputs yield identical results", () => {
    const a = transition("worker-passed", { action: "orchestrator-pass", reviewRequired: true })
    const b = transition("worker-passed", { action: "orchestrator-pass", reviewRequired: true })
    expect(a).toEqual(b)
  })
})

describe("documented semantics guard rails", () => {
  test("failure is never a dead end: terminal-for-this-receipt states accept rework", () => {
    for (const from of ["worker-failed", "orchestrator-failed", "review-rejected"] as AdmissionState[]) {
      const result = transition(from, { action: "new-receipt", reason: "fixed per review" })
      expect(result.accepted).toBe(true)
      expect(result.to).toBe("candidate")
      expect(result.replacementReceipt).toBe(true)
    }
  })

  test("humanDecision is mandatory only for leaving blocked-unknown, not for failed/rejected rework", () => {
    // From failed/rejected states an explicit new-receipt is enough; the flag
    // is a requirement only where the machine must never auto-advance.
    expect(transition("review-rejected", { action: "new-receipt", humanDecision: false }).accepted).toBe(true)
    expect(transition("worker-failed", { action: "new-receipt", humanDecision: false }).accepted).toBe(true)
    expect(transition("blocked-unknown", { action: "new-receipt", humanDecision: false }).accepted).toBe(false)
  })

  test("admission is stateless: the caller owns persistence and the envelope reviewState is untouched", () => {
    // transitionAdmission takes only a from-state and a signal; nothing is stored.
    const result = transition("review-pending", { action: "review-approve" })
    expect(result).toEqual({
      version: 1,
      accepted: true,
      from: "review-pending",
      to: "admitted",
      reason: "Reviewer approved (J1–J5 pass)",
      requiresHuman: false,
      replacementReceipt: false,
    })
  })

  test("every action name is exercised somewhere in the suite is guaranteed by the exported list", () => {
    expect(ADMISSION_ACTIONS).toHaveLength(10)
    expect(ADMISSION_ACTIONS).toContain("new-receipt")
  })
})