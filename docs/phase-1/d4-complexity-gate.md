# D4 — Start-Simple Complexity Gate (Phase 1 Design Artifacts)

**Status:** Design-only · **Artifact:** D4 · **Date:** 2026-08-30
**Source proposal:** [docs/orchestrator-improvements-plan.md](../orchestrator-improvements-plan.md), section **D4 — Start-Simple Complexity Gate**
**Companion artifacts:**

- [`d4-gate-table.json`](./d4-gate-table.json) — the decision table (machine-readable)
- [`d4-task-corpus.json`](./d4-task-corpus.json) — synthetic, non-measured task corpus
- [`d4-evaluation-template.json`](./d4-evaluation-template.json) — frozen evaluation protocol and results template

---

## 1. Purpose

The complexity gate answers one question before a task starts: *"Is direct execution proportionate, or does this task warrant orchestration — and if so, which flavor?"*

The repository already nudges users toward the answer informally: `README.md:30` says to skip the orchestrator for single-file trivial edits, and `src/core/policy.ts` (lines 71-91) describes disjoint write scopes, serialization of overlapping implementation, and review-before-completion as **prompt guidance only**. The gate formalizes that advisory logic into a decision table so it can be evaluated on a corpus before any runtime code is considered.

**This is a recommendation layer, not an enforcement layer.** It makes no runtime changes, is not imported by plugin code, does not block or force delegation, and cannot override an explicit user decision.

## 2. The Eight Dimensions

The gate assesses a task on the same eight dimensions defined in the parent plan's D4 section:

| # | Dimension | Admission question |
|---|---|---|
| 1 | `independent_subtasks` | How many children could run with disjoint scopes and no dependencies? |
| 2 | `dependent_stages` | How many steps must complete in order? |
| 3 | `files_modules` | How many files/modules change, and do writers overlap? |
| 4 | `independent_review` | Should a separate reviewer audit the change before completion? |
| 5 | `external_side_effects` | Does the task reach outside the working tree (network, GitHub, worktrees, services)? |
| 6 | `shared_mutable_state` | Would parallel writers contend for the same file, module, artifact, or storage key? |
| 7 | `security_compliance_risk` | Does the change touch credentials, redaction, permissions, worktree roots, or remotely mutating tools? |
| 8 | `expected_parallelism_value` | Would concurrency save meaningful time versus its added cost and failure surface? |

The JSON table (`d4-gate-table.json`) carries the full definitions, input types, repository source references, and the per-dimension unknown handling. Notably, `max_parallel` is validated as 1..8 with default 4 in `src/core/config.ts:51` — that ceiling is the *context* for dimension 8, not an enforcement signal.

## 3. Labels and Precedence

The gate assigns exactly one label and maps it to a recommendation:

| Label | Recommendation | When |
|---|---|---|
| `high-risk` | `orchestrate-with-review` | Security/compliance risk, or material external side effects |
| `shared-state` | `orchestrate-serialized` | Parallel writers would contend for mutable state |
| `multi-step` | `orchestrate-candidate` | Multiple dependent stages or subtasks across more than a couple of files |
| `trivial` | `direct-execution-candidate` | One file, local edits, no review obligation, no side effects |
| `incomplete-facts` | `collect-facts` | Any dimension cannot be assessed |

**Precedence (highest first):**

1. **`incomplete-facts` → `collect-facts`** — assessed *before* classification. The gate never guesses: an unknown high-risk dimension must never be treated as "no". Read-only exploration (planning/research roles) or a direct user question resolves the gap.
2. **`high-risk` → `orchestrate-with-review`** — any high-risk signal wins over every other label. Review is already the default obligation for orchestrated runs (`require_review=true`, `src/core/config.ts:52`; `src/core/policy.ts:90`).
3. **`shared-state` → `orchestrate-serialized`** — prompt rules do not enforce filesystem isolation (`src/core/policy.ts` `WORKTREE_BOUNDARY_GUIDANCE`), so overlapping writers must be serialized, not parallelized.
4. **`multi-step` → `orchestrate-candidate`** — coordination pays when work decomposes or stages depend on each other; parallelize only when `expected_parallelism_value` is medium/high and write scopes are disjoint.
5. **`trivial` → `direct-execution-candidate`** — the README default (`README.md:30`).
6. **No rule fires cleanly → `collect-facts`** — ambiguity resolves conservatively toward facts, never toward a guessed label.

Every outcome remains a *candidate*: the user can override any recommendation, and a recommendation carries no verification power by itself.

## 4. The Synthetic Corpus

[`d4-task-corpus.json`](./d4-task-corpus.json) contains **12 synthetic cases** — at least 2 (we provide 3) in each of `trivial`, `multi-step`, `shared-state`, and `high-risk`:

| caseId | label | Request shape |
|---|---|---|
| `d4-case-001` | trivial | One-line README typo |
| `d4-case-002` | trivial | Single rename in one function, typecheck |
| `d4-case-003` | trivial | Stale docstring on one export |
| `d4-case-004` | multi-step | Feature + tests + docs end-to-end option |
| `d4-case-005` | multi-step | Extract shared helper, update callers |
| `d4-case-006` | multi-step | State-key migration with shim and verification |
| `d4-case-007` | shared-state | Two overlapping edits to `src/core/policy.ts` |
| `d4-case-008` | shared-state | Feature + docs both touching command-name lists |
| `d4-case-009` | shared-state | Config refactor + shared options-type move |
| `d4-case-010` | high-risk | Enable GitHub mutations / new GitHub tooling |
| `d4-case-011` | high-risk | Worktree root whitelist + merge-back policy |
| `d4-case-012` | high-risk | Secret-handling guidance + redactor patterns |

Each case records the `request` verbatim, a `features` object over the eight dimensions, a `referenceRecommendation`, a `referenceBasis` citing the repository fact or gate rule that motivates the label, and `sourceType: "synthetic-design-case"`.

**The labels are hypotheses, not measurements.** No case has been executed; there is no latency, token, or quality data attached to any case in this phase.

## 5. How to Evaluate

[`d4-evaluation-template.json`](./d4-evaluation-template.json) freezes the protocol so that future results are comparable:

1. Pin and record the environment (plugin/SDK versions, entrypoint, host API).
2. For each case, feed **only the request text** to the gate (dimension assessment + precedence) and record the recommendation before ever reading the reference label.
3. Execute the task via the recommended path and capture per-case metrics: prompt/handoff size, delegation count, latency, failures, review loops, and safety observations.
4. Classify each case as true/false positive/negative against the reference label.
5. Aggregate totals and per-label counts into the `aggregateResults` block.
6. Freeze results under the protocol version; protocol or corpus changes require a version bump and a full re-run.

**Definitions recorded in the template:**

- **False positive** — the gate recommends orchestration where the reference label is `trivial`; orchestration added cost/latency without improving the outcome.
- **False negative** — the gate recommends direct execution where the reference label is `multi-step`, `shared-state`, or `high-risk`; direct execution omitted required decomposition, serialization, isolation, or review.

**Rubric (per case, scored 0-2):** `classification` (agreement with the reference label), `evidenceFidelity` (every metric backed by run evidence — fabrication invalidates the run), `safety` (secret handling, verification, override respect), and `proportionality` (did orchestration cost justify what it bought).

**All result fields are null or `"not-collected"`.** This template defines what *will* be recorded; it contains no measured data.

## 6. Recommendation-Only Boundary

- The gate produces a recommendation, never a hard block or an automatic delegation.
- The user can always override the recommendation; the gate never silently changes execution.
- The gate is not loaded by plugin or runtime code in this phase — `runtimeEnforced: false` in the JSON table.
- The parent plan's constraints apply unchanged: no GitHub/worktree/merge/issue/PR actions, no source or test edits, and web sources remain directional evidence (`R1` — Anthropic multi-agent research system, `R4` — Beam multi-agent orchestration patterns; the secondary "single-agent suffices on 64% of benchmark tasks" claim from R4 must be independently validated before it can become a product metric).

## 7. No-Results / No-Telemetry Statement

**This phase has collected no results and no telemetry.** The artifacts here are design-only: the decision table formalizes recommendation logic that already exists as advisory README/policy guidance; the corpus is synthetic and unexecuted; the evaluation template's result fields are null or `"not-collected"` by design. Nothing in `docs/phase-1/` claims measured behavior, runtime enforcement, or validated accuracy for the gate.

## 8. Source References (Repository)

| Reference | Location | Role in this artifact |
|---|---|---|
| README advice | `README.md:30` | Direct-execution candidate rule ("skip the orchestrator for single-file trivial edits") |
| D4 proposal | `docs/orchestrator-improvements-plan.md` §D4 (lines ~400-438) | The eight dimensions, the recommendation semantics, the "next step" this phase fulfills |
| Parallelism ceiling | `src/core/config.ts:51` | `max_parallel` 1..8, default 4 — context for parallelism-value reasoning |
| Prompt-only policy | `src/core/policy.ts:71-91` | Disjoint write scopes, serialization of overlapping implementation, review before completion — guidance only, which is why the gate is also advisory |
| Isolation boundary | `src/core/policy.ts:53-62` | `WORKTREE_BOUNDARY_GUIDANCE` / `MANAGED_WORKTREE_GUIDANCE` — no atomic child isolation, hence shared-state serialization |
| Review default | `src/core/config.ts:52`, `src/core/policy.ts:90` | `require_review=true` — review obligation for orchestrated runs |

Web research (`R1` Anthropic, `R4` Beam) is cited **in the parent plan only** as directional evidence for the cost of multi-agent execution; this document does not attach any quantitative validation to those sources.

## 9. Non-Goals

- No runtime enforcement, no plugin code change, no schema change.
- No measured corpus results, no telemetry, no accuracy claims.
- No automatic GitHub/worktree/merge/issue/PR operations.
- No claim that prompt-level guidance constitutes filesystem or security isolation.