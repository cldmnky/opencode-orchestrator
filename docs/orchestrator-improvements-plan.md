# OpenCode Orchestrator Improvement Plan

**Date:** 2026-08-30  
**Status:** Suggestion-only research plan; no implementation authorized

## Goal and Constraints

This plan identifies potential improvements to `opencode-orchestrator` using repository evidence and web research.

Constraints:

- No code changes are included or implied by this document.
- Proposals are advisory suggestions only.
- OpenCode V2 APIs are beta/experimental and require verification before implementation.
- Web sources are directional evidence, not automatically authoritative.
- Claims about storage durability, token counts, isolation, redaction completeness, and runtime enforcement must be verified before relying on them.
- No GitHub, worktree, merge, issue, or pull-request action is proposed.

> **No code changes were made.**

## Executive Summary

- The repository has a clear semantic role model—`planner`, `explore`, `implementer`, and `reviewer`—but most delegation constraints are prompt-level rather than runtime-enforced.
- `max_parallel` defaults to four and is included in orchestration prompts, but repository inspection does not show a central DAG scheduler or runtime semaphore enforcing it.
- The highest-value near-term improvements are a complexity gate, versioned structured handoffs, bounded context, two-level validation, and stronger capability preflight.
- Durable goal/run state already exists, but there are no durable per-step checkpoints, append-only lifecycle logs, materialized projections, or explicit cursor-based recovery records.
- Worktree tooling is safety-conscious for the coordinating session, yet native child sessions still lack plugin-controlled atomic worktree isolation and merge-back reconciliation.
- Messaging, adaptive DAG execution, model tiering, and scale-out should follow—not precede—a foundation of evidence contracts, budgets, recovery semantics, and observability.

## Current State Snapshot

### Architecture

- `src/index.ts` exports the server plugin.
- `src/opencode-v2/plugin.ts` uses `Plugin.define`, registers agent/command/tool transforms, context hooks, event subscriptions, goal continuation, GitHub tools, and worktree tools.
- The main plugin sets `tui: true`.
- `src/tui.ts` is a separate CLI/TUI plugin using `@opencode-ai/plugin/tui`.
- The package exports `./tui`, `./commands`, and `./installer`.
- CLI-only plugin configuration belongs in global `cli.json`, according to repository guidance.
- `src/core/` contains configuration, roles, policy, prompts, permissions, and package identity.
- `src/opencode-v2/` contains runtime commands, goal continuation, session movement, process execution, worktree support, and GitHub support.

### Delegation Rules

`src/core/config.ts` defines:

- `max_parallel`: integer from 1 through 8, default `4`.
- `require_review`: default `true`.
- `strict_agents`: default `true`.
- Goal continuation enabled by default.
- Goal continuation maximum: `50`.
- Goal continuation cooldown: `1000 ms`.
- GitHub and worktree features disabled by default.
- Mutations disabled by default.

`src/core/roles.ts` maps the default semantic roles:

| Role | Default agent | Intended behavior |
|---|---|---|
| Planning | `planner` | Read-only planning |
| Research | `explore` | Background repository/web exploration |
| Implementation | `implementer` | Focused edits |
| Review | `reviewer` | Independent audit |

`src/core/policy.ts` declares:

- Planning: foreground, read-only, parallel-safe.
- Research: background, read-only, parallel-safe.
- Implementation: foreground, writes, not parallel-safe by default.
- Review: foreground, read-only, parallel-safe.
- A child-task contract requiring task, expected outcome, exact ownership, must/must-not rules, verification, and handoff.
- A handoff format:
  - `Outcome`
  - `Files`
  - `Verification`
  - `Risks`
  - `Follow-up`

The policy also states that write scopes must be disjoint and that native V2 delegation should be retained where isolation is unnecessary.

**Observed limitation:** repository inspection shows `max_parallel` being placed into prompts/context, but no orchestrator-owned scheduling queue or runtime concurrency counter. Native OpenCode enforcement is an assumption requiring verification.

### Review and Verification

`require_review=true` changes the generated orchestration policy to require an aggregate reviewer pass. Current enforcement appears prompt-based:

- `src/core/policy.ts` describes review as mandatory.
- `src/core/prompts.ts` embeds that rule.
- No independent runtime gate was found that prevents completion without a reviewer result.
- Worker handoffs are text-based and require evidence, but the parent must verify claims directly.

### Goal Continuation

`src/opencode-v2/goal/` provides durable goal state through `ctx.storage`:

- Goal, plan-run, and halt records use versioned keys.
- `withSessionLock` serializes operations in a process-local map.
- `startGoalContinuation` listens for `session.idle` and `session.deleted`.
- Continuations are reserved under a lock.
- Cooldown, maximum continuation count, halt state, duplicate events, goal replacement, and pause races are handled.
- Prompt delivery uses queued session prompts.
- Deleted sessions clean up goal, run, and halt records.

**Observed limitation:** the storage interface exposes `get`, `set`, and `remove`; transactions, compare-and-set, append-only events, and cross-process locking are not part of the visible abstraction. Durability and crash semantics therefore require verification.

### Worktree and GitHub Opt-In

Worktree tools:

- Are registered only when `worktree.enabled=true`.
- Mutations additionally require `worktree.allow_mutations=true` and literal `confirm: true`.
- Restrict creation to an absolute configured `worktree.root`.
- Use `shell:false`, a fixed Git subcommand allowlist, bounded output, timeouts, and redaction.
- Verify worktree creation with `git worktree list` and `git rev-parse`.
- Refuse cleanup of the main worktree, dirty worktrees, and worktrees owned by another session.
- Track durable worktree records under `worktree/v2/...`.
- Track lifecycle states such as `pending`, `ready`, `moved`, `dirty`, `orphaned`, and `cleanup-failed`.

GitHub tools:

- Are registered only when `github.enabled=true`.
- Mutations require `github.allow_mutations=true` and `confirm: true`.
- Use the host `gh` executable through the injected process runner.
- Validate issue, pull-request, and repository response shapes.
- Return direct identifiers and URLs as evidence.
- Do not currently persist durable GitHub records.

**Critical boundary:** repository policy explicitly states that native V2 child sessions do not receive plugin-controlled atomic worktree isolation. Current worktree ownership applies to the coordinating session, not automatically to delegated children.

### Verification Traps

- `strict_agents=true` can fail plugin setup when a non-empty agent response lacks required agents or modes.
- Empty bootstrap responses are treated specially because config-backed agents may materialize later.
- OpenCode V2 APIs are beta/experimental.
- The package is pinned to `@opencode-ai/plugin` `0.0.0-beta-18684` and `@opencode-ai/sdk` `0.0.0-dev-18683`.
- `doctor` runtime checks inspect the local CLI machine only and remain advisory.
- Server-side `github_capabilities` is authoritative for live GitHub availability.
- Host-configured GitHub MCP and the plugin’s own `gh` tools are separate concerns.
- Prompt-level write scopes do not provide filesystem isolation.
- `ask` permission rules affect visibility but do not necessarily create interactive runtime approval in the public Promise plugin API.
- `bun run build` produces bundles but does not replace packed-package smoke testing.
- No lint or formatter command is configured.
- `dev:v2:dist` rewrites generated configuration to load `dist/index.js`.
- `opencode2 api` inspection is location-sensitive and should be run from the repository directory.

## Research Themes

### Theme 1 — Adaptive decomposition and resource-aware scaling

Anthropic describes orchestrator-worker systems, parallel exploration, explicit scaling rules, and the cost of excessive delegation. Beam compares sequential, fan-out, debate, dynamic handoff, and adaptive-planning patterns.

Suggested implication: task decomposition should be adaptive rather than always maximally parallel.

Sources:

- [R1 — Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R4 — Beam production orchestration patterns](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)
- [R6 — OpenCode plugin orchestration issue](https://github.com/anomalyco/opencode/issues/20849)

### Theme 2 — Context isolation and structured transport

PromptEngines emphasizes small, task-specific contexts and metadata transport. CopilotKit demonstrates isolated subagent calls with explicit return values and visible delegation state. The deprecated npm package claims at least 40% token reduction from structured JSON instead of raw transcript passing.

Suggested implication: downstream agents should receive typed task packets and artifact references, not copied conversation histories.

Sources:

- [R2 — PromptEngines orchestrator pattern](https://www.promptengines.com/labnotes/articles/2026-03-14-orchestrator-pattern-agent-design-v3.html)
- [R3 — CopilotKit subagents](https://docs.copilotkit.ai/pydantic-ai/multi-agent/subagents)
- [R11 — `@moderndegree/opencode-agent-teams`](https://www.npmjs.com/package/@moderndegree/opencode-agent-teams)

### Theme 3 — Independent validation, review, and failure containment

Beam discusses maker-checker debate, model tiering, circuit breakers, and bounded rounds. Anthropic recommends end-state evaluation, small evaluation suites, and human review. The npm package documents schema/static/test/semantic validation as an example architecture.

Suggested implication: reviewer output should be an independently validated gate, not merely another conversational opinion.

Sources:

- [R1 — Anthropic evaluation and reliability guidance](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R4 — Beam maker-checker and model-tiering patterns](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)
- [R11 — npm validation and failure taxonomy](https://www.npmjs.com/package/@moderndegree/opencode-agent-teams)

### Theme 4 — Worktree isolation and integration policy

Issue #20849 proposes worktree isolation as Phase 3 after background execution and DAG scheduling. The community OpenCode council repository describes lane worktrees, reconcilers, merge policy, and evidence packets. The OpenAgents teardown warns that lifecycle ownership and execution authority are separate concerns.

Suggested implication: per-worker worktrees should be introduced only with explicit ownership, merge, conflict, and cleanup semantics.

Sources:

- [R6 — Issue #20849, Phase 3 worktree isolation](https://github.com/anomalyco/opencode/issues/20849)
- [R7 — OpenCode orchestration workflows](https://github.com/marcel-tuinstra/opencode-council/tree/v0.2.0-beta)
- [R10 — OpenCode V2 architecture teardown](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)

### Theme 5 — Durable execution, checkpoints, and resumption

Anthropic describes checkpoints and resume rather than restarting long-running agents. Knowlee recommends per-step checkpointing, exponential backoff, fallback routing, and cursor-based resumption. Tyk identifies durable execution and state management as core orchestration pillars.

Suggested implication: goals and plan runs should evolve toward durable step-level execution records.

Sources:

- [R1 — Anthropic production reliability](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R5 — Agentik orchestration guide](https://www.agentik-os.com/blog/multi-agent-orchestration-production-guide)
- [R8 — Tyk enterprise orchestration guide](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)

### Theme 6 — Events, projections, observability, and budgets

The OpenAgents teardown distinguishes volatile events, durable logs, and projections. Tyk recommends trace context, token budgets, step limits, rate limiting, and audit trails. Knowlee recommends per-run logs, structured reports, alerts, and token tracking.

Suggested implication: live event delivery should not be treated as the sole source of truth.

Sources:

- [R8 — Tyk observability and governance](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)
- [R9 — Knowlee fleet operations](https://www.knowlee.ai/blog/ai-agent-orchestration-guide-2026)
- [R10 — OpenAgents event and projection model](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)

### Theme 7 — Bounded inter-agent messaging and start-simple governance

Issue #20849 identifies `promptAsync` plus SSE as possible background primitives. PR #38942 describes bounded parent/child messaging with authorization, timeouts, caps, and visible markers. Beam cites a secondary Princeton NLP claim that single-agent systems match or outperform multi-agent systems on 64% of benchmarked tasks.

Suggested implication: add messaging only where it solves a demonstrated coordination need, and route trivial tasks directly.

Sources:

- [R4 — Beam complexity tradeoffs](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)
- [R6 — OpenCode background-agent proposal](https://github.com/anomalyco/opencode/issues/20849)
- [R12 — OpenCode agent messaging proposal](https://github.com/anomalyco/opencode/pull/38942)

## Prioritized Proposals

| Priority | ID | Group | Improvement | Codebase rationale and research linkage | Effort | Impact | Primary risk |
|---|---|---|---|---|---:|---:|---|
| P0 | D4 | Delegation & Prompting | Start-simple complexity gate | README already advises skipping trivial edits; Beam and Anthropic warn about cost multiplication. | S | High | Under-delegation |
| P0 | D2 | Delegation & Prompting | Versioned JSON handoffs and artifact references | Current handoff is plain text; npm claims ≥40% token reduction from structured transport. | M | High | Information loss |
| P0 | V2 | Verification & Safety | Two-level validation before downstream admission | Current review policy is prompt-based; Anthropic and npm support explicit evaluation stages. | M | High | False confidence |
| P0 | V3 | Verification & Safety | Host-tool preflight and capability matrix | `policy.ts` already requires preflight; `doctor` remains local/advisory. | S | High | Misleading capability status |
| P0 | S3 | State & Observability | Trace, budget, latency, token, and step controls | Current hook mainly warns on failed orchestrator tools; Tyk/Knowlee recommend structured governance. | M | High | Privacy and overhead |
| P1 | D1 | Delegation & Prompting | DAG decomposition with adaptive scaling | Current native delegation has no visible task graph; Anthropic and issue #20849 describe DAG scheduling. | L | High | Over-decomposition |
| P1 | D3 | Delegation & Prompting | Context isolation target and enforcement | PromptEngines recommends task-specific contexts under 5K tokens; native isolation is not currently measured. | M | High | Lossy compression |
| P1 | V1 | Verification & Safety | Maker-checker review with circuit breaker and model tiering | `require_review` is not a runtime gate; Beam recommends bounded independent review. | M | High | Cost and review loops |
| P1 | V4 | Verification & Safety | Redaction and authority-boundary hardening | Redaction is pattern-based; child authority and permission `ask` semantics need explicit boundaries. | M | High | False security |
| P1 | S1 | State & Observability | Durable step checkpoints with backoff and cursor resume | Goal/run records lack per-step receipts; Knowlee and Anthropic recommend resumable execution. | L | High | Duplicate side effects |
| P1 | S2 | State & Observability | Separate volatile events, durable logs, and projections | Current subscriptions can miss events; OpenAgents documents this distinction. | L | High | State divergence |
| P1 | W1 | Worktree & Isolation | Worktree per worker after host API validation | Current policy explicitly says no atomic child isolation; issue #20849 proposes this as Phase 3. | L | High | Corruption or unowned edits |
| P1 | W2 | Worktree & Isolation | Reconciler and explicit merge policy | Current tools create/status/push/cleanup but do not provide merge-back policy. | L | High | Destructive merge |
| P2 | G1 | DX & Governance | Bounded parent/child messaging | PR #38942 proposes authorization, timeouts, caps, and separate message channels. | M | Medium | Deadlock |
| P2 | G2 | DX & Governance | Versioned policy profiles and evidence packets | Community council and enterprise guides emphasize reason codes, governance records, and operator review. | M | Medium | Configuration complexity |

### Delegation & Prompting

#### D1 — DAG Task Decomposition with Adaptive Scaling

**Problem**

The repository declares delegation roles and a parallelism ceiling, but source inspection does not show a first-class task graph, dependency validator, topological scheduler, or central semaphore. Native model behavior may therefore determine decomposition and concurrency.

**Proposal**

A future orchestration layer could represent each child task with:

- Stable task ID.
- Semantic role.
- Prompt and expected output schema.
- Dependency IDs.
- Exact read/write scope.
- Risk class.
- Token, step, and time budgets.
- Retry policy.
- Artifact references.
- Validation requirements.

A scheduler could execute ready nodes in waves, reject cycles and duplicate IDs, and cap active tasks at `max_parallel`. Suggested scaling heuristics:

- Simple fact or single-file tasks: direct execution or one worker.
- Small comparisons: two to four workers.
- Complex breadth-first tasks: more workers only when expected value justifies cost.
- Shared mutable files: serialize or require validated isolation.

**Files affected (candidate)**

- `src/core/config.ts`
- `src/core/policy.ts`
- `src/core/prompts.ts`
- `src/opencode-v2/plugin.ts`
- `src/opencode-v2/commands/runtime.ts`
- Candidate new `src/opencode-v2/orchestration/graph.ts`

**Effort:** L  
**Impact:** High  
**Risk:** Poor decomposition could make incorrect plans execute faster. A scheduler could also conflict with native OpenCode lifecycle semantics.

**Next step**

Create a design-only task graph schema and evaluate it against representative repository tasks before implementing a scheduler.

**Web source linkage**

- [R1](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R4](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)
- [R6](https://github.com/anomalyco/opencode/issues/20849)

#### D2 — Versioned JSON Handoffs and Artifact References

**Problem**

`HANDOFF_FORMAT` is a useful human-readable contract, but raw text is ambiguous and expensive to pass through multiple agents. The parent must parse claims from prose and cannot reliably distinguish facts, assumptions, evidence, and recommendations.

**Proposal**

A future handoff contract could use a versioned JSON envelope containing:

- `version`
- `taskId`
- `status`
- `outcome`
- `facts`
- `assumptions`
- `filesRead`
- `filesChanged`
- `verification[]`
- `risks[]`
- `followUp`
- `artifactRefs[]`
- `reviewState`

Human-readable rendering could remain available, but downstream agents should consume validated structured data and references to stored artifacts rather than raw transcripts.

The npm package claims at least 40% token reduction against naive transcript passing. That figure should be treated as an unverified external claim, especially because the package is deprecated.

**Files affected (candidate)**

- `src/core/policy.ts`
- `src/core/prompts.ts`
- `src/opencode-v2/agents.ts`
- `src/opencode-v2/commands/runtime.ts`
- Candidate new `src/core/contracts.ts`
- Candidate new `src/opencode-v2/orchestration/handoff.ts`

**Effort:** M  
**Impact:** High  
**Risk:** Overly rigid schemas could discard useful context; artifact storage could retain secrets.

**Next step**

Define a minimal schema and test whether it preserves the information currently required by the five-field handoff.

**Web source linkage**

- [R1](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R2](https://www.promptengines.com/labnotes/articles/2026-03-14-orchestrator-pattern-agent-design-v3.html)
- [R3](https://docs.copilotkit.ai/pydantic-ai/multi-agent/subagents)
- [R11](https://www.npmjs.com/package/@moderndegree/opencode-agent-teams)

#### D3 — Context Isolation and a Subagent Context Budget

**Problem**

Workers receive prompt policy, but the repository has no visible token estimator, context budget, output-size budget, or enforcement that a child receives only relevant inputs.

**Proposal**

A future transport could enforce:

- Task-specific inputs only.
- Artifact references instead of copied transcripts.
- A target of less than 5,000 task-specific tokens for ordinary workers.
- Explicit exceptions for tasks requiring larger context.
- Output size limits and compression levels.
- Parent summaries capped separately from worker outputs.
- Measured input/output token metadata where the host exposes it.

The `<5K` value should be treated as a heuristic from PromptEngines’ internal observations, not a universal correctness threshold.

**Files affected (candidate)**

- `src/core/prompts.ts`
- `src/core/policy.ts`
- `src/opencode-v2/agents.ts`
- `src/opencode-v2/commands/runtime.ts`
- `src/opencode-v2/process/runner.ts`
- Candidate new `src/opencode-v2/orchestration/context-budget.ts`

**Effort:** M  
**Impact:** High  
**Risk:** Compression could omit a critical requirement; token accounting may not be available from the pinned V2 API.

**Next step**

Measure prompt and handoff sizes on a small task corpus before selecting a hard limit.

**Web source linkage**

- [R1](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R2](https://www.promptengines.com/labnotes/articles/2026-03-14-orchestrator-pattern-agent-design-v3.html)
- [R3](https://docs.copilotkit.ai/pydantic-ai/multi-agent/subagents)

#### D4 — Start-Simple Complexity Gate

**Problem**

Multi-agent execution adds model calls, latency, coordination, and failure modes. The README already advises direct execution for trivial single-file edits, but the gate is advisory and not represented in a run record.

**Proposal**

A future admission step could estimate:

- Number of independent subtasks.
- Number of dependent stages.
- Number of files or modules.
- Need for independent review.
- External side effects.
- Shared mutable state.
- Security or compliance risk.
- Expected value of parallelism.

The system could recommend direct execution for low-complexity tasks and require an explicit user override for unnecessary orchestration.

The Beam article cites a secondary Princeton NLP claim that single-agent systems suffice on 64% of benchmark tasks. That claim should be independently validated before becoming a product metric.

**Files affected (candidate)**

- `src/core/config.ts`
- `src/core/policy.ts`
- `src/core/prompts.ts`
- `src/opencode-v2/commands/runtime.ts`
- `src/opencode-v2/plugin.ts`

**Effort:** S  
**Impact:** High  
**Risk:** A gate may under-delegate tasks whose complexity is initially hidden.

**Next step**

Build a labeled corpus of trivial, multi-step, high-risk, and shared-state tasks and evaluate false-positive/false-negative rates.

**Web source linkage**

- [R1](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R4](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)

### Verification & Safety

#### V1 — Maker-Checker Review with Circuit Breaker and Model Tiering

**Problem**

`require_review` changes prompts but does not visibly prevent a run from being reported complete without an independent reviewer. Repeated reviewer rejection could also create an unbounded loop.

**Proposal**

A future review gate could:

- Require a maker result and independent checker result.
- Keep reviewer context separate from the maker’s hidden reasoning.
- Require direct diff and test evidence.
- Limit review/rework rounds.
- Escalate to a stronger model tier after bounded failures.
- Open a circuit breaker after repeated rejection, timeout, or contradictory evidence.
- Require human confirmation for high-risk or externally mutating actions.

Model tiering should remain role/capability-based rather than hard-coded to vendor model names.

**Files affected (candidate)**

- `src/core/config.ts`
- `src/core/roles.ts`
- `src/core/policy.ts`
- `src/core/prompts.ts`
- `src/opencode-v2/plugin.ts`
- `src/opencode-v2/commands/runtime.ts`

**Effort:** M  
**Impact:** High  
**Risk:** Cost and latency could grow rapidly; independent agents may share the same blind spot.

**Next step**

Define a fixed review rubric, maximum rounds, escalation rules, and terminal states before changing runtime behavior.

**Web source linkage**

- [R1](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R4](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)
- [R8](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)

#### V2 — Two-Level Validation Before Downstream Admission

**Problem**

Current handoffs can contain claims and verification text, but downstream work is not visibly blocked until both the worker and orchestrator validate the result.

**Proposal**

A future downstream admission gate could require:

1. Worker-level validation:
   - Output schema.
   - Scope compliance.
   - Required commands.
   - Artifact existence.
   - Local tests or checks.

2. Orchestrator-level validation:
   - Direct inspection of files and repository state.
   - Cross-task consistency.
   - Conflict and dependency checks.
   - Confirmation that evidence corresponds to the current workspace.
   - Review verdict where required.

Only a validated receipt should be passed to dependent tasks.

**Files affected (candidate)**

- `src/core/policy.ts`
- `src/core/prompts.ts`
- `src/opencode-v2/plugin.ts`
- `src/opencode-v2/commands/runtime.ts`
- Candidate new `src/opencode-v2/orchestration/validation.ts`

**Effort:** M  
**Impact:** High  
**Risk:** Validation may become ceremonial if checks are not deterministic or independently sourced.

**Next step**

List which repository claims can be checked deterministically and which require reviewer judgment.

**Web source linkage**

- [R1](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R3](https://docs.copilotkit.ai/pydantic-ai/multi-agent/subagents)
- [R11](https://www.npmjs.com/package/@moderndegree/opencode-agent-teams)

#### V3 — Host Tool Preflight and Capabilities Probe Hardening

**Problem**

`src/core/policy.ts` already requires inspecting the host tool catalog before GitHub operations. `src/cli/doctor.ts` explicitly says it cannot prove merged MCP configuration, remote reachability, live permissions, or server state.

**Proposal**

A future capability layer could distinguish:

- Static configuration validity.
- Local CLI availability.
- Live server-side tool availability.
- Authentication state.
- Repository resolution.
- Permission/action availability.
- Worktree root validity.
- Native API feature availability.

Doctor output could show an explicit capability matrix and authority source for each result. It should remain credential-safe and should never treat local checks as proof of remote capability.

The existing server-side `github_capabilities` probe should remain authoritative for the plugin’s own `gh` tools.

**Files affected (candidate)**

- `src/cli/doctor.ts`
- `src/core/policy.ts`
- `src/opencode-v2/gh/client.ts`
- `src/opencode-v2/gh/tools.ts`
- `src/opencode-v2/worktree/tools.ts`
- `src/opencode-v2/plugin.ts`

**Effort:** S  
**Impact:** High  
**Risk:** Capability results may become stale or appear more authoritative than they are.

**Next step**

Document each capability’s authority, freshness, failure mode, and credential exposure before expanding doctor output.

**Web source linkage**

- [R1](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R8](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)
- [R10](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)

#### V4 — Redaction and Authority-Boundary Hardening

**Problem**

`src/opencode-v2/process/redact.ts` covers known credential patterns and caller-provided exact secrets, but pattern coverage is not proof of completeness. Handover code has a separate, narrower redaction function. Permission rules primarily control visibility, and prompt-level worker restrictions are not containment.

**Proposal**

A future safety layer could:

- Centralize redaction through one tested interface.
- Mark every evidence field as safe, redacted, or unavailable.
- Add adversarial redaction fixtures for URLs, encoded values, multiline output, and provider-specific credentials.
- Record effective authority as an intersection of parent delegation and child policy.
- Explicitly distinguish visibility, approval, and containment.
- Refuse claims of isolation unless the host provides a real boundary.

**Files affected (candidate)**

- `src/opencode-v2/process/redact.ts`
- `src/opencode-v2/commands/runtime.ts`
- `src/core/permissions.ts`
- `src/opencode-v2/agents.ts`
- `src/opencode-v2/gh/client.ts`
- `src/opencode-v2/worktree/tools.ts`

**Effort:** M  
**Impact:** High  
**Risk:** False positives can obscure useful evidence; false negatives create security exposure.

**Next step**

Perform a redaction and authority threat model, explicitly excluding any claim that regexes are a complete secret boundary.

**Web source linkage**

- [R8](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)
- [R10](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)
- [R12](https://github.com/anomalyco/opencode/pull/38942)

### Worktree & Isolation

#### W1 — Worktree per Worker, Subject to Native API Validation

**Problem**

The current policy explicitly states that native V2 child sessions do not receive plugin-controlled atomic worktree isolation. Existing worktree tools are current-session tools.

**Proposal**

A future isolation mode could provision one worktree per implementation child only if the host API can bind:

- Parent session.
- Child session.
- Worktree directory.
- Branch.
- Base commit.
- Effective permissions.
- Cleanup ownership.

If atomic binding cannot be proven, the system should refuse to claim isolation and retain the current safe-delegation behavior.

**Files affected (candidate)**

- `src/core/config.ts`
- `src/core/policy.ts`
- `src/opencode-v2/plugin.ts`
- `src/opencode-v2/worktree/git.ts`
- `src/opencode-v2/worktree/tools.ts`
- `src/opencode-v2/worktree/state.ts`
- `src/opencode-v2/worktree/events.ts`
- `src/opencode-v2/session/move.ts`

**Effort:** L  
**Impact:** High  
**Risk:** Child edits could still reach the parent checkout if binding is advisory rather than atomic.

**Next step**

Verify the pinned V2 session creation and location APIs against the installed SDK before designing an isolation contract.

**Web source linkage**

- [R6](https://github.com/anomalyco/opencode/issues/20849)
- [R7](https://github.com/marcel-tuinstra/opencode-council/tree/v0.2.0-beta)
- [R10](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)

#### W2 — Reconciler and Explicit Merge Policy

**Problem**

Current tooling supports worktree creation, status, push, and cleanup, but not a complete merge-back lifecycle. It does not define fast-forward, conflict, stale-base, or reviewer-approved integration policy.

**Proposal**

A future reconciler could require:

- Stable base commit.
- Clean worker tree.
- Verified branch ownership.
- Explicit merge strategy.
- Fast-forward-only default.
- No automatic conflict resolution.
- Review approval before integration.
- Direct commit/branch evidence.
- Reconciliation status distinct from worker completion.
- Cleanup only after integration or explicit user decision.

Existing lifecycle statuses could be extended rather than silently repurposed.

**Files affected (candidate)**

- `src/opencode-v2/worktree/state.ts`
- `src/opencode-v2/worktree/git.ts`
- `src/opencode-v2/worktree/tools.ts`
- `src/opencode-v2/worktree/events.ts`
- `src/opencode-v2/gh/tools.ts`
- `src/core/policy.ts`

**Effort:** L  
**Impact:** High  
**Risk:** Incorrect merge policy could destroy user changes or create misleading completion claims.

**Next step**

Write a merge-policy decision record covering clean fast-forward, stale base, conflict, dirty tree, abandoned worker, and failed cleanup cases.

**Web source linkage**

- [R6](https://github.com/anomalyco/opencode/issues/20849)
- [R7](https://github.com/marcel-tuinstra/opencode-council/tree/v0.2.0-beta)
- [R10](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)

### State & Observability

#### S1 — Durable Per-Step Checkpoints with Backoff and Cursor Resume

**Problem**

Goal and plan-run state is durable at a coarse level, but there are no visible durable records for each child step, attempt, output artifact, retry, or resume cursor. `withSessionLock` is process-local.

**Proposal**

A future execution record could include:

- Run ID and task ID.
- Idempotency key.
- Step status.
- Attempt number.
- Cursor or dependency watermark.
- Input artifact references.
- Output artifact references.
- Error classification.
- Next retry timestamp.
- Exponential backoff with jitter.
- Last validated checkpoint.
- Cancellation and terminal reason.

Recovery should resume from the last committed checkpoint where safe, while explicitly refusing to claim exactly-once behavior for ambiguous external side effects.

**Files affected (candidate)**

- `src/opencode-v2/goal/state.ts`
- `src/opencode-v2/goal/continuation.ts`
- `src/opencode-v2/commands/runtime.ts`
- `src/opencode-v2/plugin.ts`
- Candidate new `src/opencode-v2/orchestration/run-state.ts`

**Effort:** L  
**Impact:** High  
**Risk:** Retrying a partially completed external action can duplicate side effects.

**Next step**

Inventory which operations are replay-safe, idempotent, compensatable, or irreversibly ambiguous.

**Web source linkage**

- [R1](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R5](https://www.agentik-os.com/blog/ai-agent-orchestration-production-guide)
- [R8](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)
- [R10](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)

#### S2 — Separate Volatile Events, Durable Logs, and Projections

**Problem**

Current components subscribe to event streams for continuation and worktree reconciliation. The repository does not expose a durable orchestration event log or replayable projection layer, and event delivery guarantees are not equivalent to durable state.

**Proposal**

A future state model could provide three distinct surfaces:

1. Volatile low-latency events for UI updates.
2. Durable append-only lifecycle records for causality and replay.
3. Materialized projections for current run/task/worktree status.

Each event should have:

- Run or aggregate ID.
- Monotonic sequence.
- Event type.
- Schema version.
- Idempotency key.
- Timestamp.
- Redacted payload.
- Replay/gap semantics.

Reconnect should hydrate from a projection or durable log before consuming live events.

**Files affected (candidate)**

- `src/opencode-v2/plugin.ts`
- `src/opencode-v2/goal/continuation.ts`
- `src/opencode-v2/worktree/events.ts`
- `src/opencode-v2/goal/state.ts`
- `src/opencode-v2/worktree/state.ts`
- Candidate new `src/opencode-v2/orchestration/events.ts`
- Candidate new `src/opencode-v2/orchestration/projections.ts`

**Effort:** L  
**Impact:** High  
**Risk:** Multiple state surfaces can diverge without transactional publication and projection repair.

**Next step**

Define event authority, replay, retention, sequence, and projection-rebuild rules before selecting storage primitives.

**Web source linkage**

- [R1](https://www.anthropic.com/engineering/multi-agent-research-system)
- [R8](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)
- [R9](https://www.knowlee.ai/blog/ai-agent-orchestration-guide-2026)
- [R10](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)

#### S3 — Structured Observability, Budgets, and Step Limits

**Problem**

Current `execute.after` handling logs failed orchestrator tools, but there is no structured trace ID, per-run token budget, latency series, step limit, or audit record.

**Proposal**

A future observability envelope could capture metadata only:

- Trace ID.
- Run, task, worker, and tool IDs.
- Start/end timestamps.
- Duration.
- Model/provider identifiers where available.
- Input/output token counts where available.
- Tool-call counts.
- Retry counts.
- Validation outcomes.
- Budget consumption.
- Terminal reason.
- Approval/review references.

Hard controls could include:

- Per-run token budget.
- Per-task token budget.
- Maximum steps.
- Maximum wall-clock duration.
- Maximum retries.
- Rate limits.
- Maximum concurrent workers.

Prompts, secrets, and unrestricted raw transcripts should not be required for ordinary operational telemetry.

**Files affected (candidate)**

- `src/core/config.ts`
- `src/core/policy.ts`
- `src/opencode-v2/plugin.ts`
- `src/opencode-v2/process/runner.ts`
- `src/opencode-v2/commands/runtime.ts`
- `src/opencode-v2/goal/continuation.ts`
- `src/opencode-v2/gh/tools.ts`
- `src/opencode-v2/worktree/tools.ts`

**Effort:** M  
**Impact:** High  
**Risk:** Provider token metadata may be unavailable; telemetry can itself expose sensitive information.

**Next step**

Define a privacy-preserving metric schema and establish retention, redaction, and user-visibility rules.

**Web source linkage**

- [R8](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)
- [R9](https://www.knowlee.ai/blog/ai-agent-orchestration-guide-2026)
- [R10](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)

### DX & Governance

#### G1 — Bounded Parent/Child Messaging

**Problem**

The repository uses native event subscriptions and queued session prompts but does not expose a bounded inter-agent message channel. Background completion and direct question/reply semantics are not modeled.

**Proposal**

If the pinned V2 API supports the required primitives, a future messaging channel could:

- Use parent-mediated routing by default.
- Identify sender, recipient, parent, and task ID.
- Authorize replies against recorded parentage.
- Cap message body size.
- Cap per-child in-flight messages.
- Cap cumulative round trips.
- Time out blocked questions.
- Cancel pending waits when either session stops.
- Keep messaging separate from prompt promotion.
- Preserve the recipient’s current model explicitly.
- Emit visible, redacted transcript markers.
- Fail fast when no parent exists.

Messaging should remain opt-in until deadlock, cancellation, and race behavior are verified.

**Files affected (candidate)**

- `src/core/config.ts`
- `src/core/policy.ts`
- `src/core/prompts.ts`
- `src/opencode-v2/plugin.ts`
- `src/opencode-v2/goal/continuation.ts`
- Candidate new `src/opencode-v2/messaging/service.ts`
- Candidate new `src/opencode-v2/messaging/tools.ts`

**Effort:** M  
**Impact:** Medium  
**Risk:** Deadlock, message storms, race conditions with queued prompts, and model switching.

**Next step**

Verify `promptAsync`, child-session relationships, event delivery, and cancellation behavior against the pinned V2 contract before designing the channel.

**Web source linkage**

- [R3](https://docs.copilotkit.ai/pydantic-ai/multi-agent/subagents)
- [R6](https://github.com/anomalyco/opencode/issues/20849)
- [R12](https://github.com/anomalyco/opencode/pull/38942)

#### G2 — Versioned Policy Profiles and Evidence Packets

**Problem**

Configuration currently expresses role IDs, parallelism, review, goals, GitHub, and worktrees, but not a versioned operational profile containing budgets, isolation mode, validation policy, risk class, or approval requirements.

**Proposal**

A future policy profile could define:

- Profile version and ID.
- Role map.
- Complexity gate.
- Maximum workers.
- Token/step/time budgets.
- Review rubric and circuit breaker.
- Isolation guarantees.
- Allowed side effects.
- Required capabilities.
- Data sensitivity class.
- Human approval requirements.
- Evidence packet schema.
- Retention and redaction policy.

`doctor` and `/handover` could report the effective profile and explicit unsupported capabilities without exposing secrets.

**Files affected (candidate)**

- `src/core/config.ts`
- `src/core/policy.ts`
- `src/core/prompts.ts`
- `src/cli/doctor.ts`
- `src/cli/install.ts`
- `src/opencode-v2/commands/runtime.ts`
- `src/opencode-v2/plugin.ts`
- `src/tui.ts`

**Effort:** M  
**Impact:** Medium  
**Risk:** Profile sprawl and silent no-op configuration fields.

**Next step**

Define one conservative profile and list every field that is advisory, enforced, unsupported, or host-dependent.

**Web source linkage**

- [R7](https://github.com/marcel-tuinstra/opencode-council/tree/v0.2.0-beta)
- [R8](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)
- [R9](https://www.knowlee.ai/blog/ai-agent-orchestration-guide-2026)
- [R10](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)

## Non-Goals / Out of Scope

This plan does not propose:

- Editing source, tests, configuration, or README files.
- Replacing OpenCode’s native V2 session or plugin architecture.
- Claiming stable V2 APIs.
- Treating prompt instructions as filesystem or OS isolation.
- Automatically creating GitHub issues, branches, pull requests, or merges.
- Automatically merging worker branches.
- Guaranteeing exactly-once provider or external-tool execution.
- Persisting raw transcripts or credentials.
- Adopting the deprecated npm package as a dependency.
- Treating closed issue #20849 or closed PR #38942 as merged upstream functionality.
- Building a general-purpose enterprise agent platform.
- Certifying regulatory compliance.
- Adding distributed cluster placement before leases, fencing, and ownership semantics exist.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Over-orchestration increases cost and latency | Start-simple complexity gate, budgets, step limits, and direct-execution path |
| Bad decomposition amplifies errors | DAG validation, independent planning, two-level validation, bounded review |
| Structured compression loses requirements | Versioned schemas, artifact references, required facts/assumptions, parent verification |
| Multi-agent consensus becomes correlated error | Independent checker prompts, deterministic checks, human review for high-risk actions |
| Native V2 API changes break integration | Capability probes, pinned contract tests, explicit beta assumptions, no undocumented calls |
| Storage is not transactional or durable enough | Verify storage guarantees, add idempotency, avoid exactly-once claims, use append/replay design |
| Retry duplicates side effects | Classify operations by replay safety, require idempotency keys, pause ambiguous actions |
| Worktree isolation is only advisory | Refuse isolation claims without atomic child/location binding |
| Merge reconciliation destroys user work | Fast-forward-only default, dirty/conflict refusal, explicit confirmation, immutable base evidence |
| Messaging deadlocks or loops | Separate channels, parentage checks, timeouts, cancellation, per-child and cumulative caps |
| Redaction misses novel credential formats | Central redactor, adversarial fixtures, no raw output in evidence, explicit uncertainty |
| Observability leaks private data | Metadata-first telemetry, redaction, retention limits, configurable visibility |
| Doctor creates false confidence | Show authority and freshness for every capability; keep local checks advisory |
| Vendor/community claims are overstated | Mark source quality, verify quantitative claims, do not use deprecated/closed artifacts as dependencies |

## Next Steps

No implementation is proposed yet. Each phase begins with design, measurement, and contract verification.

### Phase 1 — Quick Wins

Suggested activities:

- Establish a task corpus for trivial, multi-step, shared-state, and high-risk requests.
- Measure current prompt sizes, handoff sizes, delegation counts, latency, failures, and review loops where host telemetry permits.
- Document which constraints are prompt-only versus runtime-enforced.
- Draft the minimal structured handoff schema.
- Draft the complexity-gate decision table.
- Create a capability authority matrix for local doctor checks, server-side probes, and host-configured tools.
- Record all assumptions about V2 APIs and storage.

Suggested exit evidence:

- Baseline metrics.
- Reviewed handoff schema.
- Complexity-gate false-positive/false-negative analysis.
- Capability matrix with explicit unknowns.

### Phase 2 — Foundation

Suggested activities:

- Design task, receipt, validation, checkpoint, and evidence-packet contracts.
- Decide whether storage can support atomic update, idempotency, append, and replay.
- Define two-level validation and maker-checker terminal states.
- Define budgets, step limits, retry classes, and circuit-breaker behavior.
- Define volatile event, durable log, and projection authority.

Suggested exit evidence:

- Versioned contract documents.
- Failure and recovery matrix.
- Storage capability report.
- Security and redaction threat model.

### Phase 3 — Isolation

Suggested activities:

- Verify native child-session and location/worktree binding in the pinned V2 environment.
- Design per-worker worktree ownership and cleanup.
- Define fast-forward, conflict, stale-base, dirty-tree, and abandoned-worker policy.
- Test reconcilers with synthetic dirty, moved, orphaned, and conflicting states.
- Keep isolation disabled unless atomicity is directly demonstrated.

Suggested exit evidence:

- Host API compatibility result.
- Worktree lifecycle state machine.
- Merge-policy decision record.
- Recovery and cleanup test matrix.

### Phase 4 — Scale

Suggested activities:

- Pilot adaptive DAG execution on a narrow workload.
- Add bounded messaging only if measured workflows require it.
- Add model tier routing only after review and budget baselines exist.
- Add structured observability and operator projections.
- Compare single-agent and multi-agent outcomes, cost, latency, and failure rates.
- Retain rollback to direct execution and current native delegation.

Suggested exit evidence:

- End-state quality comparison.
- Cost and latency report.
- Failure taxonomy and recovery statistics.
- User-visible capability and evidence report.

## Appendix

### Assumptions Requiring Verification

- **A1 — V2 API stability:** OpenCode V2 is beta/experimental; APIs may change.
- **A2 — Native background primitives:** `promptAsync`, SSE event behavior, child-session APIs, and cancellation semantics from issue #20849 are not assumed to exist in the pinned package.
- **A3 — Atomic isolation:** Current repository policy says plugin-controlled atomic child worktrees are unavailable.
- **A4 — Parallelism enforcement:** `max_parallel=4` is configured and prompted, but source inspection does not show a central runtime scheduler enforcing it.
- **A5 — Review enforcement:** `require_review=true` appears to be prompt/policy enforcement rather than an independently enforced runtime gate.
- **A6 — Storage guarantees:** `ctx.storage` durability, transactionality, cross-process behavior, and crash consistency are not established by the visible interface.
- **A7 — Token measurement:** Token counts and the `<5K` target may not be available from the host API; `<5K` is a heuristic, not a universal invariant.
- **A8 — Redactor completeness:** Existing tests cover known patterns and supplied exact secrets, not every possible provider or credential format.
- **A9 — Capability authority:** CLI `doctor` is local and advisory; server-side probes are authoritative only for the capabilities they actually test.
- **A10 — Source reliability:** Vendor articles, community repositories, secondary benchmark claims, deprecated packages, and closed PRs require independent validation.
- **A11 — GitHub durability:** Plugin GitHub tools return validated evidence but do not currently persist durable GitHub operation records.
- **A12 — Isolation/security:** Prompt rules, permission visibility, worktree bookkeeping, and OS containment are separate properties.

### Verification Checklist

Future implementation work should eventually run:

```sh
bun run typecheck && bun test && bun run build
```

Additional repository-specific checks may include:

```sh
bun run dev:setup
bun run dev:v2
bun run dev:v2:dist
bun run src/cli/index.ts doctor
```

No verification commands were run for this research-only draft.

### File Inventory

Core:

- `src/core/config.ts`
- `src/core/roles.ts`
- `src/core/policy.ts`
- `src/core/prompts.ts`
- `src/core/permissions.ts`
- `src/core/package-identity.ts`

Plugin and TUI:

- `src/index.ts`
- `src/tui.ts`
- `src/opencode-v2/plugin.ts`
- `src/opencode-v2/agents.ts`

Commands and state:

- `src/opencode-v2/commands/index.ts`
- `src/opencode-v2/commands/runtime.ts`
- `src/opencode-v2/goal/state.ts`
- `src/opencode-v2/goal/tools.ts`
- `src/opencode-v2/goal/continuation.ts`
- `src/opencode-v2/session/state.ts`
- `src/opencode-v2/session/move.ts`

Worktree and process:

- `src/opencode-v2/worktree/state.ts`
- `src/opencode-v2/worktree/tools.ts`
- `src/opencode-v2/worktree/git.ts`
- `src/opencode-v2/worktree/events.ts`
- `src/opencode-v2/process/runner.ts`
- `src/opencode-v2/process/redact.ts`

GitHub:

- `src/opencode-v2/gh/client.ts`
- `src/opencode-v2/gh/tools.ts`

CLI:

- `src/cli/index.ts`
- `src/cli/install.ts`
- `src/cli/doctor.ts`

Verification surfaces:

- `test/unit/core.test.ts`
- `test/unit/agents.test.ts`
- `test/unit/continuation.test.ts`
- `test/unit/session-state.test.ts`
- `test/unit/session-move.test.ts`
- `test/unit/runtime.test.ts`
- `test/unit/worktree.test.ts`
- `test/unit/gh.test.ts`
- `test/unit/process.test.ts`
- `test/unit/installer.test.ts`
- `test/contract/plugin.test.ts`
- `test/contract/embedded.test.ts`

### Research Source Catalog

1. [Anthropic — How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
2. [PromptEngines — The Orchestrator Pattern](https://www.promptengines.com/labnotes/articles/2026-03-14-orchestrator-pattern-agent-design-v3.html)
3. [CopilotKit — PydanticAI Sub-Agents](https://docs.copilotkit.ai/pydantic-ai/multi-agent/subagents)
4. [Beam — Multi-Agent Orchestration Patterns](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)
5. [Agentik OS — Production Orchestration Guide](https://www.agentik-os.com/blog/multi-agent-orchestration-production-guide)
6. [OpenCode issue #20849 — Plugin-Based Agent Orchestration](https://github.com/anomalyco/opencode/issues/20849)
7. [OpenCode Council — v0.2.0-beta](https://github.com/marcel-tuinstra/opencode-council/tree/v0.2.0-beta)
8. [Tyk — Enterprise AI Agent Orchestration Guide](https://tyk.io/learning-center/ai-agent-orchestration-a-complete-enterprise-guide/)
9. [Knowlee — AI Agent Orchestration Guide 2026](https://www.knowlee.ai/blog/ai-agent-orchestration-guide-2026)
10. [OpenAgents — OpenCode V2 Architecture Teardown](https://github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md)
11. [npm — `@moderndegree/opencode-agent-teams`](https://www.npmjs.com/package/@moderndegree/opencode-agent-teams)
12. [OpenCode PR #38942 — Agent-to-Agent Messaging](https://github.com/anomalyco/opencode/pull/38942)

---

*Generated via repository inspection and web research on 2026-08-30. Suggestion-only; no code changes were made.*
</subagent>