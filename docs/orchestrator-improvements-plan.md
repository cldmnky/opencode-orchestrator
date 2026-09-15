# OpenCode Orchestrator Improvement Plan

**Date:** 2026-09-15 (supersedes the 2026-08-30 suggestion-only draft)  
**Status:** Living plan — completed work recorded, remaining improvements planned

## Goal and Constraints

This plan tracks improvements to `opencode-orchestrator` against repository evidence, the pinned OpenCode V2 contract, and the current [plugin guide](https://opencode.ai/v2/docs/build/plugins), [CLI plugin guide](https://opencode.ai/v2/docs/build/plugins/cli), and [HTTP API reference](https://opencode.ai/v2/docs/api).

Constraints:

- The original 2026-08-30 draft was suggestion-only. Since then a first wave of work landed (see [Completed Work](#completed-work-and-residual-gaps)); this document now records what is done and plans the next wave.
- OpenCode V2 APIs are beta/experimental; every proposal must be re-verified against the pinned package types before implementation.
- Web sources are directional evidence, not automatically authoritative.
- Claims about storage durability, token counts, isolation, redaction completeness, and runtime enforcement must be verified before relying on them.
- New enforcement work must never weaken the static `github`/`worktree` config gates, the durable publish capability, or the per-session gate picker (`/gates`): a session-disabled gate is final.

## Executive Summary

- The semantic role model (`planner`, `explore`, `implementer`, `reviewer`) is unchanged, but the first improvement wave landed the **evidence-contract foundation**: structured handoffs (D2), an advisory complexity classifier (D4), a callable two-level validator with admission vocabulary (V2), typed evidence on GitHub/worktree results (V3), opt-in trace/budget controls (S3), and bounded maker-checker review with a circuit breaker (V1-bounded).
- Beyond the original plan, the repo now ships an orchestrator-owned worktree lifecycle with safe-boundary session entry, a fail-closed autonomous publication chain (push → draft PR → ready → best-effort approve → merge → verify), per-session gates with a TUI picker and RPC, durable worker model selection, bounded nested delegation, and a read-only TUI orchestrator-sessions sidebar.
- The dominant remaining weakness is unchanged in kind but now fixable in practice: most delegation constraints are still **prompt-only** or gated only at **plugin-owned dispatch surfaces**. The pinned beta-19507 contract now exposes `session.hook("prompt")`, `permission.hook("evaluate")`, `permission.rules` (inherited by child sessions at creation), and a native `ctx.worktree` domain — the host-side primitives needed for real runtime admission enforcement (N1), real worker containment (N2), and a documented worktree path (N3).
- `max_parallel` is still prompted, not scheduled: no DAG scheduler or concurrency semaphore exists (A4 remains true).
- Durable per-step checkpoints, append-only lifecycle logs, and materialized projections remain unimplemented (S1/S2); the TUI sidebar is a volatile projection only.

## Current State Snapshot

### Architecture

- `src/index.ts` exports the server plugin plus the serialized public pure APIs (D4 classifier, D2 contract, admission machine, evidence vocabulary, budget/trace, review-v1, publish policy, peer query).
- `src/opencode-v2/plugin.ts` uses `Plugin.define`, registers agent/command/tool transforms, a `session.hook("context")` system-prompt injector, `tool.hook("execute.after")` failure logging, the gates RPC registration, goal continuation, worktree event sync, and the observability runtime.
- The main plugin sets `tui: true`; `src/tui.ts` is the CLI/TUI plugin importing `@opencode/plugin/tui`, with a read-only orchestrator-sessions sidebar (`src/tui/sidebar.ts`).
- The package exports `./tui`, `./commands`, and `./installer`; CLI-only plugin configuration belongs in global `cli.json`.
- `src/core/` owns configuration, roles, policy, prompts, permissions, prompt building, package identity, and the pure contracts: `d4.ts` (complexity classifier), `contracts.ts` (D2 handoff schema), `admission.ts` (admission state machine), `model-reference.ts`.
- `src/opencode-v2/` owns commands/runtime, goal continuation, session state/move/move-coordinator, process runner + redaction, worktree support, GitHub support, plus the newer domains: `gates/` (per-session gates + RPC), `observability/` (trace/budget/review), `orchestration/` (validation/evidence/tools), `peers/` (peer discovery), `publish/` (publication capability + terminal chain), `worker-models/` (durable model selection).

### Delegation Rules and Config Surface

`src/core/config.ts` defines:

- `max_parallel`: integer 1..8, default `4`; `require_review`: default `true`; `strict_agents`: default `true`.
- Goal continuation enabled by default (max `50`, cooldown `1000 ms`).
- `clarify`: `auto|off` (default `auto` — native ask-tool clarification guidance).
- `trace`: `off|memory|snapshot` (default `off`); `budget`: `advisory|stop-between-steps` (default `advisory`, nullable finite `max_steps`/`max_tokens`/`max_cost_usd`/`max_wall_clock_ms`/`max_retries`); `review`: `prompt|bounded` (`max_rounds` 1..8, default 2).
- `github` and `worktree` disabled by default; mutations additionally disabled by default; `publish.enabled` default `false`.
- Defaults preserve pre-observability behavior exactly; the S3/V1 controls are strictly opt-in.

`src/core/roles.ts` still maps planning→`planner`, research→`explore`, implementation→`implementer`, review→`reviewer`. Nested delegation is bounded to the role graph (a delegating worker stays accountable; research never delegates).

### Enforcement Matrix

| Constraint | Enforcement today |
|---|---|
| `max_parallel`, disjoint write scopes, `require_review` (in `prompt` review mode), complexity routing | Prompt-only |
| `stop-between-steps` budget, bounded-review circuit breaker | Plugin-owned dispatch gates (goal auto-continuation before reservation/delivery; slash-command prompt delivery); never in-flight cancellation, never `session.interrupt` |
| GitHub/worktree mutations | Fail-closed tool preconditions + static config gates + `confirm: true` + durable publish capability + per-session gates |
| Worker authority/containment | Prompt-only (no host-enforced boundary yet — target of N2) |
| Completion gating (no finish without validated review) | Not enforced (target of N1) |

### Review and Verification

- `require_review=true` remains prompt-level in the default `prompt` review mode.
- `review.mode: "bounded"` adds `orchestrator_review_get`/`orchestrator_review_transition` with a version-1 review schema (states `pending`/`approved`/`changes-requested`/`blocked`/`tripped`, fixed reason codes, deterministic transitions); tripped/blocked records stop goal auto-continuation. Still no automatic completion gate and no model-tier escalation.
- `orchestrator_handoff_validate` performs deterministic D2 + V2 checks including parent-side `ctx.vcs` state, path existence, realpath, and redaction; it is callable, not automatic. Worker-declared verification passes are never upgraded.

### Goal Continuation

`src/opencode-v2/goal/` provides durable goal state through `ctx.storage`: versioned goal/plan-run/halt keys, `withSessionLock` (process-local), `session.idle`/`session.deleted` handling, reservation under lock, cooldown/max/halt/duplicate/replacement/pause-race handling, queued prompt delivery, and cleanup on session deletion.

**Observed limitation:** storage now exposes `get`, `set`, `remove`, **and `scan` (prefix + cursor pagination — already used by worktree state and peers)**; transactions, compare-and-set, append-only events, and cross-process locking are still absent from the visible abstraction.

### Worktree, GitHub, Publication, Gates

Worktree tools (opt-in): creation restricted to an absolute configured `worktree.root`; `shell:false`, fixed Git subcommand allowlist, bounded output, timeouts, redaction; refusal to clean up the main worktree, dirty worktrees, or other sessions' worktrees; durable records under `worktree/v2/...` with lifecycle states (`pending`, `ready`, `moved`, `dirty`, `orphaned`, `cleanup-failed`); `worktree_enter` moves only the current session with a safe-boundary pending receipt (retry until `entered:true` before delegating); move reconciliation anchors on `session.moved`.

GitHub tools (opt-in): host `gh` executable via the injected runner, validated response shapes, direct identifiers/URLs as typed evidence. A fail-closed publication chain is now orchestrator-owned: verify/tests green → commit → sync against latest remote base → exact-revision internal review → push → draft PR → ready transition → best-effort approve → merge → post-merge verify → worktree cleanup. Every step fails closed (stale SHA, dirty tree, missing receipt, moved revision, conflicts, branch protection, merge queues, permission failures). Single-collaborator repos may merge without a GitHub review; the exact-revision approved internal review receipt is the review authority.

Publication capability (`publish/v1/<project>`): durable project-scoped record (policy, not caller authentication); never authorizes issue creation; never weakens static gates.

Per-session gates (`gates/`): the family `push`, `pr-draft-create`, `pr-ready-transition`, `approve-after-review`, `merge`, `github-mutations`, `worktree-mutations` can only narrow the project/config ceiling; set via `/gates` or the TUI gate picker (RPC `opencode-orchestrator.gates`); the model reads effective gates via read-only `orchestrator_gates_get`. A session-disabled gate is final.

**Boundary that still holds:** delegated child sessions receive no plugin-controlled atomic worktree isolation. Managed ownership covers the coordinating session only; parallel children still share the parent filesystem. (N2/N3 below target this.)

### Verification Traps

- `strict_agents=true` can fail plugin setup when a non-empty agent response lacks required agents; empty/partial bootstrap responses are treated as "pending" with late setup on `agent.updated`.
- The package is pinned to `@opencode/plugin` `0.0.0-beta-19507` and `@opencode/sdk` `0.0.0-beta-19507` (names and versions changed from the `@opencode-ai/*` betas referenced by the previous draft).
- `doctor` runtime checks inspect the local CLI machine only and remain advisory; the server-side `orchestrator_github_capabilities` probe is authoritative for live GitHub availability. Host-configured GitHub MCP and the plugin's own `gh` tools are separate concerns.
- Prompt-level write scopes do not provide filesystem isolation.
- The pinned Promise plugin API **does** expose runtime permission surfaces (`permission.hook("evaluate")`, `permission.list/get/reply/rules`) and the prompt-admission hook (`session.hook("prompt")`); the previous draft's "no interactive runtime approval in the public Promise API" trap is stale.
- `bun run build` produces bundles but does not replace packed-package smoke testing; no lint or formatter is configured.
- `dev:v2:dist` rewrites the generated config to load `dist/index.js`; `opencode2 api` inspection is location-sensitive (use the deep-object `location[directory]=` parameter on beta-19507).

## Plugin Contract Conformance

Assessed 2026-09-15 against the current plugin guide and the pinned `@opencode/plugin` `0.0.0-beta-19507` declarations.

### Verified-proper usage

- Lifecycle: `Plugin.define` default export, async `setup` returning cleanup; registrations disposed in reverse order, including on the error path.
- Transforms: `agent`/`command`/`tool` registered via `ctx.*.transform` with `Registration.dispose()`; callbacks are cheap and repeatable; commands are collision-aware via a prior `ctx.command.list()` read.
- Events: `ctx.event.subscribe` with `AbortController` + explicit iterator cleanup (late agent setup on `agent.updated`); registry re-read after the event instead of trusting earlier reads.
- Hooks: `session.hook("context")` for agent-scoped system prompt injection; `tool.hook("execute.after")` for failure logging.
- Storage: `get`/`set`/`remove` plus `scan({ prefix, after, limit })` cursor pagination (worktree inventory, peer queries).
- Commands: executors rebuild prompt text, pass through the requested `delivery`, and drop stale attachment `mention` offsets — matching the documented guidance for rewritten command prompts.
- RPC: server-side `ctx.rpc.register(gatesRpcDefinition, …)` with the TUI consuming `context.client.rpc(gatesRpcDefinition)`; contract-tested.
- TUI plugin: `tui: true` on the main plugin, `./tui` export, OpenTUI/Solid peer dependencies, cleanup functions for `data.on`/slots, and the keymap layer correctly anchored in the always-mounted `app` slot (registering it from `setup` throws — host provider constraint).
- `ctx.vcs` used for parent-side validation checks; `ctx.location.project` scopes all storage keys.

### Deviations (accepted, documented)

1. `(Plugin.define as any)({ id, tui: true, … })` — the pinned `Plugin` type has no `tui` field, so the plugin object is type-erased at definition. Works and is covered by `test/contract/plugin.test.ts`, but typos in `id`/`setup` would not be caught at compile time. Alternative: a local augmented type or upstream field.
2. `ctx.catalog.model.list()` (`worker-models/runtime.ts`) — `catalog` exists in the pinned `Context` type but is **not documented** on the plugin guide; the documented surface is `ctx.model.list()`. Compat risk on future pins; treat as a tracked assumption (A15).
3. `src/tui.ts` exports a plain object `satisfies Definition` rather than `Plugin.define` from `@opencode/plugin/tui` — functionally equivalent; cosmetic conformance nit.
4. No `./rpc` package export. The docs recommend exporting `./rpc` when the RPC contract is shared with other packages; today the gates definition is bundled into both entrypoints by direct import, which is fine for internal use. Revisit if external consumers appear.

### Pinned-contract capabilities available but unused (inputs to N1–N5)

- `session.hook("prompt")` — prompt-admission hook (mutable draft: text/files/metadata/delivery). Retry semantics documented as not exactly-once.
- `permission.hook("evaluate")` — runs for `allow`/`ask` decisions after configured rules; an explicit configured `deny` is final; the hook may flip `effect` and set `message`.
- `ctx.permission.rules` — session-scoped rules; **child sessions inherit the rules in effect when they are created** (real containment, not prompts).
- Native `ctx.worktree` domain — `create`/`remove`/`list`/`refresh` + `transform`/`reload`, project ownership, `Worktree.OperationError` (force-required confirmations), `worktree.updated` events.
- `ctx.generate.text` — sessionless model calls (no session, tools, or history).
- `session.hook("retry")` — retry decision/delay override with `attempt` number.
- `ctx.reference.transform`, `ctx.skill.transform`, `ctx.shell.hook("create.before")`, `ctx.integration.*` — documented surfaces with no current use.

## Completed Work and Residual Gaps

Everything in this section shipped after the 2026-08-30 draft (issues #8/#10/#14–#21, branches `feat/s3-v1-controls`, `feat/10-phase1-runtime-contracts`, `feat/worktree-pr-orchestration`, `feat/nested-worker-delegation`, `feat/orchestration-lifecycle-reliability`, `feat/orchestrator-sessions-sidebar`, `feat/single-collab-merge`, and successors; pinned through beta-19151 → beta-19507).

| Delivered | Evidence | Residual gap |
|---|---|---|
| **D2 — versioned structured handoffs** | `src/core/contracts.ts` (strict Zod mirror, 13-field envelope), `orchestrator_handoff_validate`, `STRUCTURED_HANDOFF_GUIDANCE`, `docs/phase-1/d2-*` | Callable, not an automatic gate; one-way structured→prose rendering; no stored handoff artifacts |
| **D4 — complexity classifier** | `src/core/d4.ts`, `orchestrator_task_complexity_classify` (`runtimeEnforced: false`), `docs/phase-1/d4-*` | Advisory only; corpus labels unmeasured; not part of a run record |
| **V2 — two-level validation** | `src/core/admission.ts` (8-state machine), `orchestration/validation.ts` (C1–C7/O1–O9 checks incl. `ctx.vcs`), `orchestrator_admission_transition`, `docs/phase-1/v2-validation-checklist.md` | Stateless vocabulary + callable validator; no automatic downstream admission; required-command re-runs remain parent-owned |
| **V3 — capability/evidence hardening** | `orchestration/evidence.ts` (typed `EvidenceRecord`, `assessEvidence`, live/mutation factories) attached to every successful GH/worktree result; `docs/phase-1/v3-capability-matrix.md`; doctor authority split | Evidence returned to the model, not persisted; doctor still lacks a rendered capability matrix; `ctx.integration` auth state unused as a signal |
| **S3 — trace/budget controls** | `observability/trace.ts` + `runtime.ts` (metadata-only, snapshot usage, unknown≠zero), `observability/budget.ts` (`within|exceeded|unknown`, fail-closed only for `stop-between-steps`), `docs/phase-1/s3-v1-controls.md` | No rate limits, retention policy, or operator dashboards; gates only plugin-owned next dispatches |
| **V1-bounded — maker-checker review** | `observability/review.ts` (states/actions/reasons, terminal breaker), `orchestrator_review_get/transition`, goal-continuation integration, `test/unit/review.test.ts` | No automatic completion gate, no model-tier escalation, no separate reviewer context/hidden reasoning, process-local locking only |
| **Publication lifecycle (beyond plan)** | `publish/` + terminal-chain policy: fail-closed push→draft→ready→best-effort approve→merge→verify; single-collaborator merge; exact-revision internal review authority | No durable per-operation GitHub ledger (only the capability record); merge-policy decision record is embedded in policy prose, not a standalone doc |
| **Managed worktree lifecycle (beyond plan)** | `worktree/tools.ts` incl. `worktree_enter` safe boundary + pending receipt, `session/move-coordinator.ts`, `session.moved` anchor reconciliation | Still current-session ownership; no per-child isolation (see N2/N3); own git subprocess tooling rather than the native `ctx.worktree` domain |
| **Per-session gates + TUI picker** | `gates/` (state/tools/rpc), `/gates`, TUI picker, read-only `orchestrator_gates_get` | Gates only narrow; they cannot grant; nothing to close |
| **Bounded nested delegation + durable worker models** | `roles.ts` delegation graph, `worker-models/` (catalog + durable selection) | Nested concurrency still unscheduled (A4) |
| **Peer discovery (beyond plan)** | `peers/` — bounded, redacted, deterministic peer-goal summaries via `storage.scan` | Not messaging (G1 remains open) |
| **TUI sessions sidebar** | `src/tui/sidebar.ts` — read-only volatile projection from client caches | Not a durable projection (S2 remains open) |

## Prioritized Proposals — Remaining

| Priority | ID | Group | Improvement | Rationale | Effort | Impact | Primary risk |
|---|---|---|---|---|---:|---:|---|
| P0 | N2 | Runtime Authority | Worker containment via `permission.rules` | Child sessions inherit rules at creation — the first real host-enforced authority boundary; closes the V4 containment gap | M | High | Over-blocking legitimate work; rule drift |
| P0 | N1 | Runtime Authority | Admission enforcement via `session.hook("prompt")` + `permission.hook("evaluate")` | Makes D4/V2/V1 enforceable at runtime on plugin-owned dispatch, opt-in and fail-closed | M | High | Prompt hooks are not exactly-once; false blocks |
| P1 | N3 | Worktree & Isolation | Migrate managed worktrees onto native `ctx.worktree` (supersedes W1/W2) | Documented domain with ownership, refresh, `worktree.updated`, `Worktree.OperationError`; unlocks per-worker isolation on a supported path | L | High | Behavior drift during migration; canonical-config coupling |
| P1 | N4 | Verification & Safety | Sessionless deterministic checks via `ctx.generate.text` | Semantic handoff lint, review-rubric parsing, complexity adjudication without child sessions | S | Medium | Nondeterministic model output; cost |
| P1 | V4 | Verification & Safety | Redaction centralization + authority recording | One tested redactor; evidence marked safe/redacted/unavailable; effective authority = intersection (now expressible via N2 rules) | M | High | False security |
| P1 | S1 | State & Observability | Durable per-step checkpoints with backoff and cursor resume | Goal/run records still lack per-step receipts; `storage.scan` gives cursors; retry classes feed N5 | L | High | Duplicate side effects |
| P1 | D1 | Delegation & Prompting | DAG scheduler with adaptive scaling | `max_parallel` still prompted only (A4 true); D4 now supplies the routing input | L | High | Over-decomposition |
| P2 | S2 | State & Observability | Durable event log + materialized projections | Volatile events still sole source for continuation/sidebar hydration; TUI sidebar is a volatile projection | L | High | State divergence |
| P2 | N5 | State & Observability | Retry/backoff policy via `session.hook("retry")` | Documented retry override; feeds S1 retry classification with bounded delays | S | Medium | Fighting host classification |
| P2 | D3 | Delegation & Prompting | Context budget measurement | No token estimator or budget yet; usage snapshots exist in trace records | M | High | Lossy compression |
| P2 | G1 | DX & Governance | Bounded parent/child messaging | Pinned contract still has no messaging/parentage API; peers are a stopgap; requires host primitives first | M | Medium | Deadlock |
| P2 | G2 | DX & Governance | Versioned policy profiles + evidence packets | Config surface has grown (trace/budget/review/clarify/publish/gates); `ctx.reference.transform` can publish profile docs | M | Medium | Profile sprawl |

### Runtime Authority (new)

#### N1 — Admission Enforcement via Prompt and Permission Hooks

**Problem**

D4 classification, D2/V2 validation, and V1 review are all callable/advisory. Nothing prevents a run from being reported complete without validated review, and no admission metadata survives into the host.

**Proposal**

An opt-in enforcement mode (strictly additive to current defaults) could:

- Register `session.hook("prompt")` for the orchestrator session to attach admission metadata (`event.metadata`) and, when a configured gate refuses, steer delivery or rewrite to the refusal contract instead of admitting the orchestration prompt.
- Register `permission.hook("evaluate")` so plugin-owned tool calls (permission actions `orchestrator_validation`, `orchestrator_gates`, publication actions) can be downgraded to `deny` with a truthful `message` when the dispatch gate, bounded-review breaker, or budget evaluation refuses — a real runtime gate for plugin surfaces.
- Keep the plugin-owned dispatch gate (goal continuation, command delivery) as the primary checkpoint; hooks are the second, host-visible layer.
- Respect the documented semantics: prompt hooks run once per admission and are not an exactly-once boundary; permission hooks run only for `allow`/`ask` outcomes (explicit configured `deny` is final and must stay final).
- Never auto-enable: default behavior must stay byte-identical to today.

**Files affected (candidate)**

- `src/core/config.ts` (new enforcement mode)
- `src/opencode-v2/plugin.ts`
- `src/opencode-v2/observability/runtime.ts`
- Candidate new `src/opencode-v2/authority/hooks.ts`

**Effort:** M · **Impact:** High · **Risk:** False blocks on retry-safe hooks; overlapping with native permission UX.

**Next step**

Write a hook-semantics test matrix (admission, retry-no-rerun, deny-is-final, delivery steering) against the pinned package before any gating logic.

#### N2 — Worker Containment via Session Permission Rules

**Problem**

Worker authority is prompt-only. Disjoint write scopes and "implementers never push" are instructions, not boundaries.

**Proposal**

Use `ctx.permission.rules` to install session-scoped rules for the orchestrator session immediately before delegating, relying on documented child-session inheritance at creation:

- Deny `edit`/`write`-class actions outside the current managed worktree directory (or the orchestrator's checkout when no worktree is entered) for sessions that will spawn implementation children.
- Deny plugin-orchestrator-only tool actions (`orchestrator_validation`, `orchestrator_gates`) to child sessions at the permission layer, in addition to the existing tool-level agent checks.
- Deny GitHub mutation actions to non-orchestrator sessions when `github.enabled` (defense in depth behind the tool preconditions).
- Record effective authority as the intersection of parent delegation and these rules (feeds V4), and clear rules when the orchestrator leaves the worktree or the session ends.
- Never widen: rules only restrict, and only within the orchestrator's own session lineage; static config gates and per-session gates remain untouched.

**Verification requirement**

Child-session rule inheritance is documented on the current plugin guide but must be probed against the pinned host before relying on it (see A3/A16 below): create a child from a session with rules and confirm the child enforces them.

**Files affected (candidate)**

- `src/opencode-v2/plugin.ts`
- `src/opencode-v2/worktree/tools.ts` (rule install/clear around `worktree_enter`/`cleanup`)
- `src/core/permissions.ts`
- Candidate new `src/opencode-v2/authority/rules.ts`

**Effort:** M · **Impact:** High · **Risk:** Over-blocking legitimate parent work if rule scope is too broad; inheritance semantics differ across hosts.

**Next step**

Probe inheritance on the pinned host; then define the rule lifecycle (install at enter, clear at cleanup/exit) with unit tests against a fake rules store.

### Worktree & Isolation

#### N3 — Native Worktree Domain Migration (supersedes W1/W2)

**Problem**

The plugin implements worktrees through its own git subprocess allowlist with custom ownership bookkeeping. The pinned contract now ships a first-class `ctx.worktree` domain: project-scoped `create`/`remove`/`list`/`refresh`, recorded strategy ownership, `Worktree.OperationError` for force-required confirmations, and `worktree.updated` events. The old W1 ("worktree per worker after host API validation") and W2 ("reconciler and explicit merge policy") proposals should be re-scoped onto this documented surface; the fail-closed merge policy itself already shipped in the publication chain.

**Proposal**

- Preflight the native domain on the pinned host (`list`/`refresh`/`worktree.updated` delivery) and record compatibility (A16).
- Migrate managed worktree create/list/remove behind a thin adapter with the existing tools as fallback; keep durable `worktree/v2/...` records as the projection until native inventory is proven equivalent.
- Adopt `Worktree.OperationError({ forceRequired })` for dirty-worktree cleanup confirmation instead of ad-hoc refusal text.
- Evaluate registering the plugin's git strategy via `ctx.worktree.transform` only if the plugin must own destination layout; otherwise rely on the bundled strategy.
- Re-open per-worker isolation (old W1) on top of the native binding: orchestrator session → managed worktree → children created under rules (N2) that pin writes to that directory; cleanup only after integration or explicit user decision (old W2 lifecycles: `ready`, `moved`, `dirty`, `orphaned`, `cleanup-failed` are preserved).

**Files affected (candidate)**

- `src/opencode-v2/worktree/{tools,git,state,events}.ts`
- `src/opencode-v2/plugin.ts`
- `src/core/config.ts` (migration switch)

**Effort:** L · **Impact:** High · **Risk:** Native create/refresh waits for canonical plugins and loads canonical configuration — behavior differences around worktrees created outside the repo root must be mapped before cutover.

**Next step**

Compatibility probe + adapter design doc comparing native inventory with `worktree/v2` records on a synthetic set (clean, dirty, moved, orphaned).

### Verification & Safety (remaining)

#### V4 — Redaction Centralization and Authority Recording

Unchanged in goal from the previous draft — one tested redactor, adversarial fixtures, evidence fields marked safe/redacted/unavailable — with one new component: effective authority can now be **recorded** (and later enforced by N2) as the intersection of parent delegation, worker policy, and installed session rules. A redaction/authority threat model remains the entry point; regexes are still not a secret boundary (A8).

**Files affected (candidate):** `process/redact.ts`, `commands/runtime.ts`, `core/permissions.ts`, `gh/client.ts`, `worktree/tools.ts`, candidate `authority/rules.ts` (with N2).

#### N4 — Sessionless Deterministic Checks via `ctx.generate.text`

Use `ctx.generate.text` for checks that need judgment but not a session: semantic D2 lint (facts/assumptions coherence), review-rubric structuring for bounded review, and D4 adjudication of borderline classifications. Output must be parsed defensively and treated as advisory unless deterministic (schema/semantic) checks already pass; no transcripts or secrets in prompts; results recorded in the trace summary only as metadata.

**Files affected (candidate):** `orchestration/validation.ts`, `observability/review.ts` (adapters), `core/d4.ts`.

**Effort:** S · **Impact:** Medium · **Risk:** Model nondeterminism; added cost; must never become the sole gate.

### State & Observability (remaining)

#### S1 — Durable Per-Step Checkpoints with Backoff and Cursor Resume

As previously drafted (run/task IDs, idempotency keys, attempt numbers, cursors, error classes, backoff with jitter, last validated checkpoint, terminal reasons; refuse exactly-once claims). New inputs: `storage.scan` cursors exist; retry classes can consume N5's hook; trace summaries already count steps/retries. Replay-safety inventory (replay-safe / idempotent / compensatable / ambiguous) remains the entry point, now including the publication chain's external GitHub side effects.

**Files affected (candidate):** `goal/state.ts`, `goal/continuation.ts`, `commands/runtime.ts`, `publish/`, candidate `orchestration/run-state.ts`.

#### S2 — Durable Event Log and Materialized Projections

As previously drafted (volatile events vs durable append-only lifecycle records vs projections; monotonic sequence, schema version, idempotency key, redacted payload, replay/gap semantics). New context: the TUI sidebar is a working volatile projection; `storage.scan` pagination can back projection hydration; storage still lacks transactions, so publication rules must be defined before choosing primitives.

**Files affected (candidate):** `plugin.ts`, `goal/continuation.ts`, `worktree/events.ts`, candidate `orchestration/{events,projections}.ts`.

#### N5 — Retry/Backoff Policy via the Retry Hook

Register `session.hook("retry")` to implement bounded, classed retry policy for orchestrator sessions: honor host classification, cap delays (documented: invalid delays fall back to the computed delay; built-in max attempts remain a hard limit), and record attempts in the trace summary. Feeds S1 retry classes; must not convert terminal failures into retries for external side-effect classes.

**Files affected (candidate):** `plugin.ts`, `observability/{runtime,trace}.ts`, candidate `authority/hooks.ts` (with N1).

**Effort:** S · **Impact:** Medium · **Risk:** Fighting host classification; retry storms.

### Delegation & Prompting (remaining)

#### D1 — DAG Scheduler with Adaptive Scaling

Unchanged in goal: first-class task graph (stable IDs, roles, dependencies, scopes, risk, budgets, retries, artifacts, validation), cycle/duplicate rejection, wave execution capped at `max_parallel`. New inputs: D4 supplies routing recommendations; bounded nested delegation exists; worker models are durable. Still design-first: validate a schema against representative tasks before building a scheduler, and keep native delegation as the fallback.

#### D3 — Context Budget Measurement

Unchanged in goal (task-specific inputs, artifact references over transcripts, measured token metadata, explicit exceptions). New input: trace usage snapshots provide measured input/output token aggregates where the host emits them; the `<5K` figure remains a heuristic (A7). First step is still measurement on a small corpus, now feasible with `trace: "memory"`.

### DX & Governance (remaining)

#### G1 — Bounded Parent/Child Messaging

Still blocked on host primitives: the pinned contract has no `promptAsync`, parentage, or inter-session messaging surface (verified by grep of the pinned declarations); `permission`/`prompt` hooks do not provide it. Peer discovery is the current stopgap. Keep the design (parent-mediated routing, parentage authorization, size/round caps, timeouts, cancellation, visible redacted markers) parked until the pinned contract exposes the primitives; do not treat issue #20849 or PR #38942 as merged functionality.

#### G2 — Versioned Policy Profiles and Evidence Packets

Unchanged in goal, now with a concrete delivery surface: publish the effective profile as a local reference via `ctx.reference.transform` (handbook-style), report it through `doctor` and `/handover`, and derive it from the existing strict config blocks (trace/budget/review/clarify/publish/gates). List every field as advisory, enforced, unsupported, or host-dependent; no secrets.

## Non-Goals / Out of Scope

- Replacing OpenCode's native V2 session or plugin architecture.
- Claiming stable V2 APIs or treating beta behavior as contract.
- Treating prompt instructions as filesystem or OS isolation (until N2 lands and is verified, prompt rules remain prompts).
- Guaranteeing exactly-once provider or external-tool execution.
- Persisting raw transcripts, prompts, or credentials.
- Adopting the deprecated npm package as a dependency; treating closed issue #20849 or closed PR #38942 as merged upstream functionality.
- Widening any gate: session gates only narrow; N1/N2 enforcement must only restrict.
- Building a general-purpose enterprise agent platform; certifying regulatory compliance.
- Distributed cluster placement before leases, fencing, and ownership semantics exist.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Over-orchestration increases cost and latency | D4 routing (shipped), budgets/step limits (shipped, opt-in), direct-execution path |
| Bad decomposition amplifies errors | Two-level validation (shipped, callable), bounded review (shipped), D1 DAG validation (planned) |
| Runtime enforcement false-blocks legitimate work (N1/N2) | Opt-in modes, defaults byte-identical, truthful refusal messages, deny-is-final preserved, hook test matrix first |
| Native worktree migration drift (N3) | Adapter with fallback, dual-record comparison, compatibility probe before cutover |
| Child rule inheritance differs across hosts (N2) | Pin-level probe (A16), rules recorded and reported, never the only boundary |
| Storage is not transactional or durable enough | Idempotency keys, no exactly-once claims, append/replay design (S1/S2), scan-cursor hydration |
| Retry duplicates side effects | Replay-safety inventory incl. publication chain, retry classes (N5), pause ambiguous actions |
| Multi-agent consensus becomes correlated error | Independent checker prompts, deterministic checks first (N4 advisory only), human review for high-risk actions |
| Native V2 API changes break integration | Pinned contract tests, conformance section above, A15/A16 tracked assumptions, no undocumented calls beyond `ctx.catalog` |
| Redaction misses novel credential formats | Central redactor, adversarial fixtures, no raw output in evidence, explicit uncertainty |
| Observability leaks private data | Metadata-only trace records (shipped), retention limits still to define (S2) |
| Doctor creates false confidence | Authority/freshness per capability, local checks advisory, `ctx.integration` signal optional |

## Next Steps

### Phase A — Runtime Authority (N1, N2)

- Probe the pinned host: `session.hook("prompt")` admission/retry semantics, `permission.hook("evaluate")` ordering vs configured rules, child-session `permission.rules` inheritance.
- Ship the hook-semantics test matrix, then opt-in enforcement (N1) and the rule lifecycle around `worktree_enter` (N2).
- Exit evidence: pinned-host probe results; enforcement mode with byte-identical defaults; containment demonstrated in a contract test.

### Phase B — Worktree Migration (N3)

- Compatibility probe of `ctx.worktree` (create/list/refresh/`worktree.updated`, `Worktree.OperationError`) against synthetic clean/dirty/moved/orphaned states.
- Adapter cutover with the current tools as fallback; preserve `worktree/v2` records as projection until native inventory is proven equivalent.
- Re-scope per-worker isolation on the native binding + N2 rules.
- Exit evidence: dual-record comparison; merge/decision record for cutover; per-worker isolation design.

### Phase C — Verification Hardening (N4, V4)

- Redaction/authority threat model; central redactor with adversarial fixtures.
- Sessionless semantic checks wired as advisory post-steps of the existing validators.
- Exit evidence: threat model; fixtures green; N4 outputs recorded as trace metadata only.

### Phase D — State and Scale (S1, S2, N5, D1, D3, G1, G2)

- Replay-safety inventory; checkpoint/cursor schema; durable event log + projections; retry classes via the retry hook.
- DAG scheduler pilot on a narrow workload after S1 exists; context-budget measurement using trace snapshots.
- G1 stays parked until host messaging primitives exist; G2 profile via `ctx.reference.transform`.
- Exit evidence: failure/recovery matrix; projection rebuild proof; scheduler pilot comparison; measured handoff sizes.

## Appendix

### Assumptions Requiring Verification

- **A1 — V2 API stability:** beta/experimental; re-verify each surface per pin.
- **A2 — Background/messaging primitives:** `promptAsync`, parentage, and inter-session messaging are absent from the pinned declarations (grep-verified); issue #20849/PR #38942 remain proposals. The **prompt-admission hook, permission hooks/rules, and native worktree domain are now verified present** in the pinned package types (this reverses the 2026-08-30 status).
- **A3 — Atomic child isolation:** still unavailable end-to-end. Native worktree operations exist (N3), but child-session↔worktree binding must be demonstrated (now via N2 rule inheritance + N3), not assumed.
- **A4 — Parallelism enforcement:** unchanged — `max_parallel` is prompted; no scheduler or semaphore exists.
- **A5 — Review enforcement:** bounded review gates plugin-owned dispatch only; completion is still not gated anywhere (target N1).
- **A6 — Storage guarantees:** `get`/`set`/`remove`/`scan` confirmed (scan in use); transactions, CAS, append-only writes, and cross-process locks remain absent; durability across server restarts unverified for newer records (snapshot persistence is a live-probe item, A13).
- **A7 — Token measurement:** trace usage snapshots capture host-emitted aggregates where available; coverage is unknown/partial, never zero; `<5K` remains a heuristic.
- **A8 — Redactor completeness:** pattern coverage is not a secret boundary; adversarial fixtures still owed (V4).
- **A9 — Capability authority:** unchanged — doctor local/advisory; server probes authoritative only for tested fields.
- **A10 — Source reliability:** vendor/community claims remain directional; closed issue/PR are not contracts.
- **A11 — GitHub durability:** the publication **capability record** is durable (`publish/v1`); per-operation GitHub ledgers still do not exist.
- **A12 — Isolation vs security:** prompt rules, permission visibility, worktree bookkeeping, and OS containment remain separate properties; N2 adds the first host-enforced layer inside that model.
- **A13/A14 — S3/V1 semantics:** tracked in `docs/phase-1/assumptions.md` (partially verified; live shared-service probes outstanding).
- **A15 — Undocumented catalog domain:** `ctx.catalog` is in the pinned `Context` type but not on the plugin guide; documented equivalent is `ctx.model.list()`. Track per pin; migrate if it breaks.
- **A16 — `tui` flag and hook/worktree host behavior:** the pinned `Plugin` type lacks the `tui` field (cast in use, contract-tested); live-host behavior of `session.hook("prompt")`, `permission.hook("evaluate")`, child rule inheritance, and native worktree ops is unit-faked only and needs the Phase A/B probes.

### Verification Checklist

```sh
bun run typecheck && bun test && bun run build
bun run src/cli/index.ts doctor
```

Docs-only changes to this file need no build; the checklist applies when plan items are implemented. Packed-package smoke tests remain required for packaging changes.

### File Inventory

Core:

- `src/core/config.ts` · `roles.ts` · `policy.ts` · `prompts.ts` · `permissions.ts` · `package-identity.ts`
- `src/core/d4.ts` · `contracts.ts` · `admission.ts` · `model-reference.ts` · `prompt-builder.ts`

Plugin and TUI:

- `src/index.ts` · `src/tui.ts` · `src/tui/sidebar.ts`
- `src/opencode-v2/plugin.ts` · `agents.ts`

Commands and state:

- `src/opencode-v2/commands/index.ts` · `commands/runtime.ts`
- `src/opencode-v2/goal/{state,tools,continuation}.ts`
- `src/opencode-v2/session/{state,move,move-coordinator}.ts`

Domains:

- `src/opencode-v2/gates/{state,tools,rpc}.ts`
- `src/opencode-v2/observability/{trace,budget,review,runtime,tools}.ts`
- `src/opencode-v2/orchestration/{validation,evidence,tools}.ts`
- `src/opencode-v2/peers/tools.ts` · `publish/{state,tools}.ts` · `worker-models/{runtime,state}.ts`

Worktree, process, GitHub:

- `src/opencode-v2/worktree/{state,tools,git,events}.ts`
- `src/opencode-v2/process/{runner,redact}.ts`
- `src/opencode-v2/gh/{client,tools}.ts`

CLI:

- `src/cli/index.ts` · `install.ts` · `doctor.ts`

Verification surfaces:

- `test/unit/` (admission, agents, clarify, continuation, contracts, core, d4, evidence, gates, gh, installer, observability, orchestration-tools, peers, process, prompt-builder, publish, review, runtime, session-move, session-state, session-status, tools, tui-sidebar, worker-models, worktree)
- `test/contract/plugin.test.ts` · `embedded.test.ts` · `tui.test.ts`

Design/records:

- `docs/phase-1/` (assumptions, d2/d4/v2/v3/s3 artifacts)

### Research Source Catalog

Retained from the 2026-08-30 draft; directional only.

1. [Anthropic — How we built their multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
2. [PromptEngines — The Orchestrator Pattern](https://www.promptengines.com/labnotes/articles/2026-03-14-orchestrator-pattern-agent-design-v3.html)
3. [CopilotKit — PydanticAI Sub-Agents](https://docs.copilotkit.ai/pydantic-ai/multi-agent/subagents)
4. [Beam — Multi-Agent Orchestration Patterns](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)
5. [Agentik OS — Production Orchestration Guide](https://www.agentik-os.com/blog/multi-agent-orchestration-production-guide)
6. [OpenCode issue #20849 — Plugin-Based Agent Orchestration](https://github.com/anomalyco/opencode/issues/20849) (closed proposal; its worktree phase is now largely superseded by the shipped native `ctx.worktree` domain)
7. [OpenCode Council — v0.2.0-beta](https://github.com/marcel-tuinstra/opencode-council/tree/v0.2.0-beta)
8. [Tyk — Enterprise AI Agent Orchestration Guide](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)
9. [Knowlee — AI Agent Orchestration Guide 2026](https://www.knowlee.ai/blog/ai-agent-orchestration-guide-2026)
10. [OpenAgents — OpenCode V2 Architecture Teardown](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)
11. [npm — `@moderndegree/opencode-agent-teams`](https://www.npmjs.com/package/@moderndegree/opencode-agent-teams) (deprecated; unverified claims)
12. [OpenCode PR #38942 — Agent-to-Agent Messaging](https://github.com/anomalyco/opencode/pull/38942) (closed proposal; still no pinned primitives)

Primary contract sources (authoritative for this plan): [plugin guide](https://opencode.ai/v2/docs/build/plugins) · [CLI plugin guide](https://opencode.ai/v2/docs/build/plugins/cli) · [HTTP API](https://opencode.ai/v2/docs/api) · pinned `@opencode/plugin`/`@opencode/sdk` `0.0.0-beta-19507` declarations.

---

*Restructured 2026-09-15 from repository inspection (post issue #21, pinned beta-19507), the current OpenCode V2 plugin documentation, and the pinned package declarations. Completed items are recorded with evidence; every remaining proposal starts from a pinned-contract probe.*
