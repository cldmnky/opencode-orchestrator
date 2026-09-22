# Native subagent dispatch hook contract

This document records the pinned `@opencode/plugin` / `@opencode/sdk`
`2.0.14` behavior measured by
`test/contract/phase-f-subagent-hooks.test.ts`.

## Observed contract

- The native tool name is `subagent`.
- `execute.before` receives `tool`, `sessionID`, `agent`, `messageID`, `id`,
  and the parsed `input` object.
- A subagent input contains an `agent` target, `description`, `prompt`, and
  optional `sessionID` and `background` fields.
- The before and after events preserve the same tool call ID, session ID,
  agent ID, message ID, and input.
- Throwing from `execute.before` prevents child-session creation and no
  `execute.after` event is emitted for that call.
- `execute.after` runs with `status: "completed"` for the successful native
  foreground dispatch measured by the probe. The TypeScript hook contract also
  defines an error variant; the runtime releases an admitted call whenever
  that after event is delivered.
- Foreground dispatch keeps the parent tool call active until the child
  finishes. Background dispatch reports the native tool call as completed after
  launch, while the child continues independently.

## Runtime boundary

The plugin enforces `max_parallel` for configured-role `subagent` calls per
root session in one plugin process. It serializes admission, refuses a call
before child creation when the ceiling is full, and releases the call on the
matching after event. Background child work is not converted into an
 autonomous scheduler or a cross-process lease: 2.0.14 reports the native
background dispatch complete after launch.

The pinned probe does not establish a bounded parent completion guarantee for a
child provider failure/cancellation. The runtime therefore does not invent one:
an admitted call is released on a delivered after event, while a host path that
never emits after remains bounded by the process-local admission table and is
reported as an unsupported host guarantee rather than silently retried.

The limit does not provide filesystem isolation, worktree assignment, semantic
task independence, or exactly-once behavior. Unknown parent chains fail closed
only for configured-role dispatches owned by this plugin; unrelated tools and
agents are ignored.
