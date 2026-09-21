# Orchestration progress RPC

The server plugin exposes the read-only `opencode-orchestrator.progress` RPC
for the separate V2 CLI/TUI plugin. The TUI calls it through
`context.client.rpc`; it never imports the server storage adapter or reads
durable records directly.

## Request

```json
{ "sessionID": "<bounded session id>" }
```

The only method is `get`. The response is a bounded projection of one session:

- redacted/truncated goal hint;
- lead-board status, task-state counts, and at most 32 task summaries;
- current/reserved task title and role;
- review state and round, including `legacy-unproven` for V1 records;
- budget verdict, fixed limit statuses, and observational coverage;
- worktree status and redacted/truncated branch label;
- durable publication capability and the effective per-session gate states;
- `complete` plus bounded limitations.

No transcript, prompt, full objective, command output, credential, raw storage
record, SHA, filesystem path, or arbitrary evidence text crosses this boundary.
Missing, malformed, unavailable, or truncated state sets `complete: false` and
adds a fixed limitation rather than being interpreted as idle or complete.

The RPC is read-only. Publication, gate, board, and worktree mutations remain
in their existing server commands/tools and are not reachable from the
progress view.
