# S3 State & Observability Controls + V1 Bounded Maker-Checker Review (s3-v1-controls)

**Date:** 2026-08-30
**Branch:** `feat/s3-v1-controls`
**Status:** Implemented, test-covered, and opt-in. Default configuration is
**backward-compatible**: `trace{off}`, `budget{advisory}`, `review{prompt}`
preserve the previous behavior exactly — no extra hooks, events, tools, gates, or
storage. Enabled modes add bounded, metadata-only, callable surfaces and checks at
**plugin-owned dispatch boundaries only**. There is no automatic completion gate and
no in-flight cancellation anywhere.
**Scope:** this artifact covers the implementation of the parent plan's
[S3 — Structured observability, budgets, and step limits]
(../orchestrator-improvements-plan.md) and
[V1 — Maker-Checker Review with Circuit Breaker]
(../orchestrator-improvements-plan.md) in a bounded, opt-in form.

## 1. Configuration contract

All three blocks are strict (`additionalProperties: false`) with defaults that
reproduce earlier behavior. Names and semantics:

| Key | Default | Values | Notes |
|---|---|---|---|
| `trace.mode` | `"off"` | `off` \| `memory` \| `snapshot` | `off` = nothing is traced. `memory` = bounded in-memory metadata summaries, never persisted. `snapshot` = memory plus one bounded current record per session (`trace/v1/<project>/<session>`). |
| `budget.mode` | `"advisory"` | `advisory` \| `stop-between-steps` | `advisory` never blocks. `stop-between-steps` checks only plugin-owned next dispatches. |
| `budget.max_steps` | `null` | integer ≥ 0 (nullable) | Step ceiling. |
| `budget.max_tokens` | `null` | finite ≥ 0 (nullable) | Token ceiling (input+output+reasoning). |
| `budget.max_cost_usd` | `null` | finite ≥ 0 (nullable) | USD cost ceiling. |
| `budget.max_wall_clock_ms` | `null` | finite ≥ 0 (nullable) | Elapsed ceiling from the first observed activity. |
| `budget.max_retries` | `null` | integer ≥ 0 (nullable) | Retry ceiling. |
| `review.mode` | `"prompt"` | `prompt` \| `bounded` | `prompt` = unchanged prompt-only behavior. `bounded` adds the review tools + terminal breaker. |
| `review.max_rounds` | `2` | integer 1..8 | Bounded rework rounds before the circuit opens. |

Explicit `null` (or omission) means "no limit"; `Infinity`/`NaN`/negatives are
rejected by the strict schema (`src/core/config.ts`). The runtime activates only
when `trace.mode !== "off"`, `budget.mode === "stop-between-steps"`, or
`review.mode === "bounded"`.

## 2. Metadata-only boundary (hard constraint)

S3 records are **versioned bounded metadata summaries only**. Nothing is ever
stored for: prompts, transcripts, tool input/output, shell output, result/error
text, raw auth/credentials, or arbitrary payloads.

- Tool call IDs are held **only in memory** in the pending map to pair
  `execute.before`/`execute.after`; persisted records never carry them.
- IDs on records are **plugin correlation IDs** (taskId/runId/sessionID), never
  claimed native run IDs.
- Collections are bounded: per-session tool entries are capped
  (`TRACE_MAX_TOOL_ENTRIES`, extra tools fold into a single `other` bucket) and the
  in-memory pending map is capped (`TRACE_MAX_PENDING_CALLS`; overflow starts are
  dropped and counted via `droppedUnmatched`, never fabricated).
- There is **no append-only ledger**: at most one current trace record and one
  current review record per session.
- Usage aggregate events (`session.usage.updated`) are **snapshots** that replace
  the stored values; nothing is added, so there is no double counting. The
  incremental durable `session.usage.recorded` events are deliberately ignored.
  Missing event coverage is **unknown/partial, never zero** (a summary simply has
  no `usage` field until the first snapshot).

## 3. Runtime surface (pinned V2 only)

- Tool `execute.before` / `execute.after` hooks (metadata fields only).
- Typed `event.subscribe` events: `session.usage.updated` (usage snapshots),
  `session.step.started` (steps), `session.retry.scheduled` (retries),
  `session.deleted` (cleanup).
- The pinned Promise `SessionDomain` excludes `session.stats`; **no separate HTTP
  client is built**. Any usage that cannot be observed is unknown.
- Event/hook observation failures are caught, logged, and **never break
  orchestration**. Cleanup aborts and awaits event consumption and disposes every
  hook registration.

## 4. Deterministic budget evaluation

`evaluateBudget` (`src/opencode-v2/observability/budget.ts`) is pure: given an
observation (`steps`, `tokens`, `costUsd`, `retries`, `startedAt`, optional `now`)
and the nullable limits, it returns a **version-1** evaluation with a
`within | exceeded | unknown` verdict and one detail per configured limit.

- Boundary semantics: exact-equality is `within`; only a value strictly greater
  than the limit is `exceeded`.
- Missing observation = `unknown` (never `within`, never `0`).
- **Fail-closed rule**: for `stop-between-steps` checks, unknown **token/cost**
  coverage folds to `exceeded` with the reason recorded. Other unknowns (steps,
  wall clock, retries) remain `unknown`. `advisory` mode never yields `exceeded`
  for unknown coverage.
- `stop-between-steps` is applied **only** at plugin-owned next dispatches: goal
  auto-continuation (checked both before reservation under the session lock and
  again immediately before queued delivery) and slash-command prompt delivery
  (checked before a plan run is activated). `session.interrupt` is never called
  and in-flight provider/tool calls are never cancelled.

## 5. V1 review schema (separate from D2/admission)

`src/opencode-v2/observability/review.ts` is a **separate version-1 review
schema**. It does not change D2 `reviewState` (`src/core/contracts.ts`) or the core
admission state semantics (`src/core/admission.ts`); a self-declared D2
`reviewState` is never treated as reviewer proof, and this machine never reads the
D2 envelope.

States: `pending`, `approved`, `changes-requested`, `blocked`, `tripped`.
Actions: `start`, `approve`, `request-changes`, `block`.
Reasons are fixed enums (`manual-start`, `round-reopened`, `approval-complete`,
`changes-requested`, `rounds-exhausted`, `checker-blocked`, `checker-must-differ`,
`checker-role-mismatch`, `identity-drift`, `already-pending`, `pending-task-locked`,
`terminal-for-task`, `no-record`, `checks-failed`, `invalid-signal`). **No
free-form reviewer text is accepted or persisted.**

**Record identity is `taskId` + `runId` together.** The same taskId with a new
runId is a different record identity. Approval requires the three **fixed checks**
(`diff`, `scope`, `verification`), all true; arbitrary check names, missing keys,
empty checks, and extra keys are rejected by the schema, and the model-facing tool
schema derives its checks from the same `REVIEW_V1_CHECK_KEYS` constant so the two
can never drift apart.

Deterministic transitions (`transitionReviewV1`):

| Current | Signal | Result |
|---|---|---|
| absent | `start` (taskId, runId, maker, checker, admissionState=`review-pending`) | pending round 1 |
| pending same task/run | `start` same identity | rejected `already-pending` |
| open (pending or changes-requested) | `start` different task/run (including same task, new run) | rejected `pending-task-locked` (cannot overwrite an open record) |
| terminal (approved/blocked/tripped) old record | `start` different task/run (including same task, new run) | replaced; new pending round 1 |
| changes-requested same task/run | `start` same identity with unchanged maker/checker | next pending round (`round-reopened`); at max rounds rejected `rounds-exhausted` |
| changes-requested same task/run | `start` with a different maker or checker | rejected `identity-drift` |
| pending | `approve` with the fixed checks `diff`, `scope`, `verification` all `true` | `approved` (terminal) |
| pending | `approve` with any fixed check `false`, missing, or extra | rejected `checks-failed` |
| pending | `request-changes` | `changes-requested` when rounds remain; else `tripped` (terminal, requires human, `rounds-exhausted`) |
| pending | `block` | `blocked` (terminal, requires human, `checker-blocked`) |
| approved/blocked/tripped | any decision | rejected `terminal-for-task` |

Maker/checker constraints: `checker !== maker` and (when a role is configured)
`checker === roles.review`; reopening an exact record also requires the maker and
checker to stay unchanged. Caller identity and child-session ownership **cannot be
proven** by the plugin.

## 6. Durable storage

- **One current bounded record per session**, versioned, under stable
  project/session keys: `trace/v1/<project>/<session>` (snapshot mode) and
  `review/v1/<project>/<session>` (bounded review).
- Writes are serialized through the existing process-local `withSessionLock`
  (`src/opencode-v2/goal/state.ts`); the project segment uses the session's stable
  origin project so records stay findable across session moves.
- **Explicitly no CAS/cross-process guarantee** — the lock is process-local, and
  concurrent processes may interleave. The `review_transition` read-modify-write
  runs under one lock so a pending different task can never be silently
  overwritten within one process.
- `session.deleted` removes the trace record; review records are left alone (a
  deleted session's record is simply unreachable under its old session key and the
  next start for a different task replaces a terminal one).

## 7. Tools (orchestrator-only, conditional, callable)

All under the `orchestrator` namespace with the shared
`orchestrator_observability` permission action (denied to workers by the installer
and the agent transform, plus a runtime agent check). Registered **only when the
corresponding mode is enabled** — the default tool contract/count is unchanged:

| Tool | Registered when | Input | Outcome / boundary |
|---|---|---|---|
| `orchestrator_observability_get` | trace or stop-between-steps budget active | `sessionID` | Current bounded trace summary + budget evaluation; metadata only; limitations listed in the output. |
| `orchestrator_review_get` | `review.mode === "bounded"` | `sessionID` | Current bounded review record (or `null`), `maxRounds`, configured checker role, limitations. |
| `orchestrator_review_transition` | `review.mode === "bounded"` | `sessionID`, strict per-action `signal` (`oneOf`) | Deterministic transition, persisted under the lock. `start` requires exactly taskId/runId/maker/checker/admissionState; `approve` requires exactly the fixed boolean checks diff/scope/verification (all must be true); `request-changes`/`block` take exactly the action. Any extra per-action field is rejected. Output includes limitations. |

These tools are **callable/advisory, not automatic hooks**: nothing consumes their
results automatically and no completion gate is enforced. The orchestration
guidance (embedded only when bounded is configured) requires the explicit flow:
validate the maker handoff (`orchestrator_handoff_validate`) → reach
`review-pending` through `orchestrator_admission_transition` (`orchestrator-pass`
with `reviewRequired: true`) → `start` the record → delegate the reviewer →
record the fixed decision → map it through the admission transition → **stop on
blocked/tripped**.

## 8. Circuit breaker and dispatch gating

- Tripped/blocked records open the breaker: goal auto-continuation checks the
  current review record before reservation **and** before delivery and stops with
  the reason. Pending/changes-requested/approved do not trip it, and a new task
  start that replaces a terminal record reopens the breaker.
- The breaker applies to **goal auto-continuation only** (the plugin-owned next
  dispatch); user-typed slash commands pass gateway, and budget checks apply to
  both.
- Nothing is gated at completion: the admission machine and D2 remain stateless
  and self-declared, exactly as before.

## 9. Tests

- `test/unit/observability.test.ts` — strict config defaults/validation (including
  top-level typo rejection under the strict options schema); budget boundary
  semantics (within at equality, exceeded past it, unknown ≠ zero, token/cost
  fail-closed only for stop-between-steps); bounded metadata-only aggregation that
  ignores raw payloads and destroys call IDs; usage snapshots replace rather than
  accumulate; **pending-cap eviction counts `droppedUnmatched` on the evicted
  session** (cross-session overflow regression); session.deleted cleanup; dispose
  closes the stream and hook registrations; conditional tool registration; gate
  semantics (review breaker vs command dispatch, advisory never blocks);
  **model-facing `reviewTransitionInput` vs runtime `REVIEW_V1_SIGNAL_SCHEMA`
  parity** (per-action required sets, fixed check keys) and runtime rejection of
  every per-action extra field; approve accepting exactly the fixed checks.
- `test/unit/review.test.ts` — full transition table over **task/run identity**
  (same task new run open → `pending-task-locked`; after terminal → replaced),
  **identity-drift rejection** when reopening changes-requested with a changed
  maker or checker, fixed-checks schema/runtime parity and negative cases (empty,
  missing, arbitrary, extra check keys), terminal breaker behavior, bounded
  versioned storage, maker/checker constraints, unchanged D2/admission semantics,
  bounded-loop termination at max rounds.
- Existing suites extended: `test/unit/core.test.ts` (config + conditional
  guidance + strict top-level options), `test/unit/continuation.test.ts` (gate at
  reservation/delivery + **auto-continuation prompt includes bounded-review and
  budget guidance only when enabled**, and no guidance by default),
  `test/unit/runtime.test.ts` (gate blocks slash commands), `test/unit/session-state.test.ts`
  and `test/unit/installer.test.ts` (permission surface), `test/unit/orchestration-tools.test.ts`
  (family separation), `test/contract/plugin.test.ts` (enabled modes add tools and
  hooks without changing the default contract).
- Full suite, typecheck, and build pass on the branch.

## 10. Explicit limitations

- No CAS, transactions, or cross-process storage guarantee; exactly-once is never
  claimed.
- Caller identity and child-session ownership cannot be proven; only the
  orchestrator agent check + configured review role constraints are enforced.
- Token/cost data exists only when the host delivers `session.usage.updated`
  snapshots; missing coverage is unknown and fails closed only for
  stop-between-steps checks.
- stop-between-steps gates next dispatches it; it never cancels in-flight
  provider/tool calls, never calls `session.interrupt`, and does not impose
  per-model-vendor tiering.
- No model-vendor tiering and no migrations: D2 and admission semantics are
  byte-for-byte unchanged, and no new package exports beyond the public pure APIs
  documented in `src/index.ts`.