# Tool and command migration for 0.2

Phase 7 reduced the model-visible surface and removed overlapping state
machines. Existing prompts and agent instructions should be migrated rather
than continuing to call the removed names. The installer and doctor identify
stale generated references; user-authored text is not rewritten silently.

## Model-visible tools

| Removed name or family | Replacement or boundary |
|---|---|
| `orchestrator_goal_get`, `orchestrator_goal_set`, `orchestrator_goal_update` | `orchestrator_goal` with strict `get`, `set`, `pause`, `resume`, `complete`, or `clear` actions. |
| `orchestrator_lead_board_get` | `orchestrator_board_get`. |
| `orchestrator_lead_board_init`, `orchestrator_lead_board_task_create`, `orchestrator_lead_board_task_assign`, `orchestrator_lead_board_transition`, `orchestrator_lead_board_complete` | `orchestrator_board_action` with `init`, `create-task`, `assign-task`, `transition`, or `complete`; mutations require an expected revision. |
| `orchestrator_peer_list`, `orchestrator_session_status` | `orchestrator_status` with `mode: "single"` or paginated `mode: "list"`. |
| `orchestrator_task_complexity_classify` | No replacement tool. Use concise decomposition guidance and the lead board's mechanically knowable dependency/scope admission. The supported D4 v1 pure contract is not a model tool. |
| `orchestrator_admission_transition` | No separate call. Validation, review start, and board operations compute legal lifecycle transitions internally. The stateless admission contract remains a package-level pure API. |
| Generic orchestrator-owned review transition | Lead review get/start plus reviewer-only V2 submit. Review proof is bound to the configured reviewer child and exact revision. |
| `orchestrator_github_issue_view`, `orchestrator_github_issue_list`, `orchestrator_github_issue_create` | Removed from the core plugin. Configure a separate GitHub/MCP integration when issue workflows are needed. The core GitHub surface is repository preflight and guarded PR publication. |

The canonical default tool inventory is asserted by the server contract test.
Optional GitHub and worktree tools remain conditional and disabled by default.

## Slash commands

| Removed command | Replacement |
|---|---|
| `/restructure` | `/orchestrate` with the desired outcome and constraints. |
| `/polish` | `/orchestrate` with the specific quality, test, or documentation outcome. |
| `/stress-plan` | `/run-plan` for a hand-authored plan, or `/orchestrate` for a new planning request. |
| `/cd` | No slash-command replacement. Use the managed `orchestrator_worktree_enter` tool when worktree mode is enabled; native session movement remains host-controlled. |

The supported commands are `/orchestrate`, `/worker-models`, `/goal`,
`/run-plan`, `/halt`, `/handover`, `/publish`, and `/gates`. Command names are
declared in both `src/core/config.ts` and
`src/opencode-v2/commands/index.ts`; update both plus descriptions, prompts,
installer output, and tests when adding or renaming one.

## Configuration and package migration

- Re-run `install --check` to preview generated changes, then `install
  --migrate` to update plugin-owned agent fields after a backup.
- The installer removes stale generated permission families and old delegation
  references, but preserves exact user-authored rules and fields.
- The current distribution is `opencode-v2-agent-orchestrator`; the runtime
  plugin ID remains `opencode-orchestrator`. Do not replace the runtime ID in
  existing host state.
- Package consumers should import the supported root, `/tui`, `/commands`, and
  `/installer` entrypoints described in
  [`contracts/package-api.md`](contracts/package-api.md). Internal storage,
  review, board, and peer helpers are not supported package API.

For durable records and explicit recovery, see
[`state-migrations.md`](state-migrations.md) and
[`operations/state-recovery.md`](operations/state-recovery.md).
