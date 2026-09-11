# OpenCode Orchestrator

**Turn one prompt into a coordinated team inside OpenCode.**

Give the orchestrator a task in plain English — it breaks the work down, delegates to specialists, runs work in parallel where safe, and brings back tested, reviewed code. You stay in control while the plugin handles the choreography.

> **Conductor, not worker:** the orchestrator plans and coordinates — specialist subagents do the focused edits.

---

## What it does for you

- **Describe what you want, not how to do it.** `“Add validation to the checkout form and cover it with tests”` Just ask — the orchestrator creates a plan, assigns work, and verifies the result.
- **Parallel where safe, serialized where it matters.** Read-only research runs in parallel. Non-overlapping file scopes coordinate edits so agents avoid working on the same files.
- **Built-in review.** Every implementation is audited by a dedicated reviewer before you see the final result.
- **Asks before it guesses.** When a request is ambiguous, the orchestrator asks you a few targeted questions — with answer options — before breaking the work down. Disable with `"clarify": { "mode": "off" }`.
- **Goals that survive idle.** Start a long-running objective and let it continue during idle periods in the same OpenCode session.
- **Optional power features** when you need them: GitHub and git worktree integration, budgets and review gates, a durable `/publish` publication capability with per-session `/gates` narrowing, and same-project peer-orchestrator discovery.

### The team

| Agent | What it does |
|-------|--------------|
| **orchestrator** | Your main partner. Understands your request, plans the work, delegates, and verifies everything. |
| **planner** | Breaks down complex tasks without editing code. |
| **explore** | Maps your codebase, tests, and docs — fast, read-only research with direct `webfetch`/`websearch`. |
| **implementer** | Makes focused code changes within an assigned file scope. |
| **reviewer** | Audits the combined changes before they’re presented to you. |

You only talk to the orchestrator. It handles the rest.

### Bounded nested delegation

Specialists can delegate too, but only along a fixed graph — every delegating worker stays accountable for its children, and each child gets the same self-contained task contract:

```
orchestrator → planner, explore, implementer, reviewer
implementer  → planner, explore
planner      → explore
reviewer     → explore
explore      → (nothing — answers directly, using webfetch/websearch itself)
```

Delegation outside an agent’s own graph is off-limits even if the host would allow it, and the orchestrator verifies child claims directly instead of trusting a child’s self-report.

> **Native depth:** OpenCode’s native `experimental.subagent_depth` defaults to 1 — *"Maximum subagent nesting depth. Defaults to 1, which prevents subagents from launching subagents"* — so without it, a worker could never delegate further. The deepest approved chain above is three subagent hops, and the installer therefore sets `experimental.subagent_depth: 3` in your config, but only when the key is absent: an explicit value you set (lower or higher) always wins. The plugin itself does not enforce depth — it’s a native OpenCode setting.

---

## When should I use it?

| You want to… | Use this | Example |
|--------------|----------|---------|
| Build a feature or fix a bug in one go | `/orchestrate` | *“Fix the race in session locking and add a regression test”* |
| Keep a long objective running through idle periods | `/goal` | *“Ship the checkout refactor without regressing payments”* |
| Refactor safely | `/restructure` | `src/core/config.ts --scope=file` |
| Run a written plan | `/run-plan` | `.orchestrator/plans/my-feature.md` |
| Clean up code you just touched | `/polish` | `src/core/policy.ts` |
| Critique a plan before coding | `/stress-plan` | *“Add rate limiting with Redis fallback”* |
| Pause automation | `/halt` | — |
| Hand context to the next session | `/handover` | *“Focus on payments regression”* |
| Choose models for worker agents | `/worker-models` | — |
| Inspect or toggle the durable publication capability | `/publish` | `/publish status` |
| Narrow the publication/gate steps for this session only | `/gates` | `/gates merge=off` |

For a single-file typo or one-line edit, just prompt the model directly — you don’t need orchestration.

---

## Installation

**Prerequisites:** [Bun](https://bun.sh), [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm), [OpenCode V2](https://opencode.ai), `git` (and `gh` CLI if you want GitHub features).

Install the [published release from npm](https://www.npmjs.com/package/opencode-v2-agent-orchestrator) in your project:

```sh
cd your-project
npm install --save-dev opencode-v2-agent-orchestrator

# Add the plugin + agents to your opencode.jsonc
./node_modules/.bin/opencode-v2-agent-orchestrator install \
  --model orchestrator=openai/gpt-5#high \
  --model explore=opencode-go/mimo-v2.5

# Verify
./node_modules/.bin/opencode-v2-agent-orchestrator doctor
```

What the installer does:
- Adds the plugin to `opencode.jsonc` (as a local file reference like `./node_modules/.../dist/index.js`)
- Adds the five agents (`orchestrator`, `planner`, `explore`, `implementer`, `reviewer`) if they’re missing
- Sets `experimental.subagent_depth: 3` (only when the key is absent) so OpenCode’s native subagent depth limit — which defaults to 1 — doesn’t block the deepest approved chain `orchestrator → implementer → planner → explore`
- Gives new agents permission defaults that allow exactly the bounded nested-delegation graph (see [Bounded nested delegation](#bounded-nested-delegation)): a broad `subagent` deny followed by exact target-specific allows, with `webfetch`/`websearch` granted directly to `explore`
- Writes the orchestrator-only permission actions for the feature tool families — `orchestrator_gh`, `orchestrator_worktree`, `orchestrator_validation`, `orchestrator_observability`, plus the publication policy (`orchestrator_publish`), peer discovery (`orchestrator_peer`), and the read-only session gate inspection (`orchestrator_gates`) — as `allow` for the orchestrator and `deny` for every worker
- Leaves your existing config and commands untouched — re-running it is safe

> **Upgrading?** The installer never rewrites agents that already exist in your config. If your workers were installed by an older version (before nested delegation), they carry a flat `subagent` deny and cannot delegate. Either delete the old agent entries and reinstall, or add the target-specific allows yourself — for example, to `implementer`:
>
> ```jsonc
> "permissions": [
>   { "action": "subagent", "resource": "*", "effect": "deny" },
>   { "action": "subagent", "resource": "planner", "effect": "allow" },
>   { "action": "subagent", "resource": "explore", "effect": "allow" }
> ]
> ```
>
> Agents preserved from an older install also predate the shared permission actions for the newer tool families (`orchestrator_publish`, `orchestrator_peer`, `orchestrator_gates`): the plugin’s agent transform appends the family rules automatically only when no exact rule exists, and an explicit user-authored rule is never overridden. To migrate by hand, add to the **orchestrator**:
>
> ```jsonc
> { "action": "orchestrator_publish", "resource": "*", "effect": "allow" },
> { "action": "orchestrator_peer", "resource": "*", "effect": "allow" },
> { "action": "orchestrator_gates", "resource": "*", "effect": "allow" }
> ```
>
> and the same three actions with `"effect": "deny"` to each worker you want kept locked down. Anything you write explicitly stays authoritative — the installer and the agent transform never rewrite it.
>
> The plugin’s agent transform never overrides user-authored permission rules, so whatever you write stays authoritative. Re-running the installer also adds `experimental.subagent_depth: 3` when that key is absent; an explicit value you set is always preserved.

> Working from a source checkout? Configure OpenCode to load `./src/index.ts` and see [Development](#development). This repository's live setup uses global config; the checkout has no repo-level `opencode.jsonc`.

Check that it worked:

```sh
./node_modules/.bin/opencode-v2-agent-orchestrator doctor --json
# plus, once OpenCode is running:
opencode2 api get /api/plugin | jq -r '.data // . | .[].id' | grep opencode-orchestrator
```

---

## Quick start

```sh
cd your-project
opencode2
```

Then in the TUI:

```
/orchestrate add input validation to the user form and cover it with tests
```

The orchestrator will research the codebase, plan the changes, delegate non-overlapping file scopes to `implementer` agents, run a `reviewer`, and report back with verification.

---

## See it in action

![Orchestrator demo — single prompt to tested, reviewed code](docs/assets/demo-placeholder.svg)

| What you'd see | You type |
|----------------|----------|
| Research → plan → parallel edits → review, all summarized in one reply | `/orchestrate add pagination to /api/items with tests` |
| Goal keeps running while you step away | `/goal implement the plan at .orchestrator/plans/checkout.md` |

> **Make it yours:** record a 20–40s GIF with [VHS](https://github.com/charmbracelet/vhs), Screen Studio, or Peek, save it as `docs/assets/orchestrate-demo.gif` (and `goal-demo.gif`), then swap the image above. See `docs/assets/README.md` for a ready-to-use VHS tape.

```mermaid
flowchart LR
    U([You]) --> O{orchestrator}
    O --> P[planner<br/>breaks down task]
    O --> E[explore<br/>maps codebase]
    O --> I[implementer<br/>focused edits]
    O --> R[reviewer<br/>audits changes]
    I -. bounded .-> P
    I -. bounded .-> E
    P -. bounded .-> E
    R -. bounded .-> E
    P --> O
    E --> O
    I --> O
    R --> O
    O --> U2([Verified result<br/>+ tests + review])

    style U fill:#1a1f3a,stroke:#4a5a8a,color:#e6e8f0
    style U2 fill:#1a3329,stroke:#4a8a6a,color:#e6e8f0
    style O fill:#2a2f45,stroke:#6a7abb,color:#e6e8f0
```

*You talk only to the orchestrator — it coordinates the specialists and brings back a verified result. Dashed arrows are the bounded nested-delegation edges: workers may delegate only downward, and `explore` answers directly without delegating.*

---

## How to use — commands & examples

All commands are available after installation. They appear inside OpenCode — no files to create manually.

### `/orchestrate <task>` — your main command

One prompt that fans out, integrates, and verifies.

```
/orchestrate fix the race in session locking and add a regression test
/orchestrate implement the new webhook endpoint with tests and docs
/orchestrate add cursor-based pagination to /api/items with tests and update the docs
```

**Tip:** Be specific about the outcome you want and any constraints (“without changing the API”, “cover with tests”).

### `/goal` — for work that outlives one turn

Set an objective keyed to the current OpenCode session. The orchestrator can keep working toward it when that same session emits idle events.

```
/goal ship the checkout refactor without regressing payments
/goal            # show current goal
/goal pause      # pause without deleting
/goal resume     # continue
/goal clear      # remove it
```

Goals auto-continue when that session goes idle (up to 50 continuations by default, with a cooldown). The orchestrator checks before each continuation that the goal is still active and unchanged. When a plan run is active, the continuation prompt embeds the plan ledger path and requires the orchestrator to execute the first unfinished ledger item with direct verification, update the ledger, and keep advancing in order — unless a real blocker or a configured breaker applies (halt flag, budget fail-closed, cooldown, max continuations, or an open review circuit), and it never marks the goal or plan complete without direct evidence. Deleting the session removes its goal state.

### `/restructure` — safe refactoring

Behavior must not change. The plugin maps references and tests first.

```
/restructure src/core/config.ts --scope=file
/restructure src/opencode-v2 --scope=module --risk=broad
```

Valid scopes are `--scope=file|module|project`; with project scope, target `.` or `project`.

### `/run-plan` — execute a written plan

Put plans in `.orchestrator/plans/*.md`.

```
/run-plan                    # picks the only incomplete plan, or resumes
/run-plan my-feature         # .orchestrator/plans/my-feature.md
```

Mark a plan done with `status: complete` in frontmatter or a `## Status / complete` heading.

### Other commands

```
/halt              # pause goal + plan runs
/halt goal
/handover          # get a summary brief for the next person/session
/handover focus on payments regression
/polish            # clean up only files changed in this branch
/polish src/core/policy.ts src/core/prompts.ts
/stress-plan add rate limiting to the API with redis fallback
/publish status    # inspect the durable project-scoped publication policy
/publish enable    # opt in per project (requires publish.enabled: true in config)
/publish disable   # revoke the durable authorization
/gates             # open the TUI gate picker for this session
/gates <gate>=off  # narrow one step for this session only
/gates <gate>=on   # re-enable it (never beyond the project/config ceiling)
/gates reset       # clear this session's narrowing
/worker-models            # open the TUI worker-model picker
/worker-models explore=default
/worker-models reset      # restore all workers to configured models
```

`/stress-plan` drafts a plan, then critiques it from four angles (correctness, simplicity, security, feasibility) before finalizing.
`/publish` toggles a durable, project-scoped **authorization policy** — see [Publication capability](#publication-capability-publish) for exactly what it does and does not authorize.
`/gates` shows and narrows the per-session orchestrator gates (`push`, `pr-draft-create`, `pr-ready-transition`, `approve-after-review`, `merge`, `github-mutations`, `worktree-mutations`). Running it with no argument opens the TUI gate picker; `/gates <gate>=off` narrows one step for this session, `/gates <gate>=on` removes that narrowing, and `/gates reset` follows the project ceiling again. A session can only **narrow** the project/config ceiling and can never widen it — turning a gate on still requires the ceiling (the durable publication capability or the static `github`/`worktree` mutation switches) to allow it. Session gates apply to the current session only.
`/worker-models` selects durable runtime models for `planner`, `explore`, `implementer`, and `reviewer` only. The TUI picker lists enabled, tool-capable models and their variants. Text form accepts `worker=provider/model[#variant]`, `worker=default`, `list`, and `reset`.

---

## Configuration

You configure baseline **models** with OpenCode’s native `agents.<id>.model`; the TUI can apply durable worker-only overrides at runtime:

```jsonc
// opencode.jsonc
{
  "plugins": [{
    "package": "./node_modules/opencode-v2-agent-orchestrator/dist/index.js",
    "options": {
      "orchestrator": "orchestrator",
      "roles": {
        "planning": "planner",
        "research": "explore",
        "implementation": "implementer",
        "review": "reviewer"
      },
      "max_parallel": 4,        // how many subagents at once (1..8)
      "require_review": true,   // always run reviewer before finishing
      "strict_agents": true,    // fail if a required agent is missing
      "commands": {},           // disable a command, e.g. { "polish": false }
      "goal": { "auto_continue": true, "max_continuations": 50, "cooldown_ms": 1000 },
      "github": { "enabled": false, "allow_mutations": false },
      "worktree": { "enabled": false, "allow_mutations": false, "root": null },
      "publish": { "enabled": false }, // master gate for the durable publication capability (default off)
      "trace": { "mode": "off" },                  // off | memory | snapshot
      "budget": { "mode": "advisory" },            // advisory | stop-between-steps
      "review": { "mode": "prompt", "max_rounds": 2 }, // prompt | bounded
      "clarify": { "mode": "auto" }                // auto | off — ask targeted clarifying questions when a task is ambiguous
    }
  }],
  // If worktree.root lives outside your project, allow it:
  // "permissions": [{ "action": "external_directory", "resource": "/srv/worktrees/*", "effect": "allow" }],

  "agents": {
    "orchestrator": { "mode": "primary",  "model": "openai/gpt-5#high" },
    "planner":      { "mode": "subagent", "model": "openai/gpt-5-mini" },
    "explore":      { "mode": "subagent", "model": "opencode-go/mimo-v2.5" },
    "implementer":  { "mode": "subagent", "model": "opencode-go/deepseek-v4-flash#high" },
    "reviewer":     { "mode": "subagent", "model": "opencode-go/grok-4.6#high" }
  }
}
```

### Choosing models

| Agent | Recommended tier | Why |
|-------|----------------|-----|
| `orchestrator` | 5 (frontier) | Never downgrade this one first — it does all coordination |
| `reviewer` | 4–5 | Needs strong judgment |
| `implementer` / `planner` | 4 | Capable but cheaper than frontier |
| `explore` | 2 (cheap/fast) | Runs in parallel — cheap wins |

Model IDs shown here are illustrative; availability varies by provider and account.

The installer also writes each agent’s `permissions` for you: a broad `subagent` deny plus exact target-specific allows matching the [bounded nested-delegation graph](#bounded-nested-delegation), and direct `webfetch`/`websearch` for `explore`. Agents you add or preserve yourself keep whatever permissions you write — the plugin never overrides them.

Change a baseline model later by editing `agents.<id>.model` directly — no reinstall needed. For temporary or run-specific worker choices, use `/worker-models` in the TUI instead; overrides survive service restarts, follow the repository across this plugin’s managed worktrees, and apply to children spawned after the change. Existing child sessions keep their current model. `/worker-models worker=default` clears one override and `/worker-models reset` clears them all. The orchestrator model remains config-controlled.

---

## Real-world examples

**Add a feature with tests**

```
/orchestrate add cursor-based pagination to GET /api/items,
  keep the existing offset param working, and update the API docs
```

→ The orchestrator will explore existing pagination, plan the API change, delegate implementation with tests, run a reviewer, and summarize.

**Fix a bug with a regression test**

```
/orchestrate fix the checkout race when two tabs submit at once,
  add a regression test that reproduces it first
```

**Long-running objective**

```
/goal implement the plan at .orchestrator/plans/checkout.md
# leave this OpenCode session idle, then come back
/goal   # check progress
```

**Safe restructure**

```
/restructure src/services/payments --scope=module --risk=conservative
```

---

## Optional power features

All disabled by default. Enable only what you need.

### GitHub integration

Let the orchestrator create and list issues/PRs via your local `gh` CLI.

```jsonc
"github": { "enabled": true, "allow_mutations": false }
```

- Read-only (list/view) needs only `enabled: true`
- Creating issues/PRs needs `allow_mutations: true` **and** `confirm: true` on each call
- Pull requests are **always created as drafts** — `orchestrator_github_pr_create` has no draft toggle; the client sends `draft: true` and refuses a response that is not a draft. A PR is moved to ready (`orchestrator_github_pr_ready`) only when a fresh view directly proves the exact head revision, `draft: true`, `mergeable: true`, no dirty/unknown conflict state, and current remote base ancestry; unknown mergeability stays draft and is truthfully deferred — no polling
- Verified automatic approval (`orchestrator_github_pr_approve`) requires the ready transition, an exact-revision approved internal review, a non-author authenticated viewer, and fresh conflict-free evidence. A same-author attempt or API failure is refused and reported truthfully, and the automated approval is never claimed to satisfy branch protection
- Merging (`orchestrator_github_pr_merge`) is **autonomous** once the durable `merge` capability and the per-session `merge` gate allow it: no separate user request and no `confirm` flag are involved. It merges only after a fresh view proves the exact head/base revision, an open, unmerged, non-draft, `mergeable: true` pull with no dirty/unknown conflict state, the current remote base as an ancestor of the exact head, and an exact-revision approved internal review receipt — then verifies `merged: true` with a fresh post-merge view. Any moved SHA, conflict, missing receipt, branch protection, required check/review, permission failure, or merge queue is reported truthfully, never bypassed or polled
- Auth stays with `gh` — run `gh auth login` with least privilege. The plugin never reads tokens.
- Verify: `orchestrator_github_capabilities` (inside OpenCode) or `gh auth status` locally

### Git worktrees (separate checkouts)

Give the current session a separate checkout and branch without changing your main checkout.

```jsonc
"worktree": { "enabled": true, "allow_mutations": true, "root": "/srv/worktrees" }
```

- One managed worktree per current session, under the `root` you choose
- The orchestrator creates → enters → then delegates. Entering moves only the current session; delegated children inherit and share that context, not an atomic sandbox. OpenCode may complete a current-session move at the next safe boundary, so a pending enter is not a receipt—retry until `entered:true` before delegating.
- Create, sync, push, and cleanup require `worktree.allow_mutations: true` and a literal `confirm: true` on each call. Enter requires neither beyond `worktree.enabled: true`.
- `orchestrator_worktree_sync` fetches the latest remote base branch and merges it into the tracked branch when needed, recording an exact-revision sync receipt. It refuses a dirty tree and never resolves conflicts automatically: a conflicted merge is aborted and reported truthfully (safe relative unmerged paths only). After a conflict, the orchestrator autonomously delegates an implementer to perform the merge/resolution in the tracked worktree, then reruns verification and sync, commits, and restarts the exact-revision review — stopping only if the conflicts cannot safely be resolved.
- Verify: `./node_modules/.bin/opencode-v2-agent-orchestrator doctor` checks `git worktree list`

### Publication capability (`/publish`)

A durable, project-scoped authorization for the publication steps. Off by default at every level.

```jsonc
"publish": { "enabled": true },   // master gate; default { "enabled": false }
"review": { "mode": "bounded" }   // exact-revision review receipts require bounded mode
```

Three prerequisites must all be in place before the orchestrator may publish autonomously:

1. **Config master gate** — `publish.enabled: true` in the plugin options (default `false`). With the gate off, `/publish enable` is refused and `/publish status` / `/publish disable` still work so a stale authorization can always be inspected and revoked.
2. **Durable per-project capability** — `/publish enable` writes a durable record keyed to the stable project (it follows the repository across session moves; `/publish disable` revokes it). Idempotent toggling writes nothing when the record is unchanged.
3. **Bounded review mode** — `review.mode: "bounded"` (default `"prompt"`). Every publication step requires an exact-revision approved review receipt, which comes from the bounded review record; the `review_get` / `review_transition` tools are only registered in `bounded` mode, so with the default `"prompt"` no review record can ever exist and publication **fails closed** ("no review record exists") until `review.mode: "bounded"` is enabled.

What the capability means:

- **Authorization policy, not authentication.** The durable record says the project capability is enabled and lists what it authorizes; nothing in it proves which human invoked `/publish`. It never mutates Git or GitHub itself, and it never weakens the static `github.enabled` / `github.allow_mutations` / `worktree.enabled` / `worktree.allow_mutations` gates.
- **When enabled, it authorizes the orchestrator to pass `confirm: true` without re-prompting** for exactly five steps: worktree push, draft PR creation, the draft-to-ready transition, the verified post-ready approval, and the merge once the full merge precondition chain passes. It **never authorizes issue creation** (still gated on `github.allow_mutations` + `confirm: true`). Merge is the fifth authorized capability — not a separate approval.
- Every publication step still runs the full fail-closed gate chain: static gates, the durable capability, the per-session gates, a clean tree, an unchanged latest remote base, the exact synced head, base ancestry, and an exact-revision approved internal review receipt. The confirm-gated steps additionally require a literal `confirm: true`; the autonomous merge does not.

Mandatory sequence (prompt policy, enforced by the tools):

```
commit clean changes → worktree_sync against the latest remote base →
verify/test → exact-revision bounded review → worktree_push → draft PR create →
ready → approve at the exact revision → merge at the exact approved SHA →
post-merge verify → worktree cleanup
```

If the sync reports conflicts after aborting, the orchestrator delegates an implementer to resolve them in the tracked worktree, reruns verification/sync, commits, and restarts the exact-revision review; it stops only when conflicts cannot safely be resolved. If the base or head changes after the review, it re-syncs and re-reviews. A push without a sync receipt, with a moved base, a changed head, or a missing/mismatched approved review receipt is refused.

**Merge is the fifth authorized capability, and it is autonomous.** `orchestrator_github_pr_merge` needs no separate user request and ignores a `confirm` flag. It requires the durable `merge` capability plus the per-session `merge` gate, an exact-revision approved internal review receipt for the same head/base, and a fresh `orchestrator_github_pr_view` proving the pull is open, unmerged, and non-draft with `mergeable: true` and no dirty or unknown conflict state. It checks the exact expected head and base SHAs, requires the current remote base to be an ancestor of the exact head, merges with that exact SHA, then proves `merged: true` with a fresh post-merge view. Branch protection, required checks or reviews, permission failures, and merge queues are reported truthfully — never bypassed, never polled.

**Definition of Done (terminal drive):** a ship-shaped task is finished only when it is merged and the tracked worktree is cleaned up, or when a configured gate or missing capability refuses the next terminal step. The orchestrator runs the terminal chain as soon as the work is verified — it never stops at “changes are ready” or “the PR is open” and waits for you to ask for the merge. If a session-disabled `/gates` step or a missing durable capability refuses a step, it names the exact step and the one command that would change it instead of re-planning around the gate.

A session can narrow (never widen) any of these steps for the current session with `/gates`; see the command description above. A gate disabled for the session is final until you re-enable it.

Verify the current policy inside OpenCode with `/publish status` or `orchestrator_publish_policy_get` (read-only, orchestrator-only). Tool: `orchestrator_publish_policy_get`.

### Peer-orchestrator discovery

`orchestrator_peer_list` (orchestrator-only) lists bounded metadata about other orchestrator sessions **in the same stable project**: session ID, goal status, and a redacted/truncated objective hint, ordered deterministically with an opaque `after` cursor. It is durable metadata only and never live-complete:

- never full objectives, transcripts, prompts, files, or credentials — known-pattern redaction runs before truncation
- only goal records keyed under the caller’s own project are ever read
- sessions without a readable goal record do not appear; `complete: false` is reported truthfully when `storage.scan` is unavailable or the bounded scan cap is hit

This tells you concurrent orchestration exists and what its goal state is — it is not a live directory of sessions.

### Budgets, tracing & review gates (observability)

For teams that want cost/usage limits or a stricter review gate:

```jsonc
"trace": { "mode": "snapshot" },
"budget": {
  "mode": "stop-between-steps",
  "max_steps": 1000,
  "max_tokens": null,
  "max_cost_usd": 10,
  "max_wall_clock_ms": null,
  "max_retries": 5
},
"review": { "mode": "bounded", "max_rounds": 2 } // requires explicit approve before finishing
```

- **Trace** `memory` keeps bounded metadata in memory and never persists it; `snapshot` additionally stores one bounded current metadata record per session. Neither stores prompts, transcripts, tool input/output, arbitrary payloads, or file contents.
- **Budget** supports the five optional limits shown above; omitting a limit or setting it to `null` means no limit.
- **Budget** `advisory` only reports; `stop-between-steps` pauses *between* steps, never mid-tool
- **Bounded review** needs an explicit `approve` with three checks (`diff`, `scope`, `verification`)

> These are opt-in. The defaults (`off` / `advisory` / `prompt`) change nothing until you enable them. Curious about the details? See the collapsed **Advanced** sections below.

---

## Troubleshooting

**Is the plugin loaded?**

```sh
./node_modules/.bin/opencode-v2-agent-orchestrator doctor
./node_modules/.bin/opencode-v2-agent-orchestrator doctor --json
```

`doctor` checks config, agents, and commands (always) plus advisory checks for `git`/`gh` on *this* machine. Runtime checks never fail the report — they’re informational. Inside OpenCode, the server-side tools (`orchestrator_github_capabilities`, `orchestrator_worktree_status`) are authoritative.

**Plugin not appearing in OpenCode?**
- For an installed project, make sure its `opencode.jsonc` points at `./node_modules/opencode-v2-agent-orchestrator/dist/index.js`; this repository's source checkout is loaded as `./src/index.ts` from global config
- Restart OpenCode: `opencode2 service restart` then reopen from your project dir
- Check logs: `~/.local/share/opencode/log/opencode.log` should show `loading plugin .../dist/index.js` and `agent.updated` / `command.updated`

**GitHub or worktree not working?**
- Ensure `gh` is installed and authenticated (`gh auth status` exit code 0)
- Ensure `git worktree list --porcelain` works and your `worktree.root` is an absolute path
- For worktree create/sync/push/cleanup, enable the feature and mutations, then pass literal `confirm: true`; enter needs only `worktree.enabled: true`
- Push/PR-create refusals naming a missing capability mean the durable project policy is off: run `/publish status`, then `/publish enable` (needs `publish.enabled: true` in config). Refusals naming a missing sync receipt or review receipt mean the gate chain was not satisfied: set `review.mode: "bounded"` (the default `"prompt"` registers no review tools, so no exact-revision review receipt can exist), then run `orchestrator_worktree_sync`, verify/test, run the bounded review, and push
- Ready transition refused? A fresh view must show `draft: true`, `mergeable: true`, no dirty/unknown conflict state, and the exact head revision — an unknown or conflicted mergeability keeps the PR a draft by design
- Merge refused? The durable `merge` capability and the per-session `merge` gate must both allow it, and a fresh view must show an open, unmerged, non-draft pull at the exact head and base SHAs with `mergeable: true`, no dirty/unknown conflict state, the current remote base as an ancestor of the exact head, and an exact-revision approved review receipt. Branch protection, required checks or reviews, and merge queues are reported truthfully — never bypassed
- A publication step you expected to be on may be narrowed for this session: run `/gates` to inspect the effective gates, and `/gates <gate>=on` to remove a session narrowing (it still cannot exceed the project/config ceiling). `/gates reset` clears every session narrowing

**Nested delegation stops after the first hop?**

OpenCode’s native `experimental.subagent_depth` defaults to 1, which prevents subagents from launching subagents. Re-run the installer — it adds `experimental.subagent_depth: 3` only when the key is absent — or set the value yourself; an explicit value you configure always wins and is never overwritten.

---

<details>
<summary>How the orchestration works (for the curious)</summary>

- **Roles are prompt policy, not hard sandboxing.** `explore` is told not to use shell, `planner`/`reviewer` not to edit, and nested delegation is bounded to the role graph (implementer→planner/explore, planner→explore, reviewer→explore, explore never delegates) — the installer writes matching permission rules, but V2’s plugin API doesn’t enforce this at the filesystem level. Treat it as strong instructions plus config-level permissions.
- **File ownership coordinates agents.** The orchestrator assigns non-overlapping file scopes to each `implementer`, but those prompt-level scopes are not filesystem isolation. `max_parallel` (default 4) caps concurrency.
- **Handoffs are structured.** Workers return a five-field summary (`Outcome / Files / Verification / Risks / Follow-up`) plus a version-1 JSON envelope. The orchestrator can run `orchestrator_handoff_validate` for deterministic checks before using a handoff. Inter-agent messages — parent→child prompts and child→parent handoffs alike — are expected to be explicit, self-contained, and legible on their own.
- **Review is prompt-based by default.** `require_review: true` means the orchestrator *asks* a reviewer. There’s no hard runtime gate — `bounded` review adds an explicit `review_get` / `review_transition` flow with a circuit breaker if you need it.
- **Publication is capability policy.** `/publish` toggles a durable, project-scoped authorization record (never caller identity). When the config master gate is on and the record is enabled, the orchestrator may pass `confirm: true` without re-prompting for push / draft PR create / ready / approve / merge (merge is autonomous and ignores `confirm`) — never issue creation. Every step still requires the mandatory sync → verify → exact-revision review sequence and fails closed otherwise, and a per-session `/gates` narrowing can turn any step off for the current session.
- **Terminal drive is the default ending.** For ship-shaped work, the Definition of Done is merged and cleaned up, or a named gate/capability refusal — not a paused “PR is open” state waiting for a merge instruction.
- **State lives in OpenCode storage.** Goals and plan runs are keyed to the current session and persist through its idle periods via `ctx.storage` with per-session locks; session deletion removes that state. Conversations remain the source of truth.

Want the formal contracts? `docs/phase-1/` has them (D2 handoff, D4 gate, etc.) — you don’t need them to get started.

</details>

<details>
<summary>Limitations & V2 boundaries</summary>

- No atomic isolation for subagents — worktrees are plain `git worktree` dirs, not containers.
- `doctor` probes *this* machine’s `PATH`; the live server’s capabilities are checked via server-side tools.
- Validation tools (`orchestrator_handoff_validate`, etc.) are callable helpers — they don’t run automatically on every worker output.
- No persistence of evidence receipts beyond the tool response.
- Token/cost tracking uses `session.usage.updated` snapshots; if the host doesn’t emit them, budgets report `unknown`.
- S3/V1 controls are opt-in and bounded: budgets pause only *between* steps, review gates only after an explicit transition. No in-flight cancellation.
- The publication capability is authorization bookkeeping, not caller identity: it does not prove a human invoked `/publish`, and it never bypasses the static gates or issue creation. Merge still requires the durable `merge` capability, the per-session `merge` gate, and every fail-closed precondition — never a bare user ask.
- Session gates (`/gates`, `/gates <gate>=on|off`, `/gates reset`) are a per-session narrowing only: they can turn a ceiling-allowed step off, but never widen the project/config ceiling, and they do not carry over to another session. The model has a read-only `orchestrator_gates_get` view; only `/gates` and the TUI gate picker write the narrowing record.
- Draft/ready/approval have hard limits by design: PRs are always created as drafts; a ready transition requires fresh conflict-free evidence at the exact revision (unknown mergeability stays draft — no polling); automated approval is never claimed or relied on to satisfy branch protection, and same-author or API failures are reported truthfully, never as successes.
- Peer discovery covers the same stable project only, and only sessions with readable goal records — it is durable metadata with a redacted objective hint, never a live or complete directory of sessions.

</details>

---

## Development

```sh
bun install
bun run dev:setup        # writes gitignored dev/project/opencode.jsonc from template
bun run dev:v2           # standalone opencode2 with XDG dirs under dev/state
bun run dev:v2:dist      # loads ../../dist/index.js (run bun run build first)
bun run typecheck
bun test
bun run build            # emits dist/index.js, dist/tui.js, dist/commands.js, dist/installer.js, dist/cli/index.js
```

`dev/project/opencode.jsonc` and `dev/state/*` are gitignored — they never touch global `~/.config/opencode`.

## Compatibility

Tested against:

- `@opencode/plugin` `0.0.0-beta-19425`
- `@opencode/sdk` `0.0.0-beta-19425` (integration tests)

Main plugin sets `tui: true` and publishes `./tui`. CLI-only config belongs in `cli.json`.

Inspired by multi-agent orchestration in `oh-my-openagent` at `64d89819ef1fde81712630f8e5d798be9e4e8867` — independent implementation, no affiliation.
