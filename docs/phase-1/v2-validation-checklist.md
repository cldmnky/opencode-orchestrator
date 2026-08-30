# V2 — Two-Level Validation Checklist and Admission-State Vocabulary

**Date:** 2026-08-30
**Issue:** #8 — Phase 1 design artifact for plan item V2 ("Two-Level Validation Before Downstream Admission", `docs/orchestrator-improvements-plan.md:489-535`; P0 row `:238`).
**Status:** **Documentation-only proposal.** No runtime parser, scheduler, or completion gate is added in Phase 1. Nothing in this document changes `src/`, `test/`, `package.json`, the README, or any config; no check below is wired to an enforcement point.
**Scope:** `docs/phase-1/v2-validation-checklist.md` only.
**Companion artifacts:**

- Cross-links the D2 structured-handoff contract: [`./d2-handoff.schema.json`](./d2-handoff.schema.json), [`./d2-handoff.example.json`](./d2-handoff.example.json), [`./d2-handoff.md`](./d2-handoff.md)
- Cross-links the V3 capability authority matrix: [`./v3-capability-matrix.md`](./v3-capability-matrix.md)
- Cross-links the D4 complexity gate, the assumption ledger, and the parent plan (see §11)

## 1. Purpose

The parent plan's V2 proposal asks for a downstream admission gate that does not currently
exist (`docs/orchestrator-improvements-plan.md:497-513`) and its "Next step" is to
*"List which repository claims can be checked deterministically and which require reviewer
judgment"* (`:529`). This document delivers that list as three levels — worker deterministic
validation, orchestrator deterministic re-verification, and reviewer judgment — plus a proposed,
**non-enforcing** admission-state vocabulary (`candidate` → … → `admitted`) and V3-keyed
evidence admission rules.

Because Phase 2 is explicitly where "two-level validation and maker-checker terminal states"
are defined (`docs/orchestrator-improvements-plan.md:1047`), everything here is vocabulary and
checklist for later implementation; it carries zero runtime weight today.

Why the vocabulary is needed even without enforcement: the current `require_review` default is
`true` (`src/core/config.ts:52`) but is **prompt-only** — it changes policy text
(`src/core/policy.ts:90`, embedded at `src/core/prompts.ts:16`) and nothing else. There is no
completion gate (`docs/phase-1/assumptions.md` A5). Admission states give the design a
vocabulary to talk about *what would happen* if a gate existed, without pretending one does.

## 2. Relationship to other Phase-1 artifacts

| Artifact | Relationship to this document |
|---|---|
| [`./d2-handoff.schema.json`](./d2-handoff.schema.json) | The envelope that Level 1 validates structurally (`version` `const 1` at `:24-27`, required fields `:8-22`, `additionalProperties: false` at `:7` and per-`$defs`, path/URL patterns `:91-104`, artifact kind rules `:214-255`). |
| [`./d2-handoff.example.json`](./d2-handoff.example.json) | Illustrative envelope that §10 walks through Levels 1–3 without claiming it was executed as an orchestrated run. |
| [`./d2-handoff.md`](./d2-handoff.md) | Field mapping (§2), added-field rationale (§3), and the explicit no-runtime-adoption statement (§8, `:146-155`). |
| [`./v3-capability-matrix.md`](./v3-capability-matrix.md) | Supplies the evidence markers (`EVIDENCE_LIVE`, `EVIDENCE_MUTATION`, `EVIDENCE_REGISTERED`, `EVIDENCE_LOCAL`, `EVIDENCE_STATIC`, `UNKNOWN`) and freshness/authority markers that Level 2's evidence checks (§9) are keyed to; §5 table at `:80-95`. |
| [`./d4-complexity-gate.md`](./d4-complexity-gate.md) | Gives a recommendation (advisory) on whether review is warranted for a task class (§3 labels, `:38-59`); "review is required" in §7's decision rule follows its `high-risk` → `orchestrate-with-review` linkage (`:53`). |
| [`./assumptions.md`](./assumptions.md) | A4 (parallelism prompt-only), A5 (review enforcement prompt-only) — the current-state basis for §7.3. |
| [`../orchestrator-improvements-plan.md`](../orchestrator-improvements-plan.md) | Source of record: V1 `:446-487`, V2 `:489-535`, V3 `:537+`, Phase-2 terminal-state activity `:1047`. |

## 3. The three validation levels at a glance

| Level | Who performs it | Nature | Checks | Verdict effect (proposed) |
|---|---|---|---|---|
| **Level 1 — Worker deterministic** | The producing worker, against its own handoff and its assigned contract | Rule-based, machine-checkable | §4 (C1–C7) | `candidate` → `worker-failed` / `worker-passed` / `blocked-unknown` |
| **Level 2 — Orchestrator deterministic** | The parent/orchestrator session, independently of the worker's claims | Rule-based, machine-checkable, *re-derived* not trusted | §5 (O1–O9) | `worker-passed` → `orchestrator-failed` / `blocked-unknown` / `review-pending` / `admitted` |
| **Level 3 — Reviewer judgment** | The review role or a human, per the review obligation (`src/core/policy.ts:90`) | Judgment, rubric-based, not fully automatable | §6 (J1–J5) | `review-pending` → `admitted` / `review-rejected` / `blocked-unknown` |

**Deterministic vs judgment boundary** (the plan's `:529` question), as a decision aid:

| Claim type | Deterministically checkable? | Where checked |
|---|---|---|
| JSON/schema/version validity, field presence, enum membership, path safety | Yes (pure function over the envelope bytes) | C1, O1 |
| Declared changed files match the git working-tree delta vs a recorded base | Yes (in the orchestrator session, `git status`/`git diff`) | O2 |
| A required command's exit status and observable result, rerun by the verifier | Yes (if the verifier can execute it; capability availability is a V3 `live` fact) | O4, O9 |
| Evidence reference exists / anchor is in range / artifact file exists | Yes (`EVIDENCE_STATIC`, repository read) | C5, O4 |
| Evidence is from the current session, live, and permission-proving | Partially — *liveness* is checkable, *permission* is a live-tool result; otherwise `unknown` | O6–O9, §9 |
| Semantic correctness ("the outcome says what the diff does") | No — judgment | J1 |
| Completeness/usefulness, risk severity, task satisfaction, reliance on unresolved assumptions | No — judgment | J2–J5 |

**Phase-1 status of every check below:** none is runtime-enforced. The Level 1 and Level 2
checklists define what a worker or orchestrator following the prompts should verify manually or
with future tooling; the vocabulary in §7 defines the states such tooling would record. Where a
check is "prompt-only today" that is stated inline.

## 4. Level 1 — Worker deterministic validation

Performed by the producing worker as a self-check **before** returning the handoff. Every check
is deterministic; a hard failure yields `worker-failed`; a check that cannot be completed
because evidence is unavailable yields `blocked-unknown` (§7). The worker's self-check is
advisory for admission: Level 2 re-derives everything (§5).

### C1 — JSON / schema / version validity

| # | Check | Deterministic source |
|---|---|---|
| C1.1 | The handoff is well-formed JSON (`JSON.parse` succeeds). | Pure function |
| C1.2 | The envelope validates against `./d2-handoff.schema.json` (Draft 2020-12): `version` is `const 1` (`:24-27`). | Schema `:24-27` |
| C1.3 | All 13 required top-level fields are present: `version`, `taskId`, `status`, `outcome`, `facts`, `assumptions`, `filesRead`, `filesChanged`, `verification`, `risks`, `followUp`, `artifactRefs`, `reviewState`. | Schema `:8-22` |
| C1.4 | **No unknown fields**: the envelope and every object definition set `additionalProperties: false`, so an unrecognized field anywhere is a validation error. | Schema `:7`, `:89`, `:107`, `:133`, `:156`, `:183`, `:211` |
| C1.5 | Field types, min/max lengths, patterns, and enum memberships hold: `status` (`:35`), `reviewState` (`:86`), verification `status` (`:181`), assumption `status` (`:141-144`), risk `severity` (`:198-201`). | Schema per-`$defs` |

### C2 — Task identity and outcome

| # | Check | Deterministic source |
|---|---|---|
| C2.1 | `taskId` is non-empty (`:29`) and is the exact task identity the parent assigned in the child prompt. | Child-prompt contract `src/core/policy.ts:27-36` |
| C2.2 | `status` is consistent with `outcome` and `verification`: `completed` may legitimately coexist with `not-run` verification entries only when those checks do not apply to the delivered change; `blocked`/`failed` must explain themselves in `outcome`/`risks`. | Schema `:34-37` |
| C2.3 | `outcome` is non-empty (`:39`) and answers the child prompt's "Expected outcome" (the definition of done). | `src/core/policy.ts:29-30` |

### C3 — Declared changes inside the exact scope

| # | Check | Deterministic source |
|---|---|---|
| C3.1 | Every `filesChanged[].path` falls inside the **exact write scope** the parent granted in the child prompt — scope is "the files I may touch", not "the whole repo". | `src/core/policy.ts:31` ("Scope/file ownership: the exact files or areas the child may touch, disjoint from other children") |
| C3.2 | Every `filesChanged[].scope` string describes the actual edit made; the declared set and the real edit set agree (the worker can spot-check with `git status`). | `src/core/policy.ts:71-95` (ledger records changed files) |
| C3.3 | Every `filesRead[].path` exists in the repository at the claimed state, or is explicitly documented as absent/created (e.g. a directory that existed only after scaffolding). | Schema `fileRef` `:152-168` |

### C4 — Required commands and honest status

| # | Check | Deterministic source |
|---|---|---|
| C4.1 | Every command named in the child prompt's "Must do … verification commands" appears in `verification[]` with an entry. | `src/core/policy.ts:33` |
| C4.2 | Each entry's `status` is from `not-run` / `blocked` / `fail` / `pass` (`:181`); `not-run` entries state why in `result` (`:188`); `pass`/`fail` entries carry an observed `result`, plus `evidence[]` where a reference exists. | Schema `:169-195` |
| C4.3 | No `pass` is claimed without an observed result, and no result is fabricated: each `pass` entry maps to a reproducible output or an evidence reference. | `/v3` authority rules, §9 |
| C4.4 | Command strings and results contain no secrets, env dumps, or raw transcripts. | `src/core/policy.ts:48-51` |

### C5 — Artifact existence and path safety

| # | Check | Deterministic source |
|---|---|---|
| C5.1 | `artifactRefs` of `kind: "file"` reference **relative repository paths that exist**; `kind: "url"` references match `^https://` only (no `http://`, no whitespace). | Schema `:214-255` (`if`/`then` on kind) |
| C5.2 | Path safety everywhere path-shaped: no leading `/`, no `.`/`..` path segments, no `://` scheme prefix, no quotes or control characters; names containing spaces or dots are allowed. | Schema `$defs/relativeRepoPath` `:91-97` |
| C5.3 | Artifacts are **references, not pasted transcripts**: `artifactRefs` point at stored files/URLs; nothing in the envelope embeds a raw conversation or command log. | D2 rationale `./d2-handoff.md:60-62`; plan `:329` |

### C6 — Facts vs assumptions

| # | Check | Deterministic source |
|---|---|---|
| C6.1 | Every `facts[].statement` carries **at least one** evidence reference (`minItems: 1`). Observed-behavior claims must cite a live source (`EVIDENCE_LIVE`/`EVIDENCE_MUTATION`, §9); structural claims must cite an exact path (+ line range where useful). | Schema `:105-123`; V3 §5 |
| C6.2 | Every assumption has `id`, `statement`, `status`, `evidence` (`:132-138`); `status` ∈ `Verified` / `Partially verified` / `Unverified` / `Not supported` (`:141-144`). `Unverified` with empty `evidence` is the honest state (`:148`); `Verified` requires evidence. | Schema `:124-151` |
| C6.3 | Nothing verified is dressed as an assumption and nothing unverified is dressed as a fact: any claim the worker cannot evidence belongs in `assumptions[]`, not `facts[]`. | Orchestration rule `src/core/policy.ts:80` ("Separate established facts from assumptions: label every assumption explicitly and verify it before relying on it") |

### C7 — No credentials, no raw transcripts

| # | Check | Deterministic source |
|---|---|---|
| C7.1 | No raw tokens, authorization headers, environment secrets, or OAuth credentials anywhere in the envelope — incl. `outcome`, `result`, `scope`, evidence refs, and artifact descriptions. | `src/core/policy.ts:48-51` |
| C7.2 | No raw tool stderr/stdout transcripts; process output referenced as evidence must pass the redactor. | `src/opencode-v2/process/redact.ts:13-60` (V3 [S16]) |
| C7.3 | No embedded credentials in URLs (`https://user:pass@…`), no URI-encoded secrets. | `src/core/policy.ts:48-51`; V3 §5 credential rules `:84-92` |

**Verdicts:** all of C1–C7 pass → `worker-passed`. Any hard failure → `worker-failed`. A check
that requires evidence the worker does not have and cannot obtain (e.g. a live capability probe
the worker cannot run) → `blocked-unknown`, not a guess.

## 5. Level 2 — Orchestrator deterministic re-verification

Performed by the parent/orchestrator **independently**, in the parent session, per
`src/core/policy.ts:91`: *"Verify worker claims directly in the parent session before reporting
completion; never present a worker's self-report as your own verification."* Level 2 treats the
handoff as hostile input: it re-derives every claim the receipt rests on.

### O1 — Independently revalidate the envelope

The orchestrator re-runs C1.1–C1.5 against the bytes it actually holds (schema, version, required
fields, unknown-field strictness, enum/pattern membership). It does **not** accept the worker's
declared `pass` for these checks; it re-executes them. No schema validator exists in Phase 1 —
this is a manual/prompt-driven or future-tooling step, not a runtime call.

### O2 — Compare declared files against git status/diff

| # | Check |
|---|---|
| O2.1 | `git status`/`git diff` in the **current workspace** against the recorded base (HEAD or the pre-task snapshot from the ledger, `src/core/policy.ts:86`): the set of real working-tree changes must equal the declared `filesChanged` set restricted to this task's scope. |
| O2.2 | Any real change within this task's scope that is **not** declared → `orchestrator-failed` (undeclared write). |
| O2.3 | Real changes **outside** this task's scope must be attributable to other concurrent tasks (cross-task attribution, O5) or to the user; un-attributable foreign changes → `blocked-unknown`, ask the user. |
| O2.4 | `filesRead` entries exist at the claimed paths, unless explicitly documented as absent/created. |

### O3 — Rerun required commands in the current workspace

| # | Check |
|---|---|
| O3.1 | The orchestrator reruns every required command **itself**, in the same workspace state the worker claims, comparing exit status and observable result with the declared entry. A declared `pass` is admitted only after the orchestrator's own run reproduces it. |
| O3.2 | If the orchestrator cannot rerun a required command because a capability is missing or untested → **`blocked-unknown`** (V3 rule 3 `:25`: missing live capability stays `unknown`, never inferred). Do not convert a `pass` from the worker's environment into the parent's verification. |
| O3.3 | If the declared command itself is not reproducible (e.g. an "ephemeral script kept outside the repo"), its declared result is **corroboration, not proof**; record the limitation as a residual risk for Level 3. |

### O4 — Artifact and local link checks

| # | Check |
|---|---|
| O4.1 | `artifactRefs` of `kind: "file"` exist at the declared relative paths (repository read — `EVIDENCE_STATIC`). |
| O4.2 | `kind: "url"` references are syntactically `^https://`; actual reachability is a live-network fact and is recorded as `EVIDENCE_LIVE` **only if** fetched in the current session, otherwise `unknown`. |
| O4.3 | Evidence anchors exist: a cited `path#L19-25` resolves to a real file whose line range is in bounds (static read). |
| O4.4 | Path safety re-checked verbatim (C5.2): no leading `/`, no `.`/`..` segments, no `://` in path-shaped fields, no quotes/control characters. |

### O5 — Cross-task IDs, dependencies, disjoint scopes

| # | Check |
|---|---|
| O5.1 | `taskId` is unique across concurrent tasks and matches the identity the parent assigned; no ID reuse. |
| O5.2 | Declared write scopes are **disjoint** across concurrent children (`src/core/policy.ts:78`); overlapping claims → `orchestrator-failed` until serialized (`:79`). Prompts are advisory, not isolation (`src/core/policy.ts:53-62`, `src/opencode-v2/plugin.ts:89`) — disjointness here is a *declared-contract* check, never a filesystem-isolation claim. |
| O5.3 | If the envelope references another task's output, that dependent task must itself hold a validated receipt before consumption ("Only a validated receipt should be passed to dependent tasks", `docs/orchestrator-improvements-plan.md:513`). A dependent task whose input is `worker-passed` at best → `blocked-unknown` until the input is admitted. |

### O6 — Capability evidence against V3

Every evidence reference backing a **behavioral or permission** claim is classified with one of
the V3 markers (§9): `EVIDENCE_LIVE`, `EVIDENCE_MUTATION`, `EVIDENCE_REGISTERED`,
`EVIDENCE_LOCAL`, `EVIDENCE_STATIC`, `UNKNOWN`. Classification rules:

| # | Rule |
|---|---|
| O6.1 | Evidence of any live or mutating action must be `EVIDENCE_LIVE` or `EVIDENCE_MUTATION` captured in the **current session** (V3 validation rule `:95`). |
| O6.2 | `EVIDENCE_LOCAL` (doctor) corroborates this machine's environment only; it never proves server-session capability or permission (V3 `:23`, `:60`). |
| O6.3 | `EVIDENCE_STATIC`/`EVIDENCE_REGISTERED` admit structural and catalog-presence claims only — never that an action executed (V3 `:90`, `:87`). |
| O6.4 | Any claim whose required evidence is missing or unobservable sits at `UNKNOWN` (V3 rule 3 `:25`); it cannot contribute to a pass verdict. |

### O7 — Reject stale evidence

Freshness markers (V3 `:93`): `per-invocation`, `per-session`, `config-load`,
`startup+events`, `doctor-run`, `install-snapshot`, `live-doc`. Evidence is **stale** when:

- its freshness point predates the workspace state the receipt describes (e.g. `config-load`
  evidence for a claim about a mutation that happened after startup);
- it claims a *live* outcome in this session but was captured before the session's last
  capability probe or tool invocation;
- it rests on `doctor-run` (snapshot of the local machine) while the claim is about the
  remote/server session.

Stale evidence → `orchestrator-failed` where the claim needs to be true for admission;
`blocked-unknown` when the freshest obtainable evidence is itself `unknown`.

### O8 — Reject missing evidence

`orchestrator-failed` when any of the following is missing: an evidence reference on a `fact`
(schema minItems 1), a `result`/`evidence` on a declared `pass`, the artifact file behind a
`kind: "file"` ref, or the live tool result behind a permission/liveness claim.

### O9 — Reject unsupported evidence

`orchestrator-failed`/not-admitted when evidence rests on an authority that cannot carry the
claim (V3 `:95`): `advisory` (`EVIDENCE_LOCAL`) or `documented-live` (live beta docs,
directional per `AGENTS.md`) evidence **cannot authorize a live, mutating action**;
`declared-absent` surfaces (e.g. the pinned package exposes no session-statistics surface,
V3 §2 row `:56`) reject any claim built on them.

**Verdicts:** all of O1–O9 pass → deterministic re-verification passed. Hard failure →
`orchestrator-failed`. Unobtainable/unknown evidence → `blocked-unknown` (stop and ask the user,
per `src/core/policy.ts:45`).

## 6. Level 3 — Reviewer judgment

Reviewer judgment is **not deterministic**; it exists because the plan's risk table names
deterministic checks against "correlated error" and calls for human review of high-risk actions
(`docs/orchestrator-improvements-plan.md:1006`). It applies only when review is required (§7.3).
Rubric:

| # | Judgment | What "pass" means |
|---|---|---|
| J1 | **Semantic correctness** | The `outcome` content matches the real diff; claims name code/docs that actually exist and behave as stated; no hallucinated lines, functions, or results. |
| J2 | **Completeness / usefulness** | The task's expected outcome (child contract) is fully addressed; `followUp` is concrete and actionable; every `assumption` is surfaced, not buried. |
| J3 | **Risks / privacy / security** | `risks[]` covers the real uncertainties with honest severities (`low`/`medium`/`high`/`critical`, schema `:198-201`); no credentials or raw transcripts anywhere; external side effects disclosed. |
| J4 | **Task satisfaction** | The aggregate change satisfies the original user task, considered together with the D4 classification — which is a *recommendation only* (`./d4-complexity-gate.md:104-109`) and can be overridden by the user. |
| J5 | **Unresolved assumptions** | Any `Unverified`/`Not supported` assumption the completion silently relies on → either reject (`review-rejected`), block (`blocked-unknown`), or accept with the risk recorded. Silent reliance on an unverified assumption is a fail. |

Review verdicts map: approve → `admitted`; changes-requested/reject → `review-rejected`;
reviewer blocked (unknown evidence, unavailable reviewer, contradictory evidence) →
`blocked-unknown`. D2's `reviewState` field (`not-requested`, `pending`, `approved`,
`changes-requested`, `blocked` — schema `:85-88`) tracks the review workflow state inside the
envelope; the §7 admission states track the receipt's validation lifecycle. They are different
axes: an envelope can carry `reviewState: "approved"` while its *admission* state is still
`candidate` because Levels 1–2 never ran.

## 7. Admission-state vocabulary (proposed, non-enforcing)

Eight states, exactly:

| State | Meaning | Terminal? |
|---|---|---|
| `candidate` | The worker produced a handoff/receipt; no validation has run. Initial state of every receipt. | no |
| `worker-failed` | Level 1 found a hard failure (schema, scope, artifacts, credentials, honest status). | **terminal** (for this receipt) |
| `worker-passed` | Level 1 passed; the receipt is not yet independently re-verified. | no |
| `orchestrator-failed` | Level 2 found a hard failure (git mismatch, rerun mismatch, stale/missing/unsupported evidence). | **terminal** (for this receipt) |
| `blocked-unknown` | Validation could not complete: required evidence is missing, stale in an unrecoverable way, or a live capability is `unknown` (V3 rule 3). Hard stop awaiting human input; **no automatic transition out**. | blocked, not terminal |
| `review-pending` | Levels 1–2 passed and review is required; the reviewer has not yet ruled. | no |
| `review-rejected` | The reviewer rejected the receipt (J1–J5 fail). | **terminal** (for this receipt) |
| `admitted` | The receipt is admitted for downstream consumption (dependent tasks may consume it). Nothing further happens to this receipt. | **terminal** |

**Admission rule (the definition of `admitted`):**

> `admitted` ⇐ (worker deterministic pass **∧** orchestrator deterministic pass) **∧**
> (review is required ⟹ reviewer approved).

The state names are strings in this document only: no parser, state store, or gate implements
them in Phase 1.

### 7.1 Allowed transitions

| From | To | Condition |
|---|---|---|
| `candidate` | `worker-failed` | Any C1–C7 hard failure |
| `candidate` | `worker-passed` | All C1–C7 pass |
| `candidate` | `blocked-unknown` | Level 1 hits evidence it cannot obtain (never guessed) |
| `worker-passed` | `orchestrator-failed` | Any O1–O9 hard failure or rejected evidence |
| `worker-passed` | `blocked-unknown` | Level 2 needs evidence that is missing/stale/`unknown` in the current session |
| `worker-passed` | `review-pending` | O1–O9 pass **and** review is required (§7.3) |
| `worker-passed` | `admitted` | O1–O9 pass **and** review is not required |
| `review-pending` | `admitted` | Reviewer approves (J1–J5 pass) |
| `review-pending` | `review-rejected` | Reviewer rejects or requests changes (J1–J5 fail) |
| `review-pending` | `blocked-unknown` | Reviewer unavailable or blocked on unknown evidence |
| `worker-failed` | `candidate` | Rework: task re-enters with a new receipt (same `taskId`) |
| `orchestrator-failed` | `candidate` | Rework: task re-enters with a new receipt |
| `review-rejected` | `candidate` | Rework after fixes; rounds bounded by the V1 circuit-breaker design (future, `docs/orchestrator-improvements-plan.md:446-487`) |
| `blocked-unknown` | *(human)* | **No automatic transition.** The orchestrator stops and asks the user (`src/core/policy.ts:45`); the human's decision produces a new `candidate` round or a refusal. |

### 7.2 Terminal and blocked semantics

- **Terminal states** — `worker-failed`, `orchestrator-failed`, `review-rejected`, `admitted` —
  are terminal *for the current receipt only*: a failed receipt can be superseded by a rework
  receipt arriving at `candidate` with the same `taskId`, so failure is never a dead end for the
  underlying task. `admitted` accepts no further transitions: downstream tasks may consume the
  receipt exactly as validated.
- **Blocked state** — `blocked-unknown` stops the pipeline and demands a human; it is not
  terminal and it must **never** auto-advance to a pass state. This implements V3's ground rule
  that a missing live capability stays `unknown` and is never inferred (`./v3-capability-matrix.md:25`).

### 7.3 Review requirement and `require_review` today

- "Review is required" is a property of the task class and config: with `require_review` default
  `true` (`src/core/config.ts:52`), policy text obligates the review role to audit the aggregate
  change (`src/core/policy.ts:90`); the D4 gate maps `high-risk` classes to
  `orchestrate-with-review` and `trivial` (e.g. docs-only edits) to `direct-execution-candidate`
  (`./d4-complexity-gate.md:38-59`, `:53`) — both are advisory.
- **`require_review` is not a runtime gate.** It is validated config consumed only as prompt
  text (`src/core/config.ts:52` → `src/core/prompts.ts:16` → `src/core/policy.ts:90`); there is
  no completion gate (`docs/phase-1/assumptions.md` A5 "Partially verified" at `:26`; plan
  `:1101`). This document's states are the *vocabulary* a future gate would use; today, nothing
  changes behavior, and a run can complete with no reviewer result.

## 8. Where evidence is checked against the envelope (D2 coupling)

The D2 schema already encodes most Level-1 structure, so the checklists refer to concrete
schema invariants rather than inventing a parallel contract:

| Envelope requirement | Schema location | Enforced by checklist |
|---|---|---|
| `version` pinned to `1` | `:24-27` | C1.2 |
| 13 required fields | `:8-22` | C1.3 |
| Unknown fields rejected (envelope + all object defs) | `:7`, `:89`, `:107`, `:133`, `:156`, `:183`, `:211` | C1.4 |
| `status` / `reviewState` / verification `status` / assumption `status` / severity enums | `:35`, `:86`, `:181`, `:141-144`, `:198-201` | C1.5 |
| Facts need ≥1 evidence ref | `:116-120` | C6.1 |
| Assumptions carry id/status; `Unverified` may be empty | `:132-148` | C6.2 |
| Path safety (relative repo paths) | `:91-97` | C5.2, O4.4 |
| Evidence refs: path-with-optional-anchor or https | `:98-104` | O4.3 |
| Artifact `kind`-conditional paths/URLs | `:214-255` | C5.1, O4.1–O4.2 |

## 9. Evidence admission rules (keyed to the V3 vocabulary)

Every capability claim in a receipt is classified with one V3 marker before it may influence
admission (`./v3-capability-matrix.md:80-95`). The authority split the task requires —
**`EVIDENCE_LIVE`/`EVIDENCE_MUTATION` as the only live/mutation authorities**, distinct from
advisory/local/static/unknown — is table row R1:

| V3 marker | What it admits | Freshness | Authority for admission |
|---|---|---|---|
| `EVIDENCE_LIVE` | A live server tool or host-catalog invocation in the **current session** produced this result | `per-invocation` | **Admits live-action and permission claims** (only together with `EVIDENCE_MUTATION` for mutations) |
| `EVIDENCE_MUTATION` | A validated typed response proving an external mutation (object `id` + URL, `verified`) | `per-invocation` | **Admits the mutation fact**; the only proof of GitHub-side permission (V3 `:46`, `:76`) |
| `EVIDENCE_REGISTERED` | Tool present in the session-visible catalog with name/namespace/input schema | `per-session` | Admits availability/presence only; **never** permission or execution |
| `EVIDENCE_LOCAL` | `doctor` probe of this machine | `doctor-run` | Advisory only; corroborates local environment; **never** authorizes live/mutating actions or server-session capability (V3 `:23`, `:41-44`) |
| `EVIDENCE_STATIC` | Source/config/declarations read at a pinned version | `config-load` / `install-snapshot` | Admits structural/config facts only; **never** runtime behavior (V3 `:90`) |
| `UNKNOWN` | Not directly tested; must not be inferred from an MCP name/status | n/a | **Never admitted.** A claim requiring `UNKNOWN` evidence → `blocked-unknown` (V3 `:25`) |

**E1 — Live-action admission:** only `EVIDENCE_LIVE`/`EVIDENCE_MUTATION` from the current
session admit a claim that a live action happened or a capability is usable
(「*only a `EVIDENCE_LIVE`/`EVIDENCE_MUTATION` result from the current session can*」, V3 `:95`).

**E2 — Structural admission:** `EVIDENCE_STATIC`/`EVIDENCE_REGISTERED` admit config, source, and
catalog-presence claims; they can never back an execution claim.

**E3 — Advisory non-admission:** `EVIDENCE_LOCAL` (doctor) corroborates only; it is never
authorization, and it cannot fail a report or print `gh` output (V3 `:23`, `:60`).

**E4 — Unknown non-admission:** `UNKNOWN` is never admission; a capability that must be live but
is untested stays `unknown` and the flow stops to ask the user (V3 `:25`, `:62`, `:78`).

**Rejection shortcuts (O7–O9 recap):** *stale* — evidence predates the workspace/session state
the receipt describes; *missing* — no reference where one is required; *unsupported* — advisory
or `documented-live` authority used to back a live/mutating claim (V3 `:95`). Each is a hard
`orchestrator-failed` (or `blocked-unknown` when only the freshest evidence is unavailable).

## 10. Worked example — evaluating D2's illustrative handoff

This section walks `./d2-handoff.example.json` through Levels 1–3 **as an illustration of the
checklists, not as an executed orchestration run**: the envelope is a design artifact whose own
document records exactly what was performed (`./d2-handoff.md:119-144`); it has never passed a
real admission gate (none exists), and task `issue-8-d2-handoff-schema-draft` (example `:3`) was
not executed as an orchestrated task. The deterministic re-checks below were re-run read-only
against the current working tree.

Envelope at a glance (example `:2-147`): `version: 1`, `status: "completed"`, 13/13 required
top-level fields, 4 facts with ≥1 evidence reference each, 2 assumptions, 4 `filesRead`,
3 `filesChanged` (all `docs/phase-1/d2-*`), 4 verification entries, 3 risks, 1 followUp,
4 artifactRefs, `reviewState: "not-requested"`.

### Level 1 verdicts (C1–C7)

| Check | Result | Basis |
|---|---|---|
| C1.1 well-formed JSON | **pass** | Read + `JSON.parse` on `./d2-handoff.example.json` and `./d2-handoff.schema.json` |
| C1.2–C1.4 version/required/unknown-field strictness | **pass** (top level) | `version: 1` matches `const` (`schema:24-27`); the 13 required keys are present and no extra top-level key exists (`schema:7-22`) |
| C1.5 enums | **pass** | `status`/`reviewState` in the declared enums; verification statuses ∈ {`not-run`,`pass`} |
| C2 task identity/outcome | **pass** | `taskId` non-empty and matches the design-task identity; `status: completed` coexists with the `not-run` typecheck entry, which is legitimate because the change is docs-only (schema `:34-37`; d2-handoff.md `:48-50`) |
| C3 scope | **pass** | `filesChanged` paths (`docs/phase-1/d2-handoff.schema.json`, `…example.json`, `…md`) are all inside the D2 scope `docs/phase-1/d2-*`; scope strings describe the actual writes (example `:64-77`) |
| C4 required commands & honest status | **pass** | The suite command is declared `not-run` with a reason (example `:79-83`); the three executed checks are `pass` with `evidence` refs (example `:85-107`) |
| C5 artifact/path safety | **pass** | All `artifactRefs` file refs exist (schema/example/md are present in this tree); the URL ref is `^https://` (example `:142-144`); paths are relative, no `.`/`..`, no `://` |
| C6 facts vs assumptions | **pass** | Every fact has ≥1 evidence ref (example `:6-31`); assumptions carry `Not supported` / `Verified` statuses with appropriate evidence (example `:32-45`); the unverified 40% claim is explicitly `Not supported`, not a fact |
| C7 secrets/transcripts | **pass** | No credentials, tokens, or raw transcripts anywhere in the envelope; artifacts are references (example `:124-145`) |

### Level 2 verdicts (O1–O9)

| Check | Result | Basis |
|---|---|---|
| O1 independent revalidation | **pass** | Re-run structurally (see C1 column above); declared results were not taken on faith |
| O2 git comparison | **pass with attribution note** | `git status` shows `docs/phase-1/` untracked; the 3 declared `filesChanged` are all part of the real delta **and** within the D2 scope. Foreign files in the same untracked directory (`v3-capability-matrix.md`, `assumptions.md`, `d4-*`, and this file) are attributable to other concurrent Phase-1 tasks with disjoint scopes (O5.2), so they neither fail nor block this receipt |
| O3 rerun required commands | **pass with limitation flag** | `JSON.parse` of both JSON files re-runs cleanly. The claimed schema-validation pass used an *ephemeral Bun script kept outside the repo* (`./d2-handoff.md:121-135`) — not rerunnable by the orchestrator, so it is logged as corroboration with a residual-risk note for Level 3, not upgraded to proof (O3.3) |
| O4 artifact/link checks | **pass** | File refs exist; the URL ref is syntactically `https` (reachability unprobed here → not claimed); evidence anchors such as `src/core/policy.ts#L19-25` resolve to real, in-range lines (verified at `src/core/policy.ts:19-25`) |
| O5 cross-task | **pass (N/A mostly)** | Single-task envelope; no dependency IDs to check; declared D2 scope is disjoint from the other phase-1 writers' files |
| O6 capability evidence vs V3 | **pass** | The facts are structural claims cited to repository paths/lines — correctly `EVIDENCE_STATIC` (V3 `:90`); no `EVIDENCE_LIVE`/`EVIDENCE_MUTATION` claim is made, so nothing is over-claimed; no permission/liveness claim exists to reject |
| O7 stale evidence | **pass** | All cited evidence is `config-load`/`install-snapshot`-fresh static facts; no stale live claim |
| O8 missing evidence | **pass** | Every fact has refs; every `pass` verification entry has a result (+ evidence); artifacts exist |
| O9 unsupported evidence | **pass** | No claim rests on `EVIDENCE_LOCAL` or `documented-live` authority |

### Level 3 (judgment) — recorded, not executed

Review was **not required** for this design-only artifact: the receipt declares
`reviewState: "not-requested"` (example `:146-147`), the change is docs-only (D4 `trivial` →
`direct-execution-candidate`, `./d4-complexity-gate.md:46-47,56`), and under §7.3 admission
requires reviewer approval only *when review is required*. That label is **illustrative and local
to this single receipt**: per-receipt trivial classification does not waive issue #8's aggregate
review obligation — the aggregate reviewer pass required before issue/PR completion still applies,
as documented in [`./README.md` §4, lines 95-98](./README.md) ("Reviewer requirement for this
issue"). If a reviewer had been engaged, the
judgments available on the record would be: **J1** outcome matches the three written files;
**J2** the D2 next step (design a minimal schema and test information preservation,
`docs/orchestrator-improvements-plan.md:346-348`) is fully addressed; **J3** risks are honestly
severity-labeled incl. the unverified external 40% claim (`example :109-122`, `./d2-handoff.md:110-120`), and no credentials appear; **J5** the `Not supported` token-reduction assumption is surfaced, not silently relied on.

### Illustrative conclusion

Under the proposed vocabulary: Levels 1–2 pass for the claims actually made (with the ephemeral-
validator corroboration flag), review is not required, so the receipt's verdict is
**`worker-passed` → `admitted` (illustrative)**. Two caveats keep this honest: (1) the envelope
never traversed a real gate — the verdict is an evaluation *of* the design artifact, not a run;
(2) the non-rerunnable scratch validator (`./d2-handoff.md:137-144`) means the in-depth schema
pass is corroboration, which any real admission would re-run against a maintained validator
before trusting at full weight.

## 11. Repository citations index

### Source code (exact paths and line ranges)

| Reference | Location | Role in this document |
|---|---|---|
| Five-field handoff format | `src/core/policy.ts:19-25` | The prose contract D2 preserves; `C2`/`C4` anchor outcomes and verification prose |
| Child-task contract (scope/verification/handoff) | `src/core/policy.ts:27-36` | Source of the worker's obligations checked in C2.1, C3.1, C4.1 |
| Preflight / secrets / boundary / worktree guidance | `src/core/policy.ts:41-46`, `:48-51`, `:53-57`, `:59-62` | C7, §5 stop-and-ask, disjoint scope advisory framing |
| Orchestration rules | `src/core/policy.ts:71-95` | Parent verifies directly (`:91`), disjoint scopes (`:78-79`), review obligation (`:90`), facts-vs-assumptions (`:80`), ledger (`:86`) |
| Config schema, `max_parallel`, `require_review` | `src/core/config.ts:47-110`, `:51`, `:52` | The only runtime-validated surface: `require_review` defaults `true` but is prompt-only |
| Prompt embedding | `src/core/prompts.ts:16`, `:28` | `orchestrationRules` and `HANDOFF_FORMAT` are text-only in prompts — no gate |
| Session context text | `src/opencode-v2/plugin.ts:84`, `:89` | Parallelism ceiling and "delegated children get no atomic isolation" are prompt text |
| Doctor advisory authority | `src/cli/doctor.ts:148-158`, `:164-248` | Basis for `EVIDENCE_LOCAL` never authorizing (§9 E3); see V3 [S3]–[S5] |
| CAPTURE rules | `src/opencode-v2/process/redact.ts:13-60`; `src/opencode-v2/gh/client.ts:301-345` | C7.2, §9 `EVIDENCE_LIVE`/`EVIDENCE_MUTATION` sourcing (V3 [S6], [S16]) |

### Phase-1 docs (this directory — cross-links)

- `./d2-handoff.schema.json` — envelope invariants: required `:8-22`, `additionalProperties` `:7`/`:89`/…, `version` `:24-27`, enums `:35,86,141-144,181,198-201`, path safety `:91-97`, evidence refs `:98-104`, facts `:105-123`, assumptions `:124-151`, fileRef `:152-168`, verificationEntry `:169-195`, risk `:197-213`, artifactRef `:214-255`
- `./d2-handoff.example.json` — illustrative envelope used in §10 (fields: `:2-147`)
- `./d2-handoff.md` — field mapping `:27-38`, added-field rationale `:40-63`, verification recorded `:119-144`, no-runtime-adoption `:146-159`
- `./v3-capability-matrix.md` — ground rules `:21-28`, §2 rows incl. prompt-only `require_review`/`max_parallel`/isolation `:50-52`, preflight flow `:68-78`, evidence vocabulary `:80-95`, validation rule `:95`, citations [S1]–[S20] `:99-120`
- `./d4-complexity-gate.md` — labels/precedence `:38-59`, review linkage `:53`, recommendation-only boundary `:104-113`
- `./assumptions.md` — A4 `:25`, A5 `:26`, evidence index `:35-50`
- `../orchestrator-improvements-plan.md` — V2 proposal `:489-535` (items `:497-513`, "validated receipt" `:513`, next step `:527-529`), V1 `:446-487`, risk-table mitigation `:1006`, Phase-2 terminal states `:1047`, assumptions A4/A5 `:1100-1101`

## 12. Phase-1 boundary and document verification

**Boundary.** This document adds no runtime parser, scheduler, state store, completion gate, or
schema change. It does not alter `src/`, `test/`, `package.json`, the README, or any other
file in the repository; `./docs/phase-1/d2-*`, `d4-*`, `v3-capability-matrix.md`, and
`assumptions.md` are read-only references here. `bun run typecheck && bun test && bun run build`
was intentionally **not** run: this is a documentation-only change; running the suite remains
the ship gate for the future implementation work (recorded here as a `not-run` class decision,
consistent with `./d2-handoff.md:142-144`).

**Verification performed on this document:**

1. All eight state names (`candidate`, `worker-failed`, `worker-passed`, `orchestrator-failed`,
   `blocked-unknown`, `review-pending`, `review-rejected`, `admitted`) and all three validation
   levels are present in §3/§7/§4-§6 above; the state names occur verbatim in the transitions
   table (§7.1).
2. `git diff --check` on this file reports no whitespace errors.
3. Local cross-links resolve: `./d2-handoff.schema.json`, `./d2-handoff.example.json`,
   `./d2-handoff.md`, `./v3-capability-matrix.md`, `./d4-complexity-gate.md`,
   `./assumptions.md`, and `../orchestrator-improvements-plan.md` all exist in the working tree.
4. `JSON.parse` of the D2 schema and example succeeds (read-only re-check, §10 Level 2).
5. Cited source line ranges were re-read and confirmed against `src/core/policy.ts`,
   `src/core/config.ts`, `src/core/prompts.ts`, and `src/opencode-v2/plugin.ts`.