# OpenCode Orchestrator

V2-only TypeScript plugin that turns one OpenCode session into a coordinated team. The `orchestrator` (primary) delegates to specialized subagents — `planner`, `explore`, `implementer`, `reviewer` — via native `subagent` delegation, integrates results, and verifies before answering.

Conductor, not worker: the orchestrator never edits as a last resort, keeps write scopes disjoint, and owns the final verification.

## How it works

- **Roles by semantics, not model name.** `orchestrator` coordinates; `planner` decomposes without editing; `explore` maps code/tests/docs in background without editing or shell; `implementer` makes focused edits; `reviewer` audits without editing. By default, workers are instructed not to spawn subagents.
- **Policy, not hard enforcement.** Those per-role guardrails — `explore` without shell, workers without nested `subagent` delegation, `planner`/`reviewer` without editing — are installer defaults expressed as prompt policy. V2's plugin API does not hard-block shell access or nested delegation per role at runtime, so treat them as strong instructions the model is expected to follow, not as a filesystem or security boundary.
- **Delegation rules.** At most `max_parallel` children at once (default 4). Read-only work (`planner`, `explore`) parallelizes in background; `implementer` serializes when file ownership overlaps. The orchestrator passes an explicit self-contained child prompt for every delegation: task, expected outcome, exact file ownership, must/must-not, verification, and handoff format.
- **Handoff.** Every worker returns the unchanged five-field prose (`Outcome / Files / Verification / Risks / Follow-up`) and is additionally asked for a version-1 structured JSON envelope (see the `docs/phase-1/` D2 contract). The orchestrator can run the callable `orchestrator_handoff_validate` tool when it wants deterministic, fail-closed structural/scope/artifact/semantics checks before using a handoff downstream; it still re-verifies worker claims directly and concatenates nothing.
- **Review gate.** If `require_review=true` (default), implementation is incomplete until `reviewer` audits the aggregate diff. `require_review` remains validated config consumed as prompt policy — there is no hard runtime completion gate. The runtime admission vocabulary (`orchestrator_admission_transition`) is a stateless, explicitly-invoked tool, not an automatic hook.
- **State.** Goals and plan runs persist via `ctx.storage` with session locks. Native sessions remain the source of truth for conversation.

## When to use it

| Use | Command | When |
|-----|---------|------|
| Ad-hoc feature, bug, or multi-step task | `/orchestrate` | You want one prompt to fan out, integrate, and verify. |
| Long-running objective that survives idle | `/goal` | You want the session to keep working toward a durable goal. |
| Safe refactoring | `/restructure` | Behavior must not change; tests must pass before and after. |
| Execute a written plan | `/run-plan` | You have `.orchestrator/plans/*.md`. |
| Polish after a change | `/polish` | Clean up only files you just touched. |
| Plan before coding | `/stress-plan` | You want a plan critiqued from 4 lenses before implementation. |
| Stop automation | `/halt` | Pause goal/plan without deleting state. |
| Hand off context | `/handover` | Produce a continuation brief for the next session or person. |
| Move the session | `/cd` | Keep the session ID, history, and goal while switching to another directory. |

Skip the orchestrator for single-file trivial edits — just prompt the model directly.

## Install

Installation from a local source build (via `npm pack`) is verified; npm
publication of this package is not claimed. Build once — an existing checkout of
this repository works too — then install the freshly built tarball as a
project-local dependency and run the installer:

```sh
# 1. Build once (an existing checkout of this repository works too)
git clone https://github.com/cldmnky/opencode-orchestrator
cd opencode-orchestrator
bun install
bun run typecheck && bun test && bun run build
npm pack --pack-destination "$TMPDIR"      # writes a fresh tarball to your temp dir
cd ../your-project

# 2. Install the freshly built tarball as a project-local dependency
npm install --save-dev "$TMPDIR/opencode-v2-agent-orchestrator-0.1.4.tgz"

# 3. Run the installer; with per-agent models
./node_modules/.bin/opencode-v2-agent-orchestrator install \
  --model orchestrator=openai/gpt-5#high --model explore=opencode-go/mimo-v2.5
```

Use the tarball your own `npm pack` just produced — there is no published
registry package to install from. The installer writes a config-relative local
plugin reference — `./node_modules/opencode-v2-agent-orchestrator/dist/index.js`
for the built package, `./src/index.ts` when run from a source checkout — so V2
resolves the file directly. The exported `installConfig(path)` (`./installer`)
does the same, deriving the reference from its own location.

Global installation (`install --global`) is **not currently supported**: the CLI
writes a config-relative local reference (e.g.
`./node_modules/opencode-v2-agent-orchestrator/dist/index.js`), which only
resolves against a project-local dependency in the target project's
`node_modules`. A scoped/registry distribution is required before global install
can be documented as safe.

What it does: parses `opencode.jsonc` without stripping comments, adds the
config-relative plugin entry above (migrating any legacy bare
`opencode-orchestrator` entry in place), and adds the five agents with
role-appropriate permissions if missing. Commands are registered at runtime by
the plugin — `install` does not write `commands`.

The distribution name is `opencode-v2-agent-orchestrator`; the runtime plugin ID
remains `opencode-orchestrator` for compatibility (agent/tool/command names,
storage keys, and `doctor` checks are unchanged).

Reinstall is idempotent. Change models later via normal `agents.<id>.model`
config, not plugin options.

Verify:

```sh
./node_modules/.bin/opencode-v2-agent-orchestrator doctor        # config checks + advisory local git/gh runtime checks
./node_modules/.bin/opencode-v2-agent-orchestrator doctor --json
```

`doctor` merges two kinds of checks: static config checks (agents, modes, plugin options, commands) and advisory runtime checks probing *this machine's* git/gh — `git --version`, `gh --version`, `gh auth status` (exit code only, output suppressed), read-only `gh repo view`, and `git worktree list --porcelain`. Runtime checks never fail the report and never print headers or tokens; the server-side `orchestrator_github_capabilities` tool is authoritative for what the live session can actually do.

## Quick start

```sh
cd your-project
# ensure opencode.jsonc has the plugin + five agents (see Install)
opencode2
```

In the TUI:

```
/orchestrate add input validation to the user form and cover it with tests
```

The orchestrator will explore, plan, delegate `implementer` edits with disjoint scopes, run `reviewer`, and report verified results.

## Slash commands

All commands are registered via `ctx.command.transform` at runtime — they do not exist as files on disk. Existing project commands with the same name win; `doctor` reports collisions.

### `/orchestrate <task>` — required argument
General orchestration. Activates the orchestrator agent and its model before prompting.

```
/orchestrate fix the race in session locking and add a regression test
/orchestrate implement the new webhook endpoint with tests and docs
```

### `/goal [objective | pause | resume | clear]`
Durable session goal stored at `goal/v1/<project>/<session>`. Uses namespaced tools `orchestrator_goal_get` / `set` / `update` (orchestrator-only).

```
/goal ship the checkout refactor without regressing payments
/goal            # show current goal
/goal pause
/goal resume
/goal clear
```

Completion requires evidence: `orchestrator_goal_update(status="complete", evidence="...")` with ≥8 chars. Auto-continuation (if `goal.auto_continue=true`) admits one queued continuation per idle edge, gated by `cooldown_ms` and `max_continuations`.

### `/cd <directory>` — required argument
Moves the current session to an existing directory while preserving the session ID, history, and durable anchor; goal/plan/halt state stays keyed to the origin project. Never runs a shell — it rejects flag-shaped, NUL, and shell-metacharacter targets, resolves relative paths against the session's *current* location, and verifies the move before updating durable state.

```
/cd ../other-project
/cd src/packages/checkout
```

### `/restructure <target> [--scope=file|module|project] [--risk=conservative|broad]`
Conservative, test-backed refactoring. Validates target is inside the project, maps references/tests via `explore`, plans atomic behavior-preserving steps, verifies baseline, then delegates.

```
/restructure src/core/config.ts --scope=file
/restructure src/opencode-v2 --scope=module --risk=broad
```

Stops if no meaningful verification exists in `broad` mode unless you explicitly accept risk.

### `/run-plan [plan]`
Executes a plan from `.orchestrator/plans/*.md`. Reads the full plan, tracks a run ledger, delegates with disjoint scopes, verifies each step.

```
/run-plan                    # auto-picks sole incomplete plan or resumes active or paused stored runs
/run-plan my-feature         # .orchestrator/plans/my-feature.md
/run-plan .orchestrator/plans/my-feature.md
```

Mark a plan complete with frontmatter `status: complete` or heading `## Status / complete`.

### `/halt [goal|run|all]`
Pauses automation without deleting recoverable state. Default `all`.

```
/halt        # pauses goal + plan run + sets automation stop flag
/halt goal
/halt run
```

Resume with `/goal resume` or `/run-plan`.

### `/handover [focus]`
Factual continuation brief from `ctx.session.context` + `ctx.vcs.status/diff`. Redacts secrets, separates facts from assumptions.

```
/handover
/handover focus on payments regression
```

### `/polish [scope]`
Behavior-preserving cleanup of changed files. One `implementer` per disjoint scope, bounded by `max_parallel`, then aggregate `reviewer`.

```
/polish                      # changed files in working copy
/polish src/core/policy.ts src/core/prompts.ts
```

### `/stress-plan <request>` — required argument
Drafts a plan after `explore`, runs parallel critiques (correctness/testing, simplicity/scope, security/ops, feasibility — possibly same agent ID with different prompts), then synthesizes one revised plan under `.orchestrator/plans/`.

```
/stress-plan add rate limiting to the API with redis fallback
```

## Configuration

Use native `agents.<id>.model` for per-agent models. Plugin options are orchestration wiring only:

```jsonc
{
  "plugins": [{
    "package": "./node_modules/opencode-v2-agent-orchestrator/dist/index.js",
    "options": {
      "orchestrator": "orchestrator",
      "roles": { "planning": "planner", "research": "explore", "implementation": "implementer", "review": "reviewer" },
      "max_parallel": 4,        // 1..8
      "require_review": true,
      "strict_agents": true,    // fail setup if mapped agent missing
      "commands": {},           // e.g. { "polish": false }
      "goal": { "auto_continue": true, "max_continuations": 50, "cooldown_ms": 1000 }
    }
  }],
  "agents": {
    "orchestrator": { "mode": "primary", "model": "openai/gpt-5#high" },
    "planner":      { "mode": "subagent", "model": "openai/gpt-5-mini" },
    "explore":      { "mode": "subagent", "model": "opencode-go/mimo-v2.5" },
    "implementer":  { "mode": "subagent", "model": "opencode-go/deepseek-v4-flash#high" },
    "reviewer":     { "mode": "subagent", "model": "opencode-go/grok-4.6#high" }
  }
}
```

### Model tiering (1=cheap/fast, 5=frontier)

`orchestrator` **5** — never downgrade first; `reviewer` **4–5**; `implementer`/`planner` **4**; `explore` **2** (parallel, cheapest wins). Example root `opencode.jsonc` in this repo uses `openai/gpt-5.6-sol#xhigh` for orchestrator and `mimo-v2.5` for explore.

## Examples

**Multi-step feature**

```
/orchestrate add cursor-based pagination to /api/items with tests and update the docs
```

**Research without editing**

Ask the orchestrator to delegate: it will run `explore` in background and `planner` in foreground, then synthesize — you stay in the parent session with a ledger.

**Goal that survives idle**

```
/goal implement the plan at .orchestrator/plans/checkout.md
# ... idle continuations run ...
/halt goal
/goal resume
```

## GitHub, worktrees, and /cd

All three families are orchestrator-only (one shared permission action per family, denied to every worker) and disabled by default.

**GitHub via `gh` (`github.enabled`).** `github_capabilities` probes the `gh` binary, its auth state, and the resolved repository; `github_repo_view`, `github_issue_view`/`list`/`create`, and `github_pr_view`/`list`/`create` shell out to `gh` with `shell: false` and no model-supplied arguments. Credentials are owned by the host — configure `gh auth login` with least-privilege scopes there; the plugin never reads, stores, or prints headers, tokens, or environment secrets. The server-side `github_capabilities` probe is authoritative for what a session can actually do; the CLI `doctor` can only advisory-check this machine's `gh`.

**Worktrees via git (`worktree.enabled`).** `worktree_list`/`create`/`status`/`push`/`cleanup` run `git worktree` operations against the session's repository, restricted to the configured absolute `worktree.root`, with durable per-session/project records and git-verified results.

**`/cd <directory>`.** Moves the current session to an existing directory while preserving the session ID, history, and durable anchor (see Slash commands).

**Mutation opt-in, evidence, and cleanup.** Every mutating tool (`github_issue_create`, `github_pr_create`, `worktree_create`, `worktree_push`, `worktree_cleanup`) requires both `allow_mutations: true` in plugin options **and** a literal `confirm: true` field in the tool call; read-only tools need only `enabled: true`. Successful GitHub/worktree results carry typed, per-invocation `evidence` metadata: marker (`EVIDENCE_LIVE` for probes/reads/worktree operations, `EVIDENCE_MUTATION` for issue/PR creates), freshness `per-invocation`, authority (`authoritative-for-tested-fields`), `source`, `sessionID`, and `capturedAt`. Mutation evidence additionally embeds a validated https proof of the created object — `verified: true` plus its `id`, `number`, and `html_url`. List tools keep the evidence repeated per list item; error results are redacted strings that carry no evidence. Evidence is metadata only: nothing persists it, it is never process/transcript/header/token data, and worktree evidence never claims child isolation. `worktree_cleanup` refuses the main worktree, a worktree owned by another session, and uncommitted changes, and removes the durable record only after `git worktree remove` succeeds.

## Runtime contract tools

Three validation tools are always registered with no feature-enable gate. They live under the `orchestrator` namespace and share the single `orchestrator_validation` permission action; workers are denied them by the installer/agent transform, and each execute handler rejects non-orchestrator agents regardless of visibility rules. They are **callable/advisory primitives, not automatic hooks**: nothing routes worker output through them, they accept no `confirm` input, and no completion gate is enforced.

| Tool | Inputs | Outcome | Boundary |
|---|---|---|---|
| `orchestrator_task_complexity_classify` | The eight structured D4 facts (`independent_subtasks`, `dependent_stages`, `files_modules`, `independent_review`, `external_side_effects`, `shared_mutable_state`, `security_compliance_risk`, `expected_parallelism_value`), each nullable when unknown | Advisory, user-overridable recommendation: `collect-facts`, `direct-execution-candidate`, `orchestrate-candidate`, `orchestrate-serialized`, or `orchestrate-with-review`, with the firing rule, unknown dimensions, and rationale (`advisory: true`) | Accepts structured features only, never raw request text; missing/null facts force `collect-facts`; nothing is enforced, delegated, or blocked automatically |
| `orchestrator_handoff_validate` | `level` (`worker`/`orchestrator`), the version-1 D2 envelope, and a task contract (`taskId`, `writeScope`, `requiredCommands`, `reviewRequired`) | Deterministic fail-closed verdict + per-check results + mapped admission state + five-heading prose rendering | Worker level runs C1–C7 structural/status/scope/command/artifact/semantics/redaction checks; orchestrator level re-runs them and adds live VCS comparison, local evidence/artifact existence, foreign-file blocking, and authority checks. Never runs a shell; non-trivial contracts typically block at orchestrator level because the pinned plugin cannot re-run required commands and cannot authenticate URL evidence refs |
| `orchestrator_admission_transition` | `from` admission state + a strict `signal` (`action` plus optional `reason`/`reviewRequired`/`humanDecision`) | Deterministic `accepted`/`rejected` result with next state, `requiresHuman`, and `replacementReceipt` over the eight-state vocabulary | Stateless — persists nothing; `blocked-unknown` never auto-advances without an explicit human decision; D2 `reviewState` is self-declared and never treated as reviewer proof |

The underlying pure primitives — `classifyTaskComplexity`, the D2 Zod mirror with `parseD2Handoff`/`validateD2Handoff`/`validateD2Semantics`/`renderD2Handoff`, and `transitionAdmission` — are re-exported from the package entrypoint (`src/index.ts`) with no subpath. `docs/phase-1/` contains the full contract detail, status, and remaining limitations.

## V2 Boundary

- **`gh` is the GitHub transport.** The `orchestrator_github_*` tools call the host-installed `gh` CLI with no shell; credentials are host-managed (`gh auth login`, least-privilege scopes) and never touched by the plugin. Host-configured GitHub MCP servers remain a separate deployment concern, not a plugin feature.
- **Worktrees are plain `git worktree` operations** in the live session's server environment, tracked durably — the plugin does not fabricate an isolated filesystem for agents.
- **No atomic subagent isolation.** The current V2 native `subagent` API does not atomically accept both a parent session and a plugin-created worktree, so the plugin does not enforce per-agent worktree or GitHub issue/PR isolation; `doctor` reports that boundary as a warning. Prompts stay policy, not a filesystem or security boundary.
- **`doctor` cannot prove the server.** Its runtime checks probe this machine's PATH only and are always advisory; the server-side capabilities/worktree tools are authoritative.
- **Validation is callable, not automatic.** The three orchestration validation tools exist and are always registered, but no plugin hook intercepts worker output, nothing persists admission or classification results, and there is no completion gate. `handoff_validate` never runs a shell and can never re-run a required command itself (the pinned V2 API offers no mechanism for it to do so), so orchestrator-level contracts that name required commands deterministically yield `blocked-unknown` until the parent independently re-runs them with its own tools; URL evidence refs likewise block because their authority cannot be authenticated from D2 strings in this version.
- **No structured child-output hook.** The plugin prompts workers for the version-1 envelope, but it does not parse, validate, or transform child output automatically; the orchestrator must call `orchestrator_handoff_validate` explicitly.
- **No server-plugin statistics surface.** The pinned Promise `SessionDomain` exposes no `statistics`/`tokenCount`/`usage` surface, so the plugin cannot read session token stats server-side. This absence claim is scoped to the pinned package declarations — the official HTTP API may expose session statistics (e.g. `/api/session/stats`), which is a separate surface the plugin does not consume.
- **No evidence persistence.** Tool `evidence` records are returned to the model as metadata and are not stored; there is no durable receipt/evidence ledger.

## Development

```sh
bun install
bun run dev:setup        # writes gitignored dev/project/opencode.jsonc from template
bun run dev:v2           # standalone opencode2 with XDG dirs under dev/state
bun run dev:v2:dist      # same, but loads ../../dist/index.js (run bun run build first)
bun run typecheck
bun test
bun run build            # emits dist/index.js, dist/tui.js, dist/commands.js, dist/installer.js, dist/cli/index.js
```

Isolated harness: `dev/project/opencode.jsonc` and `dev/state/*` are gitignored and never touch global `~/.config/opencode` or the shared service.

## V2 Compatibility

Tested against:

- `@opencode-ai/plugin` `0.0.0-beta-18684`
- `@opencode-ai/sdk` `0.0.0-dev-18683` (integration tests only)

Main plugin sets `tui: true` and publishes `./tui` for the TUI command layer. CLI-only plugin config belongs in global `cli.json`; this package is dual-surface and normally enabled through the main plugin registration.

This project is behaviorally inspired by multi-agent orchestration work in `oh-my-openagent` at commit `64d89819ef1fde81712630f8e5d798be9e4e8867`. Independent implementation, no affiliation, no template copying.
