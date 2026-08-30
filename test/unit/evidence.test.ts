import { describe, expect, test } from "bun:test"
import {
  assessEvidence,
  evidenceSchema,
  liveEvidence,
  mutationEvidence,
  type Assessment,
} from "../../src/opencode-v2/orchestration/evidence.js"

const PROOF = { id: 1001, number: 42, url: "https://github.com/acme/widgets/issues/42" }

function outcome(assessment: Assessment): string {
  return assessment.outcome
}

describe("evidence schema (strict Zod)", () => {
  test("accepts a canonical live record", () => {
    const record = liveEvidence({ source: "opencode-orchestrator.gh.repo.view", sessionID: "session-1", capturedAt: 1000 })
    expect(record).toEqual({
      marker: "EVIDENCE_LIVE",
      freshness: "per-invocation",
      authority: "authoritative-for-tested-fields",
      version: 1,
      source: "opencode-orchestrator.gh.repo.view",
      sessionID: "session-1",
      capturedAt: 1000,
    })
  })

  test("accepts a canonical mutation record with proof", () => {
    const record = mutationEvidence({
      source: "opencode-orchestrator.gh.issue.create",
      sessionID: "session-1",
      capturedAt: 1000,
      proof: PROOF,
    })
    expect(record.marker).toBe("EVIDENCE_MUTATION")
    expect(record.mutation).toEqual({ verified: true, id: 1001, number: 42, url: PROOF.url })
  })

  test("rejects a missing version, empty source, negative capturedAt, and unknown enums", () => {
    const base = liveEvidence({ source: "opencode-orchestrator.gh", capturedAt: 1000 })
    expect(evidenceSchema.safeParse({ ...base, version: 2 }).success).toBe(false)
    expect(evidenceSchema.safeParse({ ...base, source: "" }).success).toBe(false)
    expect(evidenceSchema.safeParse({ ...base, capturedAt: -1 }).success).toBe(false)
    expect(evidenceSchema.safeParse({ ...base, capturedAt: 1.5 }).success).toBe(false)
    expect(evidenceSchema.safeParse({ ...base, marker: "EVIDENCE_GHOST" } as never).success).toBe(false)
    expect(evidenceSchema.safeParse({ ...base, freshness: "hourly" } as never).success).toBe(false)
    expect(evidenceSchema.safeParse({ ...base, authority: "self-certified" } as never).success).toBe(false)
  })

  test("is strict: unknown keys are rejected", () => {
    const base = liveEvidence({ source: "opencode-orchestrator.gh", capturedAt: 1000 })
    expect(evidenceSchema.safeParse({ ...base, claims: ["x"] }).success).toBe(false)
  })

  test("mutation marker requires a mutation proof", () => {
    const base = liveEvidence({ source: "opencode-orchestrator.gh", capturedAt: 1000 })
    expect(
      evidenceSchema.safeParse({ ...base, marker: "EVIDENCE_MUTATION", mutation: { ...PROOF, verified: true } })
        .success,
    ).toBe(true)
    expect(evidenceSchema.safeParse({ ...base, marker: "EVIDENCE_MUTATION" }).success).toBe(false)
  })

  test("live marker must not carry a mutation proof", () => {
    const base = liveEvidence({ source: "opencode-orchestrator.gh", capturedAt: 1000 })
    const parsed = evidenceSchema.safeParse({ ...base, mutation: PROOF })
    expect(parsed.success).toBe(false)
  })
})

describe("mutation proof validation", () => {
  test("accepts string and numeric ids", () => {
    expect(
      mutationEvidence({
        source: "opencode-orchestrator.gh.pr.create",
        capturedAt: 0,
        proof: { id: "R_kgDOABC", url: "https://github.com/acme/widgets" },
      }).mutation?.id,
    ).toBe("R_kgDOABC")
    expect(
      mutationEvidence({
        source: "opencode-orchestrator.gh.issue.create",
        capturedAt: 0,
        proof: { id: 7, number: 7, url: "https://github.com/acme/widgets/issues/7" },
      }).mutation?.number,
    ).toBe(7)
  })

  test("rejects a non-https url", () => {
    expect(() =>
      mutationEvidence({
        source: "opencode-orchestrator.gh.issue.create",
        capturedAt: 0,
        proof: { ...PROOF, url: "http://github.com/acme/widgets/issues/42" },
      }),
    ).toThrow(/https/)
    expect(() =>
      mutationEvidence({
        source: "opencode-orchestrator.gh.issue.create",
        capturedAt: 0,
        proof: { ...PROOF, url: "ftp://github.com/acme/widgets/issues/42" },
      }),
    ).toThrow(/https/)
  })

  test("rejects a malformed url, missing id, and negative or fractional number", () => {
    expect(() =>
      mutationEvidence({
        source: "opencode-orchestrator.gh.issue.create",
        capturedAt: 0,
        proof: { ...PROOF, url: "not-a-url" },
      }),
    ).toThrow()
    expect(() =>
      mutationEvidence({
        source: "opencode-orchestrator.gh.issue.create",
        capturedAt: 0,
        proof: { id: undefined as never, number: 1, url: PROOF.url },
      }),
    ).toThrow()
    expect(() =>
      mutationEvidence({
        source: "opencode-orchestrator.gh.issue.create",
        capturedAt: 0,
        proof: { id: 1, number: -1, url: PROOF.url },
      }),
    ).toThrow()
    expect(() =>
      mutationEvidence({
        source: "opencode-orchestrator.gh.issue.create",
        capturedAt: 0,
        proof: { id: 1, number: 1.5, url: PROOF.url },
      }),
    ).toThrow()
  })

  test("the factory always stamps verified: true and the schema rejects verified: false", () => {
    const record = mutationEvidence({
      source: "opencode-orchestrator.gh.issue.create",
      capturedAt: 0,
      // `verified` is not part of the factory input contract; any supplied
      // value is overwritten by the canonical `verified: true` proof.
      proof: { id: 1, number: 1, url: PROOF.url, verified: false } as never,
    })
    expect(record.mutation?.verified).toBe(true)
    const base = liveEvidence({ source: "opencode-orchestrator.gh", capturedAt: 0 })
    expect(
      evidenceSchema.safeParse({
        ...base,
        marker: "EVIDENCE_MUTATION",
        mutation: { verified: false, id: 1, number: 1, url: PROOF.url },
      }).success,
    ).toBe(false)
  })

  test("mutation proof carries only validated metadata", () => {
    const record = mutationEvidence({
      source: "opencode-orchestrator.gh.issue.create",
      sessionID: "session-1",
      capturedAt: 0,
      proof: { id: 1001, number: 42, url: PROOF.url },
    })
    expect(record).toEqual({
      marker: "EVIDENCE_MUTATION",
      freshness: "per-invocation",
      authority: "authoritative-for-tested-fields",
      version: 1,
      source: "opencode-orchestrator.gh.issue.create",
      sessionID: "session-1",
      capturedAt: 0,
      mutation: { verified: true, id: 1001, number: 42, url: PROOF.url },
    })
  })
})

describe("assessEvidence admission", () => {
  test("admits a fresh live record bound to the current session", () => {
    const record = liveEvidence({ source: "opencode-orchestrator.gh.repo.view", sessionID: "session-1", capturedAt: 1000 })
    expect(
      assessEvidence(record, { kind: "live", currentSessionID: "session-1", currentTime: 2000, maxAgeMs: 5000 }),
    ).toEqual({ outcome: "admitted" })
  })

  test("admits a live record without session binding when none is required", () => {
    const record = liveEvidence({ source: "opencode-orchestrator.worktree.list", capturedAt: 1000 })
    expect(assessEvidence(record, { kind: "live" })).toEqual({ outcome: "admitted" })
  })

  test("admits per-session freshness for a live requirement", () => {
    const record: unknown = { ...liveEvidence({ source: "s", capturedAt: 1000 }), freshness: "per-session" }
    expect(assessEvidence(record, { kind: "live", currentTime: 2000 })).toEqual({ outcome: "admitted" })
  })

  test("rejects stale live evidence beyond maxAgeMs", () => {
    const record = liveEvidence({ source: "opencode-orchestrator.gh.repo.view", sessionID: "session-1", capturedAt: 1000 })
    const assessment = assessEvidence(record, {
      kind: "live",
      currentSessionID: "session-1",
      currentTime: 7001,
      maxAgeMs: 5000,
    })
    expect(outcome(assessment)).toBe("rejected")
    if (assessment.outcome === "rejected") expect(assessment.reason).toContain("stale")
  })

  test("rejects future evidence", () => {
    const record = liveEvidence({ source: "opencode-orchestrator.gh.repo.view", capturedAt: 3000 })
    const assessment = assessEvidence(record, { kind: "live", currentTime: 1000 })
    expect(outcome(assessment)).toBe("rejected")
    if (assessment.outcome === "rejected") expect(assessment.reason).toContain("future")
  })

  test("rejects a session-mismatched record", () => {
    const record = liveEvidence({ source: "opencode-orchestrator.gh.repo.view", sessionID: "session-9", capturedAt: 1000 })
    const assessment = assessEvidence(record, { kind: "live", currentSessionID: "session-1", currentTime: 2000 })
    expect(outcome(assessment)).toBe("rejected")
    if (assessment.outcome === "rejected") expect(assessment.reason).toContain("does not match")
  })

  test("blocks a record missing a sessionID when the requirement binds one", () => {
    const record = liveEvidence({ source: "opencode-orchestrator.gh.repo.view", capturedAt: 1000 })
    expect(outcome(assessEvidence(record, { kind: "live", currentSessionID: "session-1", currentTime: 2000 }))).toBe(
      "blocked-unknown",
    )
  })

  test("blocks a missing record as blocked-unknown", () => {
    const assessment = assessEvidence(undefined, { kind: "live", currentSessionID: "session-1" })
    expect(outcome(assessment)).toBe("blocked-unknown")
    if (assessment.outcome === "blocked-unknown") expect(assessment.reason).toContain("missing")
  })

  test("blocks an UNKNOWN marker as blocked-unknown", () => {
    const record: unknown = { ...liveEvidence({ source: "s", capturedAt: 0 }), marker: "UNKNOWN" }
    expect(outcome(assessEvidence(record, { kind: "live" }))).toBe("blocked-unknown")
    expect(outcome(assessEvidence(record, { kind: "mutation" }))).toBe("blocked-unknown")
  })

  test("rejects a malformed record", () => {
    const assessment = assessEvidence({ marker: "EVIDENCE_LIVE" }, { kind: "live" })
    expect(outcome(assessment)).toBe("rejected")
    if (assessment.outcome === "rejected") expect(assessment.reason).toContain("malformed")
  })

  test("rejects unsupported authority for a live requirement", () => {
    const record: unknown = { ...liveEvidence({ source: "s", capturedAt: 0 }), authority: "advisory" }
    const assessment = assessEvidence(record, { kind: "live" })
    expect(outcome(assessment)).toBe("rejected")
    if (assessment.outcome === "rejected") expect(assessment.reason).toContain("authority")
  })

  test("rejects a non-live marker for a live requirement", () => {
    const registered: unknown = { ...liveEvidence({ source: "s", capturedAt: 0 }), marker: "EVIDENCE_REGISTERED" }
    expect(outcome(assessEvidence(registered, { kind: "live" }))).toBe("rejected")
    const local: unknown = { ...liveEvidence({ source: "s", capturedAt: 0 }), marker: "EVIDENCE_LOCAL" }
    expect(outcome(assessEvidence(local, { kind: "live" }))).toBe("rejected")
    const staticRecord: unknown = { ...liveEvidence({ source: "s", capturedAt: 0 }), marker: "EVIDENCE_STATIC" }
    expect(outcome(assessEvidence(staticRecord, { kind: "live" }))).toBe("rejected")
  })

  test("admits a mutation marker with a valid proof", () => {
    const record = mutationEvidence({
      source: "opencode-orchestrator.gh.issue.create",
      sessionID: "session-1",
      capturedAt: 1000,
      proof: PROOF,
    })
    expect(
      assessEvidence(record, { kind: "mutation", currentSessionID: "session-1", currentTime: 2000, maxAgeMs: 5000 }),
    ).toEqual({ outcome: "admitted" })
  })

  test("only a mutation marker with valid proof admits a mutation requirement", () => {
    const live = liveEvidence({ source: "opencode-orchestrator.gh.issue.view", sessionID: "session-1", capturedAt: 0 })
    const assessment = assessEvidence(live, { kind: "mutation", currentSessionID: "session-1", currentTime: 1000 })
    expect(outcome(assessment)).toBe("rejected")
    if (assessment.outcome === "rejected") expect(assessment.reason).toContain("EVIDENCE_MUTATION")

    const staleMutation = mutationEvidence({
      source: "opencode-orchestrator.gh.issue.create",
      sessionID: "session-1",
      capturedAt: 1,
      proof: PROOF,
    })
    expect(
      outcome(assessEvidence(staleMutation, { kind: "mutation", currentSessionID: "session-1", currentTime: 5001, maxAgeMs: 4000 })),
    ).toBe("rejected")

    const wrongSession = mutationEvidence({
      source: "opencode-orchestrator.gh.issue.create",
      sessionID: "session-9",
      capturedAt: 0,
      proof: PROOF,
    })
    expect(outcome(assessEvidence(wrongSession, { kind: "mutation", currentSessionID: "session-1", currentTime: 1000 }))).toBe(
      "rejected",
    )
  })

  test("structural requirement admits only static/registered documented claims", () => {
    const staticRecord = {
      marker: "EVIDENCE_STATIC",
      freshness: "config-load",
      authority: "documented-pinned",
      version: 1,
      source: "opencode-orchestrator.config",
      capturedAt: 0,
    }
    expect(assessEvidence(staticRecord, { kind: "structural" })).toEqual({ outcome: "admitted" })

    const registered = {
      marker: "EVIDENCE_REGISTERED",
      freshness: "startup+events",
      authority: "authoritative-for-tested-fields",
      version: 1,
      source: "opencode-orchestrator.plugin",
      capturedAt: 0,
    }
    expect(assessEvidence(registered, { kind: "structural" })).toEqual({ outcome: "admitted" })

    const live = liveEvidence({ source: "s", capturedAt: 0 })
    expect(outcome(assessEvidence(live, { kind: "structural" }))).toBe("rejected")

    const liveAuthority: unknown = { ...staticRecord, authority: "documented-live" }
    expect(outcome(assessEvidence(liveAuthority, { kind: "structural" }))).toBe("rejected")

    const liveFreshness: unknown = { ...staticRecord, freshness: "live-doc" }
    expect(outcome(assessEvidence(liveFreshness, { kind: "structural" }))).toBe("rejected")
  })

  test("registration requirement admits only registered claims at startup/session freshness", () => {
    const registered = {
      marker: "EVIDENCE_REGISTERED",
      freshness: "per-session",
      authority: "authoritative-for-tested-fields",
      version: 1,
      source: "opencode-orchestrator.plugin",
      capturedAt: 0,
    }
    expect(assessEvidence(registered, { kind: "registration" })).toEqual({ outcome: "admitted" })

    const wrongFreshness: unknown = { ...registered, freshness: "config-load" }
    expect(outcome(assessEvidence(wrongFreshness, { kind: "registration" }))).toBe("rejected")

    const staticRecord: unknown = { ...registered, marker: "EVIDENCE_STATIC" }
    expect(outcome(assessEvidence(staticRecord, { kind: "registration" }))).toBe("rejected")
  })

  test("advisory requirement admits only local doctor-run claims", () => {
    const advisory = {
      marker: "EVIDENCE_LOCAL",
      freshness: "doctor-run",
      authority: "advisory",
      version: 1,
      source: "opencode-orchestrator.doctor",
      capturedAt: 0,
    }
    expect(assessEvidence(advisory, { kind: "advisory" })).toEqual({ outcome: "admitted" })

    const live = liveEvidence({ source: "s", capturedAt: 0 })
    expect(outcome(assessEvidence(live, { kind: "advisory" }))).toBe("rejected")

    const declared: unknown = { ...advisory, authority: "declared-absent" }
    expect(outcome(assessEvidence(declared, { kind: "advisory" }))).toBe("rejected")
  })
})