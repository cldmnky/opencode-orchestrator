# Durable state and migration inventory

This inventory is the starting point for state-recovery and schema-migration
work. Records are plugin-scoped OpenCode storage values. Readers must parse
strictly, treat malformed data as unavailable, and never infer a safe mutation
from an unknown version.

| Family | Current key/prefix | Current version | Owner | Migration posture |
|---|---|---:|---|---|
| Goal | `goal/v1/<project>/<session>` | 1 | `src/opencode-v2/goal/state.ts` | Read strictly; move to a future V2 record only through an explicit migration. |
| Plan run | `run/v1/<project>/<session>` | 1 | `src/opencode-v2/goal/state.ts` | Preserve active/paused/complete lifecycle; archive malformed records. |
| Halt | `halt/v1/<project>/<session>` | 1 | `src/opencode-v2/goal/state.ts` | Preserve stop intent; never clear during passive reads. |
| Lead board | `lead-board/v1/<project>/<lead-session>` | 1 | `src/opencode-v2/orchestration/lead-board.ts` | V1 remains readable; V2 validation proof must be rebuilt from observed receipts. |
| Step receipts | `step/v1/<project>/<session>/<index>` | 1 | `src/opencode-v2/orchestration/step-state.ts` | Bounded receipts are historical; malformed entries are unavailable. |
| Review | `review/v1/<project>/<session>` | 1 | `src/opencode-v2/observability/review.ts` | V1 is read for status as `legacy-unproven`; caller-supplied maker/checker identity never authorizes publication or completion. |
| Review V2 | `review/v2/<project>/<session>` | 2 | `src/opencode-v2/observability/review-v2.ts` | Current bounded review authority; approved records require exact head/base SHAs, fixed checks, and plugin-observed reviewer-child provenance. |
| Trace | `trace/v1/<project>/<session>` | 1 | `src/opencode-v2/observability/trace.ts` | Replace in place only when the versioned schema changes. |
| Retry trace | `retry-trace/v1/<project>/<session>` | 1 | `src/opencode-v2/observability/trace.ts` | Bounded metadata only; no raw provider output. |
| Authority | `authority/v1/<project>/<session>` | 1 | `src/opencode-v2/authority/state.ts` | Snapshot is diagnostic and never an admission proof. |
| Gates | `gates/v1/<session>` | 1 | `src/opencode-v2/gates/state.ts` | Preserve explicit session narrowing; absent means follow the project ceiling. |
| Publication | `publish/v1/<project>` | 1 | `src/opencode-v2/publish/state.ts` | Preserve capability ceiling; malformed state is disabled. |
| Worktree | `worktree/v2/<origin-project>/<session>` | 2 | `src/opencode-v2/worktree/state.ts` | V2 is the runtime authority; legacy V1 records must not be reinterpreted silently. |
| Worktree session index | `worktree/v2/sessions/<session>` | 2 | `src/opencode-v2/worktree/state.ts` | Rebuild only from explicit worktree operations or operator recovery. |
| Session anchor | `session/v1/<project>/<session>` | 1 | `src/opencode-v2/session/state.ts` | Preserve origin/current locations across moves. |
| Worker models | `worker-models/v1/<scope>` | 1 | `src/opencode-v2/worker-models/state.ts` | Scope is hashed; preserve explicit model overrides. |
| Publication replay | `publish-replay/v1/<project>/<session>/...` | 1 | `src/opencode-v2/publish/reconcile.ts` | Idempotency records are bounded mutation receipts. |

## Migration rules

1. A missing record is different from a malformed record. Missing state may use
   the documented default; malformed state is unavailable and must be reported.
2. Migrations are pure, strict, idempotent, and tested from serialized values.
3. A legacy record may remain visible for status, but cannot silently authorize
   a new mutation or publication operation.
4. Archive before destructive reset. Recovery commands must identify one
   session and one family; broad recursive deletion is not supported.
5. Do not copy prompts, transcripts, command output, credentials, or arbitrary
   evidence text into a migration record.
