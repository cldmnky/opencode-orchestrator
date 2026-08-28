# OpenCode Orchestrator

V2-only TypeScript plugin that turns one OpenCode session into a coordinated team. The `orchestrator` (primary) delegates to specialized subagents — `planner`, `explore`, `implementer`, `reviewer` — via native `subagent` delegation, integrates results, and verifies before answering.

Conductor, not worker: the orchestrator never edits as a last resort, keeps write scopes disjoint, and owns the final verification.

## How it works

- **Roles by semantics, not model name.** `orchestrator` coordinates; `planner` decomposes without editing; `explore` maps code/tests/docs in background without editing or shell; `implementer` makes focused edits; `reviewer` audits without editing. By default, workers are instructed not to spawn subagents.
- **Policy, not hard enforcement.** Those per-role guardrails — `explore` without shell, workers without nested `subagent` delegation, `planner`/`reviewer` without editing — are installer defaults expressed as prompt policy. V2's plugin API does not hard-block shell access or nested delegation per role at runtime, so treat them as strong instructions the model is expected to follow, not as a filesystem or security boundary.
- **Delegation rules.** At most `max_parallel` children at once (default 4). Read-only work (`planner`, `explore`) parallelizes in background; `implementer` serializes when file ownership overlaps. The orchestrator passes an explicit self-contained child prompt for every delegation: task, expected outcome, exact file ownership, must/must-not, verification, and handoff format.
- **Handoff.** Every worker returns `Outcome / Files / Verification / Risks / Follow-up`. The orchestrator concatenates nothing — it re-verifies worker claims directly.
- **Review gate.** If `require_review=true` (default), implementation is incomplete until `reviewer` audits the aggregate diff.
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

Skip the orchestrator for single-file trivial edits — just prompt the model directly.

## Install

> **Warning: never use the npm registry package named `opencode-orchestrator`.**
> That registry name is owned by `agnusdei1207` and is **unrelated to this
> repository** — invoking that registry package by name through `npx` (or via a
> `package.json` dependency) runs the unrelated package, not this plugin. Install
> a freshly built tarball from this repository's source instead.

GitHub's `v0.1.1` release tarball predates the config-relative local-entry fix:
its installer writes a bare `opencode-orchestrator` reference that V2 resolves
against `node_modules` — the unrelated registry package. No fixed release is
published yet, so build from source (or reuse an existing checkout):

```sh
# 1. Build once (an existing checkout of this repository works too)
git clone https://github.com/cldmnky/opencode-orchestrator
cd opencode-orchestrator
bun install
bun run typecheck && bun test && bun run build
npm pack --pack-destination "$TMPDIR"      # writes a fresh tarball to your temp dir
cd ../your-project

# 2. Install the freshly built tarball as a project-local dependency
npm install --save-dev "$TMPDIR/opencode-orchestrator-0.1.1.tgz"

# 3. Run the installer; with per-agent models
./node_modules/.bin/opencode-orchestrator install \
  --model orchestrator=openai/gpt-5#high --model explore=opencode-go/mimo-v2.5
```

The tarball keeps the `0.1.1` version name until the next release, so always use
your own `npm pack` output — never the stale GitHub `v0.1.1` asset.

The current source/next-release installer writes a config-relative local plugin
reference — `./node_modules/opencode-orchestrator/dist/index.js` for the built
package, `./src/index.ts` when run from a source checkout — so V2 resolves the
file directly without a bare package name. The exported `installConfig(path)`
(`./installer`) does the same, deriving the reference from its own location.

Global installation (`install --global`) is **not currently supported**: the CLI
writes a config-relative local reference (e.g.
`./node_modules/opencode-orchestrator/dist/index.js`), which only resolves
against a project-local dependency in the target project's `node_modules`. Do
not use the npm registry name — it is an unrelated package. A scoped/registry
distribution is required before global install can be documented as safe.

What it does: parses `opencode.jsonc` without stripping comments, adds the config-relative plugin entry above (migrating any legacy bare `opencode-orchestrator` entry in place), and adds the five agents with role-appropriate permissions if missing. Commands are registered at runtime by the plugin — `install` does not write `commands`.

Reinstall is idempotent. Change models later via normal `agents.<id>.model` config, not plugin options.

Verify:

```sh
./node_modules/.bin/opencode-orchestrator doctor        # checks agents, modes, plugin options
./node_modules/.bin/opencode-orchestrator doctor --json
```

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
    "package": "./node_modules/opencode-orchestrator/dist/index.js",
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

## V2 Boundary

The current V2 native `subagent` API does not atomically accept both a parent session and a plugin-created worktree. This plugin therefore does not pretend to enforce per-agent worktree or GitHub issue/PR isolation; `doctor` reports that boundary as a warning. Do not treat prompt instructions as a filesystem security boundary.

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

- `@opencode-ai/plugin` `0.0.0-beta-18414`
- `@opencode-ai/sdk` `0.0.0-dev-18560` (integration tests only)

Main plugin sets `tui: true` and publishes `./tui` for the TUI command layer. CLI-only plugin config belongs in global `cli.json`; this package is dual-surface and normally enabled through the main plugin registration.

This project is behaviorally inspired by multi-agent orchestration work in `oh-my-openagent` at commit `64d89819ef1fde81712630f8e5d798be9e4e8867`. Independent implementation, no affiliation, no template copying.
