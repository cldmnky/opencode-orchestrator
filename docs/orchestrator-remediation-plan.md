# OpenCode Orchestrator Remediation Plan

## Implementation status

Updated continuously as the remediation lands in mergeable PRs. Completed
items are checked only after their production behavior and tests are merged.

- [x] Baseline fixtures restored and committed.
- [x] Phase 0 contract-fixture documentation, state inventory, and fixture-presence tests.
- [x] Phase 1 fresh temporary bundle for Phase A/D contract tests, verification scripts, CI workflow, and publish-tag ordering.
- [x] Phase 2 capability vocabulary and initial claim/prompt alignment.
- [x] Phase 3 plugin-observed verification receipts and read-only receipt discovery.
- [ ] Phase 4 reviewer-child provenance and review V2.
- [ ] Phase 5 lead-board V2 and completion-chain migration.
- [ ] Phase 6 runtime parallel dispatch admission (or documented host limitation).
- [ ] Phase 7 model-visible surface reduction and D4 v2 removal.
- [ ] Phase 8 installer migration, live doctor, and state recovery.
- [ ] Phase 9 read-only orchestration progress RPC/TUI.
- [ ] Phase 10 declarations, package API, and bundle cleanup.
- [ ] Phase 11 final documentation and release verification.

The current branch implements the first three foundational slices. Phase 3
measured the pinned beta-19507 shell hook, added bounded plugin-observed
receipts, and replaced lead command-proof claims with exact-revision receipt
matching. Later status updates will record exact host-contract findings and any
item that remains advisory because beta-19507 cannot provide the required
provenance.

## Purpose

This document is the implementation plan for hardening, simplifying, and completing the OpenCode V2 orchestrator plugin. It is written for an implementer agent expected to carry the work from the current repository state through tests, documentation, migration, and release readiness.

The plan addresses four findings:

1. The repository has a strong safety foundation, especially around Git, GitHub, worktrees, strict state, and fail-closed publication.
2. Some user-facing claims are stronger than the runtime guarantees. In particular, concurrency limits, command reruns, and reviewer identity are not currently provenance-bound.
3. The model-visible control plane is too large: up to 38 tools, 11 commands, and several overlapping state machines.
4. Build, test, packaging, migration, and operator recovery need to become reproducible and easier to use.

This is a V2-only plan. Do not add V1 compatibility. Before changing plugin, CLI plugin, or HTTP integration code, re-read:

- <https://opencode.ai/v2/docs/build/plugins>
- <https://opencode.ai/v2/docs/build/plugins/cli>
- <https://opencode.ai/v2/docs/api>
- <https://opencode.ai/v2/openapi.json>

The repository is pinned to `@opencode/plugin` and `@opencode/sdk` `0.0.0-beta-19507`. Any change that depends on host behavior must be proven against that pinned version before production code relies on it.

---

## Current baseline

At the time this plan was written:

- `bun run typecheck` passes.
- The restored D2/D4 fixtures make the source unit suite green.
- The latest full suite reports 1,075 passing tests, one skipped test, and no failures after a fresh build.
- Contract tests for Phase A and Phase D build a private temporary bundle per test process; they no longer consume ignored `dist/` output.
- A checked-in GitHub Actions workflow runs typecheck, unit tests, contract tests, build, and package smoke verification.
- The plugin can register up to 38 model-visible tools and 11 slash commands.
- `max_parallel` is prompt guidance, not a runtime limit.
- Lead-board command checks are supplied by the orchestrator as `{ id, verdict }` values. The plugin does not prove that the lead actually ran those commands.
- Bounded review stores caller-supplied maker/checker identities. The plugin does not prove which child session produced the review.
- `src/core/d4v2.ts` is currently tested but is not wired into a runtime tool or exported from the package entrypoint; Phase 7 removes it.
- `src/opencode-v2/session/state.ts` still contains a separate, unused `worktree/v1` model while runtime worktrees use `src/opencode-v2/worktree/state.ts` and `worktree/v2`.
- The README refers to deleted assets and deleted narrative documentation.

Preserve the restored fixtures throughout the work:

- `docs/phase-1/d2-handoff.schema.json`
- `docs/phase-1/d2-handoff.example.json`
- `docs/phase-1/d4-task-corpus.json`

---

## Target outcome

The completed plugin must have the following properties:

1. A fresh checkout can run the documented verification commands without pre-existing generated files.
2. Every claim described as enforced is backed by plugin-observed state or a host-provided boundary. Prompt guidance is labeled as guidance.
3. Verification receipts are derived from actual, permission-approved tool executions and are bound to the lead session and exact revision.
4. Review receipts are submitted by the configured reviewer child session, not synthesized by the orchestrator.
5. `max_parallel` is enforced at the model-visible subagent dispatch boundary when the pinned host contract permits it.
6. Unsupported guarantees fail closed and are described truthfully; no unsupported native scheduler or exactly-once guarantee is invented.
7. The model-visible orchestration surface is materially smaller and has one canonical path for each operation.
8. Existing installations have a documented, test-covered migration path.
9. The TUI exposes useful orchestration progress without reading server storage directly.
10. The published package has declarations, fresh bundles, a packed-package smoke test, and no broken documentation links.

---

## Architectural principles

Apply these rules in every phase:

### Enforcement requires provenance

A model-provided boolean, string, role name, or evidence reference is a claim, not proof. Enforcement decisions may rely only on:

- Plugin-owned state written from a validated runtime callback.
- A typed OpenCode host event or hook proven by a pinned contract test.
- A validated Git/GitHub operation performed through the existing safe clients.
- Explicit user-owned configuration or command state.

### Preserve least privilege

Do not add a plugin-owned arbitrary command runner that bypasses the host's `shell` permission. Verification must observe a command that was already admitted by the host. If the pinned hook cannot prove command success, retain advisory verification and correct the product wording instead of creating a privileged workaround.

### Fail closed without dead-ending the user

Every refusal must include:

- What failed or is unknown.
- What the refusal protects.
- The next safe recovery action.

Malformed durable state must remain non-executable, but the operator must gain an inspect/export/archive/reset path.

### One state machine per concern

Do not add another model-managed state machine. Internalize transitions when possible. The model should request an operation; plugin code should compute the resulting transition.

### Keep persisted data bounded and non-sensitive

Do not persist prompts, transcripts, tool output, command output, headers, credentials, or arbitrary provider payloads. New records must use strict schemas, bounded strings and arrays, versioned keys, redaction where text is unavoidable, and deterministic parsing.

### Keep `src/core/` independent

Pure configuration, policy, schemas, and deterministic transitions belong in `src/core/`. Filesystem, process, OpenCode context, CLI, and storage adapters remain outside it.

---

## Scope and non-goals

### In scope

- Reproducible tests and CI.
- Truthful documentation and prompts.
- Plugin-observed verification receipts.
- Reviewer-child provenance.
- Runtime subagent concurrency admission.
- Lead-board and review schema migrations.
- Tool and command consolidation.
- Installer migration and live doctor support.
- Read-only TUI progress.
- Package declarations and bundle hygiene.
- Removal of dead and low-value surfaces.

### Explicit non-goals

- OpenCode V1 support.
- Cross-process transactions or exactly-once execution when the host storage API has no CAS/transaction primitive.
- A native autonomous child scheduler unless the pinned V2 API exposes a supported child-spawn API.
- Filesystem sandboxing or atomic child worktree assignment.
- Storing raw command output to prove verification.
- Proving human identity behind `/publish`.
- Replacing host-configured GitHub MCP. The plugin's own guarded publication path remains separate.

---

## Delivery strategy

Implement this work as ordered, independently green slices. Every slice must include production code, tests, documentation, and migration behavior where applicable. Do not begin broad surface removal before the replacement path is tested.

Recommended pull-request sequence:

1. Reproducible verification and CI.
2. Truthfulness and policy deduplication.
3. Verification-receipt contract probe and runtime.
4. Reviewer-child provenance and review V2.
5. Lead-board V2 and publication integration.
6. Runtime parallel dispatch admission.
7. Tool/command consolidation and removals.
8. Installer migration, live doctor, and state recovery.
9. TUI progress view.
10. Package declarations, bundle cleanup, documentation, and release verification.

Each phase below includes exact deliverables and acceptance criteria.

---

## Phase 0 — Freeze and characterize the current contract

### Objective

Record a clean baseline before changing behavior and make test fixtures first-class repository assets.

### Work

1. Keep the three restored JSON fixtures tracked.
2. Add a short `docs/phase-1/README.md` explaining that these JSON files are executable contract fixtures, not disposable planning artifacts.
3. Add a test that checks every repository-relative path loaded at test module initialization exists.
4. Capture the current model-visible command and tool inventory in a test fixture generated from source registration, not handwritten documentation.
5. Add a baseline assertion for default and fully enabled tool counts. This test will be intentionally updated during consolidation.
6. Record current storage prefixes and schema versions in a migration table under `docs/state-migrations.md`.

### Files

- `docs/phase-1/README.md`
- `docs/state-migrations.md`
- `test/unit/repository-fixtures.test.ts`
- `test/contract/plugin.test.ts`

### Acceptance criteria

- Deleting any required fixture causes a targeted, readable test failure.
- The tool inventory test identifies the registering module for every tool.
- The state migration table includes goal, run, halt, lead board, steps, review, authority, publish, gates, worker models, worktree, and session anchors.

---

## Phase 1 — Make build, test, and release verification reproducible

### Objective

Make all verification commands independent of ignored local artifacts and prevent stale bundles from being tested.

### Work

#### 1. Build contract-test bundles in a temporary directory

Create `test/contract/helpers/build-plugin.ts` using `Bun.build` to compile `src/index.ts` into a test-owned temporary directory. It must:

- Build once per test process.
- Return a file URL for the fresh entrypoint.
- Surface build diagnostics clearly.
- Clean up its directory after the suite.
- Never write into repository `dist/`.

Replace the direct `../../dist/index.js` imports in:

- `test/contract/phase-a-hooks.test.ts`
- `test/contract/phase-d-retry.test.ts`

Keep one explicit distribution smoke test that runs the real package build and verifies the resulting entrypoints. That smoke test may use `dist/`, but it must run only after invoking the build itself.

#### 2. Split verification scripts

Add package scripts with unambiguous responsibilities:

- `test:unit`
- `test:contract`
- `test:package`
- `verify` = typecheck + unit + contract + build + package smoke

Keep `bun test` working from a clean checkout because repository instructions currently advertise it.

#### 3. Add CI

Add `.github/workflows/ci.yml` that:

1. Checks out the repository.
2. Installs the pinned Bun version.
3. Runs `bun install --frozen-lockfile`.
4. Runs `bun run typecheck`.
5. Runs unit tests.
6. Runs contract tests.
7. Runs the build.
8. Runs `npm pack --dry-run` and the packed-package smoke test.
9. Verifies `git status --short` is empty after non-build test jobs.

Use job timeouts and preserve test logs on failure. Do not let tests reach external networks unless a contract test explicitly installs a loopback-only guard.

#### 4. Harden release ordering

Update `scripts/publish.sh` so verification and package creation complete before creating or pushing a tag. A failed npm publish must not leave a newly pushed release tag.

Do not accept OTP on a command-line argument because it can be visible in process listings. Keep interactive npm handling or a documented secure environment mechanism.

### Acceptance criteria

- A checkout with no `dist/` passes unit and contract tests.
- Touching source after a build cannot cause tests to silently use the old bundle.
- CI catches a deleted fixture.
- CI catches a stale or malformed package export.
- Tags are not created before all verification and pack checks pass.

---

## Phase 2 — Make claims and prompts match runtime guarantees

### Objective

Remove contradictions and ensure the README, tool descriptions, status messages, and system prompts use the same vocabulary for guidance, recorded claims, and enforced proof.

### Work

#### 1. Introduce a capability vocabulary

Create a pure module such as `src/core/capabilities.ts` defining:

- `guidance`: prompt-only preference.
- `recorded`: strict state supplied through a tool, but without actor provenance.
- `observed`: plugin-observed host or process event.
- `enforced`: a runtime operation refuses without the required observed/configured state.

Use these terms in documentation and generated prompt text.

#### 2. Centralize feature guidance

Refactor duplicated policy assembly in:

- `src/core/policy.ts`
- `src/core/prompts.ts`
- `src/opencode-v2/plugin.ts`

Create one structured capability-to-guidance renderer. The startup context hook should append only dynamic facts that are not already in the agent system prompt.

Remove the contradiction in `src/core/policy.ts` that says automated PR coordination requires the user to perform it while publication supports autonomous PR lifecycle.

#### 3. Correct current claims before new enforcement lands

Until later phases are complete:

- Describe `max_parallel` as an instructed ceiling.
- Describe lead command checks as orchestrator-recorded results.
- Describe bounded review as an orchestrator-recorded review receipt whose caller identity is not proven.
- State near the quick start that default review is prompt-based and authority is off.
- Keep publication's exact-SHA and remote verification claims, which are already runtime enforced.

#### 4. Add claim consistency tests

Add tests that assert prohibited phrases do not appear when the backing capability is only advisory. Examples:

- No “runtime concurrency cap” before the dispatch limiter is enabled.
- No “reviewer-proven” language for V1 review records.
- No “command was rerun” language for caller-supplied checks.

### Acceptance criteria

- Each important README claim maps to a named capability level.
- Prompt variants no longer contradict one another.
- Default configuration documentation clearly separates prompt policy from enforcement.
- Policy text remains concise enough that existing readability tests pass.

### Progress

Phase 2 introduced `src/core/capabilities.ts` and embedded one shared
vocabulary in orchestration, worker, continuation, and command prompts. Current
wording calls `max_parallel` guidance, plugin-observed lead command validation
enforced, V1 review identity recorded, and publication revision checks
enforced. The GitHub guidance no longer contradicts the autonomous publication
lifecycle. The remaining claim cleanup is coupled to the Phase 4–6 provenance
work and will be updated as those phases land.

---

## Phase 3 — Add plugin-observed verification receipts

### Objective

Replace caller-supplied passing command checks with receipts derived from actual host-admitted shell tool executions.

### 3A. Contract probe first

Before production implementation, extend the pinned embedded-host contract suite to measure `tool.hook("execute.before")` and `tool.hook("execute.after")` for the native shell tool.

The probe must establish:

- Exact tool name.
- Input shape containing the command.
- Whether the input is stable between before and after.
- Completed result shape and the field that proves zero/non-zero exit.
- Error shape.
- Session ID, agent ID, message ID, and call ID stability.
- Hook order.
- Disposal behavior.
- Whether throwing from the before hook prevents execution.
- No external network access.

Write the measured contract into a small current document under `docs/contracts/verification-hook.md` and pin it in tests.

If the pinned host cannot reliably expose command identity and success, stop this phase after the probe, retain recorded/advisory checks, and keep the corrected wording from Phase 2. Do not create an arbitrary privileged runner.

### 3B. Receipt schema

If the contract probe succeeds, add:

- `src/opencode-v2/verification/state.ts`
- `src/opencode-v2/verification/runtime.ts`
- `src/opencode-v2/verification/tools.ts` for bounded read-only receipt-ID discovery

Define a strict `VerificationReceiptV1` containing only bounded metadata:

```ts
type VerificationReceiptV1 = {
  version: 1
  receiptID: string
  rootSessionID: string
  sessionID: string
  agentID: string
  messageID: string
  commandDigest: string
  commandLabel: string
  status: "pass" | "fail"
  exitCode: number
  startedAt: number
  completedAt: number
  repository: {
    rootDigest: string
    headSha: string
  }
}
```

Requirements:

- `commandDigest` is SHA-256 over a documented canonical command representation.
- `commandLabel` is known-pattern redacted, whitespace-collapsed, and sharply bounded. It is diagnostic only.
- Raw command input and output exist only transiently in memory.
- No stdout/stderr is persisted.
- `receiptID` is deterministic from non-secret identity fields or a bounded random opaque ID.
- The session must resolve to the board's lead session and configured orchestrator agent.
- The repository root and exact HEAD are read after successful completion through existing safe Git helpers.
- Missing Git state, unknown result shape, an error result, non-zero exit, or a moved session produces no passing receipt.
- Writes use stable project/session keys and strict parsing.
- Receipts are bounded per session. Define an eviction policy and never evict a receipt referenced by an active board if that can be determined safely.

### 3C. Contract matching

Add a pure canonicalization helper in `src/core/verification.ts`. A required command in a D2 contract is satisfied only when:

- Its canonical digest matches a passing receipt.
- The receipt belongs to the lead/root session.
- The receipt agent is the configured orchestrator.
- The receipt HEAD equals the revision being validated.
- The receipt was captured after the task entered `awaiting-validation`.
- The receipt is not stale under a documented bound.

Lead-board validation inputs must change from caller-supplied checks to receipt IDs. Keep failed receipt information available for diagnostics, but never accept it as passing proof.

### Tests

- Pure digest/canonicalization tests.
- Strict schema tests.
- Redaction and bounded-size tests.
- Before/after pairing tests, including out-of-order and dropped events.
- Revision drift tests.
- Wrong session, wrong agent, wrong command, stale receipt, non-zero exit, malformed result, and missing Git tests.
- Disposal and memory-bound tests.

### Acceptance criteria

- No lead-board completion path accepts `{ id, verdict: "pass" }` as command proof.
- A successful receipt can be traced to one actual completed shell tool call without storing raw output.
- Existing host shell permission remains the authority for allowing execution.
- Unknown hook shapes fail closed and cannot fabricate a receipt.

### Progress

Phase 3 measured the native `shell` tool contract in
`test/contract/phase-e-verification-hooks.test.ts` and documented it in
`docs/contracts/verification-hook.md`. The runtime now observes paired
`execute.before`/`execute.after` events, stores only redacted bounded metadata,
reads Git `HEAD` after completion, rejects stale/moved/mismatched observations,
and protects active-board receipt references during bounded eviction. Lead
validation requires receipt IDs from `orchestrator_verification_get`, the
configured orchestrator agent, the root lead session, the exact revision, the
task lifecycle timestamp, and the 24-hour freshness bound. Caller-supplied
`checks` remain diagnostic and cannot satisfy required commands. The pinned
host exposed all required identity and exit-code fields, so no host limitation
was recorded for this phase.

---

## Phase 4 — Bind review records to the reviewer child session

### Objective

Make bounded review provenance reflect the actual invoking reviewer agent and child session.

### Work

#### 1. Introduce review V2

Create a version-2 review schema with fields including:

```ts
type ReviewRecordV2 = {
  version: 2
  taskId: string
  runId: string
  leadSessionID: string
  reviewerSessionID: string
  reviewerAgentID: string
  headSha: string
  baseSha: string
  state: "pending" | "approved" | "changes-requested" | "blocked" | "tripped"
  round: number
  checks?: { diff: boolean; scope: boolean; verification: boolean }
  submittedAt?: number
  updatedAt: number
}
```

Keep free-form reviewer prose out of durable state. The ordinary child response remains in session history; the receipt stores only the bounded decision.

#### 2. Split lead and reviewer operations

Replace the model-visible generic transition tool with two explicit operations:

- Lead-only review start: creates a pending record pinned to task/run/head/base and expected reviewer role.
- Reviewer-only review submit: accepts approve, request-changes, or block and derives actor identity from `ToolContext`, not input.

The submit handler must verify:

- `tool.agent` equals the configured review agent.
- `tool.sessionID` is a child of the lead session.
- The pending record names that lead, task, run, and exact revision.
- The record is still pending and at the expected round/version.
- Approval contains exactly the three fixed passing checks.
- Request changes and block follow deterministic bounded transitions.

Add a dedicated permission action for reviewer submission. Fresh installs allow it only for the configured review agent and deny it to every other agent. The orchestrator receives read/start authority but cannot submit reviewer approval.

#### 3. Migration

V1 review records remain readable for status display but are not valid publication or lead-board completion proof after review V2 becomes active.

On encountering a V1 record:

- Report `legacy-unproven`.
- Require a new V2 review at the exact revision.
- Never silently upgrade caller-supplied maker/checker identities into proven reviewer provenance.

#### 4. Publication integration

Update worktree push, PR create, ready, approval, merge, and board completion to require an approved V2 review receipt for new operations.

### Tests

- Reviewer agent and child-parent identity tests.
- Orchestrator self-approval refusal.
- Unrelated reviewer session refusal.
- Revision drift and stale round tests.
- Reviewer changes-requested/rework/second-round flow.
- Legacy V1 read-only and publication refusal tests.
- Installer permissions and agent-transform tests.

### Acceptance criteria

- The orchestrator cannot create an approved V2 review record by calling a tool itself.
- The configured reviewer child can submit exactly one decision for the active round.
- Publication fails closed on V1, missing, stale, or revision-mismatched reviews.

---

## Phase 5 — Upgrade the lead board and completion chain

### Objective

Make the durable lead board consume observed verification and reviewer provenance directly, while reducing model-managed transitions.

### Work

#### 1. Lead-board schema V2

Add V2 task validation fields:

- Exact revision.
- Verification receipt IDs.
- Verification timestamp.
- Review V2 reference.
- Validation actor derived from tool context.

Do not store caller-supplied check verdict strings as proof.

#### 2. Conservative migration

Provide a pure V1-to-V2 migration:

- Planned, ready, reserved, delivered, reported, failed, ambiguous, blocked, and rework states retain their safe lifecycle meaning.
- A V1 `validated` or `completed` task without observed receipts becomes `awaiting-validation` with a bounded migration note.
- A fully completed historical goal remains readable as historical state, but its legacy proof cannot authorize a new publication mutation.
- Malformed V1 state remains unavailable; do not guess.

Migration must be idempotent and tested from serialized fixtures.

#### 3. Internalize transitions

Replace generic model-selected transition edges with intent-level actions. For example:

- `report-task`
- `validate-task` using receipt IDs
- `submit-review-result` through the reviewer tool
- `request-rework`
- `mark-blocked`
- `reconcile-ambiguous`

Plugin code chooses the legal state transition. The model must not calculate admission state separately.

#### 4. Remove the manual admission step from the happy path

Keep the pure admission transition function if it remains useful for tests/public API, but stop requiring the orchestrator to call `orchestrator_admission_transition` between validation and review. Handoff validation and review start should compute the next state internally.

#### 5. Completion requirements

Board completion requires:

- Every task completed under V2 rules.
- All aggregate required commands matched by observed receipts at the exact head revision.
- Approved reviewer-child V2 receipt at the same head/base.
- Active unchanged goal generation.
- Fresh board revision under the session lock.

### Acceptance criteria

- V1 proof cannot silently become V2 proof.
- The happy path requires fewer model-visible calls than today.
- Board completion and publication share the same receipt validators.
- A stale revision invalidates both verification and review without partial completion.

---

## Phase 6 — Enforce runtime parallel dispatch admission

### Objective

Turn `max_parallel` into a real process-local limit at the native subagent tool boundary without claiming a native autonomous scheduler.

### Contract probe

Measure native `subagent` tool hook behavior:

- Tool name and input shape.
- Before/after pairing and call IDs.
- Whether after runs on child failure and cancellation.
- Whether throwing in before prevents child creation.
- Agent/session identity for nested delegation.
- Whether the parent tool remains active until the child completes.

If before-hook refusal cannot reliably prevent dispatch, leave `max_parallel` as guidance and document the host limitation. Do not claim enforcement.

### Runtime design

If supported, add `src/opencode-v2/dispatch/runtime.ts`:

- Resolve each configured-role subagent invocation to its root orchestrator session by walking `parentID` through `session.get`, with a strict depth bound.
- Track active call IDs per root session in memory.
- Serialize admission for one root session so simultaneous before hooks cannot exceed the ceiling.
- Refuse a new dispatch when active count is already `max_parallel`.
- Remove the active entry on completed/error after hooks.
- Bound global and per-session maps.
- Clear state on plugin disposal.
- Treat missing parent/session information as unknown and fail closed only for plugin-owned configured-role dispatches; do not interfere with unrelated agents/plugins.

The refusal message must tell the model to consume native completion delivery and retry later. It must not encourage polling.

### Scope limits

Do not claim this provides:

- Cross-process concurrency enforcement.
- Filesystem isolation.
- Automatic scheduling.
- Exact disjoint-write enforcement for arbitrary child prompts.

Lead-board scope conflict checks remain the authority for board reservations. Prompt-level scopes outside the board remain advisory.

### Acceptance criteria

- At most `max_parallel` configured-role child calls are active per root orchestrator session in one plugin process.
- Different root sessions do not block one another.
- Nested delegation counts against the same root ceiling.
- Cleanup occurs on success, error, cancellation where observable, and plugin disposal.
- README wording distinguishes dispatch admission from a scheduler.

---

## Phase 7 — Simplify the model-visible surface

### Objective

Reduce tool-selection burden and remove overlapping or disconnected features after replacement paths are available.

This is a planned breaking cleanup for a `0.2.0` release. Document every removed name and replacement.

### Tool consolidation

#### Goal tools

Replace `goal_get`, `goal_set`, and `goal_update` with:

- `orchestrator_goal` using strict action variants: get, set, pause, resume, complete, clear.

User-facing `/goal` remains.

#### Lead-board tools

Replace six board mutation tools with:

- `orchestrator_board_get`
- `orchestrator_board_action`

Use a discriminated union for action-specific input. Keep strict expected revisions on every mutation.

#### Status tools

Combine `peer_list` and `session_status` into:

- `orchestrator_status`

Support one-session detail and paginated same-project list modes.

#### Validation tools

- Keep one handoff validation operation.
- Internalize admission transitions.
- Remove the model-visible D4 complexity classifier; retain a pure classifier only if it has an actual supported external API.
- Keep semantic coherence as concise decomposition guidance. Enforce only the mechanically knowable part at runtime: conservative admission from declared board scopes and dependency edges. Do not claim that the plugin can prove semantic coupling or filesystem isolation.

#### Review tools

- Keep lead review start/read operations.
- Add reviewer-only submit.
- Remove generic orchestrator-owned review transition after V2 migration.

### Command consolidation

Remove:

- `/restructure`
- `/polish`
- `/stress-plan`

These are prompt recipes that overlap `/orchestrate`. Document equivalent `/orchestrate` examples.

Keep:

- `/orchestrate`
- `/worker-models`
- `/goal`
- `/run-plan`
- `/halt`
- `/handover`
- `/publish`
- `/gates`

When changing command names, update both `src/core/config.ts` and `src/opencode-v2/commands/index.ts`, plus descriptions/prompts/tests, as required by repository policy.

### GitHub issue tools

Remove generic issue view/list/create from the core plugin, or move them behind a separately published optional extension. The core GitHub surface should focus on repository preflight and the guarded PR publication lifecycle.

### Remove generation hints

Remove `hints.mode`, generation-hint schemas, the sessionless hint call, and associated prompt text unless a benchmark committed before this phase demonstrates measurable orchestration quality improvement. Deterministic validation must not pay for a second model call that cannot alter its result.

### Remove D4 v2; retain the useful board invariant

#### Decision

Remove D4 v2 as a classifier. Do not wire `src/core/d4v2.ts` into a tool, command, configuration key, durable record, package export, or publication gate.

D4 v2 mostly converts a caller-supplied coherence claim directly into a label: `coupled-outcome` becomes `cohesive-slice`, `independent` becomes `parallel-candidate`, and overlap becomes `serialized`. The plugin has no independent observation that can prove semantic coupling between files or outcomes. Wiring that classifier into the orchestrator would therefore add ceremony and model-visible surface without adding provenance or enforcement.

The one useful safety rule is that overlapping, broad, or unknown work must not be admitted concurrently. That rule belongs in lead-board task creation and reservation, where the plugin already controls scope-conflict admission, rather than in a disconnected advisory classifier.

This decision does not remove or change the restored `docs/phase-1/d4-task-corpus.json` fixture. D4 v1 still consumes that fixture. D4 v1 compatibility is a separate decision: this phase removes its model-visible tool as specified above, while any change to its currently exported pure API must be handled explicitly under the package-API work in Phase 10.

#### Preserve the decomposition policy without D4 v2 branding

Fold the useful behavior into the existing vertical-slice guidance in `src/core/policy.ts`:

- Keep code, tests, wiring, and requested documentation together when they produce one coupled outcome.
- Split only when each child task has its own outcome, acceptance evidence, ownership, and no hidden dependency.
- Express genuine sequencing through explicit lead-board dependency edges.
- Treat disjoint declared scopes as candidates for concurrent reservation, not proof of semantic independence.
- Serialize overlapping, broad, or unknown declared scopes.

State the enforcement boundary precisely:

- Semantic coherence remains guidance because the plugin cannot infer it reliably from paths or model assertions.
- Board scope syntax, dependency ordering, and scope-conflict admission are runtime-enforced for enrolled board tasks.
- Scope packets remain declarations, not filesystem access controls. They do not prove that an agent will only touch the listed files.
- The runtime dispatch ceiling from Phase 6 limits active child calls but does not prove task independence.

Do not persist `coherence`, `sliceMetadata`, or equivalent caller-supplied labels. They would be recorded claims rather than observed proof and would create another state field with no safe consumer.

#### Strengthen lead-board scope admission

Update the lead-board path so removing the classifier does not weaken conservative dispatch:

1. During scope normalization, treat an omitted or empty scope as unknown and canonicalize it to a broad scope. It must not be interpreted as disjoint work.
2. Continue rejecting malformed, absolute, traversing, duplicate, or oversized paths.
3. Continue treating broad scopes, write/write overlap, and write/read overlap as conflicts.
4. Permit concurrent reservation only when declared scopes do not conflict, dependencies are complete, and the Phase 6 process-local dispatch ceiling has capacity.
5. Keep dependency edges authoritative for known semantic sequencing even when path scopes appear disjoint.
6. Return an actionable waiting reason for broad/overlapping scope conflicts; do not convert waiting into failure.

Use terminology such as `declared-scope-conflict` and `concurrent-reservation-candidate`. Avoid `coherence-proven`, `independent`, or similar wording that implies stronger evidence than the plugin has.

#### Files and references to remove or update

- Delete `src/core/d4v2.ts`.
- Delete `test/unit/d4v2.test.ts`.
- Remove D4 v2-specific cross-checks from `test/unit/d4.test.ts` and `test/unit/core.test.ts`.
- Remove `D4_V2_COHERENCE_GUIDANCE` and its prompt assembly references from `src/core/policy.ts` and `src/core/prompts.ts`.
- Remove D4 v2 product claims from `README.md`; replace them with the truthful decomposition and declared-scope admission boundary above.
- Remove comments or tests that describe D4 v2 as a runtime surface.
- Do not add a replacement D4 v2 tool or rename the existing D4 v1 tool to imply v2 behavior.

#### Replacement tests

Move the safety coverage to lead-board and prompt-policy tests:

- Omitted or empty task scope becomes broad/unknown and cannot be reserved concurrently with active scoped work.
- Explicit broad scope conflicts conservatively.
- Write/write and write/read overlaps serialize.
- Read/read overlap alone does not create a write conflict.
- Disjoint declared scopes are reservation candidates only after dependencies complete.
- A dependency edge serializes tasks even when their declared paths are disjoint.
- Scope-conflict waiting leaves the task ready and does not mark it failed.
- Prompts retain concise vertical-slice guidance without referring to D4 v2, slice metadata, or a coherence classifier.
- Tool inventory, package exports, and README contain no D4 v2 runtime surface.

#### Acceptance criteria

- `src/core/d4v2.ts` and its dedicated test suite are removed.
- No registered tool, command, prompt, package export, or durable schema exposes D4 v2, and no current-capability documentation presents it as available. Historical migration notes may name the removed surface.
- No caller-supplied coherence label influences an enforcement or publication decision.
- Unknown, broad, or overlapping declared scopes fail closed to serialized reservation.
- Semantic coherence is described as guidance; declared-scope conflict admission is described as enforcement.
- The D4 v1 corpus remains tracked and its still-supported compatibility tests remain green.

### Surface target

Record before/after counts. Aim for:

- No more than 10 always-on orchestrator tools in the default configuration.
- Feature-specific GitHub/worktree tools only when enabled.
- One canonical model-visible operation per state transition family.

### Acceptance criteria

- No prompt refers to a removed tool or command.
- Installer permissions contain no orphaned action family.
- TUI command registration matches server command registration.
- README contains a migration table from every removed name to its replacement.
- Default tool count is materially lower and asserted in tests.

---

## Phase 8 — Installer migration, live doctor, and state recovery

### Objective

Make upgrades safe for existing installations and provide recovery from fail-closed state.

### Installer migration

Add explicit modes:

- `install` preserves current behavior.
- `install --check` prints a deterministic diff and writes nothing.
- `install --migrate` updates plugin-owned agent fields after creating a backup.

The migration engine must distinguish:

- Plugin-owned generated rules and prompt sections.
- Exact user-authored rules that must remain authoritative.
- Removed permission families.
- Missing reviewer-submit permission.
- Old delegation graph entries.
- Legacy plugin/package references.

Never rewrite a config after a parse or validation failure. Preserve JSONC comments and formatting as far as `jsonc-parser` permits.

### Doctor improvements

Static doctor should detect:

- Missing or stale generated permission families.
- Removed command entries.
- Legacy V1 review/board/worktree state when discoverable.
- Broken plugin references.
- Missing declarations/entrypoints in a packed install.

Add `doctor --live` that uses `opencode2 api`, not a separately constructed localhost client. It should scope every location-aware request with the OpenAPI deep-object location parameter and verify:

- Plugin activation for the requested directory.
- Registered commands.
- Effective agents.
- Server-side GitHub capability probe availability.
- Worktree tool availability.
- TUI plugin export presence where observable.

Parse only expected response fields and never print raw headers, credentials, or unbounded responses.

### State recovery

Add an operator-owned CLI command, not a model tool, for state inspection:

- `state export --session <id>`: bounded JSON metadata only.
- `state validate --session <id>`: reports schema family and exact parse issue paths.
- `state archive --session <id>`: copies versioned records to an archive namespace before removal.
- `state reset --session <id> --family <family>`: requires explicit family and confirmation.

Do not add broad recursive deletion. State recovery must never touch repository files, Git, or GitHub.

### Remove dead V1 worktree code

After migration/inspection behavior is defined, remove the unused worktree model and helpers from `src/opencode-v2/session/state.ts` and their dedicated tests. Keep session anchors there. If historical `worktree/v1` keys need cleanup, handle them only through the operator migration/archive path; do not silently reinterpret them as V2 records.

### Acceptance criteria

- Existing user-authored permissions survive migration.
- Fresh and migrated configs converge to the same plugin-owned fields.
- `--check` is byte-for-byte non-mutating.
- Live doctor uses service discovery/authentication through `opencode2 api`.
- State reset cannot operate without an explicit session and family.

---

## Phase 9 — Add a read-only orchestration progress UI

### Objective

Expose the value of durable orchestration state in the TUI without giving the CLI plugin direct server-storage access.

### Server RPC

Add a typed read-only status RPC, following the existing gates RPC pattern. It should return a bounded view containing:

- Goal state and redacted objective hint.
- Lead-board status and counts by task state.
- Current/reserved task title and role.
- Review state and round.
- Budget verdict and observed coverage.
- Worktree state and bounded branch label.
- Publication capability and per-session gate summary.
- Explicit limitations and completeness flag.

Never return transcripts, prompts, command output, full objectives, credentials, arbitrary evidence text, or raw storage records.

### TUI integration

Use `context.client.rpc` from `src/tui.ts`. Extend the existing cached summary support in `src/tui/sidebar.tsx` rather than creating a second sidebar system.

Requirements:

- Fetch summaries for visible orchestrator sessions.
- Refresh on relevant typed events and command completion.
- Return cleanup functions for every subscription and slot.
- Do not poll when native events can invalidate the cache.
- Show unknown/incomplete rather than assuming idle or complete.
- Keep rows short; use a detail dialog for the task list and gate/budget information.
- Mutations remain in existing commands/dialogs. The progress view is read-only.

### Tests

- RPC schema and redaction tests.
- TUI cache invalidation tests.
- Missing RPC/plugin compatibility behavior.
- Cleanup tests.
- Snapshot-like tests for active, blocked, review-pending, publication-refused, and complete states.

### Acceptance criteria

- The sidebar uses its existing `summaries` property with real RPC data.
- The TUI never imports server storage modules.
- No unbounded state crosses the RPC boundary.

---

## Phase 10 — Package API, typing, and bundle cleanup

### Objective

Make the published package match its exported API and reduce avoidable bundle duplication.

### Declarations

Add a declaration-only TypeScript build configuration and emit `.d.ts` files for supported entrypoints. Update `package.json` exports to include `types` for:

- `.`
- `./tui` if a public type surface is intended
- `./commands`
- `./installer`

If an entrypoint is not intended for external use, remove it instead of publishing an undocumented untyped API.

### Define the supported public API

Review `src/index.ts`. Export only APIs the project commits to maintaining. Recommended public surface:

- Default plugin definition.
- Option schema and option types.
- Installer API if intentionally supported.
- A small set of pure contract types with declarations.

Do not export every internal state helper simply because it is pure.

### Isolate beta compatibility casts

Replace broad `(Plugin.define as any)` and repeated `Info<any, undefined>` usage with a small compatibility adapter module. Document why the pinned plugin type omits any runtime-supported field such as `tui`. Keep unsafe casts at one boundary and contract-test it.

### Bundle review

Externalize dependencies that are guaranteed to be installed with the package or supplied by the host. Verify every decision with a packed install; do not optimize bundle size by creating runtime resolution failures.

Add package tests that:

- Install the generated tarball into an isolated directory.
- Import every exported subpath.
- Load the server plugin in the embedded host.
- Resolve the TUI export.
- Invoke the installer against a temporary config.
- Confirm declarations resolve under a small TypeScript consumer project.

### Acceptance criteria

- A TypeScript consumer resolves all documented imports without implicit `any` module errors.
- Unsupported internal helpers are no longer public.
- Packed-package smoke tests run against the tarball, not the source checkout.
- Bundle size changes are recorded, but correctness takes precedence over size.

---

## Phase 11 — Documentation and release completion

### Objective

Finish with documentation that matches the final runtime and contains no stale links.

### README restructuring

Keep the README focused on:

1. What the plugin does.
2. What is guidance versus enforced.
3. Installation.
4. Quick start.
5. Core commands.
6. Optional worktree/GitHub publication.
7. Safety boundaries.
8. Troubleshooting.

Move detailed schemas, state machines, and migration tables to `docs/`.

Remove the deleted placeholder demo references unless real assets are restored. Replace the broad claim that all formal Phase 1 documents exist with links to files that actually ship.

### Required documents

- `docs/architecture.md`
- `docs/enforcement-boundaries.md`
- `docs/state-migrations.md`
- `docs/tool-command-migration-0.2.md`
- `docs/contracts/verification-hook.md`
- `docs/contracts/subagent-hook.md`
- `docs/operations/state-recovery.md`

### Release checklist

1. Ensure the working tree contains no generated or accidental files.
2. Run `bun install --frozen-lockfile` in a clean checkout.
3. Run `bun run typecheck`.
4. Run all unit tests.
5. Run all contract tests.
6. Run `bun run build`.
7. Run packed-package smoke tests.
8. Run the isolated `opencode2 --standalone` development harness.
9. Verify source and packed entrypoints separately.
10. Verify `/orchestrate`, `/goal`, `/run-plan`, `/halt`, `/handover`, `/worker-models`, `/publish`, and `/gates` in the TUI.
11. Verify reviewer submission from a real reviewer child.
12. Verify a real shell execution produces a bounded receipt and revision drift invalidates it.
13. Verify GitHub/worktree features remain disabled by default.
14. Verify publication refuses without V2 review and verification receipts.
15. Verify all documentation links.

---

## Cross-phase test matrix

Every new stateful or mutating feature must cover this matrix where applicable:

| Area | Required cases |
|---|---|
| Parsing | valid, missing, malformed, unknown fields, old version |
| Identity | correct agent/session, wrong agent, wrong session, missing parent, stale child |
| Revision | exact match, abbreviated SHA, changed head, changed base, non-ancestor |
| Concurrency | concurrent writers, stale expected version, cleanup after failure |
| Storage | absent, malformed, write failure, remove failure, scan unavailable |
| Security | path traversal, option injection, shell disabled, secret-shaped text, oversized input |
| Lifecycle | success, refusal, retry/rework, pause, resume, halt, session move, disposal |
| Evidence | missing, stale, wrong command, wrong revision, failed execution, unknown host shape |
| Migration | fresh, V1, repeated migration, partial/malformed legacy record |
| UX | concise status, actionable recovery, no false success language |

---

## Final definition of done

The remediation is complete only when all of the following are true:

- A clean checkout passes the documented verification commands without pre-existing `dist/`.
- CI runs all required checks and catches missing fixtures or stale package output.
- `max_parallel` is either runtime-enforced under a pinned contract or explicitly retained as guidance with no enforcement claim.
- Lead-board command proof comes from plugin-observed receipts, or the feature remains explicitly advisory if the host cannot provide the necessary evidence.
- Approved review proof comes from the configured reviewer child session.
- Publication accepts only the new exact-revision proof chain.
- Legacy proof is readable but cannot silently authorize new mutations.
- The default model-visible tool count is significantly reduced.
- The disconnected D4 v2 classifier is removed, while conservative declared-scope conflict admission and dependency ordering remain enforced by the lead board.
- Removed commands/tools have a migration guide and no remaining prompt references.
- Existing installations can inspect and migrate generated permissions safely.
- Operators can inspect and recover malformed durable state without broad deletion.
- The TUI displays bounded progress through a typed server RPC.
- The package publishes declarations for every supported public entrypoint.
- README claims, source comments, prompts, tool descriptions, and runtime behavior agree.
- `bun run typecheck`, all tests, build, packed-package smoke tests, and the isolated live harness pass.

The final result should be smaller and easier to operate than the current plugin. Do not consider the remediation successful if it merely adds new tools, schemas, or policy text while preserving the same model-visible ceremony.
