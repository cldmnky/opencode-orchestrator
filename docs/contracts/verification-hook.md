# Native shell verification hook contract

Measured against `@opencode/plugin` and `@opencode/sdk`
`2.0.11` by `test/contract/phase-e-verification-hooks.test.ts`.
The probe uses a deterministic loopback OpenAI-compatible provider, a throwaway
project, and no external network access.

## Observed shape

The native verification tool is named `shell`. The model-facing input observed
by the hook is an object containing a string `command`, for example:

```json
{"command":"printf '[phase-e-probe] ok'"}
```

`tool.hook("execute.before")` receives exactly these keys:

```text
agent, id, input, messageID, sessionID, tool
```

`tool.hook("execute.after")` receives the same identity and input keys plus:

```text
result, status
```

For a completed native shell call, `before` and `after` preserve the same
`id`, `sessionID`, `agent`, `messageID`, and `input`. A successful command has
`status: "completed"`; its nested `result.output.exit` and
`result.metadata.exit` are both numeric zero values.

The outer hook status is also `"completed"` for a non-zero shell exit. The
authoritative success signal is therefore the nested numeric exit code, not the
outer status or the nested status label. A command exiting 7 reports both exit
fields as 7 and must not produce a passing receipt.

Throwing from `execute.before` prevents the shell execution and no matching
`execute.after` event is delivered. Receipts must never be created from that
before event alone.

## Receipt boundary

The production verifier records only bounded metadata after a paired event with
a valid numeric exit code and a fresh Git `HEAD` observation. Raw command output,
stderr, provider payloads, and credentials are never persisted. Unknown or
malformed hook shapes fail closed and produce no passing receipt.

Receipt labels use the shared known-pattern redactor and are capped at 256
characters. Lead validation additionally requires the receipt to be from the
root lead session and configured orchestrator agent, to match the exact HEAD,
to post-date the task's validation lifecycle, and to be no older than 24 hours.
New lead-board validations persist the selected receipt IDs; eviction retains
receipts referenced by an active board and skips eviction when board state
cannot be inspected safely.
