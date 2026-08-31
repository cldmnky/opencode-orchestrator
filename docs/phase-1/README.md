# Phase 1 — Coordinator-Owned Index (issue #8 design + issue #10 runtime)

**Date:** 2026-08-30
**Issue:** [#8 — Phase 1 contracts and design artifacts](https://github.com/cldmnky/opencode-orchestrator/issues/8) (historical design) · [#10 — Phase 1 runtime contracts](https://github.com/cldmnky/opencode-orchestrator/issues/10) (callable implementation)
**Branches:** `feat/8-orchestration-phase1-contracts` (issue #8, merged) · `feat/10-phase1-runtime-contracts` (issue #10, current)
**Status:** The ten design artifacts from issue #8 are complete. Issue #10 added **callable runtime implementations** of the phase-1 contracts (three orchestrator-only tools plus public pure APIs and typed evidence metadata). `feat/s3-v1-controls` added the **opt-in S3 observability/budget controls and V1 bounded maker-checker review** ([`./s3-v1-controls.md`](./s3-v1-controls.md)) with default-backward-compatible behavior. The split is documented throughout: **implemented callable surfaces** below are real and test-covered, while **enforcement, telemetry, isolation, and persistence** remain unimplemented (the S3/V1 addition is opt-in metadata-only tracing/budget evaluation and bounded explicit review rounds — still no automatic completion gate, no in-flight cancellation, and no self-declared gate). Parent-verified outcomes (see [Verification](#6-validation-commands)):

- `bun run typecheck` **passed**; full `bun test` on `feat/s3-v1-controls` is **524 pass / 1 skip / 0 fail** (525 tests across 20 files; the single skip is the pre-existing cross-volume platform case; the issue #10-era run was 456 pass / 1 skip / 0 fail across 18 files); `bun run build` **passed** and emitted all five bundles (`dist/index.js`, `dist/tui.js`, `dist/commands.js`, `dist/installer.js`, `dist/cli/index.js`).
- `npm pack` of the source build into the approved temp area contained `package.json`, the README, and all five bundles; importing the unpacked `dist/index.js` exposed and executed `classifyTaskComplexity` and exported `D2_HANDOFF_SCHEMA`, `transitionAdmission`, `evidenceSchema`, and `assessEvidence`.
- Embedded V2 host tests (part of the full suite) **passed**: source, config-relative source, and package-like local dist loading. `bun run src/cli/index.ts doctor` **passed** static options/agents and the local advisory git/gh/auth/repo/worktree checks, with the expected workflow/MCP/runtime-authority warnings.
- **The shared-service live-reload smoke is inconclusive, not a pass:** `opencode2 api get /api/plugin` from the repo `cwd` did **not** list `opencode-orchestrator` (it listed built-ins and an unrelated failed global nono-sandbox plugin), and the shared service was **not** restarted because restarting/reopening it could interrupt the current session. A shared-service plugin load is therefore unverified.
- The **final independent aggregate review passed** with no blocking or major findings; the only remaining live-host limitation is the inconclusive shared-service discovery probe above.

This README is the coordinator-owned entry point for the Phase 1 artifacts. It maps every artifact,
prescribes the reading order, records what is established by source inspection and by the issue #10
runtime tests versus what remains unverified, and defines what "done" means for this phase. It does
**not** claim a shared-service live plugin load (the probe was inconclusive and the service was not
restarted). The independent aggregate source/test/docs review passed.

---

## 1. Scope statement (read this first)

**This directory is the design source for the phase-1 contracts AND the record of their issue #10 runtime implementation.** Distinguish the two layers carefully:

**Implemented callable surfaces (issue #10) — present, test-covered, public:**

- **Three always-registered orchestrator-only tools** under the `orchestrator` namespace, sharing the `orchestrator_validation` permission action: `orchestrator_task_complexity_classify` (D4), `orchestrator_handoff_validate` (D2 + V2 validation), and `orchestrator_admission_transition` (V2 vocabulary). Workers are denied them by the installer/agent transform, and every execute handler rejects non-orchestrator agents regardless of visibility.
- **Public pure APIs** re-exported from `src/index.ts`: `src/core/d4.ts` (`classifyTaskComplexity`), `src/core/contracts.ts` (strict D2 Zod mirror: `parseD2Handoff`, `validateD2Handoff`, `validateD2Semantics`, `renderD2Handoff`, safety helpers), `src/core/admission.ts` (`transitionAdmission`), and `src/opencode-v2/orchestration/evidence.ts` (typed `EvidenceRecord` + `assessEvidence` + `liveEvidence`/`mutationEvidence` factories).
- **Typed per-invocation evidence metadata** on every successful GitHub/worktree tool result (`EVIDENCE_LIVE`; `EVIDENCE_MUTATION` with an https proof for issue/PR creates).
- **Prompt/tool integration:** `src/core/policy.ts` `STRUCTURED_HANDOFF_GUIDANCE` asks workers for the version-1 JSON envelope alongside the unchanged five-field prose and tells the parent to call `orchestrator_handoff_validate`; the runtime contract tools are wired in `src/opencode-v2/plugin.ts`.

**Still not implemented (unchanged from issue #8) — do not read the above as these:**

- **No runtime enforcement:** `max_parallel`/`require_review` remain validated config consumed as prompt text; there is no scheduler, semaphore, or completion gate. The admission states are a stateless vocabulary, not a state store. D4 remains advisory (`runtimeEnforced: false`); the D2 validator is callable, not automatic. The S3/V1 addition gates **only plugin-owned next dispatches** when explicitly configured (`stop-between-steps` budget, bounded review breaker); it never calls `session.interrupt`, never cancels in-flight calls, and never acts as a completion gate.
- **No collected telemetry:** there are no measured results anywhere in this directory. The D4 corpus labels are hypotheses, the evaluation template's result fields are `null`/`"not-collected"`, and no token/latency/quality number is a measurement. S3 `trace` records are opt-in bounded metadata summaries (never persisted prompts/transcripts/payloads); their counts are records of observed events, not measured evaluation metrics.
- **No atomic child isolation:** prompt-level disjoint write scopes and managed `worktree/v2` bookkeeping are **not** filesystem or process isolation.
- **No exactly-once claim** and **no persistence of evidence receipts:** tool `evidence` metadata is returned to the model and not stored; there is no durable receipt/evidence ledger. S3/V1 storage is one bounded current record per session under process-local locking only (no CAS/transactions/cross-process guarantee).
- **No automatic child-output hook:** no plugin hook intercepts worker output; the D2 validator runs only when the orchestrator calls it.

The parent plan's constraints apply unchanged: no GitHub/worktree/merge/issue/PR operations by this
docs phase, no web-source claims upgraded to facts, and web research remains directional evidence
([`../orchestrator-improvements-plan.md`](../orchestrator-improvements-plan.md), D4 section).

---

## 2. Artifact map

All ten sibling artifacts below live in this directory. The design artifacts were produced by issue
#8; the runtime mirrors were added by issue #10. Statuses below reflect both layers.

| Artifact | Purpose | Status |
|---|---|---|
| [`d4-complexity-gate.md`](./d4-complexity-gate.md) | **D4 — Start-Simple Complexity Gate.** Eight-dimension decision table with five outcomes and a precedence order. | Implemented as a **callable advisory classifier** (`orchestrator_task_complexity_classify` → `classifyTaskComplexity` in `src/core/d4.ts`); **not hard-enforced** (`runtimeEnforced: false`). |
| [`d4-gate-table.json`](./d4-gate-table.json) | Machine-readable D4 decision table. | Design table complete; **mirrored verbatim by `src/core/d4.ts`**; non-breaking runtime metadata added; `runtimeEnforced: false` preserved. |
| [`d4-task-corpus.json`](./d4-task-corpus.json) | **12 synthetic, unexecuted** task cases. | **Frozen and unmeasured** (unchanged). Conformance-verified against the runtime classifier: 11 cases match their `referenceRecommendation`; `d4-case-006` is the documented intentional mismatch (classifier returns `orchestrate-serialized` vs the `orchestrate-candidate` adjudication hypothesis). |
| [`d4-evaluation-template.json`](./d4-evaluation-template.json) | Frozen evaluation protocol with all result fields `null` / `"not-collected"`. | **Frozen and unmeasured** (unchanged); no results, no telemetry. |
| [`v3-capability-matrix.md`](./v3-capability-matrix.md) | **V3 — authority matrix** and six-marker evidence vocabulary. | Design matrix complete; the evidence vocabulary is now **implemented** (`src/opencode-v2/orchestration/evidence.ts` with `evidenceSchema`/`assessEvidence`/factories) and **attached as typed metadata** to GH/worktree tool results. Doctor/MCP/unknown/session-stats boundaries unchanged. |
| [`d2-handoff.md`](./d2-handoff.md) | **D2 — versioned structured handoff.** Draft mapping + compatibility notes. | Implemented as a **strict runtime Zod mirror + prompt/tool integration** (`src/core/contracts.ts`, `orchestrator_handoff_validate`); one-way structured→prose rendering; schema JSON remains a contract/reference, not a dynamically loaded parser. |
| [`d2-handoff.schema.json`](./d2-handoff.schema.json) | The D2 envelope JSON Schema (13 required fields, strict). | Design schema complete; **mirrored by the runtime Zod contract** (`src/core/contracts.ts`); the JSON file is a contract/reference document, not loaded at runtime. |
| [`d2-handoff.example.json`](./d2-handoff.example.json) | Illustrative validating envelope (`taskId: issue-8-d2-handoff-schema-draft`). | Historical issue #8 example, kept schema-valid; **passes the current runtime mirror** (`parseD2Handoff`/`D2_HANDOFF_SCHEMA`); time-scoped facts updated; issue #10 completed its follow-up. |
| [`v2-validation-checklist.md`](./v2-validation-checklist.md) | **V2 — Two-Level Validation Checklist and Admission-State Vocabulary.** C1–C7 / O1–O9 / J1–J5, eight states, evidence admission rules, worked example. | Implemented as a **stateless vocabulary + callable validator** (`src/core/admission.ts`, `validateHandoff` in `src/opencode-v2/orchestration/validation.ts`); enforcement, telemetry, and persistence remain unimplemented; the worked example stays illustrative (its envelope never traversed a real child hook). |
| [`assumptions.md`](./assumptions.md) | **A1–A12 assumption and verification ledger**, evidence index, backlog. | Ledger complete with a dated issue #10 implementation note; A11 stays **Verified (negative)**; A4/A5 stay **Partially verified**; no backlog command was executed for the original ledger. `feat/s3-v1-controls` appended a dated note and A13/A14 rows (statuses below). |
| [`s3-v1-controls.md`](./s3-v1-controls.md) | **S3 — observability/budget controls + V1 — bounded maker-checker review** (opt-in). | **Implemented** on `feat/s3-v1-controls`: strict defaulted config, metadata-only trace summaries (snapshots, unknown≠zero), deterministic within/exceeded/unknown budget evaluation, fail-closed token/cost only for stop-between-steps, separate version-1 review schema with fixed transitions and a terminal breaker, one bounded record per session, conditional orchestrator-only tools, and exact limitations. No automatic completion gate, no in-flight cancellation, no D2/admission changes, no tiering, no migrations. |

---

## 3. Reading order

1. **Boundaries and assumptions first** — `assumptions.md` (the status vocabulary and the A1–A12
   ledger) plus this README's §1 scope statement. They frame the split between implemented callable
   surfaces and unimplemented enforcement/telemetry/isolation/persistence.
2. **D4** — `d4-complexity-gate.md` (then `d4-gate-table.json`, `d4-task-corpus.json`,
   `d4-evaluation-template.json` for the machine shapes).
3. **D2** — `d2-handoff.md` (then `d2-handoff.schema.json`, `d2-handoff.example.json`).
4. **V3** — `v3-capability-matrix.md` (authority model and evidence vocabulary the V2 checklist is
   keyed to; now implemented as typed tool-result evidence).
5. **V2** — `v2-validation-checklist.md` (consumes D2 structure and V3 evidence rules; now backed by
   the callable validator and stateless admission machine).
6. **Machine assets last** — re-read the two JSON trios (D4 table/corpus/template, D2
   schema/example) against the markdown that explains them.
7. **S3/V1 controls last** — `s3-v1-controls.md` (the opt-in bounded implementation added on
   `feat/s3-v1-controls`), cross-linked from §4.

---

## 4. Established facts vs assumptions

Facts below are established by **read-only source/declaration inspection** in this repository and by
the **parent-verified issue #10 runs** (see §6: `bun run typecheck`, the full 456-pass/0-fail suite,
`bun run build`, `npm pack` + dist import, `doctor`, and the embedded V2 host tests).
Each cites its evidence. Assumptions
cite the ledger row that still needs host/contract probing. This phase collected **no telemetry**, so
nothing below is a measurement.

### Runtime contract tools (issue #10 — implemented, callable, not automatic)

- Three tools are registered unconditionally (no feature-enable gate) under the `orchestrator`
  namespace with the shared `orchestrator_validation` permission action
  (`src/core/permissions.ts:35-46`): `task_complexity_classify`, `handoff_validate`, and
  `admission_transition` (`src/opencode-v2/orchestration/tools.ts`). Every execute handler calls
  `requireOrchestrator(tool.agent, options)` and rejects any non-orchestrator agent
  (`src/opencode-v2/orchestration/tools.ts:111-115`). → assumption **[A4]/[A5] Partially verified**
  **unchanged**: the tools are callable/advisory and do not enforce `max_parallel`/`require_review`.
- `task_complexity_classify` mirrors `d4-gate-table.json` version 1 exactly and accepts **only the
  eight structured dimension facts** (each nullable when unknown); missing/null facts force
  `collect-facts`; invalid structured input throws/rejects (`src/core/d4.ts`). It does not infer
  facts from prose. Corpus conformance: 11/12 cases match; `d4-case-006` is the intentional
  mismatch (classifier → `orchestrate-serialized` vs reference `orchestrate-candidate`).
- `handoff_validate` (worker level) runs C1–C7; orchestrator level re-runs them and adds live VCS
  comparison, local evidence/artifact existence, foreign-file blocking, and authority checks
  (`src/opencode-v2/orchestration/validation.ts`). It never runs a shell. **Required commands at
  orchestrator level always produce `blocked-unknown`** because the pinned V2 API cannot re-run them
  (`checkRerun`); URL evidence refs likewise always block (`checkAuthority`) because typed
  `EvidenceRecord` input is not accepted in this version; D2 `reviewState` is never treated as
  reviewer proof. It may return `review-pending`/`admitted` only when every implemented
  deterministic check passes and no unobservable requirement remains.
- `admission_transition` is a stateless eight-state machine with no storage
  (`src/core/admission.ts`); `blocked-unknown` never auto-advances (only `new-receipt` with
  `humanDecision: true`); `reviewState` is self-declared (`validateD2Semantics` warns accordingly).
- Unit tests: `test/unit/contracts.test.ts`, `test/unit/d4.test.ts`, `test/unit/admission.test.ts`,
  `test/unit/evidence.test.ts`, `test/unit/orchestration-tools.test.ts` (all part of the full
  456-pass/0-fail suite). The shared-service live-reload smoke is **inconclusive** (see §6); the
  final independent aggregate review passed with no blocking or major findings.

### Prompt-only configuration (no runtime enforcement)

- `max_parallel` is validated as 1..8 with **default 4** (`src/core/config.ts:51`) and is consumed
  **only** as prompt/system text (`Runtime parallelism ceiling`, `src/opencode-v2/plugin.ts:90`);
  no scheduler or semaphore exists anywhere in `src/`. → assumption **[A4] Partially verified**.
- `require_review` is validated config with **default `true`** (`src/core/config.ts:52`) and is
  consumed only as policy/prompt text (`src/core/prompts.ts:16`, `src/core/policy.ts:110`); there
  is **no completion gate** — `admission_transition` uses an explicit contract `reviewRequired`
  (a task-class/config property) but no hook consumes a transition automatically. → assumption
  **[A5] Partially verified**.
- **Aggregate review obligation:** this issue's completion still requires an aggregate reviewer pass
  by repository policy (`src/core/policy.ts:110`) — implemented callable surfaces do not waive it.
  Full suite/build/pack results are recorded in §6; the final independent aggregate review passed.

### Authority split (doctor vs live server) and typed evidence

- `doctor` is **local and advisory only**: its runtime checks are warn-or-pass, never fail the
  report, never print `gh` output (`src/cli/doctor.ts`), and cannot prove merged MCP config, remote
  reachability, live capability, auth, or permission grants. The server-side
  `orchestrator_github_capabilities` probe is authoritative **only for the gh fields it actually
  tests**; its negative results are live evidence (`EVIDENCE_LIVE`,
  `authoritative-for-tested-fields`) scoped to those tested fields only. → assumption
  **[A9] Partially verified**; the typed-evidence half of the V3 vocabulary is now implemented
  (`src/opencode-v2/orchestration/evidence.ts`) and attached to every successful GH/worktree result
  (`src/opencode-v2/gh/tools.ts`, `src/opencode-v2/worktree/tools.ts`). Evidence is metadata only
  and is never persisted.

### Storage surface and exactly-once

- The storage surface is `get`/`set`/`remove`/`scan` plus a **process-local, in-memory**
  `withSessionLock` map — no transactions, no compare-and-set, no cross-process primitives
  (`src/opencode-v2/goal/state.ts`). Durability and crash consistency are unverified. Tool
  `evidence` records are not stored anywhere. **Exactly-once is never claimed.** → assumption
  **[A6] Partially verified**, **[A11] Verified (negative)** — still no durable GitHub/evidence
  record ledger.

### S3/V1 controls (opt-in, bounded, metadata only — `feat/s3-v1-controls`)

- The three config blocks are strict with defaults that preserve prior behavior: `trace`
  `off|memory|snapshot` (default `off`), `budget` `advisory|stop-between-steps` (default
  `advisory`) with nullable finite `max_steps`/`max_tokens`/`max_cost_usd`/`max_wall_clock_ms`/
  `max_retries`, and `review` `prompt|bounded` (default `prompt`, `max_rounds` 1..8 default 2)
  (`src/core/config.ts`). Unknown keys, bad modes, negative/NaN/Infinity limits, and out-of-range
  rounds are rejected.
- The observability runtime (`src/opencode-v2/observability/runtime.ts`) activates only when a
  mode is enabled and uses **only** pinned tool `execute.before/after` hooks and typed
  `event.subscribe` events; it never builds a separate HTTP client (the pinned Promise
  `SessionDomain` has no `session.stats`). Usage aggregate events are snapshots that **replace**
  stored values (never add), so no double counting occurs; missing coverage is **unknown, never
  zero**. `session.usage.recorded` (incremental) events are deliberately ignored. Event/hook
  failures are caught and never break orchestration; cleanup awaits event consumption and
  disposes hook registrations.
- The bounded trace/review records are metadata only: no prompts, transcripts, tool
  input/output, shell output, result/error text, credentials, or call IDs (call IDs live only
  in the in-memory pending map). One current record per session under
  `trace/v1/<project>/<session>` and `review/v1/<project>/<session>`, written through
  `withSessionLock` with **no CAS/cross-process guarantee**.
- Budget evaluation is deterministic `within|exceeded|unknown` (`evaluateBudget`,
  `src/opencode-v2/observability/budget.ts`); exact-boundary is `within`; unknown token/cost
  coverage fails closed **only** for `stop-between-steps` checks (reason recorded); `advisory`
  never blocks. `stop-between-steps` gates **only** goal auto-continuation (before reservation
  and before delivery) and slash-command prompt delivery; `session.interrupt` is never called
  and nothing is cancelled in flight.
- `review_transition`/`transitionReviewV1` is a **separate version-1 review schema** with fixed
  enums/reasons only; it does not change D2 `reviewState` (`src/core/contracts.ts`) or the
  admission machine (`src/core/admission.ts`). Deterministic transitions: absent+start →
  pending r1; pending+approve(all checks true) → approved (terminal); pending+request-changes →
  changes-requested while rounds remain, else tripped (terminal, requires human); pending+block
  → blocked (terminal, requires human); changes-requested+start → next round. Approved/blocked/
  tripped are terminal for the current task; tripped/blocked open the **circuit breaker** for
  goal auto-continuation until a terminal-replacing start.
- Tools (`observability_get`, `review_get`, `review_transition`) are registered **only when the
  corresponding mode is enabled** under the `orchestrator` namespace with the shared
  `orchestrator_observability` permission action; the default tool contract/count is unchanged.
  Outputs carry explicit limitations (no CAS, unprovable caller identity, one bounded record per
  session). They are callable/advisory — no automatic gate.
- Tests: `test/unit/observability.test.ts`, `test/unit/review.test.ts` plus focused extensions
  in `test/unit/{core,continuation,runtime,session-state,installer,orchestration-tools}.test.ts`
  and `test/contract/plugin.test.ts`. Full suite/typecheck/build pass on the branch (see §6).

### Worktree boundary

- Managed `worktree/v2` records are **current-session bookkeeping**, not isolation; prompt-level
  disjoint write scopes do not equal filesystem isolation (`src/core/policy.ts:53-62`,
  `src/opencode-v2/plugin.ts:96`). Worktree evidence (`EVIDENCE_LIVE`) describes live local
  operations and never proves child isolation. → assumptions **[A3] Not supported**, **[A12]
  Partially verified**.

### API beta and package pins — session statistics nuance

- The repository is pinned to `@opencode-ai/plugin@0.0.0-beta-18684` and
  `@opencode-ai/sdk@0.0.0-dev-18683` (`package.json:37,45`); the V2 API is beta/experimental and
  `AGENTS.md` treats `https://opencode.ai/v2/openapi.json` as the HTTP contract while flagging the
  README's "V2 Boundary" as stale. → assumption **[A1] Unverified**.
- **Session statistics, scoped carefully:** a grep of the pinned plugin `dist/*.d.ts` found **no
  `statistics` / `tokenCount` / `usage` surface in the pinned Promise `SessionDomain`**
  (`v3-capability-matrix.md`, row "Documented V2 session-statistics surface"), and the repository
  never consumes token stats. The official HTTP API **may** expose session statistics (e.g.
  `/api/session/stats`); the absence claim is therefore scoped to the *pinned package
  declarations*, never stated universally, and whether any stats are reachable server-side from
  this plugin remains an open probe. → assumption **[A7] Unverified** (linked to **[A2] Unverified**).

---

## 5. Definition of done

**Artifact completion (done in issues #8 + #10):**

| Item | Definition of done | Status |
|---|---|---|
| D4 | Decision table + synthetic unexecuted corpus + frozen evaluation template; advisory only, `runtimeEnforced: false`; implemented as a callable classifier with no enforcement; corpus conformance verified (case006 intentional mismatch); corpus/template stay unmeasured with no results claimed. | **Complete (design + callable classifier)** — no measured results |
| V3 | Capability authority matrix with explicit unknowns; evidence vocabulary implemented as a typed runtime schema + `assessEvidence` + factories and attached as metadata to GH/worktree tool results; doctor/MCP/unknown/session-stats boundaries preserved. | **Complete (design + runtime vocabulary)** |
| D2 | Strict Draft 2020-12 schema + validating example; five-field prose mapping; implemented as a strict runtime Zod mirror + prompt/tool integration `orchestrator_handoff_validate`; one-way rendering; callable, no automatic hook. | **Complete (draft + runtime mirror)** — example remains an issue #8 artifact honored as such |
| V2 | Three-level checklist (C1–C7, O1–O9, J1–J5), eight-state admission vocabulary, evidence admission rules; implemented as a stateless vocabulary (`transitionAdmission`) + callable fail-closed validator; enforcement/telemetry/persistence not implemented; worked example stays illustrative. | **Complete (proposal + callable validator)** |
| A1–A12 | Every assumption recorded with a status, exact evidence, remaining unknown, and next verification step; A11 **Verified** (negative); the rest Partially verified / Unverified / Not supported; dated issue #10 implementation note appended without falsifying the historical read-only ledger. **A13/A14 added by `feat/s3-v1-controls`** (see assumptions.md). | **Ledger complete** — **no backlog command executed** |
| S3/V1 | Opt-in strict controls: metadata-only bounded trace summaries (snapshots, unknown≠zero), deterministic budget evaluation with fail-closed token/cost only for stop-between-steps, separate V1 review schema with fixed transitions/terminal breaker, one bounded record per session, conditional orchestrator-only tools, exact limitations; default behavior unchanged. | **Complete (implemented + tests)** on `feat/s3-v1-controls` — still no automatic completion gate, no in-flight cancellation, no D2/admission changes |
| Repository checks | `bun run typecheck` **passed**; full `bun test` **524 pass / 1 skip / 0 fail** (525 tests across 20 files on `feat/s3-v1-controls`; the skip is the pre-existing cross-volume platform case; issue #10-era run was 456 pass / 1 skip / 0 fail across 18 files); `bun run build` **passed** all five bundles; `npm pack` + unpacked `dist/index.js` import **passed** (issue #10) and the `dist/index.js` export sweep for the S3/V1 pure APIs passed; final independent aggregate review passed with no blocking or major findings (issue #10). | **Complete (verified)** — shared-service live-reload smoke remains **inconclusive** (not a pass) |

Whether all ten artifacts satisfy the parent plan's Phase 1 exit evidence
(`docs/orchestrator-improvements-plan.md:1022-1039`) is a **parent-side review decision**: the
handoff schema (D2), FP/FN protocol (D4 template), and capability matrix with unknowns (V3) are
produced, and the plan's "baseline metrics" item is explicitly **not** produced because this phase
collects no telemetry. This README records the parent-verified checks (§6) and independent aggregate
review as **passed**, while holding the **shared-service live-reload smoke as inconclusive** (the
probe did not list the plugin and the service was not restarted).

---

## 6. Validation commands

These are the checks that verify this directory as of this README:

```sh
# 1. All JSON artifacts parse (schema, example, gate table, corpus, evaluation template)
for f in docs/phase-1/*.json; do bun -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || exit 1; done
```

**Runtime mirror verification (re-run by issue #10):**

```sh
# 2. D2 example passes the runtime Zod mirror (strict, 13 fields, unknown-data rejection implied elsewhere)
bun -e 'const {parseD2Handoff,D2_HANDOFF_SCHEMA}=await import("./src/core/contracts.ts");const e=JSON.parse(require("fs").readFileSync("docs/phase-1/d2-handoff.example.json","utf8"));const a=parseD2Handoff(e);if(!a.ok){console.error(JSON.stringify(a.issues));process.exit(1)}if(!D2_HANDOFF_SCHEMA.safeParse(e).success)process.exit(1);console.log("ok")'

# 3. D4 corpus classification: 11/12 match referenceRecommendation; case006 is the intentional mismatch
bun -e 'const {classifyTaskComplexity}=await import("./src/core/d4.ts");const c=JSON.parse(require("fs").readFileSync("docs/phase-1/d4-task-corpus.json","utf8"));const n=c.cases.filter(x=>x.caseId!=="d4-case-006").filter(x=>classifyTaskComplexity(x.features).recommendation!==x.referenceRecommendation);if(n.length)process.exit(1);if(classifyTaskComplexity(c.cases.find(x=>x.caseId==="d4-case-006").features).recommendation!=="orchestrate-serialized")process.exit(1);console.log("ok")'
```

**D2 verifier history (honest, labeled):** the issue #8 draft's example validation used an
*ephemeral scratch validator kept outside the repo* implementing the keyword subset the schema uses
(`type`, `const`, `enum`, `required`, `additionalProperties`, `properties`, `items`, `minItems`,
`minLength`, `maxLength`, `pattern`, `$ref`, `allOf`, `if`/`then`), plus an independent Zod model
and a keyword-coverage check against the Draft 2020-12 metaschema. That was **not** a full Draft
2020-12 implementation (no `format`, `unevaluatedProperties`, `prefixItems`, `$dynamicRef`, …), and
full metaschema compliance was asserted by keyword coverage rather than by running the official
metaschema. Since issue #10, the example also passes the **maintained in-repo runtime mirror**
(`src/core/contracts.ts` — strict Zod, deterministic issue paths, validated by
`test/unit/contracts.test.ts`), which supersedes the scratch checker for structural validation; the
JSON schema document itself is a contract/reference, not loaded at runtime.

```sh
# 4. Local markdown link / path checks — the ten sibling links in §2 and the root links in §7
#    resolve to existing files (re-checkable with a link scraper)

# 5. Whitespace check on this file (and the directory while at it)
git diff --check -- docs/phase-1/README.md
```

**Repository checks (parent-verified, all as recorded):**

```sh
bun run typecheck                                          # passed (incl. feat/s3-v1-controls)
bun test                                                   # 524 pass / 1 skip / 0 fail (525 tests, 20 files) on feat/s3-v1-controls
bun run build                                              # passed: dist/index.js, dist/tui.js, dist/commands.js, dist/installer.js, dist/cli/index.js
npm pack --pack-destination "$TMPDIR"                      # tarball contains package.json, README, all five bundles (issue #10)
# unpacked dist/index.js import exposed/executed classifyTaskComplexity, D2_HANDOFF_SCHEMA,
# transitionAdmission, evidenceSchema, assessEvidence       # passed (issue #10)
# dist/index.js export sweep for evaluateBudget, transitionReviewV1, TRACE_MODES/BUDGET_MODES/
# REVIEW_MODES, parseTraceSummary, reviewStorageKey        # passed (feat/s3-v1-controls)
bun run src/cli/index.ts doctor                            # static options/agents + local advisory git/gh/auth/repo/worktree checks passed
                                                           # (expected workflow/MCP/runtime-authority warnings)
# Embedded V2 host tests (source, config-relative source, package-like local dist) — part of full suite, passed
```

**Shared-service live-reload smoke — inconclusive (not verified, not a pass):**
`opencode2 api get /api/plugin` from the repo `cwd` did **not** list `opencode-orchestrator`; it
listed built-ins and an unrelated failed global nono-sandbox plugin. The shared service was **not**
restarted because restarting/reopening it could interrupt the current session. Per `AGENTS.md`, this
probe is authoritative for the live session, so a live shared-service plugin load is **unverified**;
no live-reload pass is claimed. The **final independent aggregate review passed** with no blocking
or major findings.

There is **no configured lint or formatter** in this repository — no lint claim is made.

---

## 7. Source links

- Parent source plan: [`../orchestrator-improvements-plan.md`](../orchestrator-improvements-plan.md)
  — sections D1–D4, V1–V3, Phase 1 activities/exit evidence (`:1022-1039`), "Assumptions Requiring
  Verification" (`:1095-1108`), and the verification checklist (`:1110-1127`).
- Root README: [`../../README.md`](../../README.md) — the repository's published guidance,
  including the direct-execution default the D4 gate formalizes (`README.md:30`) and the "Runtime
  contract tools" section.
- Repository instructions: [`../../AGENTS.md`](../../AGENTS.md) — the "OpenCode V2 Contract"
  (beta/experimental API, package pins, doctor/probe authority), the layout, and ship
  verification.
- Issue: [#8 — Phase 1 contracts and design artifacts](https://github.com/cldmnky/opencode-orchestrator/issues/8) (historical design).
- Issue: [#10 — Phase 1 runtime contracts](https://github.com/cldmnky/opencode-orchestrator/issues/10) (callable implementation; current branch `feat/10-phase1-runtime-contracts`).
- Branch (issue #8, merged): `feat/8-orchestration-phase1-contracts`.
