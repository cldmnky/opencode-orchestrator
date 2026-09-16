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
- The orchestrator's **language is its weakest user-facing surface**: operational policy strings are 400–850-character single sentences, the agent has a functional description but no voice or tone contract, and clarification guidance covers only initial task ambiguity. User-visible output inherits this density. G3 targets plain-language communication, a helpful personality, and restatement/summary loops.
- The **N3 native-worktree probe is complete (2026-09-15) and blocks cutover**: the pinned `ctx.worktree` domain cannot back the managed `worktree/v2` lifecycle (detached create, no ownership/dirty/moved/orphan states, `refresh` result dropped at the plugin surface, destructive `force`). The only permitted follow-up is a read-only inventory observation pilot with `worktree/v2` still authoritative. See [`docs/phase-1/n3-native-worktree-compatibility.md`](phase-1/n3-native-worktree-compatibility.md).
- The **N4 sessionless-generate contract probe is complete (2026-09-15)** and the **Phase C close
  (2026-09-16) implemented its permitted pilot**: an opt-in, default-off `hints.mode: "advisory"`
  post-step that runs one sessionless generation call only after deterministic D2 checks pass,
  builds prompts from check verdicts only, parses/redacts/bounds the output, records a bounded
  trace-shaped metadata record on the `handoff_validate` result, and never gates. No real provider
  call was measured and the surface still has no abort control (the plugin races a 2 s external
  timeout), so the pilot remains metadata-only and its live envelope is unmeasured. See
  [`docs/phase-1/n4-sessionless-generate-compatibility.md`](phase-1/n4-sessionless-generate-compatibility.md).
- **Config drift defect (verified against the live schema):** the installer and dev template still write `experimental.subagent_depth`, but the current host schema defines **top-level** `subagent_depth` and `experimental` rejects additional properties — so installer-managed installs silently run at native depth 1 and nested delegation breaks. G4 plans the migration. `experimental.continue_loop_on_deny` and `experimental.batch_tool` are confirmed host keys the orchestrator experience needs but the installer does not set.
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
- `authority`: `off|enforce` (default `off`); `hints`: `{ mode: "off"|"advisory", model? }` (default off; `advisory` requires an explicit `providerID`/`id` model reference).
- `github` and `worktree` disabled by default; mutations additionally disabled by default; `publish.enabled` default `false`.
- Defaults preserve pre-observability behavior exactly; the S3/V1 controls are strictly opt-in, and the Phase C close (`authority` snapshots, generation hints) is opt-in and default-off.

`src/core/roles.ts` still maps planning→`planner`, research→`explore`, implementation→`implementer`, review→`reviewer`. Nested delegation is bounded to the role graph (a delegating worker stays accountable; research never delegates).

### Enforcement Matrix

| Constraint | Enforcement today |
|---|---|
| `max_parallel`, disjoint write scopes, `require_review` (in `prompt` review mode), complexity routing | Prompt-only |
| `stop-between-steps` budget, bounded-review circuit breaker | Plugin-owned dispatch gates (goal auto-continuation before reservation/delivery; slash-command prompt delivery); never in-flight cancellation, never `session.interrupt` |
| GitHub/worktree mutations | Fail-closed tool preconditions + static config gates + `confirm: true` + durable publish capability + per-session gates |
| Worker authority/containment | Opt-in `authority.mode: "enforce"`: N1 gate on tagged dispatches, N2 child-only tool-action session rules, and durable `authority/v1` snapshots. Snapshots are records, never decisions; not filesystem/process/worktree isolation |
| Generation hints (N4 pilot) | Opt-in `hints.mode: "advisory"`: advisory metadata only, never a gate; runs only after deterministic D2 checks pass |
| Completion gating (no finish without validated review) | Not enforced (target of N1) |

### Review and Verification

- `require_review=true` remains prompt-level in the default `prompt` review mode.
- `review.mode: "bounded"` adds `orchestrator_review_get`/`orchestrator_review_transition` with a version-1 review schema (states `pending`/`approved`/`changes-requested`/`blocked`/`tripped`, fixed reason codes, deterministic transitions); tripped/blocked records stop goal auto-continuation. Still no automatic completion gate and no model-tier escalation.
- `orchestrator_handoff_validate` performs deterministic D2 + V2 checks including parent-side `ctx.vcs` state, path existence, realpath, and redaction; it is callable, not automatic. Worker-declared verification passes are never upgraded.

### Conversation and Tone

**Observed limitation (user-reported, source-confirmed):** the orchestrator's generated language is complex and hard to understand.

- `src/core/policy.ts` embeds multiple 400–850-character single-sentence guidance strings (e.g. the worktree/publication/review policies); the runtime context injection in `src/opencode-v2/plugin.ts` (`session.hook("context")`) contains 556–858-character sentences. Instruction density propagates into model output.
- `buildOrchestratorSystem` (`src/core/prompts.ts`) contains only operational policy; the orchestrator agent's description is "Coordinates specialized agents and verifies their work." — there is no voice, tone, or audience contract.
- `CLARIFY_GUIDANCE` (`clarify.auto`) covers only initial task ambiguity, in one dense sentence. There is no restatement-before-start, no plain-language status at phase boundaries, and no end-of-run summary contract.
- Status messages (`emitStatus` in `commands/runtime.ts`) are terse and mechanical (e.g. "Dispatch blocked by configured controls: …") with no what-it-means / what-next layering; `/handover` emits a raw redacted section dump rather than a readable summary.

G3 (below) plans the fix.

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
- The host config schema moved subagent nesting depth from `experimental.subagent_depth` to **top-level `subagent_depth`**; the current `experimental` block has `additionalProperties: false`, so the installer-written nested key is silently ignored and installs run at native depth 1 (G4 fixes the installer; A17 records the verification).
- Embedded-host native worktree calls are **location-routed, not config-routed**: `OpenCode.create({ config: { directory } })` leaves the plugin's boot `ctx.location` at the process working directory, and every `ctx.worktree.*` call must pass `location: { directory }` to target a project (the domain resolves it to a location-scoped service). `ctx.worktree.refresh` resolves to `void` and drops the core `{ updated, removed }` result, and dirty removal raises `Git.WorktreeError` with `forceRequired: true` — not `Worktree.OperationError`. A directly-passed plugin object is instantiated once per active location, so event ids can be delivered more than once in the same harness (dedupe by id).

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
- `ctx.generate.text` — sessionless model calls (no session, tools, or history). **Probe complete 2026-09-15 (N4): exact `{ prompt, model? } -> { text }` shape measured, catchable `Generate.*` failures, test-only deterministic provider override.** The Phase C close (2026-09-16) wired the permitted pilot behind default-off `hints.mode: "advisory"`: one bounded advisory metadata record after deterministic checks pass; no real provider call measured, no abort control (external timeout race).
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
| P0 | G3 | DX & Governance | Plain-language communication, helpful personality, clarification/summary loop | Policy strings run 400–850 chars in single sentences; no voice/tone spec; clarify covers only initial ambiguity; user output inherits the density | M | High | Losing precision in safety-critical instructions |
| P0 | G4 | DX & Governance | Installer schema migration: top-level `subagent_depth` + recommended experimental keys | Live schema moved depth to top-level; `experimental` rejects additional properties, so installer-written depth is dead and nested delegation silently breaks; `continue_loop_on_deny`/`batch_tool` are confirmed host keys the experience needs | S | High | Silent config drift on future pins |
| P1 | N3 | Worktree & Isolation | Migrate managed worktrees onto native `ctx.worktree` (supersedes W1/W2) — **compatibility probe complete 2026-09-15: cutover blocked; no adapter implemented** | Documented domain with ownership, refresh, `worktree.updated`; the probe measured project-scoped inventory, detached create, `Git.WorktreeError.forceRequired` dirty refusal, and silent row drops — the native states do not match `worktree/v2` | L | High | Behavior drift during migration; canonical-config coupling; native `force` deletes dirty trees |
| P1 | N4 | Verification & Safety | Sessionless deterministic checks via `ctx.generate.text` — **contract probe complete 2026-09-15; opt-in metadata-only pilot wired 2026-09-16 (`hints.mode: "advisory"`, default off)** | Semantic handoff lint, review-rubric parsing, complexity adjudication without child sessions | S | Medium | Nondeterministic model output; cost |
| P1 | V4 | Verification & Safety | Redaction centralization (**V4a complete 2026-09-15**) + authority recording (**V4b complete 2026-09-16, opt-in enforce mode only**) | One tested redactor with adversarial fixtures and a threat model; evidence stays transient; durable effective-authority snapshots are records that never gate (N2 rules remain the only host-enforced layer) | M | High | False security |
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

**Compatibility probe — COMPLETE (2026-09-15); cutover blocked.**

`test/contract/phase-b-worktree.test.ts` boots embedded beta-19507 hosts in temporary Git repositories and measures the native `ctx.worktree` domain directly (every call routed with `location: { directory }`, zero provider traffic). The full mapping table and command evidence live in [`docs/phase-1/n3-native-worktree-compatibility.md`](phase-1/n3-native-worktree-compatibility.md).

- **list/refresh:** project-scoped `{ directory, strategy? }` rows (root row has no strategy); `ctx.worktree.refresh` resolves to `void` and drops the core `{ updated, removed }` result; `worktree.updated` carries only `{ projectID }`; `worktree.resolved` is project resolution, not session movement.
- **create:** returns exactly `{ directory }` (canonical `realpath`), collision-suffixes `-2`, and creates a **detached** HEAD — `branch`/`from` are starting refs, never a new branch. Unknown refs fail as `Git.WorktreeError` with `forceRequired: false`.
- **remove:** clean removal succeeds and drops the row/linkage; dirty removal fails closed with a directly observed `Git.WorktreeError.forceRequired: true` and git's `contains modified or untracked files` message; `force: true` deletes the dirty tree; unknown directories and the main checkout are refused as `Worktree.InvalidDirectoryError`; workspace-scoped locations are refused.
- **Inventory semantics:** externally created git worktrees are adopted on the next `list`; vanished directories are silently dropped (no orphan record). Of the managed states (`pending`, `ready`, `dirty`, `moved`, `orphaned`, `cleanup-failed`), only a partial `ready` (directory inventory) maps; dirty detection, ownership, `moved`, and `orphaned` do not.
- **Decision:** **cutover is blocked.** An adapter cannot back the managed lifecycle on the measured native surface; the only permitted follow-up is a read-only inventory observation pilot with `worktree/v2` still authoritative. `forceRequired` is the one native signal worth adopting. No child filesystem/process isolation claim is made.

**Next step (post-probe)**

No further N3 work is authorized by this probe. If a read-only inventory observation pilot is wanted, it needs an explicit new slice with its own opt-in switch, `worktree/v2` records still authoritative, no native `create`/`remove`, no `force`, and dedupe-by-event-id handling.

### Verification & Safety (remaining)

#### V4 — Redaction Centralization and Authority Recording

**V4a (redaction centralization) complete 2026-09-15.** `process/redact.ts` is the single redaction implementation; the duplicate private redactor in `session/move.ts` was deleted in favor of the canonical import. The replacement is not an unconditional strict superset: canonical coverage is broader for documented credential shapes and keyed output uses the canonical `key: [redacted]` form, but whole-word matching intentionally stops matching credential keywords embedded in longer identifiers (`session_token`, `my_secret`) that the prior boundary-less helper caught incidentally; pattern redaction remains a heuristic, not a secret boundary. Adversarial fixtures now cover encoded exact secrets, query-like text, multiline mixed output, substring preservation, empty secret lists, and `redactProcessResult`; direct session-move tests pin GitHub-token, Bearer-token, and no-exact-secret-channel behavior; D2 C7 has GitHub-token/Bearer-shaped fail cases plus a no-secret control; evidence tests pin only enforced schema boundaries and document that `source` has no credential-shape rejection. The threat model at [`docs/v4-redaction-threat-model.md`](v4-redaction-threat-model.md) inventories consumers, raw process-output entry paths, both redaction layers, never-stored data, transient evidence/authority limits, the peer-hint limit, and the regex limit (A8). Behavior outside redaction expansion is unchanged: defaults, D2 v1, admission, review, publication, and gates are untouched.

**V4b (effective-authority recording) complete 2026-09-16 — opt-in, records only, never gates.** The Phase C close landed the permitted slice on top of Phase A's N2 containment:

- **Schema and key:** one strict version-1 record per configured-role child session under `authority/v1/<project>/<session>` (`src/opencode-v2/authority/state.ts`): session/parent IDs, role agent, capture time, mode/rule-scope literals, one entry per tracked tool-action family (the eight containment actions), and an explicit `unknownDimensions` list.
- **Dimensions and intersection:** `parent` (the delegating parent's family-wide rules at snapshot time), `worker-policy` (the plugin's static containment denies for configured-role children), `installed` (the child's own rules read back after install), and `effective` = strictest of the three (`unknown` if any dimension is unknown, else `deny` > `ask` > `allow` > `unconstrained`). Only `resource: "*"` rules participate.
- **Lifecycle:** written during the child's own admission after the rules are ensured, under the existing process-local `withSessionLock`; recording is best-effort and never changes the admission decision; every snapshot this runtime wrote is cleared on runtime disposal (plugin teardown), so no record outlives the enforcing process. Install/clear is deliberately **not** tied to worktree enter/cleanup in this slice.
- **Read surface:** `orchestrator_authority_get` (registered only in enforce mode, orchestrator role only, reusing the read-only `orchestrator_observability` permission action so installer/agent-transform rules are unchanged) returns the record or an explicit `unknown` (`missing`/`malformed`/`unreadable`) plus plain limits. It never writes, and no admission/permission/gate/review/publication path reads snapshots.
- **Honest strength:** tool-action containment metadata only — not filesystem, process, worktree, or atomic child isolation; one current record per session with a process-local lock only (no CAS, transactions, retention, or cross-process guarantee).
- **Exit evidence:** `test/unit/authority.test.ts` → 40 pass, 0 fail, 262 expect() calls (includes snapshot schema/key, last-match-wins family effects, intersection strictness, unknown/malformed/unreadable reads, recording after rule install, best-effort failure that never blocks admission, clear-on-dispose, and tool registration/role rejection); `test/unit/evidence.test.ts` pins that hints and snapshots are neither EvidenceRecords nor authority; full-suite, typecheck, build, and `git diff --check` results are in the Phase C ledger.

**Files landed:** `src/opencode-v2/authority/state.ts` (new), `src/opencode-v2/authority/tools.ts` (new), `src/opencode-v2/authority/runtime.ts`, `src/opencode-v2/plugin.ts`, `test/unit/authority.test.ts`, `docs/v4-redaction-threat-model.md`.

#### N4 — Sessionless Deterministic Checks via `ctx.generate.text`

Use `ctx.generate.text` for checks that need judgment but not a session: semantic D2 lint (facts/assumptions coherence), review-rubric structuring for bounded review, and D4 adjudication of borderline classifications. Output must be parsed defensively and treated as advisory unless deterministic (schema/semantic) checks already pass; no transcripts or secrets in prompts; results recorded as bounded metadata only. **Implemented form (Phase C close):** one opt-in advisory post-step on `handoff_validate` whose bounded, redacted, versioned record is attached to the validator result (schema owned by `observability/trace.ts`); the plugin does not write it into the session trace summary and does not persist it.

**Contract probe complete (2026-09-15); the permitted opt-in pilot landed in the Phase C close (2026-09-16).** The probe measured the pinned surface end to end in an embedded host and produced the decision record [`docs/phase-1/n4-sessionless-generate-compatibility.md`](phase-1/n4-sessionless-generate-compatibility.md):

- Probe scope delivered: exact `{ prompt, model? } -> { text }` shape, sessionless behavior (no session, inbox item, history, or tool call; session-scoped `generate`/`model.request`/`http.request` hooks never fire), a deterministic in-process provider injected through `ctx.aisdk.hook("sdk")`/`("language")`, and two catchable failures (`Generate.ModelSelectionError` for an unknown model, `Generate.UnavailableError` for a provider failure) — with **no real-provider call** and zero external network attempts. The unknown-model case rejects before any provider call; the provider-failure case fails inside the injected in-process provider, which is the suite's only provider call (never a configured provider or the network).
- Measured result: the injected language model received exactly one user text message with `tools: []`; an unknown model rejects before the injected provider is called; example prompts and outputs stayed non-sensitive fixtures.
- Decision at probe time: **pilot-only, not authorized for production wiring.** A real provider call (network, credentials, cost, latency, model choice, output nondeterminism) was deliberately not measured, the declared input has **no timeout/abort control**, and the only deterministic seam is a test-only host-wide provider override; provider packaging is pin-coupled to the built-in dynamic npm loader.
- Corrected plan assumption: N4 cannot be treated as a deterministic check by itself. Any use remains advisory, with deterministic schema/semantic checks first.
- **Exit evidence:** `bun test test/contract/phase-c-generate.test.ts` → 6 pass, 0 fail, 67 expect() calls; `bun run build`, `bun run typecheck`, and `git diff --check` green; full-suite evidence recorded in the decision record's reproduction section.

**Implemented pilot (Phase C close, 2026-09-16) — opt-in, default-off, metadata only.** The close wired exactly the permitted advisory post-step:

- **Config:** strict `hints: { mode: "off" | "advisory", model?: { providerID, id } }`, default `{ mode: "off" }`; `advisory` requires an explicit model reference (no host-default guessing). With hints off, `handoff_validate` output is byte-identical and no generation call is made.
- **Ordering:** the call runs only after the deterministic D2 checks return `pass`; failing/blocked receipts produce a bounded `skipped` record and no call.
- **Prompt:** check ids and verdicts only (`<check-id>=<verdict>` lines plus fixed instruction text); no check details, commands, paths, session text, transcripts, secrets, URLs, or payloads. Hard cap 1200 characters; over-cap prompts are skipped, never truncated.
- **Output:** defensive `{ text }` parse, single-line/control-character normalization, hard cap 600 characters, canonical-redactor pass, then a 280-character bounded hint in the record. Reasons come from a fixed enum, so provider error text and payload echoes cannot be recorded.
- **Bounding:** the surface has no abort/timeout control, so the post-step races the call against a 2 s external timeout; a timeout abandons the wait (it cannot cancel the call) and records `timed-out`.
- **No gating:** the record never changes the verdict, admission state, checks, prose, a gate, or any other decision. It is trace-shaped bounded metadata (schema in `observability/trace.ts`) attached to the `handoff_validate` result; the plugin does not write it into the session trace summary or persist it. Caller-known secrets thread only through the existing injected redactor seam (production threads none).
- **Exit evidence:** `test/unit/orchestration-tools.test.ts` → 56 pass, 0 fail, 296 expect() calls (includes enabled/disabled paths, verdicts-only prompt assertions, fail-path skip, size bounds, credential redaction, exact-secret threading with a no-secret control, timeout race, provider failure, defensive parse, and a fixed-key metadata record); `test/unit/observability.test.ts` and `test/unit/process.test.ts` pin the record schema/bounds and the redaction shape; full-suite, typecheck, build, and `git diff --check` results are in the Phase C ledger.
- **Still unmeasured:** no real provider call, cost, latency, or nondeterminism was exercised; the live provider envelope remains unmeasured and the pilot must not be described as production-validated.

**Files landed:** `src/core/config.ts` (`hints`), `src/opencode-v2/orchestration/validation.ts` (hint runner), `src/opencode-v2/orchestration/tools.ts` (post-step wiring), `src/opencode-v2/observability/trace.ts` (record schema), `src/opencode-v2/plugin.ts` (`ctx.generate.text` wiring), `test/unit/{orchestration-tools,observability,process,evidence}.test.ts`.

**Effort:** S · **Impact:** Medium · **Risk:** Model nondeterminism; added cost; must never become the sole gate (it cannot: the record is advisory metadata).

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

#### G3 — Plain-Language Communication and a Helpful Orchestrator Personality

**Problem**

The orchestrator's language is hard to read (see [Conversation and Tone](#conversation-and-tone)). Dense compound instructions shape both model behavior and user-visible output; there is no personality or audience contract; clarification exists only for initial ambiguity; and status/handover output is mechanical. Users should not need to parse gate names, admission states, and semicolon chains to follow what the orchestrator is doing.

**Proposal**

1. **Layered communication contract.**
   - *User-facing rendering*: plain language, short sentences (one instruction per sentence, target ≤ 25 words), jargon glossed on first use ("a gate — a safety step you can turn off for this session"), and status messages structured as **what happened / what it means / what happens next or what you can do**.
   - *Model-facing contracts stay precise*: D2 envelopes, evidence records, and fail-closed preconditions are unchanged. Where a policy sentence would reach the user (status text, handover), render through the plain-language template instead of pasting the policy string.
2. **Helpful-personality spec** appended to the orchestrator system prompt:
   - Friendly, concise, proactive; explains the plan in one or two sentences before starting non-trivial work.
   - **Restates the request** in 2–3 bullets before starting multi-worker work and lists the assumptions it will proceed under; asks the existing native ask tool when scope, success criteria, or verification is ambiguous (extends `clarify.auto`, which remains the mechanism — this adds restatement and an ask budget so the orchestrator does not stall on endless questions).
   - Announces phase transitions in one plain line (plan → delegate → review → publish) and never presents internal state (admission states, SHAs, gate names) without a plain gloss.
   - **Ends runs with a summary**: outcome, what changed, how it was verified, what is left — structured from the D2 handoff fields so user summaries and worker handoffs share one skeleton.
3. **Restructure the dense strings**: rewrite the 400–850-character single sentences in `policy.ts`/`plugin.ts` runtime injection into short bulleted sentences. This improves model compliance and any user-visible reuse. Fail-closed preconditions keep byte-equivalent semantics, enforced by tests.
4. **Readability guardrails**: length/structure assertions for user-facing strings (extend the existing status-text tests) and a before/after examples page under `docs/`.

**Constraints:** no safety-language weakening — restructuring may split sentences but must not drop a fail-closed precondition; equivalence is test-enforced. Workers keep their focused operational prompts; the personality spec is orchestrator-only so worker output stays task-shaped.

**Files affected (candidate)**

- `src/core/policy.ts` · `src/core/prompts.ts` (restructure dense strings; personality, restatement, and summary sections)
- `src/opencode-v2/agents.ts` (orchestrator description/voice)
- `src/opencode-v2/commands/runtime.ts` (status templates, readable `/handover` summary)
- `src/opencode-v2/plugin.ts` (runtime context injection restructure)
- `test/unit/{core,runtime,prompt-builder}.test.ts` (readability assertions)

**Effort:** M · **Impact:** High · **Risk:** Precision loss in safety-critical instructions; tone drift.

**Next step**

Write the plain-language template and personality spec as a short design note; pilot on status messages and the finish summary with readability assertions; then roll out to the agent prompt and runtime injection.

#### G4 — Installer Schema Migration and Recommended Host Config — COMPLETE (2026-09-15)

**Problem**

Verified 2026-09-15 against the live config schema (`https://opencode.ai/config.json`): subagent nesting depth is defined as **top-level** `subagent_depth` ("Maximum subagent nesting depth. Defaults to 1, which prevents subagents from launching subagents"), and the `experimental` block has `additionalProperties: false` with properties `disable_paste_summary`, `batch_tool`, `openTelemetry`, `primary_tools`, `continue_loop_on_deny`, `mcp_timeout`, and `policies` — **no `subagent_depth`**.

The repo still writes the dead location:

- `src/cli/install.ts` sets `experimental.subagent_depth: 3` (only when absent)
- `dev/project/opencode.example.jsonc` uses the same nested form
- `README.md` documents the nested form in four places

On the current beta the nested key is therefore ignored, and installer-managed installs silently run at native depth 1 — the documented delegation chain `orchestrator → implementer → planner → explore` cannot happen. The user hit this in practice and had to set top-level `"subagent_depth": 3` manually.

Two additional confirmed host keys are required/recommended for the orchestrator experience and are absent from installer output and docs:

- `experimental.continue_loop_on_deny: true` — "Continue the agent loop when a tool call is denied". Without it, a denied tool call (orchestrator-only tools, permission refusals, and the future N1/N2 deny effects) terminates a worker's loop instead of letting the model react and take another path.
- `experimental.batch_tool: true` — "Enable the batch tool". Parallel tool invocation per turn; materially helps orchestrator throughput.

**Proposal**

- Installer writes **top-level `subagent_depth: 3`** when the top-level key is absent (preserve-explicit-values philosophy unchanged). Migrate the legacy location: if `experimental.subagent_depth` exists and no top-level key does, move the value up and remove the stale nested key; never overwrite an explicit user value at either location.
- Update `dev/project/opencode.example.jsonc` to the top-level form; add the two recommended `experimental` keys to the template.
- Optionally (installer flag or interactive prompt) set `experimental.continue_loop_on_deny: true` and `experimental.batch_tool: true` when absent; strictly opt-in, never overwrite existing values.
- Fix the four README references; document the recommended host-config block under Configuration and Troubleshooting ("nested delegation silently blocked" symptom).
- Extend `test/unit/installer.test.ts`: new key placement, legacy-key migration, and no-overwrite cases.
- Add a **pin-drift guard**: a contract test asserting every key the installer writes exists in the live schema (fetched at test time or a committed schema snapshot refreshed on pin bumps).

**Files affected (candidate)**

- `src/cli/install.ts`
- `dev/project/opencode.example.jsonc`
- `README.md`
- `test/unit/installer.test.ts`

**Effort:** S · **Impact:** High · **Risk:** the same drift recurs on the next schema move — mitigated by the schema-snapshot contract test and A17.

**Next step**

Identify the beta where the key moved (probe older pins or schema history), ship the installer migration + template/README updates, and add the schema-snapshot guard before the next pin bump.

**Implemented (2026-09-15)**

- `src/cli/install.ts` writes **top-level** `subagent_depth: 3` when the key is absent. A legacy `experimental.subagent_depth` migrates to the top level only when no top-level value exists: the user's value moves byte-for-byte and the stale nested key is removed. An explicit top-level value wins, and a coexisting nested value is preserved rather than deleted (no data loss). It also adds `experimental.continue_loop_on_deny: true` and `experimental.batch_tool: true` only when absent, preserving explicit values and every unrelated `experimental` key.
- `dev/project/opencode.example.jsonc` uses the top-level depth key plus the two recommended `experimental` keys; all four README references were updated, with the recommended host keys documented under Configuration and the "nested delegation stops after the first hop" symptom under Troubleshooting.
- `test/unit/installer.test.ts` covers fresh placement, legacy migration (value preserved, stale key removed), explicit top-level preservation, coexisting nested preservation, absent-only recommended keys, user-value preservation, reinstall idempotency, and a dev-template parity assertion. An **offline schema-snapshot pin-drift guard** pins installer-written key placement to the 2026-09-15 verified schema (top-level `subagent_depth`; `experimental` keys exactly `continue_loop_on_deny` + `batch_tool`; no nested `subagent_depth`), refreshed by hand on pin bumps — no network at test time.
- The five embedded-host child-session cases in `test/contract/phase-a-hooks.test.ts` (the ones that create a child through the shared `createChildViaSubagent` helper) now carry an explicit 20 s per-case timeout. Bun's 5 s default per-test budget is the only 5 s bound that distinguishes these heavier cases (the harness activation poll is shared by all 13 tests), so it no longer fails them on a loaded machine. No assertion, sequence, or measured behavior changed; the other cases keep the default budget so a genuine hang still fails fast.
- **Exit evidence:** `bun test test/unit/installer.test.ts` → 63 pass, 1 platform skip, 0 fail; `bun test test/contract/phase-a-hooks.test.ts` → 13 pass, 0 fail; `bun run typecheck` → clean. Full suite and `bun run build` were not part of this slice's exit checks.

## Non-Goals / Out of Scope

- Replacing OpenCode's native V2 session or plugin architecture.
- Claiming stable V2 APIs or treating beta behavior as contract.
- Treating prompt instructions as filesystem or OS isolation (until N2 lands and is verified, prompt rules remain prompts).
- Treating recorded effective-authority snapshots as admission decisions, evidence, or isolation. They are bounded tool-action records that no decision path reads.
- Guaranteeing exactly-once provider or external-tool execution.
- Persisting raw transcripts, prompts, or credentials.
- Claiming a measured live-provider envelope (network, cost, latency, nondeterminism) for the opt-in generation-hint pilot.
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
| Plain-language rewrite drops a safety precondition (G3) | Layered rendering; fail-closed strings restructured with test-enforced semantic equivalence; readability fixtures |
| Installer-written config keys drift out of the host schema (G4) | Schema-snapshot contract test refreshed per pin bump; preserve-explicit-values migration; placement verified against the live schema (A17) |
| Native worktree migration drift (N3) | Adapter with fallback, dual-record comparison, compatibility probe before cutover |
| Child rule inheritance differs across hosts (N2) | Pin-level probe (A16), rules recorded and reported, never the only boundary |
| Storage is not transactional or durable enough | Idempotency keys, no exactly-once claims, append/replay design (S1/S2), scan-cursor hydration |
| Retry duplicates side effects | Replay-safety inventory incl. publication chain, retry classes (N5), pause ambiguous actions |
| Multi-agent consensus becomes correlated error | Independent checker prompts, deterministic checks first (N4 advisory only), human review for high-risk actions |
| Native V2 API changes break integration | Pinned contract tests, conformance section above, A15/A16 tracked assumptions, no undocumented calls beyond `ctx.catalog` |
| Redaction misses novel credential formats | Central redactor, adversarial fixtures, no raw output in evidence, explicit uncertainty |
| Authority snapshots mistaken for enforcement or isolation | Read surface and docs state tool-action-only scope and "records, never decisions"; no decision path reads snapshots; unknown states are explicit |
| Generation hints echo sensitive model output | Verdicts-only prompts, defensive parse, canonical redaction, hard size caps, fixed reason vocabulary, metadata-only record, default off |
| Observability leaks private data | Metadata-only trace records (shipped), retention limits still to define (S2) |
| Doctor creates false confidence | Authority/freshness per capability, local checks advisory, `ctx.integration` signal optional |

## Next Steps

### Phase 0 — Conversation Quality (G3, quick win) — COMPLETE (2026-09-15)

Delivered as one slice on `feat/g3-phase-0-plain-language`; no gate, tool, schema, config, or fail-closed behavior changed.

- [x] **Design note:** `docs/g3-communication-contract.md` records the layered contract (plain language for user-facing output; precise, unchanged contracts for the model), the ≤ 25-word one-instruction-per-sentence rule, the first-use jargon glossary, the status template (what happened / what it means / what's next), the restatement + ask-budget rule, phase-transition announcements, and the finish-summary skeleton shared with the D2 handoff fields.
- [x] **Pilot:** `statusMessage()` in `src/opencode-v2/commands/runtime.ts` renders command statuses through the template, and `/handover` renders the shared D2 five-field skeleton (Outcome / Files / Verification / Risks / Follow-up) through `formatHandoverSummary()`, which states unavailable reads instead of omitting them.
- [x] **Personality spec:** orchestrator-only voice, restatement, ask budget, phase announcements, and finish-summary sections in `buildOrchestratorSystem`; worker prompts are unchanged, and `clarify: off` still suppresses the ask-tool instruction. The orchestrator description adds a plain-language sentence after its preserved contract prefix.
- [x] **Dense strings restructured:** `src/core/policy.ts` and the `src/opencode-v2/plugin.ts` runtime context injection are now short bulleted lines (publication policy: 127 → 24 max words per line, 70.4 → 11.2 average); every pinned safety phrase stays byte-identical.
- [x] **Readability + semantic-equivalence fixtures:** `test/unit/core.test.ts` asserts ≤ 25 words per line for every restructured constant plus a fail-closed precondition table (23 universal, 2 orchestrator dispatch, 3 plugin-owned control preconditions); `test/unit/runtime.test.ts` asserts the status template, short sentences, and the D2 handover skeleton; `test/unit/prompt-builder.test.ts` pins the one remaining dense line (out-of-scope `prompt-builder.ts`) and proves the personality spec does not leak into command prompts.
- [x] **Examples page:** `docs/g3-before-after.md` with measured before/after readability numbers and per-surface examples.
- **Exit evidence:** `bun run typecheck`, `bun test` (839 pass, 1 skip, 0 fail), and `bun run build` green on the slice; readability fixtures green; the before/after page recorded; `/handover` user summary derived from the D2 handoff fields; disclosed deviation: the `prompt-builder.ts` coordination line remains dense and is tracked by a fixture.

### Quick Win — Installer Config Drift (G4)

- Fix the installer to write top-level `subagent_depth: 3` (migrate the dead `experimental.subagent_depth` key), and update the dev template + the four README references to the nested form.
- Document (and optionally install, only when absent) `experimental.continue_loop_on_deny: true` and `experimental.batch_tool: true` — both confirmed host keys; continue-on-deny keeps the shipped runtime-authority denials recoverable for workers instead of terminal.
- Add the schema-snapshot contract test so installer-written keys are re-validated on every pin bump.
- Exit evidence: installer tests green including migration/no-overwrite cases; a fresh install produces a schema-valid config in which the documented `orchestrator → implementer → planner → explore` chain is actually reachable.

### Phase A — Runtime Authority (N1, N2) — COMPLETE (2026-09-15)

Delivered as one cohesive runtime-authority slice (`phase-a-runtime-authority`); opt-in, default-off, and strictly restricting. Nothing in this phase widens a gate, changes the durable publish capability, the per-session gates, the static `github`/`worktree` switches, the D2 v1 contract, or the handoff/`reviewState`/admission vocabulary.

- **Config:** strict `authority: { mode: "off" | "enforce" }`, default `{ mode: "off" }`; unknown modes, wrong types, unknown keys, and typos reject at parse time. With the key absent, parse output is byte-identical to the pre-Phase-A parse.
- **One runtime module:** `src/opencode-v2/authority/runtime.ts` owns exactly two registrations (`session.hook("prompt")`, `permission.hook("evaluate")`), starts only in enforce mode, exposes its pure helpers for unit testing, disposes both registrations on cleanup exactly once (evaluate registration first, then prompt; concurrent and repeated `dispose()` calls share that one pass, and a partial registration failure cleans up what it did register before rethrowing), and is wired in `src/opencode-v2/plugin.ts` behind `shouldStartAuthority`.
- **N1 prompt admission (plugin-owned dispatches only):** `buildCommandPrompt` dispatches and goal continuations carry a bounded namespaced metadata marker (`opencode-orchestrator.authority`, `version: 1`, `dispatch: "command" | "continuation"`) only in enforce mode. At admission the marker triggers the existing shared dispatch gate with the same check kind the pre-delivery path uses (`command` for slash commands, `auto` for continuation); a refusal throws a bounded truthful error before admission (never a rewritten model-executable refusal prompt), and an allowed dispatch appends an `admitted: true` marker while preserving every unrelated metadata key. Prompt hooks are not an exactly-once boundary: every path is idempotent, the gate is re-consulted per attempt, and the contract suite proves a second tagged attempt is refused again with no inbox item.
- **N1 permission enforcement (selected plugin-owned actions):** the explicit family set is `orchestrator_goal`, `orchestrator_gh`, `orchestrator_worktree`, `orchestrator_validation`, `orchestrator_publish`. A gate refusal downgrades `allow`/`ask` to `deny` with a bounded truthful `message`; a gate-lookup failure is a fail-closed deny with a bounded safe message; native tools and every action outside the set are untouched. Deliberate exclusions, documented in `src/core/permissions.ts`: `orchestrator_observability` (the bounded-review recovery surface — denying `review_transition` would trap an open circuit), `orchestrator_gates`, and `orchestrator_peer` (read-only inspection/discovery). Permission actions are family-granular, so a read-only tool inside an enforced family inherits the family decision — a documented limitation.
- **Configured deny stays final:** the pinned host does not invoke the evaluation hook for an explicit configured `deny` (re-proven in the contract suite with the probe hook as a canary while the same session's `ask` action still reaches the chain), and the production hook itself never rewrites an already-denied decision.
- **N2 child-only containment:** a session is treated as a configured-role child only when it has a `parentID` AND its agent ID is one of the configured role agents. During that child's own prompt admission the hook reads the child's existing rules, preserves them verbatim, and appends only the missing exact `deny` rules for the full orchestrator-only tool family plus the goal tools (8 exact rules, deterministic order, no duplicate exact denies); later new messages are idempotent and write nothing. A failed child lookup or rule installation fails closed before admission (no inbox item). No rule is ever installed or cleared on a parent session, and there is no worktree install/clear lifecycle here. Why child-only (direction correction retained): the host runs tool calls concurrently, so a temporary parent-session install-and-clear has no atomic safe step and can restrict concurrent parent work; installing on the child during the child's own awaited admission is the measured safe point. Session rules take precedence over an explicit agent allow, and the child's rule set remains readable in `session.get`.
- **Enforcement strength is bounded by the configured controls:** the admission/permission gate is the existing dispatch gate, so N1 only refuses when bounded review (`review.mode: "bounded"` with a `blocked`/`tripped` record) or `budget.mode: "stop-between-steps"` refuses. With neither configured, the gate always allows and enforce mode adds only the metadata/containment behavior.

**Pinned-host probe results (2026-09-15, beta-19507; retained as the measurement basis).** `test/contract/phase-a-hooks.test.ts` boots the built `dist/index.js` entry in isolated `OpenCode.create` hosts next to a test-only probe plugin and records the host's actual behavior. Measured semantics, unchanged by this phase:

- `session.hook("prompt")` runs once per admission on the owned draft; mutations become the admitted inbox payload returned to the caller and listed by `session.inbox.list`; resubmitting an already-admitted message ID returns the original admission without re-running the hook or adding a second inbox item.
- `permission.hook("evaluate")` observes both `allow` and `ask` decisions and a hook mutation to `deny` (plus `message`) is honored; a configured `deny` is final and bypasses the hook chain.
- Child sessions inherit the parent's `permission.rules` as a creation-time snapshot; a request-time `permission.rules` write is awaited inside the child's own prompt hook and observable immediately after admission; a hook failure prevents admission (`UnexpectedStatus` is the caller-visible wrapper) and creates no inbox item.
- Harness boundaries: the public `session.create` surface drops `parentID`, so the child path uses the host's built-in `subagent` tool aborted at its first progress update (after creation, before any prompt or model dispatch); the embedded SDK host registers directly-passed plugin objects without per-plugin options, so the enforce-mode contract host injects options at `setup` while running the real production code path. No provider call is possible in the suite (unresolvable probe models, `delivery: "queue"` + `resume: false`, a throwing `http.request` guard) and every case asserts zero `model.request`/`http.request` events.

**Exit evidence (all commands green on the slice):**

- `bun run typecheck` clean; `bun run build` succeeds (emits `dist/index.js` et al.); `git diff --check` clean.
- `bun test test/unit/authority.test.ts test/unit/core.test.ts` — 91 pass, 0 fail, 2421 `expect()` calls (26 of them the new authority unit tests: config/defaults, action selection, metadata parse/merge, classification, rule merge/dedup, gate refusal incl. the bounded-review breaker, gate failure, cleanup).
- `bun test test/contract/phase-a-hooks.test.ts` — 13 pass, 0 fail, 197 `expect()` calls (the 7 measurement probes plus 6 production cases: allowed admission metadata, blocked tagged dispatch with no inbox item, permission downgrade with a truthful message plus configured-deny finality, child-only containment, containment-install failure, default-off boundary).
- `bun test test/contract/embedded.test.ts test/contract/plugin.test.ts` — 8 pass, 0 fail, 124 `expect()` calls (default-off registration assertion and enforce-mode registration/cleanup assertion; default-off isolated-host prompt/permission boundary).
- `bun test` — 881 pass, 1 skip, 0 fail, 6723 `expect()` calls across 882 tests / 32 files.

**Limits and disclosures (never overclaim):**

- Child permission containment is **tool-action containment only**. Session rules are not filesystem, process, worktree, or atomic child isolation; parallel children still share the parent filesystem, and rule inheritance is a creation-time snapshot with no cross-process guarantee.
- N2 is a **session-rule restriction on plugin-owned tool actions**, and the agent transform already denies those families to worker agents; the session rules make the restriction part of the child's own policy and are readable in `session.get`.
- N1 admission enforcement applies only to *tagged plugin-owned dispatches*: untagged prompts (arbitrary user prompts and other plugins' dispatches) never invoke the dispatch gate and never gain N1 metadata. In enforce mode every admission still performs one `session.get` for N2 child classification (and may append containment rules for a configured-role child); an unreadable session fails closed.
- The pinned host wraps hook failures, so the bounded truthful admission message lives in the hook's thrown error; the caller-visible error is the host's `UnexpectedStatus`. A refusal never rewrites the prompt text.
- Prompt hooks are not exactly-once; concurrent submissions can run the enforcement hook more than once. The runtime is idempotent and never counts attempts.
- All host claims are pin-specific (beta-19507). Session `deny` finality, hook skip behavior, metadata propagation, and the wrapped error shape can change on another pin; re-run `test/contract/phase-a-hooks.test.ts` before relying on them.
- No model-facing authority surface, no admission vocabulary, D2 field, `reviewState` value, handoff validation, gate, publication step, or worktree/GitHub behavior changed.

### Phase B — Worktree Migration (N3)

**Compatibility probe complete (2026-09-15) — cutover blocked.** The probe measured the pinned native `ctx.worktree` domain end to end in temporary repositories and produced the decision record [`docs/phase-1/n3-native-worktree-compatibility.md`](phase-1/n3-native-worktree-compatibility.md):

- Probe scope delivered: list/refresh, `worktree.updated`/`worktree.resolved` events, create (return value, canonicalization, detached HEAD, collision suffix), clean removal, dirty removal with the directly observed `Git.WorktreeError.forceRequired: true`, unknown-directory/main-checkout refusal, workspace-location refusal, project scoping, external-worktree adoption, and vanished-directory handling — with zero provider requests and the current checkout untouched.
- Measured result: native inventory maps only partially onto `worktree/v2` (`ready` as directory inventory); `pending`, `dirty`, `moved`, `orphaned`, and `cleanup-failed` have no native equivalent, native `refresh` discards its `{ updated, removed }` result at the plugin surface, `create` never creates a branch, and `force: true` deletes dirty trees.
- Decision: cutover is blocked; no adapter or strategy registration was implemented. A read-only inventory observation pilot (with `worktree/v2` authoritative) is the only future candidate and needs an explicit new slice.
- Corrected plan reference: dirty removal on the plugin surface raises `Git.WorktreeError` with `forceRequired`, not `Worktree.OperationError` (the HTTP server maps errors to a `WorktreeError` response; that mapping was declaration/source evidence only).
- **Exit evidence:** `bun test test/contract/phase-b-worktree.test.ts` → 6 pass, 0 fail, 95 expect() calls; `bun run build`, `bun run typecheck`, and `git diff --check` green; full-suite evidence recorded in the decision record's reproduction section.
- Remaining (not authorized by this probe): adapter with fallback, per-worker isolation re-scope on the native binding + N2 rules. These stay parked until inventory equivalence is proven.

### Phase C — Verification Hardening (N4, V4) — COMPLETE (2026-09-16)

- **N4 contract probe complete (2026-09-15).** `test/contract/phase-c-generate.test.ts` measures the pinned sessionless `ctx.generate.text` surface (exact `{ prompt, model? } -> { text }` shape, no session/inbox/history/tool side effects, catchable `Generate.*` failures, no external network traffic, and no host-reachable ambient credential — the `OPENCODE_API_KEY` variable is removed for each probe host's lifetime and its value is captured only so it can be restored on cleanup, never passed to the host, logged, or persisted). The decision record is [`docs/phase-1/n4-sessionless-generate-compatibility.md`](phase-1/n4-sessionless-generate-compatibility.md). The probe did not itself authorize production wiring; the Phase C close later landed exactly the permitted opt-in pilot behind default-off `hints.mode: "advisory"` (see the ledger below).
- **V4a complete 2026-09-15 — redaction/authority threat model written; central redactor with adversarial fixtures.** `process/redact.ts` is canonical (the `session/move.ts` duplicate was removed); fixtures cover encoded exact secrets, query-like text, multiline mixed output, substring preservation, empty secret lists, and `redactProcessResult`; C7 has GitHub-token/Bearer fail cases plus a no-secret control; evidence tests pin enforced boundaries only. Threat model: [`docs/v4-redaction-threat-model.md`](v4-redaction-threat-model.md). V4a itself recorded no authority and persisted no evidence; **V4b landed in this close**.
- **V4b complete 2026-09-16 — durable effective-authority snapshots.** Opt-in `authority.mode: "enforce"` records one bounded `authority/v1` snapshot per configured-role child after N2 rule install (parent rules, worker policy, installed rules, and their strictest-effect intersection with explicit unknown states), clears it on runtime exit, and exposes a read-only orchestrator-only lookup. Snapshots are records, never decisions.
- **N4 pilot complete 2026-09-16 — opt-in advisory generation post-step.** Default-off `hints.mode: "advisory"` runs one bounded sessionless generation call only after deterministic D2 checks pass, builds prompts from check verdicts only, parses/redacts/bounds the output, records a bounded trace-shaped metadata record on the `handoff_validate` result, and never gates; the live provider envelope remains unmeasured.
- Exit evidence: see the Phase C evidence ledger below (`bun run typecheck`, the five focused unit suites, `test/contract/phase-c-generate.test.ts`, full `bun test`, `bun run build`, `git diff --check`).

### Phase C evidence ledger (recorded 2026-09-16)

Environment: this slice's worktree `phase-c-close` on top of `main` `7b83a33` (the V4a redaction
audit merge); pinned `@opencode/plugin` / `@opencode/sdk` `0.0.0-beta-19507`; bun 1.3.3;
`bun install` run in the worktree before verification. All commands were run from the worktree
root. Nothing was committed, pushed, or published by this slice, and no GitHub or worktree
mutation tool was used.

| # | Command | Result |
|---|---|---|
| 1 | `bun run typecheck` | pass (`tsc --noEmit`, exit 0) |
| 2 | `bun test test/unit/orchestration-tools.test.ts test/unit/authority.test.ts test/unit/observability.test.ts test/unit/process.test.ts test/unit/evidence.test.ts` | 188 pass / 0 fail, 936 `expect()` calls (5 files) |
| 3 | `bun test test/contract/phase-c-generate.test.ts` | 6 pass / 0 fail, 67 `expect()` calls |
| 4 | `bun test` | 943 pass / 1 skip / 0 fail, 7226 `expect()` calls (944 tests, 34 files; skip is the pre-existing cross-volume case) |
| 5 | `bun run build` | pass; emitted `dist/index.js` et al. (gitignored) |
| 6 | `git diff --check` | clean (no whitespace errors) |
| 7 | `git status --short` | exactly the declared scope: 13 modified files plus the two new authority modules; no out-of-scope file changed |

Delivered in this close (all opt-in and default-off):

- **Generation hints (N4 pilot):** `hints: { mode, model? }` config (advisory requires an explicit
  model), the verdicts-only prompt builder plus bounded defensive parser and timeout race in
  `orchestration/validation.ts`, the post-step wiring in `orchestration/tools.ts`, the strict
  bounded record schema in `observability/trace.ts`, and `ctx.generate.text` wiring in
  `plugin.ts`. With hints off, no call is made and `handoff_validate` output is unchanged.
- **Durable effective-authority snapshots (V4b):** `authority/state.ts` (schema, `authority/v1`
  key, family-wide last-match-wins effects, strictest-effect intersection with explicit unknown
  states, locked read/write/clear), recording and clear-on-dispose in `authority/runtime.ts`, and
  the orchestrator-only read-only `orchestrator_authority_get` tool in `authority/tools.ts`,
  registered only in enforce mode and reusing the read-only `orchestrator_observability`
  permission action (no new permission action; installer/agent-transform untouched).
- **Docs:** the threat model records the new assets, the never-stored list, the implemented V4b
  semantics, and the N4 pilot limits; this plan records the Phase C ledger.

Limits and non-claims (unchanged in kind, restated so nothing is overclaimed):

- Snapshots record host-enforced **tool-action** authority only: no filesystem, process,
  worktree, or atomic child isolation; one current record per session with a process-local lock
  only; cleared when the enforcing runtime exits; no admission/permission/gate/review/publication
  path reads them.
- Generation hints are advisory metadata only: no real provider call, cost, latency, or
  nondeterminism was measured; the surface has no abort control; no hint text is persisted as
  evidence or written into the session trace summary; the pilot never gates.
- Defaults are unchanged: `authority` off, `hints` off, trace/budget/review as before, D2 v1
  fields and admission vocabulary frozen, publication/gates untouched.

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
- **A8 — Redactor completeness:** pattern coverage is not a secret boundary and no completeness claim is made. V4a delivered adversarial fixtures for the documented API and a threat model ([`docs/v4-redaction-threat-model.md`](v4-redaction-threat-model.md)); unknown-format evasion remains out of reach by design and caller-known exact secrets are only redacted where a caller threads them.
- **A9 — Capability authority:** unchanged — doctor local/advisory; server probes authoritative only for tested fields.
- **A10 — Source reliability:** vendor/community claims remain directional; closed issue/PR are not contracts.
- **A11 — GitHub durability:** the publication **capability record** is durable (`publish/v1`); per-operation GitHub ledgers still do not exist.
- **A12 — Isolation vs security:** prompt rules, permission visibility, worktree bookkeeping, and OS containment remain separate properties; N2 adds the first host-enforced layer inside that model, and V4b's snapshots are records of that layer only — never isolation and never decisions.
- **A13/A14 — S3/V1 semantics:** tracked in `docs/phase-1/assumptions.md` (partially verified; live shared-service probes outstanding).
- **A15 — Undocumented catalog domain:** `ctx.catalog` is in the pinned `Context` type but not on the plugin guide; documented equivalent is `ctx.model.list()`. Track per pin; migrate if it breaks.
- **A16 — `tui` flag and hook/worktree host behavior:** the pinned `Plugin` type lacks the `tui` field (cast in use, contract-tested). Live-host behavior is now probed on the pinned host: `session.hook("prompt")`, `permission.hook("evaluate")`, and child rule inheritance by `test/contract/phase-a-hooks.test.ts` (Phase A, 13 pass); the native worktree domain by `test/contract/phase-b-worktree.test.ts` (Phase B, 6 pass — cutover blocked, see the N3 decision record). Measured harness facts: an embedded host's plugin boot `ctx.location` follows the process working directory, `ctx.worktree.*` routes a per-call `location` ref to a location-scoped service, and a directly-passed plugin object is instantiated once per active location (dedupe events by id).
- **A17 — Host config key placement:** verified 2026-09-15 against the live schema (`https://opencode.ai/config.json`): `subagent_depth` is a top-level `Config` property (default 1); the `experimental` block has `additionalProperties: false` and defines `continue_loop_on_deny` and `batch_tool` but no `subagent_depth`. The installer's `experimental.subagent_depth` is therefore dead on current hosts (G4). Key placement is pin-dependent: treat every installer-written config key as pin-coupled and re-verify per bump (schema-snapshot contract test).
- **A18 — Sessionless generate surface:** `ctx.generate.text({ prompt, model? })` is measured sessionless with exactly `{ text }` output and catchable `Generate.ModelSelectionError`/`Generate.UnavailableError` failures (Phase C probe, 6 pass). Deterministic verification is possible only through a **test-only** host-wide provider override (`ctx.aisdk.hook("sdk")`/`("language")`); the host's built-in dynamic provider plugin owns the first `sdk` hook and npm-loads `evt.package`, so config-declared provider packages are pin-coupled. No timeout/abort control exists on the declared input, and no real provider call (network, credentials, cost, latency, output nondeterminism) has been measured. The Phase C close wired the permitted opt-in, default-off `hints.mode: "advisory"` pilot (verdicts-only prompt, defensive parse, canonical redaction, size caps, 2 s external timeout race, metadata-only record, never a gate); its live-provider envelope remains **unmeasured**. See [`docs/phase-1/n4-sessionless-generate-compatibility.md`](phase-1/n4-sessionless-generate-compatibility.md) and §11 of [`docs/v4-redaction-threat-model.md`](v4-redaction-threat-model.md).

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
- `src/opencode-v2/authority/{runtime,state,tools}.ts`
- `src/opencode-v2/peers/tools.ts` · `publish/{state,tools}.ts` · `worker-models/{runtime,state}.ts`

Worktree, process, GitHub:

- `src/opencode-v2/worktree/{state,tools,git,events}.ts`
- `src/opencode-v2/process/{runner,redact}.ts`
- `src/opencode-v2/gh/{client,tools}.ts`

CLI:

- `src/cli/index.ts` · `install.ts` · `doctor.ts`

Verification surfaces:

- `test/unit/` (admission, agents, clarify, continuation, contracts, core, d4, evidence, gates, gh, installer, observability, orchestration-tools, peers, process, prompt-builder, publish, review, runtime, session-move, session-state, session-status, tools, tui-sidebar, worker-models, worktree)
- `test/contract/plugin.test.ts` · `embedded.test.ts` · `tui.test.ts` · `phase-a-hooks.test.ts` · `phase-b-worktree.test.ts` · `phase-c-generate.test.ts`

Design/records:

- `docs/phase-1/` (assumptions, d2/d4/v2/v3/s3 artifacts, n3-native-worktree-compatibility, n4-sessionless-generate-compatibility)

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
