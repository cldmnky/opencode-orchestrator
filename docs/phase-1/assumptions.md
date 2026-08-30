# Phase 1 — Assumption and Verification Ledger (issue #8 + issue #10 note)

**Date:** 2026-08-30
**Issue:** #8 — Phase 1 assumption and verification ledger · #10 — Phase 1 runtime contracts (implementation note below)
**Source of record:** `docs/orchestrator-improvements-plan.md:1095-1108` ("Assumptions Requiring Verification"), restated here with conservative statuses, exact evidence, remaining unknowns, and next verification steps.

**Scope statement:** this ledger records *what is established by source inspection* and *what remains unverified* for assumptions A1-A12 against the pinned OpenCode V2 contract. **No verification command in the backlog below was executed for this ledger**; every status is derived from read-only source/package-declaration inspection. This ledger makes no measured-telemetry claims and contains no credentials.

---

## Issue #10 implementation note (dated — added without falsifying the historical scope)

> **Added 2026-08-30 by issue #10.** This note supplements, but does not rewrite, the historical
> read-only ledger above. Issue #10 added **callable runtime surfaces** that verify part of the
> V3 evidence vocabulary and the D2/admission contracts, covered by unit tests
> (`test/unit/contracts.test.ts`, `test/unit/d4.test.ts`, `test/unit/admission.test.ts`,
> `test/unit/evidence.test.ts`, `test/unit/orchestration-tools.test.ts`) within the full
> parent-verified suite: `bun run typecheck` passed, `bun test` was **456 pass / 1 skip / 0 fail**
> (457 tests across 18 files; the skip is the pre-existing cross-volume platform case), `bun run
> build` passed all five bundles, and `npm pack` + unpacked `dist/index.js` import passed.
> None of that changes the **statuses** in the A1–A12 table below: the
> tools are callable/advisory, not enforcement, so A4 and A5 stay **Partially verified**; the
> typed-evidence implementation is recorded under A9; A11 stays **Verified (negative)** because
> evidence records are still not persisted; A7's HTTP-vs-pinned-Promise nuance is stated
> explicitly. The original backlog remains unexecuted: no backlog command was run for the original
> ledger, and the issue #10 facts are established by source inspection + the parent-verified runs
> above, not by the backlog probes. The shared-service live-reload smoke is **inconclusive** (the
> `opencode2 api get /api/plugin` probe did not list this plugin and the service was not restarted),
> while the final independent aggregate review passed with no blocking or major findings.

## Status vocabulary

| Status | Meaning |
|---|---|
| **Verified** | The claim (including, where marked, a *negative* claim) is directly established by source/declaration inspection in this repository and cannot reasonably be otherwise from the inspected contract. |
| **Partially verified** | Part of the claim is established by source inspection (config, prompt, or interface presence), but the enforcing/runtime half of the claim has not been demonstrated. |
| **Unverified** | No evidence in this repository establishes the claim; it remains open for Phase 1 host/contract probing. |
| **Not supported** | The inspected contract/policy explicitly states the capability does not exist; treated as a policy-stated negative, re-checked only if the host contract changes. |

## Assumption ledger

| ID | Assumption | Status | Evidence | What is established | What remains unknown | Next verification |
|---|---|---|---|---|---|---|
| A1 | V2 API stability | Unverified | `package.json:37,45` (pins `@opencode-ai/plugin@0.0.0-beta-18684`, `@opencode-ai/sdk@0.0.0-dev-18683`); `docs/orchestrator-improvements-plan.md:14,1097`; `AGENTS.md` "OpenCode V2 Contract" (API is beta/experimental; README "V2 Boundary" section already stale) | The package pins prerelease V2 package generations; repository guidance and the plan both treat the V2 API as beta/experimental and subject to change | Whether the pinned declaration surface matches the live `https://opencode.ai/v2/openapi.json` contract; stability timeline; drift between pins, docs, and live API | Diff pinned plugin/sdk declarations against the live V2 OpenAPI; record the diff outcome in this ledger (still no stability promise either way) |
| A2 | Native background primitives | Unverified | `docs/orchestrator-improvements-plan.md:1098` (issue #20849 `promptAsync`/SSE/child-session/cancellation "not assumed to exist in the pinned package"); `node_modules/@opencode-ai/plugin/dist/tui/context.d.ts:40` (TUI `Data.session` exposes `cost(sessionID)`, `status(sessionID)`); no `promptAsync`/child-session symbols found by grep of `node_modules/@opencode-ai/plugin/dist` | The pinned package's TUI context exposes per-session status/cost; the repository does not depend on `promptAsync` (symbol absent from pinned declarations); issue #20849 is a proposal, not a contract | Whether any *server-side* background/child-session prompt API exists on the pinned host; semantics of proposal issue/PR vs available contract; whether TUI-context stats are reachable from the server plugin | Probe the live host API for background/child-session/prompt endpoints; treat only the observed host surface, never the issue text, as the contract |
| A3 | Atomic child isolation | Not supported | `src/core/policy.ts:53-57` ("native V2 subagent API does not expose a plugin-controlled atomic worktree or location boundary; prompt-level disjoint write scopes do not equal filesystem isolation"); `src/core/policy.ts:59-62` (managed worktree is current-session-owned; "not atomic child isolation"); `src/opencode-v2/plugin.ts:89` ("delegated children get no atomic isolation"); `src/cli/doctor.ts:149-152` (workflow-boundary `warn`); worktree sources `src/opencode-v2/worktree/{git,events,tools,state}.ts` | Policy, plugin prompt text, and doctor all state the same negative: plugin-controlled atomic child worktrees are unavailable; managed worktree ownership is session-scoped bookkeeping with durable `worktree/v2/...` records (see `docs/orchestrator-improvements-plan.md:108-117`) | Nothing material — the negative is policy-stated; only the host contract changing could alter it | Re-check the V2 API docs for any location/worktree boundary primitive before any future isolation feature; record the finding |
| A4 | Parallelism enforcement | Partially verified | `src/core/config.ts:51` (`max_parallel`, default 4); `src/opencode-v2/plugin.ts:90` (runtime parallelism ceiling injected into orchestrator context); `src/core/prompts.ts:16`; `src/core/policy.ts` (parallel-safe role declarations); `docs/orchestrator-improvements-plan.md:1100,24,81` (no central scheduler in source); **issue #10**: `orchestrator_task_complexity_classify` (advisory, `runtimeEnforced: false`) does not change this | The ceiling exists as config *and* prompt/context text; research role is declared background/parallel-safe by policy; plan inspection found no scheduler or runtime concurrency counter; the issue #10 tools are callable/advisory only | Whether the host or any hook layer actually enforces a concurrency ceiling; whether concurrent parallel writes can race; no repository-side scheduler/semaphore exists to verify | Grep plugin hooks for any scheduler/semaphore; run N parallel delegations and observe host serialization behavior; record observations as measurements |
| A5 | Review enforcement | Partially verified | `src/core/config.ts:52` (`require_review`, default true); `src/core/prompts.ts:16`; `src/core/policy.ts` (mandatory reviewer pass in policy); `docs/orchestrator-improvements-plan.md:1101,85-89` (enforcement appears prompt-based; "no independent runtime gate was found"); **issue #10**: `orchestrator_admission_transition` (`src/core/admission.ts`) branches on an explicit contract `reviewRequired` field, and `orchestrator_task_complexity_classify`/`orchestrator_handoff_validate` are advisory/callable | `require_review` is validated config and is embedded in the generated orchestration policy/prompt; no runtime completion gate exists in inspected source; the issue #10 admission tool branches on `reviewRequired` only when explicitly called and is not a hook, so enforcement status is unchanged | Whether completion can proceed without any reviewer result; whether host hooks could gate; consistency of reviewer-pass requests in practice | Run an orchestration that skips the reviewer pass and check whether completion is blocked; inspect `execute.after`/session hooks for any gate |
| A6 | Storage guarantees | Partially verified | `src/opencode-v2/goal/state.ts:36-44` (`StorageLike`: `get`/`set`/`remove`, optional `scan`); `src/opencode-v2/goal/state.ts:122-140` (`withSessionLock` over a module-level `Map<string, Promise<void>>`); versioned goal/plan/halt keys (`state.ts:115-120`); `docs/orchestrator-improvements-plan.md:97,104,722` (interface lacks transactions/CAS/append-only events/cross-process locking; `withSessionLock` documented as process-local) | The storage abstraction exposes get/set/remove/scan only; lock serialization is explicitly process-local (in-memory map); no transactional, CAS, or cross-process API is declared anywhere in the repository's storage usage | Durability and crash consistency of `ctx.storage`; cross-process behavior; `scan` pagination semantics (`prefix`/`after`/`limit`/`next` contract, `state.ts:40-43`); record survival across server restarts | Restart the shared service and confirm goal records survive; write from two sessions concurrently and inspect serialization; verify `scan` cursor semantics; document findings as measurements |
| A7 | Token measurement / `<5K` heuristic | Unverified | `node_modules/@opencode-ai/plugin/dist/tui/context.d.ts:40` (pinned TUI `Data.session.cost(sessionID)`, `status(sessionID)`); grep of the pinned plugin `dist/*.d.ts` finds no `statistics`/`tokenCount`/`usage` surface in the Promise `SessionDomain`; repository grep finds no consumption of cost/token stats anywhere in `src/`; `<5K` handoff heuristic cited in plan context (`docs/orchestrator-improvements-plan.md:1103`) | Pinned declarations expose session-level cost/status only on the **TUI context**, and the pinned **Promise server `SessionDomain` has no statistics surface**; the repository consumes neither, so no in-repo token accounting exists. The **official HTTP API is a separate surface** and may expose session statistics (e.g. `/api/session/stats`); the absence claim is scoped to the pinned package declarations only and is never stated universally | Whether any stats are reachable server-side from this plugin (an open probe); in what units; whether any token-count API exists; whether real handoffs are actually `<5K` (no measurement has been made) | Attempt to read session cost/stats from the live host API (pinned Promise server vs official HTTP); measure a real handoff size and record the number as a measurement, not a design fact |
| A8 | Redactor completeness | Unverified | `src/opencode-v2/process/redact.ts:3-10` (two layers: known secret patterns + exact caller-known secrets including URI-encoded form); `redact.ts:16-25` (keyed pairs, credential query params, GitHub tokens/PATs, Slack tokens, Bearer patterns); `docs/orchestrator-improvements-plan.md:1104`; `src/core/policy.ts:48-51` (never request/log raw secrets) | The layered design and the enumerated pattern set are in code; redaction is threaded through the process runner and `gh` client (`src/opencode-v2/gh/client.ts:4-12`); policy forbids requesting or logging raw credentials | Coverage of credential formats beyond the enumerated shapes; whether tests exercise every pattern (current tests cover known patterns and supplied exact secrets only); behavior on unexpected/novel formats | Add a fixture sweep with additional credential formats (cloud provider keys, JWTs, URI-encoded exact secrets); run the suite against it; review the `gh` client redaction path — record pass/fail per fixture |
| A9 | Capability authority | Partially verified | `src/cli/doctor.ts:149-158` (doctor cannot prove host MCP config, remote reachability, live tool capability, auth, or permission grants; server-side probe authoritative); `src/cli/doctor.ts:164-172,173-248` (advisory runtime checks, warn-or-pass only, `gh` output suppressed, exit-code-only auth check); `src/cli/doctor.ts:240-245` (runtime-authority: CLI probes local PATH/directory only); `src/core/policy.ts:42-45` (preflight: inspect the actual host catalog; never infer availability); **issue #10**: `src/opencode-v2/orchestration/evidence.ts` (`EvidenceRecord` schema + `assessEvidence` + `liveEvidence`/`mutationEvidence` factories) and typed per-invocation evidence on every successful GH/worktree tool result (`src/opencode-v2/gh/tools.ts`, `src/opencode-v2/worktree/tools.ts`) | The authority split is designed and coded: CLI `doctor` is local/advisory and can never fail the report or print `gh` output; server-side `orchestrator_github_capabilities` and worktree status tools are authoritative for live sessions **for the tested fields only** (their negative/degraded results are equally live evidence, scoped to those fields); the V3 evidence vocabulary is now a typed runtime record with a fail-closed `assessEvidence` gate, attached as metadata to tool results | Live behavior of the server-side probe on a real host; whether the probe covers every capability orchestration later depends on; merged-config and permission visibility limits; whether any evidence records should ever be persisted (currently none are) | Run `bun run src/cli/index.ts doctor` on a live host (read-only) and compare against the server-side capability probe result; record both in this ledger |
| A10 | Source reliability | Unverified | `docs/orchestrator-improvements-plan.md:1106-1107` (vendor articles, community repositories, secondary benchmark claims, deprecated packages, closed PRs); `docs/orchestrator-improvements-plan.md:15-16` (web sources "directional evidence, not automatically authoritative"); `docs/orchestrator-improvements-plan.md:1127` (research-only draft, no verification commands run) | The plan itself labels all external evidence directional; issue/PR references (e.g., #20849) are proposals, not contracts; no phase-1 run has validated them | Which external claims survive independent validation against pinned docs/API; which sources are deprecated, closed, or stale | Re-validate each cited external source against the pinned declarations and live docs; drop deprecated/closed sources; annotate remaining claims with their provenance |
| A11 | GitHub durability | Verified (negative claim) | `src/opencode-v2/gh/tools.ts:20-40` (docstring: "`storage` and `location` are accepted for the stage contract but not yet used; durable GitHub records are a later stage"); `src/opencode-v2/gh/client.ts:7-19` (all access via `gh` CLI, fixed endpoint templates, validated typed evidence only); **issue #10**: per-invocation `evidence` records (`src/opencode-v2/orchestration/evidence.ts`) are returned to the model as payload metadata and are never written to storage (`src/opencode-v2/gh/tools.ts`, `src/opencode-v2/worktree/tools.ts`); `docs/orchestrator-improvements-plan.md:1107,126` | The plugin does **not** persist GitHub operation records or evidence receipts: tool results are validated in-memory evidence (`id`/`number`/`html_url` + typed `evidence` metadata) returned to the model, and `storage`/`location` are accepted but unused. This verifies the negative claim only — it is not evidence of any positive durable-support capability | The design of the later-stage durable record storage (key scheme, retention, crash consistency) | Verify no `gh`-related or evidence-ledger record keys exist in storage; when the later stage lands, verify durable records exist under a defined key and re-open A11 |
| A12 | Isolation/security separation | Partially verified | `src/core/policy.ts:48-51` (secret-handling rules), `:53-57` (prompt rules advisory, no filesystem isolation), `:59-62` (per-session worktree ownership only); `src/cli/doctor.ts:149-152`; worktree implementation `src/opencode-v2/worktree/git.ts` (shell off, fixed subcommand allowlist, bounded output — see `docs/orchestrator-improvements-plan.md:113`); `src/opencode-v2/gh/tools.ts:26-28` (shared `orchestrator_gh` permission action + runtime agent check); `src/core/policy.ts:60-61` (worktree records durable, session-scoped) | The code separates the properties: permission action, runtime agent check, redaction layer, prompt guidance, and per-session worktree bookkeeping are distinct mechanisms; prompt rules are explicitly advisory for filesystem isolation | OS-level containment (none implemented); behavior against a hostile or compromised session; whether permission visibility matches actual enforcement on a live host | Attempt cross-session access to another session's managed worktree; verify permission enforcement and agent-check behavior on a live host |

## Evidence index (paths verified to exist)

- `docs/orchestrator-improvements-plan.md:1095-1108` — assumptions source of record (also cited: `:14-16`, `:24`, `:81`, `:85-89`, `:97`, `:104`, `:108-117`, `:126`, `:722`, `:1100-1108`, `:1127`)
- `src/core/policy.ts:48-62` — secret-handling, worktree-boundary, managed-worktree guidance; `:82-89` — `STRUCTURED_HANDOFF_GUIDANCE`
- `src/opencode-v2/goal/state.ts:36-44` — `StorageLike` interface; `:122-140` — `withSessionLock` (process-local map); `:115-120` — versioned key scheme
- `src/opencode-v2/gh/tools.ts` — GitHub tools docstring (durable records are a later stage) and per-invocation `evidence` attachment (issue #10)
- `src/opencode-v2/gh/client.ts:7-19` — `gh` CLI-only client, fixed endpoint templates, validated evidence
- `src/opencode-v2/process/redact.ts:3-10` — redaction design; `:16-25` — pattern set
- `src/cli/doctor.ts:149-158,164-172,173-248,240-245` — advisory runtime checks and capability authority
- `src/opencode-v2/worktree/{git,events,tools,state}.ts` — managed worktree implementation (tools attach `EVIDENCE_LIVE` per successful result)
- `src/opencode-v2/orchestration/evidence.ts` — typed `EvidenceRecord` schema, `assessEvidence`, `liveEvidence`/`mutationEvidence` factories (issue #10)
- `src/core/contracts.ts` — D2 strict Zod mirror: `parseD2Handoff`, `validateD2Handoff`, `validateD2Semantics`, `renderD2Handoff` (issue #10)
- `src/core/admission.ts` — stateless eight-state admission machine `transitionAdmission` (issue #10)
- `src/core/d4.ts` — D4 classifier `classifyTaskComplexity` (issue #10)
- `src/opencode-v2/orchestration/{validation,tools}.ts` — `validateHandoff` and the three orchestrator-only validation tools (issue #10)
- `test/unit/{contracts,d4,admission,evidence,orchestration-tools}.test.ts` — issue #10 module tests, part of the full parent-verified suite (456 pass / 1 skip / 0 fail)
- `src/core/config.ts:51-52` — `max_parallel` / `require_review` defaults
- `src/opencode-v2/plugin.ts:90,96` — parallelism ceiling and no-atomic-isolation prompt text; `:75-80` — orchestration tool wiring; `:97` — validation-tools context text
- `src/core/prompts.ts:16` — policy embedding
- `package.json:37,45` — pinned `@opencode-ai/plugin@0.0.0-beta-18684`, `@opencode-ai/sdk@0.0.0-dev-18683`
- `node_modules/@opencode-ai/plugin/dist/tui/context.d.ts:40` — pinned TUI context `Data.session` (`cost`, `status`); no statistics surface in the pinned Promise `SessionDomain` (grep, no matches)
- `AGENTS.md` — "OpenCode V2 Contract" (beta/experimental; README boundary stale)

## Verification backlog

### Phase 1 — current contract (next steps against the pinned host, read-only unless noted)

> These original backlog items remain **unexecuted** for the issue #8 ledger. Issue #10 established
> new facts through source inspection and the parent-verified repository runs (see the dated note
> at the top of this file); it did **not** run the backlog probes, and the shared-service
> live-reload smoke remains **inconclusive** (the `/api/plugin` probe did not list this plugin and
> the service was not restarted). The final independent aggregate review passed with no blocking
> or major findings.

- **A1** — diff pinned declarations vs live `https://opencode.ai/v2/openapi.json`; record drift.
- **A2** — probe live host API for background/child-session/prompt endpoints; ignore proposal issue text as contract.
- **A3** — re-check V2 docs for worktree/location-boundary primitives (status expected to remain `Not supported`).
- **A4** — grep hooks for scheduler/semaphore; observe host serialization under N parallel delegations.
- **A5** — run orchestration without a reviewer pass; check whether completion is gated.
- **A6** — restart shared service and confirm goal records survive; two-session concurrent write test; `scan` cursor verification.
- **A7** — probe whether the pinned Promise server can read any stats (it exposes no statistics surface) vs the official HTTP API (`/api/session/stats` candidate); measure one real handoff size (record as measurement).
- **A8** — fixture sweep of additional credential formats (cloud keys, JWTs, URI-encoded exact secrets); run `bun test` against it.
- **A9** — `bun run src/cli/index.ts doctor` already ran under issue #10 and passed static options/agents plus the local advisory git/gh/auth/repo/worktree checks (expected workflow/MCP/runtime-authority warnings); the remaining probe is comparing that local result against the server-side capability probe (which requires a live session and remains a backlog step).
- **A10** — re-validate each external source against pinned docs; drop deprecated/closed sources.
- **A11** — confirm no `gh`-related or evidence-ledger record keys exist in storage (negative claim re-check); re-open when the durable-record stage lands.
- **A12** — cross-session worktree access attempt; permission/agent-check verification on live host.

### Future implementation (post-phase-1 changes; listed here per repository requirements)

```sh
bun run typecheck && bun test && bun run build
```

Repository-specific extras when implementing:

```sh
bun run dev:setup
bun run dev:v2
bun run dev:v2:dist
bun run src/cli/index.ts doctor
opencode2 api get /api/plugin   # run from the repo cwd; ?directory= is ignored on the pinned beta
```

**Explicit caveat:** passing `bun run typecheck && bun test && bun run build`, or any of the extras above, is **not** proof of API stability (A1), atomic child isolation (A3), or redactor completeness (A8). Those questions are answered only by the contract-diff and fixture-sweep steps in the Phase 1 backlog, not by compilation or bundling. Per `docs/orchestrator-improvements-plan.md:1127`, no verification commands were run for this research-only draft; this ledger does not claim otherwise.
