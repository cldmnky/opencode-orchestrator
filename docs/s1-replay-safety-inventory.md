# S1 Slice 1 — Replay-Safety Inventory (Publish Chain and Continuation Dispatch)

**Date:** 2026-09-16
**Status:** Slice 1 implemented (durable per-step receipts, schema + storage helpers,
goal-continuation wiring, session-end cleanup), plus the completed-marking follow-up: the
next idle edge records the previously delivered step as `completed` (best-effort,
memory-tracked, under the session lock). This inventory is a **design/reference
artifact**: it classifies existing steps and names the duplicate-PR risk and the
branch-name pre-check. **Nothing here enforces any classification** — the publish
chain, admission decisions, and every gate are byte-identical to before.

**Scope:** the publication chain owned by the orchestrator (`worktree_sync` →
`worktree_push` → `github_pr_create` → `github_pr_ready` → best-effort
`github_pr_approve` → `github_pr_merge` → fresh verification → `worktree_cleanup`), the
local steps around it (commit, verification, review record), and the goal-continuation
dispatch that now writes receipts. Issue creation is deliberately outside the autonomous
chain and is listed only to say so.

**Non-goals:** no scheduler, no event log, no projections, no retry hook/backoff, no
publish behavior change, no exactly-once claim.

## 1. Why an inventory first

Durable per-step receipts (`step/v1/<project>/<session>/<stepIndex>`,
`src/opencode-v2/orchestration/step-state.ts`) record what the plugin tried:
`pending` (reserved), `dispatched` (delivery confirmed), `completed`, `failed`, with an
idempotency key, attempt number, timestamps, optional cursor, a bounded/redacted failure
class and message, and an optional bounded/redacted completion message. The goal
continuation now writes `completed` at the next idle edge after a delivery — an
observation that the delivered turn ended, never proof that it succeeded. `failed` is
still only recorded state for later slices.

A receipt can make a replay **detectable**. It cannot make a replay **safe**: storage
has no transactions, the session lock is process-local, and the GitHub API is an
external system whose responses can be lost after the mutation already happened. Before
any slice consumes receipts for retry or resume, each step must be classified by what a
second attempt actually does.

## 2. Classification vocabulary

| Class | Meaning | Retry rule |
|---|---|---|
| **replay-safe** | Repeating the step has no new external effect (reads, local recalculation). | May run any time. |
| **idempotent** | Repeating with the same identity (branch, PR number, revision) converges to the same end state; the second attempt is a no-op, the same result, or a fail-closed refusal. | May retry with the same identity after re-verifying preconditions. |
| **compensatable** | A repeat may produce a duplicate external object or event, but the duplicate is detectable and reversible/dedupable (close the duplicate, reuse the existing object). | Retry only with a detection + compensation step. |
| **ambiguous** | The first attempt's outcome cannot be determined from the local record; a blind replay may duplicate or corrupt. | Never retry blindly: read fresh remote truth first (view/verify), then either adopt the existing result, compensate, or fail closed. |

Two standing rules:

1. **Exactly-once is refused.** No step in this chain is claimed exactly-once. Even an
   `idempotent` step can fail between the mutation and the local receipt update; the
   receipt then says `pending`/`dispatched` and is not proof the remote state matches.
2. **Receipts never gate.** A missing, malformed, or unreadable receipt cannot change an
   admission, gate, review, publish, or worktree decision. Receipt writes are best-effort
   and swallowed after logging.

## 3. Publish-chain inventory

| Step | Tool / surface | Class | Reasoning and current guard |
|---|---|---|---|
| Commit clean changes | `git commit` (local) | replay-safe | Local-only; repeating requires a changed tree and creates no external effect. The chain always commits before publication. |
| Sync against latest remote base | `worktree_sync` | idempotent | Re-merging an already-merged base is a no-op/fast-forward; conflicts abort and record no receipt; nothing is pushed. |
| Verification / tests | configured commands | replay-safe | Read-only with respect to Git/GitHub (local build artifacts aside). |
| Exact-revision review record | `review` state + `orchestrator_review_transition` | idempotent | One current record per session key; replay at the same head/base either keeps the same state or fails closed on identity/terminal rules. |
| Push branch | `worktree_push` | idempotent **within the exact preconditions**; ambiguous outside them | Requires a clean tree, unchanged remote base, exact synced head, base ancestry, approved exact-revision receipt, and `confirm: true`, then verifies the remote ref equals the pushed head exactly. Re-pushing the same head is a same-ref update; a moved head/base must instead re-sync and re-review (fail closed). |
| Draft PR create | `github_pr_create` | **ambiguous** (not idempotent) | The client always POSTs a new draft after exact head/base + ancestry checks and verifies the created object. If the POST response is lost, a retry cannot recover the PR number/URL; GitHub's uniqueness rule (one open pull per head/base) only rejects a retry while that first pull is still open, so it is not a general duplicate guard. **Duplicate PR risk** — see §4. |
| Ready transition | `github_pr_ready` | idempotent | Requires a fresh pre-view with `draft: true` and verifies a post-view (`open`, unmerged, `draft: false`, exact head). A replay after success fails the draft precondition and refuses; it never creates a second state change. |
| Best-effort approval | `github_pr_approve` | replay-safe in effect; append-only on GitHub | Pinned to the exact head commit; it is optional and never a merge precondition. A replay can append a duplicate APPROVE review event at worst — harmless, since the merge authority is the internal exact-revision review receipt, not the GitHub review. |
| Merge | `github_pr_merge` | **ambiguous** | The PUT merge can succeed while the response is lost. The tool requires an open, unmerged, non-draft PR at the exact head/base with a fresh conflict-free view, then verifies `merged: true` with a second fresh view. A blind replay must not run: after a lost response the only safe step is a fresh `github_pr_view` — adopt `merged: true` / the merge SHA, otherwise re-evaluate. |
| Post-merge verification | `github_pr_view` | replay-safe | Read-only fresh remote truth. |
| Worktree cleanup | `worktree_cleanup` | idempotent | Removing an already-removed tracked worktree is a no-op/fail-closed; no external side effect. |
| Issue creation (outside the chain) | `github_issue_create` | ambiguous / duplicate risk | Not authorized by the publish capability; issue creation is outside every autonomous chain and is never retried by it. |

### Continuation dispatch (receipts already wired)

| Step | Class | Reasoning |
|---|---|---|
| Goal-continuation prompt delivery | ambiguous for side-effecting turns; replay-safe for read-only turns | The receipt distinguishes `pending` (reserved under the session lock) from `dispatched` (prompt queued), and the next idle edge marks it `completed` from an in-memory per-session index. Completion is an observation that the session went idle after delivery, not proof the turn succeeded or that its side effects are unique; the dedupe/completion maps are process-local and volatile. |

## 4. Duplicate PR risk and the branch-name pre-check

**Risk.** `github_pr_create` has no dedupe step. The realistic duplicate paths:

1. The create response is lost after GitHub created the draft (timeout, transport
   failure): locally the step is `pending`/`dispatched` with no PR number, so a caller
   cannot tell "not created" from "created but unacknowledged".
2. A retry uses a *different* head/base pair (for example a re-pushed branch after
   re-sync) for the same logical task. GitHub's same-head/base rejection does not apply,
   so a second PR is created.
3. A hand-driven or partially recovered session repeats `github_pr_create` outside the
   receipted flow.

A duplicate draft PR is not just noise: two PRs with the same logical change can both
receive ready/approve/merge attention, and evidence/URLs diverge.

**Branch-name pre-check (recommended, not implemented in slice 1).** Before calling
`github_pr_create`, list pulls for the repository (`github_pr_list`) and match the
intended `head.ref` and `base.ref` client-side; if a PR already exists, adopt it instead
of creating:

- open PR with the same head/base and head SHA equal to the expected revision: reuse it
  (record its number in the step receipt) and continue the chain at the next step;
- open PR with the same head/base but a different head SHA: fail closed and re-run sync
  + exact-revision review before any transition;
- only when no PR matches: create, then verify `draft: true` and exact head/base SHAs.

Honest limits of the pre-check: `github_pr_list` supports state filtering only (no
server-side head filter) and its listing is bounded by the tool's default page, so a PR
outside that page is invisible. It also cannot distinguish two different logical tasks
that share a branch, cannot match a PR that is already closed/merged, and cannot close a
cross-process race between two pre-checks and two creates. It reduces the duplicate
window; it does not close it. It is therefore a compensating control, not a guarantee,
and it belongs with slice-1 receipts (the idempotency key + step identity) rather than in
this slice.

## 5. What slice 1 actually adds

- `step/v1/<project>/<session>/<stepIndex>` records with a strict version-1 schema,
  bounded/redacted failure and completion text, and storage helpers (read, write, remove,
  bounded scan listing with pagination, last-completed lookup, session-prefix removal).
  Missing `storage.scan` returns empty results, never an error or a completeness claim.
- Goal continuation writes one `pending` receipt for the reserved turn under the same
  session lock as the goal reservation, then updates it to `dispatched` after the prompt
  is queued. Both writes are best-effort: they can never change an admission decision.
- Completed marking: the continuation remembers the last delivered step index per session
  **in memory only** and, at the next idle edge, marks that receipt `completed` under the
  same session lock, before any new admission attempt. The mark is best-effort and never
  blocks or changes an admission. `completed` and `failed` are sticky terminal records: a
  completion never rewrites a finished or failed receipt (see §6).
- `session.deleted` cleanup removes the session's step prefix together with goal/run/halt
  records, serialized by the same lock, and drops the in-memory completion index.
- No scheduler, no retry, no resume, no event log, no publish change. `attempt` / `cursor`
  remain recorded state for later slices.

## 6. Limitations

- Process-local `withSessionLock` only; no CAS, transactions, or cross-process guarantee.
- Scan-based cleanup and lookups are bounded (`STEP_SCAN_ENTRY_CAP`); a degenerate store
  stops at the cap instead of claiming completeness.
- Completion is inferred, not proven. The mark means "the session went idle after this
  step was delivered"; it does not prove the turn succeeded or that its external effects
  are unique, and it is never a resume or completion gate. The tracked index is
  process-local, so a plugin restart, a dropped idle edge, or a session that never idles
  again leaves the receipt at `dispatched` (or `pending` if the dispatched update also
  failed).
- Completion writes are best-effort and swallowed after a warning, like every other
  receipt write; a storage failure leaves the receipt at its previous status and never
  blocks or retries an admission. The optional completion note is redacted and truncated
  like a failure message (`STEP_COMPLETED_MESSAGE_MAX_LENGTH`).
- Receipts are observability records: they are never proof of remote state and never an
  authorization, admission, or completion signal.
- The classifications above describe the current code and the API shapes it relies on
  (GitHub uniqueness by head/base, merge with expected head SHA, post-merge fresh view).
  They must be re-validated if the publish chain changes.
