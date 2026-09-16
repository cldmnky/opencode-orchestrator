# G3 Before / After Examples

**Status:** Phase 0 evidence page (2026-09-15); full rollout section added (2026-09-16)
**Contract:** [docs/g3-communication-contract.md](./g3-communication-contract.md)

Measured per-line word counts use the exported constants directly (split on `\n`, count whitespace-separated tokens per line). "max" is the longest single line; the plain-language target is ≤ 25 words.

## Measured readability

| Constant | Lines before | Max words before | Avg words before | Lines after | Max words after | Avg words after |
|---|---:|---:|---:|---:|---:|---:|
| `PUBLICATION_POLICY_GUIDANCE` | 8 | 127 | 70.4 | 51 | 24 | 11.2 |
| `GITHUB_LIFECYCLE_GUIDANCE` | 4 | 60 | 42.3 | 14 | 21 | 13.3 |
| `WORKTREE_LIFECYCLE_GUIDANCE` | 6 | 50 | 32.2 | 21 | 19 | 10.0 |
| `MANAGED_WORKTREE_GUIDANCE` | 4 | 50 | 31.5 | 11 | 19 | 12.4 |
| `STRICT_DECOMPOSITION_GUIDANCE` | 3 | 42 | 37.0 | 8 | 23 | 13.8 |
| `PROMPTING_POLICY_GUIDANCE` | 5 | 34 | 29.2 | 14 | 15 | 10.3 |
| `TOOL_AVAILABILITY_GUIDANCE` | 4 | 42 | 33.3 | 12 | 21 | 12.0 |
| `CLARIFY_GUIDANCE` | 4 | 54 | 25.0 | 6 | 23 | 17.2 |
| `D4_V2_COHERENCE_GUIDANCE` | 4 | 45 | 36.5 | 12 | 20 | 12.0 |
| `VERTICAL_SLICE_GUIDANCE` | 3 | 45 | 30.0 | 6 | 24 | 15.3 |
| `terminalDriveGuidance` (all features) | 5 | 58 | 42.4 | 14 | 25 | 15.5 |
| `STRUCTURED_HANDOFF_GUIDANCE` | 6 | 59 | 27.3 | 12 | 24 | 13.6 |

Character totals stay within 1% (for example publication: 4071 → 4108), because the restructure splits and connects sentences instead of dropping safety text. Every restructured constant is now asserted at ≤ 25 words per line in `test/unit/core.test.ts`.

## Full rollout: command and continuation prompts

The full rollout extends the short-bullet rule to the authored command prompts in `buildCommandPrompt` and the plan-ledger rules in `planContinuationGuidance`. Before, each prompt was a single line that joined every instruction with commas; each authored line is now one short sentence.

Counts are per authored prompt block (the command text before the shared sections), measured with `arguments = "scope"`; the plan row covers the `Plan ledger:` block in a plan-aware continuation.

| Prompt | Lines before | Max words before | Max sentence before | Lines after | Max words after | Max sentence after |
|---|---:|---:|---:|---:|---:|---:|
| `goal` | 1 | 47 | 24 | 5 | 24 | 24 |
| `restructure` | 1 | 36 | 29 | 5 | 9 | 9 |
| `run-plan` | 1 | 43 | 36 | 7 | 9 | 9 |
| `halt` | 1 | 21 | 10 | 3 | 10 | 10 |
| `handover` | 1 | 36 | 29 | 6 | 10 | 10 |
| `polish` | 1 | 30 | 22 | 5 | 9 | 9 |
| `stress-plan` | 1 | 33 | 27 | 5 | 12 | 12 |
| `gates` | 1 | 23 | 16 | 3 | 12 | 12 |
| `planContinuationGuidance` | 3 | 44 | 44 | 8 | 17 | 17 |

Six authored sentences were over the 25-word budget before: four in the command record (`restructure` 29, `run-plan` 36, `handover` 29, `stress-plan` 27) and two in the plan ledger (30 and 44). All six are now split into bullets. `test/unit/core.test.ts` asserts every command and continuation prompt line and sentence is within budget; the only allowed over-budget line is the tracked prompt-builder coordination line.

### Command prompt example: `/run-plan`

**Before** — one 36-word sentence:

```
Read the complete plan before changing files, follow the plan's phase order, track each step, delegate safe independent work only with disjoint write scopes, verify every step, and audit the aggregate result with the review role.
```

**After** — one instruction per line, with the pinned wording intact:

```
Read the complete plan before changing files.
Follow the plan's phase order.
Track each step.
Delegate safe independent work only with disjoint write scopes.
Verify every step.
Audit the aggregate result with the review role.
```

### Plan continuation example: configured breakers

**Before** — one 44-word sentence:

```
Continue autonomously through the ledger unless a real blocker or a configured breaker applies (halt flag, budget fail-closed, cooldown, max continuations, or an open review circuit); stop and report to the user otherwise, and never mark the goal or plan complete without direct evidence.
```

**After**:

```
Continue autonomously through the ledger unless a real blocker or a configured breaker applies.
Configured breakers: halt flag, budget fail-closed, cooldown, max continuations, or an open review circuit.
Stop and report to the user otherwise.
Above all, never mark the goal or plan complete without direct evidence.
```

Phrases the suite asserts lowercase keep a short lead-in (`Then`, `Above all,`) so the phrase itself stays byte-identical instead of being re-capitalized: `execute the first unfinished item with direct verification`, `update the ledger to record the change`, `never mark the goal or plan complete without direct evidence`, and `redact secrets`.

## Status message example: blocked dispatch

**Before** — one mechanical line, raw reason only:

```
Dispatch blocked by configured controls: stop-between-steps: max_steps exceeded (observed 12, configured 10)
```

**After** — what happened, what it means, what's next; the raw reason survives verbatim:

```
What happened: Dispatch blocked by configured controls: stop-between-steps: max_steps exceeded (observed 12, configured 10)
What it means: The command was not delivered, so no new work started.
What's next: Inspect the controls with /gates or orchestrator_observability_get, then retry.
```

## Status message example: goal set

**Before**:

```
Orchestration goal set:
ship the release
```

**After**:

```
What happened: Orchestration goal set.
What it means: The orchestrator will keep working toward this objective automatically.
What's next: Pause it with /goal pause, or clear it with /goal clear.

Objective: ship the release
```

## Status message example: halt

**Before**:

```
Automation halted (goal paused, plan run paused, automatic continuation stopped).
```

**After**:

```
What happened: Automation halted (goal paused, plan run paused, automatic continuation stopped).
What it means: Automatic continuation will not start new work for this session.
What's next: Resume with /goal resume or /run-plan when you are ready.
```

## Status message example: refused `/publish enable`

**Before** — two dense sentences with the fix buried at the end:

```
/publish enable refused: the publication capability is disabled by plugin configuration (publish.enabled: false). An operator must set publish.enabled: true in the plugin options first; the durable project policy cannot be enabled while the capability is off.
```

**After** — the refusal, its meaning, and the one action that changes it:

```
What happened: /publish enable refused: the publication capability is disabled by plugin configuration (publish.enabled: false).
What it means: The durable project policy cannot be enabled while the capability is off, so nothing changed.
What's next: An operator must set publish.enabled: true in the plugin options first.
```

## Report example: `/handover`

**Before** — a raw redacted section dump with internal headings:

```
# OpenCode Orchestrator Handover
Focus: continue API work

## Recent session context
...

## VCS status
modified src/index.ts

## Current diff
...
```

**After** — the same facts rendered through the shared D2 field skeleton (Outcome, Files, Verification, Risks, Follow-up), with the raw diff kept as an explicitly labelled appendix:

```
# Handover summary
Focus: continue API work

Outcome — what this session did and where it left the work:
user: keep the API stable

assistant: Implemented the change.

Files — what was read or changed, with scope:
- modified src/index.ts

Verification — the commands run and their results:
Not captured in this handover; run the checks this work needs and record the results.

Risks — what is uncertain or unverified:
This summary was assembled from session context and VCS state; it does not prove that any check passed.

Follow-up — the next concrete action:
Continue with: continue API work. Re-read the Outcome section and verify the working copy before changing it.

Current diff (raw evidence):
src/index.ts
+API_KEY=[redacted]
```

Missing reads are stated, never omitted: `Unavailable: <reason>` replaces the section body.

## Policy string example: publication capability

**Before** — one 127-word line (excerpt):

```
When the durable capability is enabled it authorizes the orchestrator to pass confirm:true without re-prompting for exactly: worktree push, draft PR creation, the draft-to-ready transition, the verified post-ready approval, and merge after the full merge precondition chain. The verified post-ready approval is best-effort and optional: 'approve-after-review' gates only that approval attempt, and a truthful refusal (self-approval, a missing approval capability, or an API failure) never blocks the merge, which is independently authorized by the durable 'merge' capability plus the per-session merge gate and every merge precondition.
```

**After** — one rule per bullet; the pinned confirmation clause stays byte-identical on its own wrapped line:

```
When the durable capability is enabled it authorizes the orchestrator to pass confirm:true
without re-prompting for exactly: worktree push, draft PR creation, the draft-to-ready transition, the verified post-ready approval, and merge after the full merge precondition chain.
The verified post-ready approval is best-effort and optional.
The 'approve-after-review' gate controls only that approval attempt.
A truthful refusal never blocks the merge.
Refusals include self-approval, a missing approval capability, or an API failure.
The merge is independently authorized by the durable 'merge' capability, the per-session merge gate, and every merge precondition.
```

## Policy string example: GitHub merge

**Before**:

```
Merge is autonomous when the durable publish capability 'merge' and the per-session gates allow it: no separate user merge instruction is required. Run orchestrator_github_pr_merge with a fresh conflict-free view at the exact approved revision, the exact head and base SHAs, and the exact-revision approved internal review receipt; verify merged:true again with a fresh orchestrator_github_pr_view, then clean up the tracked worktree.
```

**After**:

```
Merge is autonomous when the durable publish capability 'merge' and the per-session gates allow it.
That means no separate user merge instruction is required.
Run orchestrator_github_pr_merge with a fresh conflict-free view.
Use the exact approved revision, the exact head and base SHAs, and the exact-revision approved internal review receipt.
Then verify merged:true again with a fresh orchestrator_github_pr_view and clean up the tracked worktree.
```

## Orchestrator voice example

**Before** — functional description with no audience contract:

```
Coordinates specialized agents and verifies their work.
```

**After** — same contract prefix, plus the user-facing voice:

```
Coordinates specialized agents and verifies their work. Explains plans, status, and results in plain language.
```

The orchestrator system prompt also gains the personality spec:

- voice: friendly, concise, proactive; explain the plan in one or two sentences before non-trivial work;
- plain language: one instruction per sentence, ≤ 25 words, jargon glossed on first use;
- restatement before multi-worker work, with stated assumptions and an ask budget of at most three questions;
- one plain line per phase transition (plan → delegate → review → publish);
- finish summary in the shared D2 field skeleton.

Worker prompts are unchanged: the spec is added only by `buildOrchestratorSystem`, and `test/unit/core.test.ts` asserts its absence in every worker system prompt.

## Safety preservation

The restructure keeps every fail-closed precondition with identical meaning. `test/unit/core.test.ts` asserts:

- 23 universal preconditions (disjoint scopes, fail-closed serialization, no-isolation caveats, the delegation ban, worktree entry order, review-before-push, publication fail-closed, merge preconditions, no-GitHub-APPROVE rule, never-polled, issue-creation exclusion, session-gate finality, terminal-drive rules, D2 freeze, evidence rules, secret redaction, tool preflight) in the orchestrator, worker, and continuation prompts;
- 2 orchestrator dispatch rules (`Require an exact disjoint write scope…`, `Serialize implementation tasks…`) in the orchestrator rules block;
- 3 plugin-owned control preconditions (bounded-review breaker, budget in-flight safety, budget unknown fail-closed) in the orchestrator and continuation prompts, and not in the worker prompt.

Pinned phrases are preserved byte-for-byte inside the restructured lines; where the original phrase was lowercase mid-sentence, a short lead-in keeps the phrase intact rather than re-capitalizing it. The full rollout applies the same rule to the command and continuation prompts: pinned wording keeps its exact case inside short bullets, and the new fixtures assert every authored line and sentence is within the budget.

## Known remaining dense string

`src/core/prompt-builder.ts` is outside both file sets, so its coordination line remains: one line, 42 words, whose second sentence is 36 words. Both suites pin the deviation explicitly. `test/unit/prompt-builder.test.ts` asserts any *other* over-25-word line in the built orchestration prompt fails; `test/unit/core.test.ts` asserts the same line is the only over-budget line across every command prompt, so a new dense line in either file fails a fixture.
