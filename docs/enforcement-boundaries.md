# Enforcement boundaries

The orchestrator deliberately separates prompt guidance, recorded claims,
observed facts, and refusing enforcement. A model-supplied field is never
treated as proof merely because it has a familiar name.

## Capability levels

| Level | Examples | What it means |
|---|---|---|
| Guidance | role instructions, coherent vertical slices, clarification, terminal-drive policy, strict decomposition | Prompt text asks the model to behave a certain way. It is not a filesystem or process boundary. |
| Recorded | goals, board tasks, declared scopes, trace summaries, review intent, authority snapshots | The plugin stored a bounded value after parsing it. The value remains a claim unless a later runtime boundary validates it. |
| Observed | typed host hook events, shell exit codes, subagent ancestry, Git/GitHub reads, exact revision receipts | The plugin observed a host or safe-client event and retained only bounded metadata. |
| Enforced | permission refusals, dispatch admission, board transition checks, budget stops, review requirements, publication gates | A plugin or host operation refuses the next action when a required precondition is false, missing, stale, or unknown. |

## What is enforced

- Configured-role subagent dispatch is admitted at the native `subagent`
  boundary and limited by `max_parallel` per root session in one plugin
  process. Admission is released on the matching host after event.
- Tool families check the configured agent and shared permission action. GitHub
  and worktree families are disabled unless their config gates are enabled;
  mutations require their mutation switch and the tool-specific confirmation
  where applicable.
- Lead-board task schemas, dependency ordering, declared-scope normalization,
  and conservative overlap admission are enforced for enrolled board tasks.
  Unknown, broad, malformed, or overlapping write scopes do not become a
  concurrent reservation.
- A bounded review approval requires the configured reviewer child provenance,
  fixed checks, and the exact head/base revision. Legacy V1 review records are
  status-only (`legacy-unproven`).
- Lead completion and publication require plugin-observed verification receipts
  and exact-revision review evidence. Budget `stop-between-steps` can refuse a
  subsequent dispatch; it never claims to cancel a tool already running.
- The durable publication capability and per-session `/gates` record can only
  narrow or authorize the configured ceiling. They never bypass static
  GitHub/worktree gates, review, verification, ancestry, conflict, or revision
  checks. Merge is autonomous only after every fail-closed precondition passes.
- State recovery is operator-only, requires one explicit session and family,
  archives before removal, and refuses destructive work when bounded scanning
  is unavailable or incomplete.

## What remains guidance or unsupported

- Role prompts do not sandbox files, processes, network access, or child
  behavior. Permission configuration is the host boundary; prompt role policy
  is not.
- Declared scopes coordinate board reservations but do not prove semantic
  independence or prevent an agent from touching an unlisted path.
- `max_parallel` is process-local admission, not a cross-process scheduler,
  lease, or queue. The pinned host contract does not establish a bounded
  completion callback for every child-provider failure path.
- A reviewer identity or approval supplied by a model is not proof. Only the
  plugin-observed reviewer-child relationship is accepted for V2 publication
  proof.
- A GitHub approval is optional and best-effort; it is not substituted for
  branch protection or required checks. The plugin never reads or prints
  credentials.
- Storage has no general CAS/transaction primitive, so durable operations are
  process-local and not exactly once. Replay descriptors make ambiguous
  external effects detectable; they do not make those effects idempotent.
- Missing usage events, malformed state, unknown mergeability, stale receipts,
  and incomplete bounded scans remain explicitly unknown and fail closed where
  a mutation or completion decision depends on them.

The pinned native hook observations are documented in
[`contracts/verification-hook.md`](contracts/verification-hook.md) and
[`contracts/subagent-hook.md`](contracts/subagent-hook.md). The read-only TUI
boundary is documented in [`contracts/progress-rpc.md`](contracts/progress-rpc.md).
