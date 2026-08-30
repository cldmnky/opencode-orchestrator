import { z } from "zod"

/**
 * Typed evidence vocabulary and admission checks (V3).
 *
 * Tool results that claim success carry a typed `evidence` record describing
 * *what* was verified, *how fresh* that verification is, and *who* is
 * authoritative for it. Evidence contains only validated metadata — never
 * ProcessResult objects, stdout/stderr transcripts, headers, or tokens — so
 * it can be serialized to the model without weakening redaction.
 *
 * Authority model:
 * - `EVIDENCE_LIVE` — the claim was produced by a live, per-invocation
 *   operation (a `gh`/`git` run whose output was validated before shaping).
 * - `EVIDENCE_MUTATION` — a live mutation whose effect was confirmed by the
 *   host (e.g. GitHub API `id`/`number`/`html_url` on the created object).
 * - `EVIDENCE_REGISTERED` — a registration-time claim (tools, agents, hooks).
 * - `EVIDENCE_LOCAL` — a local, advisory claim (doctor-style checks).
 * - `EVIDENCE_STATIC` — a structural claim from pinned/documented contracts.
 * - `UNKNOWN` — the claim cannot be classified; admission must fail closed.
 *
 * `assessEvidence` is the single admission gate: it rejects future/stale,
 * session-mismatched, unsupported-authority, and unsupported-marker claims,
 * and blocks (as unknown) missing records and `UNKNOWN` markers. Only a
 * mutation marker carrying a valid mutation proof is admitted for mutation
 * requirements.
 */

export const EVIDENCE_MARKERS = [
  "EVIDENCE_LIVE",
  "EVIDENCE_MUTATION",
  "EVIDENCE_REGISTERED",
  "EVIDENCE_LOCAL",
  "EVIDENCE_STATIC",
  "UNKNOWN",
] as const
export type EvidenceMarker = (typeof EVIDENCE_MARKERS)[number]

export const FRESHNESS_VALUES = [
  "per-invocation",
  "per-session",
  "config-load",
  "startup+events",
  "doctor-run",
  "install-snapshot",
  "live-doc",
] as const
export type Freshness = (typeof FRESHNESS_VALUES)[number]

export const AUTHORITY_VALUES = [
  "authoritative-for-tested-fields",
  "advisory",
  "documented-pinned",
  "documented-live",
  "declared-absent",
] as const
export type Authority = (typeof AUTHORITY_VALUES)[number]

/** Mutation proof URLs must be https; http or other schemes are rejected. */
const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), { message: "url must be an https URL" })

export const mutationProofSchema = z
  .object({
    verified: z.literal(true),
    id: z.union([z.string(), z.number()]),
    number: z.number().int().nonnegative().optional(),
    url: httpsUrl,
  })
  .strict()

export type MutationProof = z.infer<typeof mutationProofSchema>

export const evidenceSchema = z
  .object({
    marker: z.enum(EVIDENCE_MARKERS),
    freshness: z.enum(FRESHNESS_VALUES),
    authority: z.enum(AUTHORITY_VALUES),
    version: z.literal(1),
    source: z.string().min(1),
    sessionID: z.string().min(1).optional(),
    capturedAt: z.number().int().nonnegative(),
    mutation: mutationProofSchema.optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.marker === "EVIDENCE_MUTATION" && record.mutation === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mutation"],
        message: "EVIDENCE_MUTATION requires a mutation proof",
      })
    }
    if (record.marker !== "EVIDENCE_MUTATION" && record.mutation !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mutation"],
        message: "mutation proof is only allowed on EVIDENCE_MUTATION records",
      })
    }
  })

export type EvidenceRecord = z.infer<typeof evidenceSchema>

export type LiveEvidence = EvidenceRecord & { marker: "EVIDENCE_LIVE" }
export type MutationEvidence = EvidenceRecord & { marker: "EVIDENCE_MUTATION"; mutation: MutationProof }

export type LiveEvidenceInput = {
  /** Fully namespaced producer, e.g. `opencode-orchestrator.gh.issue.list`. */
  source: string
  sessionID?: string
  capturedAt?: number
}

/** Build a live per-invocation evidence record; throws if the record is invalid. */
export function liveEvidence(input: LiveEvidenceInput): LiveEvidence {
  return evidenceSchema.parse({
    marker: "EVIDENCE_LIVE",
    freshness: "per-invocation",
    authority: "authoritative-for-tested-fields",
    version: 1,
    source: input.source,
    sessionID: input.sessionID,
    capturedAt: input.capturedAt ?? Date.now(),
  }) as LiveEvidence
}

export type MutationProofInput = {
  id: string | number
  number?: number
  url: string
}

export type MutationEvidenceInput = LiveEvidenceInput & { proof: MutationProofInput }

/**
 * Build a mutation evidence record whose proof is validated before it can be
 * returned: `verified: true`, a string/number id, an optional non-negative
 * integer number, and an https-only url. Throws on any malformed proof so a
 * tool can never serialize invalid mutation evidence.
 */
export function mutationEvidence(input: MutationEvidenceInput): MutationEvidence {
  return evidenceSchema.parse({
    marker: "EVIDENCE_MUTATION",
    freshness: "per-invocation",
    authority: "authoritative-for-tested-fields",
    version: 1,
    source: input.source,
    sessionID: input.sessionID,
    capturedAt: input.capturedAt ?? Date.now(),
    mutation: { ...input.proof, verified: true },
  }) as MutationEvidence
}

export type Assessment =
  | { outcome: "admitted" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "blocked-unknown"; reason: string }

type EvidenceRequirementBase = {
  /** When bound, the evidence must carry this exact sessionID (provenance). */
  currentSessionID?: string
  /** Reference clock for future/staleness checks; defaults to Date.now(). */
  currentTime?: number
  /** Maximum allowed age for the evidence, in milliseconds. */
  maxAgeMs?: number
}

/**
 * Requirement kinds distinguish what kind of claim admission is asked about.
 * Every variant may carry the shared session/time/age constraints as needed;
 * the kind discriminates which marker/authority/freshness boundary applies.
 */
export type EvidenceRequirement =
  | (EvidenceRequirementBase & { kind: "live" })
  | (EvidenceRequirementBase & { kind: "mutation" })
  | (EvidenceRequirementBase & { kind: "structural" })
  | (EvidenceRequirementBase & { kind: "registration" })
  | (EvidenceRequirementBase & { kind: "advisory" })

/**
 * Admit or refuse an evidence record against a requirement. Fail-closed:
 * missing records and `UNKNOWN` markers block as unknown; every other
 * violation (malformed, future, stale, session-mismatched, unsupported
 * authority, unsupported marker, missing mutation proof) is rejected.
 */
export function assessEvidence(record: unknown, requirement: EvidenceRequirement): Assessment {
  if (record === undefined || record === null) {
    return { outcome: "blocked-unknown", reason: "missing current live proof: no evidence record" }
  }
  const parsed = evidenceSchema.safeParse(record)
  if (!parsed.success) {
    return {
      outcome: "rejected",
      reason: `malformed evidence record: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    }
  }
  const evidence = parsed.data

  if (evidence.marker === "UNKNOWN") {
    return { outcome: "blocked-unknown", reason: "evidence marker is UNKNOWN; claim cannot be classified" }
  }

  if (requirement.currentSessionID !== undefined) {
    if (evidence.sessionID === undefined) {
      return { outcome: "blocked-unknown", reason: "evidence does not carry a sessionID; provenance cannot be bound" }
    }
    if (evidence.sessionID !== requirement.currentSessionID) {
      return {
        outcome: "rejected",
        reason: `evidence session ${evidence.sessionID} does not match current session ${requirement.currentSessionID}`,
      }
    }
  }

  const now = requirement.currentTime ?? Date.now()
  if (evidence.capturedAt > now) {
    return { outcome: "rejected", reason: `evidence capturedAt ${evidence.capturedAt} is in the future` }
  }
  if (requirement.maxAgeMs !== undefined && now - evidence.capturedAt > requirement.maxAgeMs) {
    return {
      outcome: "rejected",
      reason: `evidence is stale: capturedAt ${evidence.capturedAt} exceeds max age ${requirement.maxAgeMs}ms`,
    }
  }

  switch (requirement.kind) {
    case "live":
      if (evidence.marker !== "EVIDENCE_LIVE") {
        return { outcome: "rejected", reason: `live requirement needs EVIDENCE_LIVE marker, got ${evidence.marker}` }
      }
      if (evidence.authority !== "authoritative-for-tested-fields") {
        return {
          outcome: "rejected",
          reason: `live requirement needs authoritative-for-tested-fields authority, got ${evidence.authority}`,
        }
      }
      if (evidence.freshness !== "per-invocation" && evidence.freshness !== "per-session") {
        return {
          outcome: "rejected",
          reason: `live requirement needs per-invocation or per-session freshness, got ${evidence.freshness}`,
        }
      }
      return { outcome: "admitted" }

    case "mutation":
      if (evidence.marker !== "EVIDENCE_MUTATION") {
        return { outcome: "rejected", reason: `mutation requirement needs EVIDENCE_MUTATION marker, got ${evidence.marker}` }
      }
      if (evidence.authority !== "authoritative-for-tested-fields") {
        return {
          outcome: "rejected",
          reason: `mutation requirement needs authoritative-for-tested-fields authority, got ${evidence.authority}`,
        }
      }
      if (evidence.freshness !== "per-invocation") {
        return {
          outcome: "rejected",
          reason: `mutation requirement needs per-invocation freshness, got ${evidence.freshness}`,
        }
      }
      if (evidence.mutation === undefined) {
        return { outcome: "rejected", reason: "mutation evidence is missing its mutation proof" }
      }
      return { outcome: "admitted" }

    case "structural":
      if (evidence.marker !== "EVIDENCE_STATIC" && evidence.marker !== "EVIDENCE_REGISTERED") {
        return {
          outcome: "rejected",
          reason: `structural requirement needs EVIDENCE_STATIC or EVIDENCE_REGISTERED marker, got ${evidence.marker}`,
        }
      }
      if (evidence.authority !== "documented-pinned" && evidence.authority !== "authoritative-for-tested-fields") {
        return {
          outcome: "rejected",
          reason: `structural requirement needs documented-pinned or authoritative-for-tested-fields authority, got ${evidence.authority}`,
        }
      }
      if (
        evidence.freshness !== "config-load" &&
        evidence.freshness !== "startup+events" &&
        evidence.freshness !== "install-snapshot"
      ) {
        return {
          outcome: "rejected",
          reason: `structural requirement needs config-load, startup+events, or install-snapshot freshness, got ${evidence.freshness}`,
        }
      }
      return { outcome: "admitted" }

    case "registration":
      if (evidence.marker !== "EVIDENCE_REGISTERED") {
        return { outcome: "rejected", reason: `registration requirement needs EVIDENCE_REGISTERED marker, got ${evidence.marker}` }
      }
      if (evidence.authority !== "authoritative-for-tested-fields" && evidence.authority !== "documented-pinned") {
        return {
          outcome: "rejected",
          reason: `registration requirement needs authoritative-for-tested-fields or documented-pinned authority, got ${evidence.authority}`,
        }
      }
      if (evidence.freshness !== "startup+events" && evidence.freshness !== "per-session") {
        return {
          outcome: "rejected",
          reason: `registration requirement needs startup+events or per-session freshness, got ${evidence.freshness}`,
        }
      }
      return { outcome: "admitted" }

    case "advisory":
      if (evidence.marker !== "EVIDENCE_LOCAL") {
        return { outcome: "rejected", reason: `advisory requirement needs EVIDENCE_LOCAL marker, got ${evidence.marker}` }
      }
      if (evidence.authority !== "advisory") {
        return { outcome: "rejected", reason: `advisory requirement needs advisory authority, got ${evidence.authority}` }
      }
      if (evidence.freshness !== "doctor-run") {
        return { outcome: "rejected", reason: `advisory requirement needs doctor-run freshness, got ${evidence.freshness}` }
      }
      return { outcome: "admitted" }
  }
}