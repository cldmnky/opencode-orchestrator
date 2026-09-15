---
status: in-progress
title: Prefer coherent end-to-end vertical slices
taskId: vertical-slices
created: 2026-09-14
---

# Prefer Coherent End-to-End Vertical Slices

## Goal

Change decomposition guidance so the orchestrator prefers the smallest
**coherent end-to-end implementation slice** over the smallest file or layer.
Split work only at a verified boundary.

Preserved throughout every phase:

- Parallelism for genuinely independent work.
- Serialization for shared mutable state (fail-closed).
- Exact handoff validation and review requirements.
- Existing worktree and GitHub fail-closed flows.
- Advisory semantics: recommendations never override an explicit user decision.

## How this revision differs from the draft

Independent critiques (correctness, scope, security, feasibility) returned
1 approve-with-conditions and 3 changes-requested. This revision applies all
required corrections:

1. **Phase 0 re-scoped** from "measure a baseline corpus" to "freeze a
   measurement-protocol artifact first, then run it manually." No in-repo
   instrument measures decomposition quality (trace is opt-in metadata-only;
   no task/delegation records exist), so all outcomes are collected
   out-of-band and recorded in docs. Nothing gates on telemetry the host may
   never deliver.
2. **Metric availability table added.** Every metric is labeled
   manual / opt-in-host / unavailable. All thresholds are hypotheses until
   the first frozen-protocol baseline run populates them.
3. **MVP file list is explicit, with exclusions.** Pinned test phrases stay
   verbatim. New wording folds into the existing child-task contract where
   possible instead of adding new embed points.
4. **Anti-overlap invariant added.** Coupling is resolved by sequencing /
   serialization plus integrated parent verification — never by concurrent
   overlapping writes.
5. **Never-do boundaries stated.** No D2 v1 / D4 v1 schema changes, no
   isolation or scheduler claims, no new commands or options, no
   worktree/GitHub mutations in the MVP.
6. **Security acceptance criteria (L1–L7) and tests (T1–T6) adopted**,
   including honest O5 foreign-file handling.
7. **README sequencing noted.** An unrelated README clarification is
   currently uncommitted in the working tree; the MVP docs edit rebases onto
   it after it lands.

## Feature-boundary rubric

A proposed implementation slice is coherent only when all five hold:

1. **Cohesive user outcome.** One demonstrable behavior, fix, or visible
   sub-outcome. "Update one file" is not an outcome.
2. **Shared acceptance tests.** The slice names an acceptance statement and
   verification command(s). Code, wiring, and tests that must change together
   to prove the outcome stay in one slice.
3. **Unavoidable file coupling.** Files group when they must change together:
   API contract, import graph, command registry, config shape, runtime wiring,
   shared fixture, or behavior-level test.
4. **Explicit ownership scope.** The parent assigns exact writable files and
   acceptance responsibility. Broad scope must not conceal unrelated work.
5. **No shared mutable overlap with another slice.** Parallel writable slices
   share no file, module, command list, config object, state key, storage
   namespace, fixture, or mutable integration surface. Read-only overlap is
   safe; semantic write overlap is not.

Decision rules:

- Keep coupled code, tests, wiring, and requested docs in one slice even
  across several files.
- Split only when every resulting slice has its own outcome, acceptance
  evidence, ownership, and no hidden dependency.
- Dependent but non-overlapping slices run sequentially with an explicit edge.
- Unknown coupling fails closed: serialize.
- Parallelize only after the parent verifies the rubric from repository facts.
  Prompt-level scopes are coordination units, never filesystem isolation.
- A reviewer may own cross-slice acceptance, but only when stated explicitly.

## Phase 0 — Freeze the measurement protocol (docs-only)

**Status: complete (2026-09-15).** Artifact created at
`docs/phase-1/vertical-slice-evaluation-template.json` (protocol version 1,
frozen date 2026-09-15): five-condition rubric, 12 hypothesis-marked corpus
cases, per-case null/`not-collected` result slots, the binding metric
availability table, and thresholds labeled hypotheses until the first baseline
run. No results collected and no telemetry claimed.

**Purpose:** Make future claims falsifiable before changing any behavior.

**Scope:** New docs artifacts only. No source, config, schema, or test edits.

**Tasks:**

1. Add a versioned vertical-slice evaluation template under `docs/phase-1/`
   (modeled on `d4-evaluation-template.json`), containing:
   - The rubric above, frozen as scorer instructions.
   - A corpus of 9–12 tasks: ≥3 single-outcome multi-file features, ≥3
     genuinely independent pairs, ≥3 shared-state/overlap cases, ≥3
     trivial/direct controls. All labels marked hypotheses.
   - Per-case slots: outcome, children count, files/areas per child, rubric
     pass/fail per slice, acceptance owner, parallel vs serialized, rework
     and review loops, verification result.
   - All result fields `null` / `not-collected` at freeze time.
2. Add the metric availability table (below) to the template.
3. Record the frozen protocol version and the rule that corpus/label changes
   require a version bump and full re-run.

**Metric availability (binding):**

| Metric | How collected | Availability |
|---|---|---|
| `slice_cohesion_rate` | Manual rubric scoring per case | manual |
| `unnecessary_split_rate` | Manual per-case judgment vs baseline | manual |
| `acceptance_coverage` | Manual per-case check | manual |
| `parallel_independence_precision` | Manual per-case transcript/VCS check | manual |
| `shared_state_violations` | Manual per-case check; target is zero observed violations, never "guaranteed serialization" | manual |
| `integration_rework_rate` | Manual per-case check | manual |
| `delegation_count` | Manual per-case count | manual |
| Prompt byte size | Deterministic: prompts are pure functions of options | in-repo computable |
| Tokens / cost / latency / steps | Host snapshots replace, never sum; delivery unverified | unavailable until live-host probe |

**Thresholds (hypotheses, finalized after first baseline run):**

- ≥25% relative reduction in unnecessary splitting.
- ≥80% cohesion on sampled multi-file outcomes.
- Zero observed shared-state violations per case.
- No regression in independent-task completion or verification.
- Prompt byte-size growth recorded; no assert on tokens.

**Verification:** `git diff --check`; template is valid JSON. No tests exist
yet for the new artifact; add a structural test only if the repo pattern
requires it (d4 corpus is read at test runtime — do not couple to it).

## Phase 1 — Prompt-guidance MVP (no schema changes)

**Status: complete (2026-09-15).** Prompt-only MVP landed in `src/core/policy.ts`
(`VERTICAL_SLICE_GUIDANCE` + child-task contract fold), `src/core/roles.ts`,
`src/core/prompts.ts` (orchestrator rules, worker system, continuation),
`src/core/prompt-builder.ts`, and `README.md`. No config, D2/D4 schema,
validation/tools schema, observability, worktree/GitHub, command, installer,
doctor, or TUI change; no runtime scheduler and no isolation claim.

**Purpose:** Prefer vertical slices without touching configuration, schemas,
runtime scheduling, or persisted state.

**Files in scope (complete list):**

- `src/core/policy.ts` — fold 1–2 sentences into the existing child-task
  contract; add a shared constant only if folding cannot cover all five
  embed points without duplicating divergent wording.
- `src/core/roles.ts` — implementation guidance: "coherent end-to-end
  slices with focused ownership" (replaces bare "focused changes").
- `src/core/prompts.ts`, `src/core/prompt-builder.ts` — embed via existing
  builders only; prefer the narrowest placement that reaches orchestration,
  worker, and continuation prompts over adding to the shared `common`
  section that taxes every dispatch. Record byte-size delta.
- `README.md` — update "focused edits / non-overlapping scopes" wording so
  it does not imply one child per file. Rebase onto the in-flight README
  clarification currently uncommitted; land after it.
- `test/unit/core.test.ts`, `test/unit/prompt-builder.test.ts`,
  `test/unit/agents.test.ts`, `test/contract/plugin.test.ts` — extend
  pinned-phrase coverage for the new wording.

**Explicitly excluded:** `src/core/config.ts`, `src/core/d4.ts`,
`src/core/contracts.ts`, `src/core/admission.ts`, orchestration
`validation.ts`/`tools.ts` schemas, `observability/*`, `plugin.ts` behavior,
`agents.ts`, `tui.ts`, installer, doctor, worktree/GitHub modules, any new
command or option, any D2/D4 field.

**Required invariant (verbatim-compatible):** "Unavoidable coupling between
files is resolved by sequencing or serialization with integrated parent
verification — never by concurrent overlapping writes. Prompt-level scopes
are coordination units, not filesystem isolation."

**Language requirements (L1–L7):** slice ≠ isolation/permission boundary;
retain exact-disjoint-scope + serialize-overlap lines verbatim with shared
files named to exactly one slice; independence verified pre-dispatch from
facts with unknown ⇒ serialize and `max_parallel` ceiling kept; aggregate
review and parent direct-verification retained; one terminal chain on the
integrated revision with no per-slice publication and no model-driven
gate/config changes (issue creation never authorized); secret placeholders,
no inlined raw transcripts/diffs; honest `blocked-unknown` handling with no
post-hoc scope widening to convert C3/O5 failures into passes.

**Required tests (T1–T6):** exactly-once prompt-invariant suite extended
with slice guidance present; negative-content test for isolation phrasing
with caveats verbatim; scope-partition unit behavior
(overlap ⇒ serialize, unknown ⇒ serialize, disjoint ⇒ parallel,
empty ⇒ no parallel writes) if a helper lands, else covered by prompt
tests; contracts/validation suites green unchanged plus a locked-in case
that parallel-slice receipts validated post-write trip O5
`blocked-unknown`; D4 corpus unchanged; `bun run typecheck && bun test &&
bun run build` green.

**Verification:**

```sh
bun test test/unit/prompt-builder.test.ts
bun test test/unit/core.test.ts
bun test test/contract/plugin.test.ts
bun run typecheck
bun test
bun run build
```

Then repeat the Phase 0 corpus manually and record results in the frozen
template.

## Checkpoint A — Decide whether to proceed

**Status: pending manual baseline-vs-after evidence (not yet decided).** The
frozen corpus has not been run, the manual baseline-vs-after comparison has not
been recorded, and the live telemetry probe for tokens/cost/latency/steps has
not run. No phase-2+ work is authorized by this checkpoint.

Go beyond the MVP only if the manual baseline-vs-after comparison shows
lower unnecessary splitting with no decline in acceptance coverage or
verification, zero observed shared-state violations, continued parallelism
for rubric-permitted independent work, no safety/publication regression,
and a demonstrated user need for an explicit override. Otherwise stop at
the prompt-only MVP.

## Phase 2 — Optional decomposition configuration (gated)

Only if Checkpoint A shows users need an explicit strategy override.
Optional strict config (e.g. a strategy key defaulting to current MVP
behavior), prompt-preference only; must never disable serialization,
scope validation, review, worktree lifecycle, or publication
preconditions. Existing configs parse unchanged; typos rejected.
Candidate files: `src/core/config.ts`, `src/core/policy.ts`,
`src/core/prompts.ts`, `README.md`, `dev/project/opencode.example.jsonc`,
plus strict-schema/default-preservation tests. Verification: focused
config/prompt/contract/installer tests, then full suite and build.

## Phase 3 — Optional D4 coherence signal (gated, versioned)

Only if the rubric proves repeatable and a machine-readable signal
demonstrably improves classification. Never mutate D4 v1: additive v2
artifact + separate classifier/tool surface, coordinated updates to
pinned guidance text and tests, D2 flow-through question named upfront.
Verification: v1 corpus unchanged, v2 cases behave (cohesive ⇒ slice
metadata, independent ⇒ parallel candidate, overlap ⇒ serialized,
null ⇒ collect-facts, invalid rejected), full suite and build green.

## Phase 4 — Rollout and completion

Repeat the identical corpus protocol under the approved configuration,
compare baseline / MVP / later phases, have the review role audit slice
boundaries, shared-state handling, acceptance ownership, prompt
compatibility, and exact review/worktree/GitHub invariants. Mark complete
only with green tests, reviewer approval, zero observed shared-state
violations, met thresholds, unavailable telemetry honestly marked, and
declined optionals recorded as declined.

## Rollback and compatibility

- Phase 1 is additive prompt text; revert without state or config impact.
- D2 handoffs, plan files, review receipts, worktree records, and
  publication flows unchanged by every phase until its gate passes.
- No phase claims filesystem isolation or runtime concurrency enforcement.

## Status

**Phases 0 and 1 complete; Checkpoint A pending manual baseline-vs-after
evidence; the overall plan is NOT complete.** Phases 2–4 remain gated,
unstarted, and unauthorized.

### Phase 0/1 evidence ledger (recorded 2026-09-15)

Environment: this slice's working tree on top of HEAD `146f54a`; pinned
`@opencode/plugin` / `@opencode/sdk` `0.0.0-beta-19507`; `bun install` run in
the worktree before verification.

| # | Command | Result |
|---|---|---|
| 1 | `bun test test/unit/prompt-builder.test.ts` | 10 pass / 0 fail |
| 2 | `bun test test/unit/core.test.ts` | 51 pass / 0 fail |
| 3 | `bun test test/unit/agents.test.ts` | 13 pass / 0 fail |
| 4 | `bun test test/contract/plugin.test.ts` | 2 pass / 0 fail |
| 5 | `bun run typecheck` | pass (`tsc --noEmit`, exit 0) |
| 6 | `bun test` | 790 pass / 1 skip / 0 fail (791 tests, 29 files) |
| 7 | `bun run build` | pass; emitted `dist/index.js`, `dist/tui.js`, `dist/commands.js`, `dist/installer.js`, `dist/cli/index.js` |
| 8 | `git diff --check` | clean (no whitespace errors) |
| 9 | `git status --short` | only the Phase 0/1 scope files are modified/added |
| 10 | `bun -e "JSON.parse(await Bun.file('docs/phase-1/vertical-slice-evaluation-template.json').text()); console.log('valid')"` | `valid` |

Prompt byte-size delta (deterministic, measured against the same HEAD sources
with identical inputs; prompts are pure functions of options):

| Prompt | Before | After | Delta |
|---|---|---|---|
| orchestrator system | 8322 | 9074 | +752 |
| worker system (implementation) | 6050 | 6799 | +749 |
| continuation | 5422 | 6052 | +630 |
| command `orchestrate` | 5717 | 5874 | +157 |
| command `run-plan` | 5323 | 5323 | +0 |

Requirement coverage in this slice:

- T1: pinned-phrase suites extended with the slice guidance and the exact
  anti-overlap invariant (`test/unit/core.test.ts`,
  `test/unit/prompt-builder.test.ts`, `test/unit/agents.test.ts`,
  `test/contract/plugin.test.ts`).
- T2: negative-content tests assert no positive isolation or scheduling claim
  while the advisory caveats stay verbatim.
- T3: no scope-partition helper landed (prompt-only Phase 1, as planned), so the
  overlap ⇒ serialize, unknown ⇒ serialize, and disjoint ⇒ parallel rules are
  covered by prompt-text assertions on `orchestrationRules`, worker, and
  continuation prompts.
- T4: contracts/validation suites are green unchanged (full `bun test`); the
  locked-in O5 foreign-file `blocked-unknown` case remains green in
  `test/unit/orchestration-tools.test.ts` (out of this slice's write scope and
  untouched). The D4 corpus is unchanged.
- T5: `bun run typecheck && bun test && bun run build` green (rows 5–7).

Pending at Checkpoint A (not evidence, and never to be estimated):

- The manual baseline-vs-after corpus run under the frozen protocol.
- The live-host telemetry probe for tokens / cost / latency / steps.
- Checkpoint A's decision and any Phase 2–4 authorization.

No implementation beyond Phases 0–1 is authorized by this plan alone; each
later phase must execute through the standard implementer → review →
publication chain after Checkpoint A passes.
