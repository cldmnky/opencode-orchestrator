# V2 — Two-Level Validation Checklist and Admission-State Vocabulary

**Date:** 2026-08-30
**Issue:** #8 — Phase 1 design artifact for plan item V2 ("Two-Level Validation Before Downstream Admission", `docs/orchestrator-improvements-plan.md:489-535`; P0 row `:238`). **Issue #10** implemented the vocabulary and a callable validator (see Status).
**Status:** The design proposal (issue #8) is complete. Issue #10 implemented the **stateless admission vocabulary** (`transitionAdmission`, `src/core/admission.ts`, tool `orchestrator_admission_transition`) and a **callable fail-closed D2 validator** (`validateHandoff`, `src/opencode-v2/orchestration/validation.ts`, tool `orchestrator_handoff_validate`). What is **still not implemented**: runtime enforcement, a scheduler, a state store (the machine is stateless), a completion gate, worker-output interception hooks, and any telemetry. `require_review` remains validated config consumed as prompt text.
**Scope:** `docs/phase-1/v2-validation-checklist.md` only (source changes for issue #10 live in `src/core/admission.ts`, `src/core/contracts.ts`, and `src/opencode-v2/orchestration/{validation,tools}.ts`, with tests in `test/unit/admission.test.ts`, `test/unit/contracts.test.ts`, and `test/unit/orchestration-tools.test.ts`).
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
are defined (`docs/orchestrator-improvements-plan.md:1047`), issue #8 delivered vocabulary and a
checklist, and issue #10 implemented the deterministic core: worker-level C1–C7 and orchestrator-level
O2–O6 checks run inside the callable `orchestrator_handoff_validate` tool, and the eight-state
admission vocabulary is a stateless `orchestrator_admission_transition` tool. The **judgment layer
(J1–J5), review gating, state persistence, and completion gating remain unimplemented**.

Why the vocabulary is needed even without enforcement: the current `require_review` default is
`true` (`src/core/config.ts:52`) but is **prompt-only** — it changes policy text
(`src/core/policy.ts:110`, embedded at `src/core/prompts.ts:16`) and nothing else. There is no
completion gate (`docs/phase-1/assumptions.md` A5). The admission tools give the design a
vocabulary to talk about *what would happen* if a gate existed, and the validator lets the
orchestrator run the deterministic checks on demand — without pretending persistence or
enforcement exist.

## 2. Relationship to other Phase-1 artifacts

| Artifact | Relationship to this document |
|---|---|
| [`./d2-handoff.schema.json`](./d2-handoff.schema.json) | The envelope that Level 1 validates structurally (`version` `const 1` at `:24-27`, required fields `:8-22`, `additionalProperties: false` at `:7` and per-`$defs`, path/URL patterns `:91-104`, artifact kind rules `:214-255`). |
| [`./d2-handoff.example.json`](./d2-handoff.example.json) | Illustrative envelope that §10 walks through Levels 1–3 without claiming it was executed as an orchestrated run. |
| [`./d2-handoff.md`](./d2-handoff.md) | Field mapping (§2), added-field rationale (§3), rendering (§4); the runtime adoption boundary (§8) replacing the issue #8 no-runtime-adoption statement. |
| [`./v3-capability-matrix.md`](./v3-capability-matrix.md) | Supplies the evidence markers (`EVIDENCE_LIVE`, `EVIDENCE_MUTATION`, `EVIDENCE_REGISTERED`, `EVIDENCE_LOCAL`, `EVIDENCE_STATIC`, `UNKNOWN`) and freshness/authority markers that Level 2's evidence checks (§9) are keyed to; the vocabulary is now implemented (`src/opencode-v2/orchestration/evidence.ts`). |
| [`./d4-complexity-gate.md`](./d4-complexity-gate.md) | Gives a recommendation (advisory) on whether review is warranted for a task class (§3 labels); "review is required" in §7's decision rule follows its `high-risk` → `orchestrate-with-review` linkage. |
| [`./assumptions.md`](./assumptions.md) | A4 (parallelism prompt-only), A5 (review enforcement prompt-only) — the current-state basis for §7.3. |
| [`../orchestrator-improvements-plan.md`](../orchestrator-improvements-plan.md) | Source of record: V1 `:446-487`, V2 `:489-535`, V3 `:537+`, Phase-2 terminal-state activity `:1047`. |

## 3. The three validation levels at a glance

| Level | Who performs it | Nature | Checks | Verdict effect |
|---|---|---|---|---|
| **Level 1 — Worker deterministic** | The producing worker, against its own handoff and its assigned contract | Rule-based, machine-checkable | §4 (C1–C7) | `candidate` → `worker-failed` / `worker-passed` / `blocked-unknown` |
| **Level 2 — Orchestrator deterministic** | The parent/orchestrator session, independently of the worker's claims | Rule-based, machine-checkable, *re-derived* not trusted | §5 (O1–O9) | `worker-passed` → `orchestrator-failed` / `blocked-unknown` / `review-pending` / `admitted` |
| **Level 3 — Reviewer judgment** | The review role or a human, per the review obligation (`src/core/policy.ts:110`) | Judgment, rubric-based, not fully automatable | §6 (J1–J5) | `review-pending` → `admitted` / `review-rejected` / `blocked-unknown` |

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

**Runtime status of every check below (issue #10):** the deterministic checklists are implemented
inside the callable `orchestrator_handoff_validate` tool (`src/opencode-v2/orchestration/validation.ts`).
Worker level runs C1–C7; orchestrator level re-runs them and adds live VCS comparison (O2), the
required-command re-run limitation (O3), local evidence/artifact existence (O4), foreign-file
blocking (O5), and authority checks (O6). The tool is fail-closed and callable — not an automatic
gate. **Checks that the tool cannot perform remain explicitly unavailable:** required-command
re-runs always block at orchestrator level (O3, the pinned V2 API offers no re-run mechanism),
typed `EvidenceRecord` input is not accepted so URL evidence authority always blocks (O6), and all
J1–J5 reviewer judgment remains human/prompt territory. Where a check is only prompt-policy or
unavailable, that is stated inline.

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
declared `pass` for these checks; it re-executes them. The runtime validator does this
deterministically as check `c1-structure` (`parseD2Handoff`, `src/core/contracts.ts`) and fails
closed on any structural issue with a deterministic issue path.

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
per `src/core/policy.ts:111`).

**Implemented/unavailable split (issue #10):** the runtime validator (`validateHandoff`,
`src/opencode-v2/orchestration/validation.ts`) implements O1 (via `c1-structure` re-derivation),
O2 (live VCS comparison), O3 (re-run limitation → always `blocked-unknown` when the contract names
required commands), O4 (local evidence/artifact file existence + containment), O5 (foreign-file
attribution blocking), and O6 (authority: URL refs always block; local file refs pass only when
confirmed to exist). O7–O9 remain partially folded into implemented checks (C6 flags
`pass`-without-evidence; O4/O6 fail or block on missing/unsupported evidence) and otherwise stay
manual/hand-derived boundaries for the validator's caller. Anything unobservable by the validator
produces `blocked-unknown`, never an inferred pass.

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

## 7. Admission-state vocabulary (implemented as a stateless machine; non-enforcing)

Eight states, exactly — mirrored exactly by `ADMISSION_STATES` in `src/core/admission.ts`:

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

**Runtime status:** the vocabulary is implemented as the **stateless** machine
`transitionAdmission` in `src/core/admission.ts` (tool `orchestrator_admission_transition`), with a
deterministic result (`version: 1`, `accepted`, `from`, `to`, `reason`, `requiresHuman`,
`replacementReceipt`). It is not a state store: the caller owns the current state and persists
nothing. `blocked-unknown` never auto-advances (only a `new-receipt` signal with
`humanDecision: true` starts a rework round), and the machine never reads D2 `reviewState` — a
self-declared `approved` is never treated as approval. The validator maps its verdicts to
machine-appropriate admission states (`worker-failed`/`blocked-unknown`/`worker-passed` at worker
level; `orchestrator-failed`/`blocked-unknown`/`review-pending`/`admitted` at orchestrator level).

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
  change (`src/core/policy.ts:110`); the D4 gate maps `high-risk` classes to
  `orchestrate-with-review` and `trivial` (e.g. docs-only edits) to `direct-execution-candidate`
  (`./d4-complexity-gate.md:38-59`, `:53`) — both are advisory.
- **`require_review` is not a runtime gate.** It is validated config consumed only as prompt
  text (`src/core/config.ts:52` → `src/core/prompts.ts:16` → `src/core/policy.ts:110`); there is
  no completion gate (`docs/phase-1/assumptions.md` A5 "Partially verified" at `:26`; plan
  `:1101`). A run can complete with no reviewer result.
- **`admission_transition` uses an explicit contract `reviewRequired`.** In the implemented
  machine, an `orchestrator-pass` signal must carry `reviewRequired` (a task-class/config
  property passed through the task contract — **not** the envelope's self-declared `reviewState`);
  it branches to `review-pending` when true and `admitted` when false. That is an explicit,
  caller-supplied branch — **not** a completion hook, and nothing consumes a transition
  automatically.

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
checklists, not as an executed orchestration run**: the envelope is an issue #8 design artifact,
task `issue-8-d2-handoff-schema-draft` (example `:3`) was not executed as an orchestrated task,
and the historical walk below is preserved as originally written. It has **never traversed a
real orchestrated child hook** — even though the current runtime parser tests accept the file, no
worker ever emitted (or validated) this envelope through the implemented tooling. The deterministic
re-checks below were re-run read-only against the current working tree at issue #8 time.

> **Runtime note (issue #10):** the current maintained parser (`test/unit/contracts.test.ts`
> `parseD2Handoff`/`D2_HANDOFF_SCHEMA`) accepts this example, and the D2 structural promt-side
> claims in this walk line up with the implemented C1–C3/C5/C6 checks. That is a **parser-level
> acceptance test only** — it is not a live orchestration run, and it does not change the
> illustrative verdict below.

Envelope at a glance (example `:2-147`): `version: 1`, `status: "completed"`, 13/13 required
top-level fields, 4 facts with ≥1 evidence reference each (current tree: 5), 2 assumptions,
4 `filesRead`, 3 `filesChanged` (all `docs/phase-1/d2-*`), 4 verification entries, 3 risks,
1 followUp, 4 artifactRefs, `reviewState: "not-requested"`.

### Level 1 verdicts (C1–C7)

| Check | Result | Basis |
|---|---|---|
| C1.1 well-formed JSON | **pass** | Read + `JSON.parse` on `./d2-handoff.example.json` and `./d2-handoff.schema.json` |
| C1.2–C1.4 version/required/unknown-field strictness | **pass** (top level) | `version: 1` matches `const` (`schema:24-27`); the 13 required keys are present and no extra top-level key exists (`schema:7-22`) |
| C1.5 enums | **pass** | `status`/`reviewState` in the declared enums; verification statuses ∈ {`not-run`,`pass`} |
| C2 task identity/outcome | **pass** | `taskId` non-empty and matches the design-task identity; `status: completed` coexists with the `not-run` typecheck entry, which is legitimate because the change is docs-only (schema `:34-37`; d2-handoff.md `:48-50`) |
| C3 scope | **pass** | `filesChanged` paths (`docs/phase-1/d2-handoff.schema.json`, `…example.json`, `…md`) are all inside the D2 scope `docs/phase-1/d2-*`; scope strings describe the actual writes (example `:64-77`) |
| C4 required commands & honest status | **pass** | The suite command is declared `not-run` with a reason (example `:88-92`); the three executed checks are `pass` with `evidence` refs (example `:93-116`) |
| C5 artifact/path safety | **pass** | All `artifactRefs` file refs exist (schema/example/md are present in this tree); the URL ref is `^https://` (example `:149-153`); paths are relative, no `.`/`..`, no `://` |
| C6 facts vs assumptions | **pass** | Every fact has ≥1 evidence ref (example `:6-39`); assumptions carry `Not supported` / `Verified` statuses with appropriate evidence (example `:41-54`); the unverified 40% claim is explicitly `Not supported`, not a fact |
| C7 secrets/transcripts | **pass** | No credentials, tokens, or raw transcripts anywhere in the envelope; artifacts are references (example `:133-153`) |

### Level 2 verdicts (O1–O9)

| Check | Result | Basis |
|---|---|---|
| O1 independent revalidation | **pass** | Re-run structurally (see C1 column above); declared results were not taken on faith |
| O2 git comparison | **pass with attribution note** | `git status` shows `docs/phase-1/` untracked; the 3 declared `filesChanged` are all part of the real delta **and** within the D2 scope. Foreign files in the same untracked directory (`v3-capability-matrix.md`, `assumptions.md`, `d4-*`, and this file) are attributable to other concurrent Phase-1 tasks with disjoint scopes (O5.2), so they neither fail nor block this receipt |
| O3 rerun required commands | **pass with limitation flag** | `JSON.parse` of both JSON files re-runs cleanly. The claimed schema-validation pass used an *ephemeral Bun script kept outside the repo* (`./d2-handoff.md:141-152`) — not rerunnable by the orchestrator, so it is logged as corroboration with a residual-risk note for Level 3, not upgraded to proof (O3.3) |
| O4 artifact/link checks | **pass** | File refs exist; the URL ref is syntactically `https` (reachability unprobed here → not claimed); evidence anchors such as `src/core/policy.ts#L19-25` resolve to real, in-range lines (verified at `src/core/policy.ts:19-25`) |
| O5 cross-task | **pass (N/A mostly)** | Single-task envelope; no dependency IDs to check; declared D2 scope is disjoint from the other phase-1 writers' files |
| O6 capability evidence vs V3 | **pass** | The facts are structural claims cited to repository paths/lines — correctly `EVIDENCE_STATIC` (V3 `:90`); no `EVIDENCE_LIVE`/`EVIDENCE_MUTATION` claim is made, so nothing is over-claimed; no permission/liveness claim exists to reject |
| O7 stale evidence | **pass** | All cited evidence is `config-load`/`install-snapshot`-fresh static facts; no stale live claim |
| O8 missing evidence | **pass** | Every fact has refs; every `pass` verification entry has a result (+ evidence); artifacts exist |
| O9 unsupported evidence | **pass** | No claim rests on `EVIDENCE_LOCAL` or `documented-live` authority |

### Level 3 (judgment) — recorded, not executed

Review was **not required** for this design-only artifact: the receipt declares
`reviewState: "not-requested"` (example `:155-156`), the change is docs-only (D4 `trivial` →
`direct-execution-candidate`, `./d4-complexity-gate.md:46-47,56`), and under §7.3 admission
requires reviewer approval only *when review is required*. That label is **illustrative and local
to this single receipt**: per-receipt trivial classification does not waive issue #8's aggregate
review obligation — the aggregate reviewer pass required before issue/PR completion still applies,
as documented in [`./README.md` (Definition of done)](./README.md). If a reviewer had been engaged, the
judgments available on the record would be: **J1** outcome matches the three written files;
**J2** the D2 next step (design a minimal schema and test information preservation,
`docs/orchestrator-improvements-plan.md:346-348`) is fully addressed — issue #10 later completed it;
**J3** risks are honestly
severity-labeled incl. the unverified external 40% claim (`example :118-130`, `./d2-handoff.md:135-165`), and no credentials appear; **J5** the `Not supported` token-reduction assumption is surfaced, not silently relied on.

### Illustrative conclusion

Under the proposed vocabulary: Levels 1–2 pass for the claims actually made (with the ephemeral-
validator corroboration flag), review is not required, so the receipt's verdict is
**`worker-passed` → `admitted` (illustrative)**. Three caveats keep this honest: (1) the envelope
never traversed a real gate or hook — the verdict is an evaluation *of* the design artifact, not a
run; (2) the non-rerunnable scratch validator (`./d2-handoff.md:157-165`) means the in-depth schema
pass is corroboration, which any real admission would re-run against a maintained validator
before trusting at full weight; (3) the current runtime parser tests (`test/unit/contracts.test.ts`)
accept the file, but that is a parser-level acceptance of a static JSON document — it still never
traversed a real orchestrated child hook, and nothing here claims the receipt was admitted by a
live run.

## 11. Repository citations index

### Source code (exact paths and function names; line ranges where stable)

| Reference | Location | Role in this document |
|---|---|---|
| Five-field handoff format | `src/core/policy.ts:19-25` (`HANDOFF_FORMAT`) | The prose contract the D2 envelope preserves; `C2`/`C4` anchor outcomes and verification prose |
| Child-task contract (scope/verification/handoff) | `src/core/policy.ts:27-36` (`CHILD_TASK_CONTRACT`) | Source of the worker's obligations checked in C2.1, C3.1, C4.1 |
| Structured-handoff guidance | `src/core/policy.ts:82-89` (`STRUCTURED_HANDOFF_GUIDANCE`) | Asks workers for the version-1 envelope and the parent to call `orchestrator_handoff_validate` (issue #10) |
| Preflight / secrets / boundary / worktree guidance | `src/core/policy.ts:41-46`, `:48-51`, `:53-57`, `:59-62` | C7, §5 stop-and-ask, disjoint scope advisory framing |
| Orchestration rules | `src/core/policy.ts:91-115` (`orchestrationRules`) | Parent verifies directly (`:111`), disjoint scopes (`:98-99`), review obligation (`:110`), facts-vs-assumptions (`:100`), ledger (`:106`) |
| Config schema, `max_parallel`, `require_review` | `src/core/config.ts:47-110`, `:51`, `:52` | The only runtime-validated surface: `require_review` defaults `true` but is prompt-only |
| Prompt embedding | `src/core/prompts.ts:16`, `:28` | `orchestrationRules` and `HANDOFF_FORMAT` are text-only in prompts — no gate |
| Session context text | `src/opencode-v2/plugin.ts:85-101` | Parallelism ceiling (`:90`) and "delegated children get no atomic isolation" (`:96`) are prompt text; the validation tools are named at `:97` |
| Admission state machine | `src/core/admission.ts` (`transitionAdmission`, `ADMISSION_STATES`) | The implemented eight-state vocabulary + stateless transition function (issue #10) |
| D2 runtime mirror | `src/core/contracts.ts` (`parseD2Handoff`, `validateD2Handoff`, `validateD2Semantics`, `renderD2Handoff`) | The implemented schema/structural/semantic/render primitives backing C1/C6 (§4) and O1 (§5) |
| Handoff validator | `src/opencode-v2/orchestration/validation.ts` (`validateHandoff`; `src/opencode-v2/orchestration/tools.ts` for the tool) | C1–C7 / O2–O6 deterministic validation at worker/orchestrator level (issue #10) |
| Doctor advisory authority | `src/cli/doctor.ts:148-158`, `:164-248` | Basis for `EVIDENCE_LOCAL` never authorizing (§9 E3); see V3 [S3]–[S5] |
| CAPTURE rules | `src/opencode-v2/process/redact.ts:13-60`; `src/opencode-v2/gh/client.ts:301-345` | C7.2, §9 `EVIDENCE_LIVE`/`EVIDENCE_MUTATION` sourcing (V3 [S6], [S16]) |

### Phase-1 docs (this directory — cross-links)

- `./d2-handoff.schema.json` — envelope invariants: required `:8-22`, `additionalProperties` `:7`/`:89`/…, `version` `:24-27`, enums `:35,86,141-144,181,198-201`, path safety `:91-97`, evidence refs `:98-104`, facts `:105-123`, assumptions `:124-151`, fileRef `:152-168`, verificationEntry `:169-195`, risk `:197-213`, artifactRef `:214-255`
- `./d2-handoff.example.json` — illustrative envelope used in §10 (fields `:2-156`)
- `./d2-handoff.md` — field mapping §2, added-field rationale §3, rendering §4, issue #8 draft verification §7, runtime adoption boundary §8, issue #10 runtime verification §9
- `./v3-capability-matrix.md` — ground rules §1, authority matrix §2, preflight flow §4, evidence vocabulary §5, citations index §6
- `./d4-complexity-gate.md` — labels/precedence §3, review linkage §3, recommendation-only boundary (incl. callable classifier) §6, no-results statement §7
- `./assumptions.md` — A4/A5 ledger rows, evidence index, verification backlog, and the dated issue #10 implementation note
- `../orchestrator-improvements-plan.md` — V2 proposal `:489-535` (items `:497-513`, "validated receipt" `:513`, next step `:527-529`), V1 `:446-487`, risk-table mitigation `:1006`, Phase-2 terminal states `:1047`, assumptions A4/A5 `:1100-1101`

## 12. Phase-1 boundary and document verification

**Boundary.** Issue #8 added no runtime parser, scheduler, state store, completion gate, or schema
change. Issue #10 implemented the **callable** admission vocabulary and handoff validator described
above — still **no automatic hooks, no enforcement, no state persistence, no telemetry**. Neither
issue altered `package.json`; `./docs/phase-1/d4-task-corpus.json` and
`./d4-evaluation-template.json` remain frozen and unmeasured. At issue #8 time,
`bun run typecheck && bun test && bun run build` was intentionally **not** run (documentation-only
change). For issue #10 the parent-verified repository checks pass (see the
[phase-1 README §6](./README.md)): `bun run typecheck`, full `bun test` (456 pass / 1 skip / 0 fail,
457 tests across 18 files), `bun run build` (all five bundles), and `npm pack` + `dist/index.js`
import. The **shared-service live-reload smoke is inconclusive** (the `opencode2 api get
/api/plugin` probe did not list this plugin and the service was not restarted). The **final
independent aggregate review passed** with no blocking or major findings.

**Verification performed on this document:**

1. All eight state names (`candidate`, `worker-failed`, `worker-passed`, `orchestrator-failed`,
   `blocked-unknown`, `review-pending`, `review-rejected`, `admitted`) and all three validation
   levels are present in §3/§7/§4-§6 above; the state names occur verbatim in the transitions
   table (§7.1) and match `ADMISSION_STATES` in `src/core/admission.ts`.
2. `git diff --check` on this file reports no whitespace errors.
3. Local cross-links resolve: `./d2-handoff.schema.json`, `./d2-handoff.example.json`,
   `./d2-handoff.md`, `./v3-capability-matrix.md`, `./d4-complexity-gate.md`,
   `./assumptions.md`, and `../orchestrator-improvements-plan.md` all exist in the working tree.
4. `JSON.parse` of the D2 schema and example succeeds, and the example passes the maintained
   runtime mirror (`parseD2Handoff`/`D2_HANDOFF_SCHEMA` in `test/unit/contracts.test.ts`).
5. Cited source line ranges were re-read and confirmed against `src/core/policy.ts`,
   `src/core/config.ts`, `src/core/prompts.ts`, `src/opencode-v2/plugin.ts`, and the issue #10
   modules (`src/core/admission.ts`, `src/core/contracts.ts`,
   `src/opencode-v2/orchestration/{validation,tools}.ts`).
