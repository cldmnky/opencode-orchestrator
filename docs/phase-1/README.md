# Phase 1 — Coordinator-Owned Index (issue #8)

**Date:** 2026-08-30
**Issue:** [#8 — Phase 1 contracts and design artifacts](https://github.com/cldmnky/opencode-orchestrator/issues/8)
**Branch:** `feat/8-orchestration-phase1-contracts`
**Status:** All ten design artifacts are complete and cross-linked; repository checks (`bun run typecheck && bun test && bun run build`) are **pending the parent orchestrator** (see [Definition of done](#definition-of-done)).

This README is the coordinator-owned entry point for the Phase 1 design artifacts of
[issue #8](https://github.com/cldmnky/opencode-orchestrator/issues/8). It maps every artifact,
prescribes the reading order, records what is established by source inspection versus what remains
unverified, and defines what "done" means for this phase.

---

## 1. Scope statement (read this first)

**This phase is documentation and design only.** Every artifact in this directory is a design
proposal, a checklist, a ledger, or a frozen template for *future* measurement. Nothing here is
runtime behavior:

- **No source change:** no `src/`, `test/`, `package.json`, README, or config file is modified by
  this phase; no `src/core/policy.ts` or `src/core/prompts.ts` text changes; the published
  five-field `HANDOFF_FORMAT` remains the operative contract.
- **No collected telemetry:** there are no measured results anywhere in this directory. The D4
  corpus labels are hypotheses, the evaluation template's result fields are `null`/
  `"not-collected"`, and no token, latency, or quality number in the parent plan is treated as a
  measurement here.
- **No runtime enforcement:** `max_parallel` and `require_review` are validated config consumed
  only as prompt text; there is no scheduler, semaphore, or completion gate. The V2 admission
  states are vocabulary, not a state store. The D4 gate is a recommendation layer, never a block.
- **No atomic child isolation:** prompt-level disjoint write scopes and managed `worktree/v2`
  bookkeeping are explicitly **not** filesystem or process isolation.
- **No exactly-once claim:** the storage surface has no transactions, CAS, or cross-process
  primitives; durability and crash consistency are unverified.
- **No runtime handoff adoption:** no parser, validator, or prompt integration consumes the D2
  schema/example; real worker handoffs are not emitted as envelopes.

The parent plan's constraints apply unchanged: no GitHub/worktree/merge/issue/PR operations, no
web-source claims upgraded to facts, and web research remains directional evidence
([`../orchestrator-improvements-plan.md`](../orchestrator-improvements-plan.md), D4 section).

---

## 2. Artifact map

All ten sibling artifacts below live in this directory. Each links only to read-only references;
none is imported by plugin code.

| Artifact | Purpose | Status |
|---|---|---|
| [`d4-complexity-gate.md`](./d4-complexity-gate.md) | **D4 — Start-Simple Complexity Gate.** Formalizes the README/policy advisory logic ("skip the orchestrator for single-file trivial edits") into an eight-dimension decision table with five labels and a precedence order. Explicitly a recommendation layer, not enforcement. | Design-only; complete. `runtimeEnforced: false`. |
| [`d4-gate-table.json`](./d4-gate-table.json) | Machine-readable version of the D4 decision table: eight dimensions, unknown handling, labels, precedence rules, decision outcomes, source references. | Design-only; complete. |
| [`d4-task-corpus.json`](./d4-task-corpus.json) | **12 synthetic, unexecuted** task cases (3 trivial, 3 multi-step, 3 shared-state, 3 high-risk) with verbatim requests, dimension features, reference labels, and justification. `measured: false`. | Design-only; complete. No case executed; labels are hypotheses. |
| [`d4-evaluation-template.json`](./d4-evaluation-template.json) | Frozen evaluation protocol (environment pin, blind gate run, per-case metrics, FP/FN rubric, aggregation) with **all result fields `null` / `"not-collected"`**. | Design-only; complete. Defines what *will* be recorded; contains no measured data. |
| [`v3-capability-matrix.md`](./v3-capability-matrix.md) | **V3 — Host-Tool Preflight and Capability Authority Matrix.** One authority model across static / registration / local-advisory (`doctor`) / live-host / host-MCP / live-server / storage / documented-V2 layers, plus the six-marker evidence vocabulary (`EVIDENCE_LIVE`, `EVIDENCE_MUTATION`, `EVIDENCE_REGISTERED`, `EVIDENCE_LOCAL`, `EVIDENCE_STATIC`, `UNKNOWN`), freshness markers, and preflight flow. | Design-only; complete. Explicit unknowns preserved throughout. |
| [`d2-handoff.md`](./d2-handoff.md) | **D2 — versioned structured handoff draft.** Maps the five-field prose `HANDOFF_FORMAT` into a strict Draft 2020-12 envelope (`version: 1`), documents added fields (facts/assumptions/artifactRefs/reviewState…), rendering, completeness, and **no-runtime-adoption** statement. | Design-only draft; complete. No parser or prompt integration. |
| [`d2-handoff.schema.json`](./d2-handoff.schema.json) | The D2 envelope JSON Schema: 13 required fields, `additionalProperties: false` everywhere, path/URL safety (`relativeRepoPath`, `^https://` only), enums, length caps. | Design-only draft; complete. Also walked by V2 §10. |
| [`d2-handoff.example.json`](./d2-handoff.example.json) | Illustrative validating envelope (`taskId: issue-8-d2-handoff-schema-draft`) demonstrating honest verification entries, including a `not-run` suite command with a reason. | Design-only draft; complete. Illustrates, not executed as an orchestrated run. |
| [`v2-validation-checklist.md`](./v2-validation-checklist.md) | **V2 — Two-Level Validation Checklist and Admission-State Vocabulary.** Three levels (worker deterministic C1–C7, orchestrator deterministic O1–O9, reviewer judgment J1–J5), eight non-enforcing admission states (`candidate` → … → `admitted`), evidence admission rules keyed to V3, and a worked Level 1–3 walk of the D2 example. | Documentation-only proposal; complete. Zero runtime weight. |
| [`assumptions.md`](./assumptions.md) | **A1–A12 assumption and verification ledger** from the plan's "Assumptions Requiring Verification", restated with statuses (`Verified` / `Partially verified` / `Unverified` / `Not supported`), exact evidence, remaining unknowns, a verification backlog, and an evidence index. | Ledger complete; **no backlog command was executed** — every status derives from read-only source/declaration inspection. |

---

## 3. Reading order

1. **Boundaries and assumptions first** — `assumptions.md` (the status vocabulary and the A1–A12
   ledger) plus this README's §1 scope statement. They frame everything else as design, not
   runtime behavior.
2. **D4** — `d4-complexity-gate.md` (then `d4-gate-table.json`, `d4-task-corpus.json`,
   `d4-evaluation-template.json` for the machine shapes).
3. **D2** — `d2-handoff.md` (then `d2-handoff.schema.json`, `d2-handoff.example.json`).
4. **V3** — `v3-capability-matrix.md` (authority model and evidence vocabulary the V2 checklist is
   keyed to).
5. **V2** — `v2-validation-checklist.md` (consumes D2 structure and V3 evidence rules).
6. **Machine assets last** — re-read the two JSON trios (D4 table/corpus/template, D2
   schema/example) against the markdown that explains them.

---

## 4. Established facts vs assumptions

Facts below are established by **read-only source/declaration inspection** in this repository;
each cites its evidence. Assumptions cite the ledger row that still needs host/contract probing.
This phase collected **no telemetry**, so nothing below is a measurement.

### Prompt-only configuration (no runtime enforcement)

- `max_parallel` is validated as 1..8 with **default 4** (`src/core/config.ts:51`) and is consumed
  **only** as prompt/system text (`Runtime parallelism ceiling`, `src/opencode-v2/plugin.ts:84`);
  no scheduler or semaphore exists anywhere in `src/`. → assumption **[A4] Partially verified**.
- `require_review` is validated config with **default `true`** (`src/core/config.ts:52`) and is
  consumed only as policy/prompt text (`src/core/prompts.ts:16`, `src/core/policy.ts:90`); there
  is **no completion gate** — a run can complete with no reviewer result. → assumption
  **[A5] Partially verified**.
- **Reviewer requirement for this issue:** even though `require_review` is prompt-level and these
  artifacts are docs-only, this issue's completion still requires an aggregate reviewer pass by
  repository policy (the orchestrator review obligation, `src/core/policy.ts:90`) — docs-only
  scope does not waive it. No full-suite run is claimed below because that is the parent's step.

### Authority split (doctor vs live server)

- `doctor` is **local and advisory only**: its runtime checks are warn-or-pass, never fail the
  report, never print `gh` output (`src/cli/doctor.ts:164-248`), and cannot prove merged MCP
  config, remote reachability, live capability, auth, or permission grants
  (`src/cli/doctor.ts:153-158`). The server-side `orchestrator_github_capabilities` probe is
  authoritative **only for the gh fields it actually tests** (`src/opencode-v2/gh/client.ts:301-345`).
  → assumption **[A9] Partially verified**.

### Storage surface and exactly-once

- The storage surface is `get`/`set`/`remove`/`scan` plus a **process-local, in-memory**
  `withSessionLock` map — no transactions, no compare-and-set, no cross-process primitives
  (`src/opencode-v2/goal/state.ts:36-44,122-140`). Durability and crash consistency are
  unverified. **Exactly-once is never claimed.** → assumption **[A6] Partially verified**.

### Worktree boundary

- Managed `worktree/v2` records are **current-session bookkeeping**, not isolation; prompt-level
  disjoint write scopes do not equal filesystem isolation (`src/core/policy.ts:53-62`,
  `src/opencode-v2/plugin.ts:89`). → assumptions **[A3] Not supported**, **[A12] Partially
  verified**.

### API beta and package pins — session statistics nuance

- The repository is pinned to `@opencode-ai/plugin@0.0.0-beta-18684` and
  `@opencode-ai/sdk@0.0.0-dev-18683` (`package.json:37,45`); the V2 API is beta/experimental and
  `AGENTS.md` treats `https://opencode.ai/v2/openapi.json` as the HTTP contract while flagging the
  README's "V2 Boundary" as stale. → assumption **[A1] Unverified**.
- **Session statistics, scoped carefully:** a grep of the pinned plugin `dist/*.d.ts` found **no
  `statistics` / `tokenCount` / `usage` surface in the pinned Promise `SessionDomain`**
  (`v3-capability-matrix.md`, row "Documented V2 session-statistics surface"), and the repository
  never consumes token stats. However, the **official HTTP API docs may expose session
  statistics**; the absence claim is therefore scoped to the *pinned package declarations*, not
  stated universally. Whether any stats are reachable server-side from this plugin remains an
  open probe. → assumption **[A7] Unverified** (linked to **[A2] Unverified**).

---

## 5. Definition of done

**Artifact completion (done in this phase):**

| Item | Definition of done | Status |
|---|---|---|
| D4 | Decision table (`d4-gate-table.json`), synthetic unexecuted corpus, and frozen evaluation template present; recommendation-only; `runtimeEnforced: false`; no results claimed. | **Complete** |
| V3 | Capability authority matrix with explicit unknowns across all layers, evidence vocabulary, and preflight flow; pinned declarations cited as the tested truth, official docs flagged directional. | **Complete** |
| D2 | Strict Draft 2020-12 schema (`version: 1`) plus validating example; five-field prose mapping documented; no runtime adoption claimed. | **Complete** |
| V2 | Three-level deterministic/judgment checklist (C1–C7, O1–O9, J1–J5), eight-state admission vocabulary, evidence admission rules keyed to V3, worked (illustrative, non-executed) walk of the D2 example. | **Complete** |
| A1–A12 | Every assumption recorded with a status, exact evidence, remaining unknown, and next verification step; one negative claim **Verified** (A11 — no durable GitHub records), the rest Partially verified / Unverified / Not supported; verification backlog documented for host/contract probing. | **Ledger complete** — **no backlog command executed** |
| Repository checks | `bun run typecheck && bun test && bun run build` is the repository ship gate (plan "Verification Checklist"). This phase changes no code, so the suite was **intentionally not run** — the example records it as a `not-run` verification entry with a reason. | **Pending parent orchestrator** |

Whether all ten artifacts satisfy the parent plan's Phase 1 exit evidence (`docs/orchestrator-improvements-plan.md:1034-1039`) is a **parent-side review decision**: the handoff schema (D2), FP/FN protocol (D4 template), and capability matrix with unknowns (V3) are produced; the plan's "baseline metrics" item is explicitly **not** produced because this phase collects no telemetry. The full test suite has **not** been run yet — do not treat this README as claiming it was.

---

## 6. Validation commands

These are the checks that verify this directory as of this README:

```sh
# 1. All five JSON artifacts parse (schema, example, gate table, corpus, evaluation template)
for f in docs/phase-1/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || exit 1; done

# 2. D2 schema/example validation — approach and limitations
```

**D2 verifier approach and limitation (honest record):** the example was validated by an
*ephemeral scratch validator kept outside the repo* implementing the keyword subset the schema
uses (`type`, `const`, `enum`, `required`, `additionalProperties`, `properties`, `items`,
`minItems`, `minLength`, `maxLength`, `pattern`, `$ref`, `allOf`, `if`/`then`), plus an
independent Zod model and a keyword-coverage check against the Draft 2020-12 metaschema. That is
**not** a full Draft 2020-12 implementation (no `format`, `unevaluatedProperties`, `prefixItems`,
`$dynamicRef`, …), and full metaschema compliance of the schema document itself was asserted by
keyword coverage rather than by running the official metaschema against it. Any real admission
gate must re-run the example against a maintained validator before trusting it at full weight
(V2 checklist §10, O3.3 corroboration rule).

```sh
# 3. Local markdown link / path checks — the ten sibling links in §2 and the root links in §7
#    resolve to existing files (verified manually and re-checkable with a link scraper)

# 4. Whitespace check on this file (and the directory while at it)
git diff --check -- docs/phase-1/README.md

# 5. Repository ship gate — PENDING PARENT, not run for this docs-only phase
bun run typecheck && bun test && bun run build
```

There is **no configured lint or formatter** in this repository — no lint claim is made.

---

## 7. Source links

- Parent source plan: [`../orchestrator-improvements-plan.md`](../orchestrator-improvements-plan.md)
  — sections D1–D4, V1–V3, Phase 1 activities/exit evidence (`:1022-1039`), "Assumptions Requiring
  Verification" (`:1095-1108`), and the verification checklist (`:1110-1127`).
- Root README: [`../../README.md`](../../README.md) — the repository's published guidance,
  including the direct-execution default the D4 gate formalizes (`README.md:30`).
- Repository instructions: [`../../AGENTS.md`](../../AGENTS.md) — the "OpenCode V2 Contract"
  (beta/experimental API, package pins, doctor/probe authority), the layout, and ship
  verification.
- Issue: [#8 — Phase 1 contracts and design artifacts](https://github.com/cldmnky/opencode-orchestrator/issues/8).
- Branch: `feat/8-orchestration-phase1-contracts`.