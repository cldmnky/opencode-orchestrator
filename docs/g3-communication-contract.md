# G3 Communication Contract

**Status:** Phase 0 implemented (2026-09-15)
**Scope:** pilot on status messages and the finish/handover summary; orchestrator-only personality spec; policy-string restructure with test-enforced semantic equivalence. No gate, tool, schema, or fail-closed behavior changes.

## Problem

The orchestrator's language was its weakest user-facing surface:

- Policy strings in `src/core/policy.ts` and the runtime context injection in `src/opencode-v2/plugin.ts` ran 400–850 characters per single sentence (the publication policy peaked at 127 words in one line).
- The orchestrator agent had a functional description but no voice or tone contract.
- Clarification guidance covered only initial task ambiguity. There was no restatement-before-start, no phase-transition announcement, and no end-of-run summary contract.
- Status messages were terse and mechanical, and `/handover` emitted a raw redacted section dump.

## The contract has two layers

| Layer | Audience | Rule |
|---|---|---|
| User-facing rendering | The person reading the session: status messages, phase announcements, finish summaries, handover | Plain language. One instruction per sentence. Target **≤ 25 words per sentence**. Jargon glossed on first use. Structured as **what happened / what it means / what's next or what you can do**. |
| Model-facing contracts | The orchestrator and worker models | Precise and unchanged: D2 envelope, evidence records, tool names, SHAs, receipts, and every fail-closed precondition. Restructured into short bulleted sentences, but each safety phrase stays byte-equivalent. |

The two layers meet at one rule: **when a policy sentence would reach the user, render it through the plain-language template instead of pasting the policy string.** Refusals keep their full truth; they are explained, never softened.

## Plain-language rules

1. **One instruction per sentence.** Split compound instructions at `;`, `and`, or `but`.
2. **≤ 25 words per sentence.** Long lists become bullets.
3. **Active voice, named actor.** Say who does what: "the orchestrator", "you can", "the reviewer".
4. **Gloss jargon on first use.** Table below; the same glosses are used in status text.
5. **Never paste raw internal state.** Admission states, SHAs, gate names, tool names, and policy strings need a plain gloss the first time they appear.
6. **Never claim success without evidence.** A refusal or a blocked step says what happened, what it means, and the one action that changes it.
7. **Keep the fix short.** A status message is three lines unless the user asked for detail.

### First-use glossary (pilot)

| Term | Gloss |
|---|---|
| gate | a safety step you can turn off for this session |
| durable policy / capability | a saved project-wide authorization |
| capability toggle | a saved authorization, not proof of who asked for it |
| admission state | the recorded stage of a task handoff |
| SHA / revision | the exact commit being reviewed or merged |
| fail closed | the step stops instead of guessing |
| worktree | a separate checkout the orchestrator owns for this session |
| receipt | recorded proof that a step actually happened |
| review receipt | recorded proof that the change was reviewed at that exact revision |

## Status template

```
What happened: <one plain sentence about the event>
What it means: <one plain sentence about the effect>
What's next:    <one plain sentence: the next automatic step, or the command you can run>
```

- Implemented as `statusMessage()` in `src/opencode-v2/commands/runtime.ts`. Every prose status message routes through it.
- The third line is omitted only when there is genuinely nothing next.
- Longer reports (`/publish status`, `/gates`, the worker-model list) keep the same header block and then a details/evidence section with short bulleted lines. `/handover` uses the D2 field skeleton instead, because the next session consumes it like a handoff.
- Usage and validation messages still start with the template so a reader always knows whether anything ran; the copy-pasteable usage line follows.

## Restatement and ask budget

Applies to the orchestrator only (`buildOrchestratorSystem` in `src/core/prompts.ts`); workers stay task-shaped.

- **Restate before multi-worker work.** Two or three bullets: what was asked, what will change, what done looks like.
- **State assumptions.** List the assumptions being proceeded under and mark them as assumptions.
- **Ask only what blocks.** Ask when scope, success criteria, or verification is genuinely ambiguous. Use the native ask tool, which `clarify.auto` owns.
- **Ask budget.** At most three questions in one ask, each with concrete options. Never re-ask a question the user already answered. Record answers in the task ledger.
- **Do not stall.** If no answer is blocking, state the assumptions and proceed.

## Phase-transition announcements

One plain line per transition, in order: **plan → delegate → review → publish**.

- Shape (free text, one line): `<phase> — <what is happening in plain words>.`
- One line per transition. No internal state without a gloss.
- A refused or blocked phase announces what is refused, why, and what the user can do.

## Finish summary skeleton (shared with D2)

User summaries and worker handoffs share one skeleton: the five D2 handoff fields, exported as `HANDOFF_SUMMARY_FIELDS` in `src/core/policy.ts` and asserted equal to `D2_PROSE_HEADINGS`.

| D2 field | User-facing rendering |
|---|---|
| Outcome | what was achieved — one or two sentences first, then detail |
| Files | what was read or changed, with scope |
| Verification | the commands run and their results; "not run" is stated, never implied |
| Risks | what is uncertain, unverified, or could regress |
| Follow-up | the next concrete action, or "nothing left" |

- The orchestrator instruction lives in the summary section of `buildOrchestratorSystem`.
- `/handover` renders the same skeleton for the next session through `formatHandoverSummary()` in `src/opencode-v2/commands/runtime.ts`.
- The D2 envelope itself is unchanged: the skeleton is rendering only, never a schema change.

## Safety preservation rules

- Restructuring may split sentences, reorder within a constant, or add glosses. It may never drop, weaken, or re-scope a fail-closed precondition.
- Phrases pinned by the existing suite are kept byte-identical inside the restructured bullet (for example `do not silently claim the work`, `never delegate implementation from the main checkout`, `A session-disabled gate is final`). Where a pinned phrase is lowercase mid-sentence, a short lead-in keeps the phrase intact instead of re-capitalizing it.
- `test/unit/core.test.ts` carries the fail-closed precondition tables that assert every precondition still reaches the composed prompts with the same meaning (universal, orchestrator dispatch, and plugin-owned control groups).
- Worker prompts are unchanged: the personality, restatement, and summary sections are added only by `buildOrchestratorSystem`.
- Model-facing contracts are unchanged: D2 schema/envelope, evidence records, tool and command names, config, gates, and the publication chain.

## Enforcement map

| Contract | Enforced by |
|---|---|
| Status template shape and ≤ 25-word sentences | `test/unit/runtime.test.ts` (`statusMessage`, emitted statuses) |
| Handover uses the five D2 fields | `test/unit/runtime.test.ts` (`formatHandoverSummary`) |
| Summary skeleton equals the D2 prose headings | `test/unit/core.test.ts` (`HANDOFF_SUMMARY_FIELDS` vs `D2_PROSE_HEADINGS`) |
| Personality/restatement/summary are orchestrator-only | `test/unit/core.test.ts` (present in `buildOrchestratorSystem`, absent from `buildWorkerSystem`) |
| Restructured policy keeps every fail-closed precondition | `test/unit/core.test.ts` (fail-closed precondition tables) |
| Policy constants are bulleted with short lines | `test/unit/core.test.ts` (max words per line) |
| Command prompts keep the coordination line as the only over-budget line | `test/unit/prompt-builder.test.ts` |

## Out of scope (tracked follow-ups)

- The coordination line in `src/core/prompt-builder.ts` is not in the Phase 0 file set and remains a single dense sentence.
- Gate names inside `gateChangeMessage()` (`src/opencode-v2/gates/state.ts`) are wrapped by the status template in `runtime.ts` but are not themselves rewritten.
- Worker personality is intentionally absent; workers keep focused operational prompts.
