# N5 — Retry/Backoff Policy via `session.hook("retry")` (pinned beta-19507)

**Date:** 2026-09-16
**Status:** Contract probe **complete** and the default-off production slice **wired**: pure bounded policy (`src/opencode-v2/observability/retry.ts`), opt-in `retry: { mode: "bounded", max_delay_ms }` config, one orchestrator-only `session.hook("retry")` registration, and a bounded metadata-only retry trace record. With `retry.mode: "off"` (the default) no hook is registered, no record is written, and every existing behavior stays byte-identical.
**Scope:** `src/opencode-v2/observability/retry.ts` (new), `src/opencode-v2/observability/trace.ts` (bounded retry record + fixed vocabulary), `src/core/config.ts` (strict `retry` block), `src/opencode-v2/plugin.ts` (default-off hook wiring), `test/unit/retry.test.ts` (new), `test/unit/observability.test.ts`, `test/contract/phase-d-retry.test.ts` (new), and the N5 notes in [`../orchestrator-improvements-plan.md`](../orchestrator-improvements-plan.md).

## 1. Question

The plan's N5 asks whether `session.hook("retry")` can implement a **bounded, classed** retry policy for orchestrator sessions: honor host classification, cap delays, never convert terminal failures into retries, never retry ambiguous external effects blindly, never fight the built-in maximum attempt count, and record attempts in the trace only.

## 2. Measured host surface (direct runtime observation)

Method: `test/contract/phase-d-retry.test.ts` boots embedded `OpenCode.create` hosts (pinned `@opencode/sdk` `0.0.0-beta-19507`) in throwaway directories, injects a deterministic in-process AI SDK language model through the scoped `ctx.aisdk.hook("sdk")`/`("language")` seam, pins the session model with `session.switchModel` (the embedded host does not apply the agent's configured model), and drives real session prompts. Terminal classifications are injected as an AI SDK `APICallError` (HTTP 401); retryable ones as a 429 or a thrown plain `Error`. No external network: `models.fetch: false`, a process-wide fetch guard that records and rejects every non-loopback URL before a real send (self-tested), and the ambient `OPENCODE_API_KEY` removed for each host's lifetime (captured only to restore it, asserted absent while the host runs).

Symbol-level host evidence (installed pinned package): `node_modules/@opencode/core/dist/chunks/file-access-wqg2ybf7.js` (`SessionRunnerRetry.policy`: the hook is called with `attempt++` starting at 2, the proposed decision is `{retry: <host classification>, delay: <computed>}`, and the applied delay is `Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : <computed>`; `Schedule.max([exponential 2 s, recurs(4)]).pipe(jittered)`; `session.retry.scheduled` is published in `wait`), `node_modules/@opencode/plugin/dist/promise/session.d.ts` (`SessionRetry`, `SessionRetryDecision`). Nothing below claims behavior beyond what the running host did.

| Surface | Measured result |
|---|---|
| Callback shape | Exactly `{ sessionID, agent, model, error, attempt, decision }`. `model` is `{ providerID, id, variant }` (the resolved variant included; observed `variant: "default"`). `decision` is `{ retry: true, delay }` or `{ retry: false }` with no `delay` key. |
| `attempt` numbering | Physical: the initial request is 1, the first retry is **2**, then 3, 4, 5. The hook is called once before each proposed retry. |
| Terminal classification | An `APICallError` 401 classifies as `provider.auth` (with `status: 401`); the hook is called **once** with `decision: { retry: false }`, no retry is scheduled, and the model is called once. A thrown plain `Error` classifies as `provider.unknown` (retryable by the host) with `{ type, message }` and no `status` key. |
| Delay override | `{ retry: true, delay: 0 }` is honored: the retry is scheduled immediately (`at - observedAt < 250 ms` in the suite) and the model is re-called. |
| Invalid delay fallback | An override of `NaN` or `-1` falls back to the host's computed exponential delay (measured 1.4–3.5 s bounds for the first retry), and the retry still runs. |
| Built-in ceiling | `recurs(4)`: the hook is called exactly four times (attempts 2–5) across retries for one request; the request then fails with no fifth hook call. The maximum attempt count stays a host hard limit. |
| Scheduled events | `session.retry.scheduled` carries `{ sessionID, assistantMessageID, attempt, at, error }`; one event per scheduled retry. **The same event (identical `evt_…` id) is delivered more than once to one subscription** — consumers must dedupe by id (the S3 runtime already does). |
| Hook cleanup | Disposing the registration returned by `ctx.session.hook("retry", …)` stops callbacks; disposing twice is safe. |
| Isolation | The suite performs zero external fetch attempts in all cases (guard record asserted). |
| Harness fact | The embedded host invokes a directly-passed plugin's `setup` **twice**; location-scoped session hooks mean only the matching registration fires for the probed session. The probe records one callback per host decision. |

## 3. Production slice

### Configuration (`retry`, strict, default off)

```jsonc
{
  "retry": {
    "mode": "off",        // off | bounded; off is the default and registers nothing
    "max_delay_ms": 30000 // 0..900000 (the host's own 15-minute retry-after ceiling)
  }
}
```

Unknown keys, unknown modes, non-integer/negative values, and values above 900 000 are rejected; an omitted block parses to `{ mode: "off", max_delay_ms: 30000 }` and every existing config parses unchanged.

### Pure bounded policy (`src/opencode-v2/observability/retry.ts`)

Fixed classes (never extended at runtime) and rules, in order:

| Class | Error types | Rule |
|---|---|---|
| `rate-limited` | `provider.rate-limit` | keep the host-proposed retry, cap the delay |
| `provider-internal` | `provider.internal` | keep the host-proposed retry, cap the delay |
| `transport` | `provider.transport` | **veto** (`retry: false`): the hook cannot verify the request was not already accepted/rejected, so it never retries this ambiguous external effect blindly |
| `unknown` | `provider.unknown`, anything else not positively classified | **veto**: the class cannot be established, so no blind retry |
| `terminal` | `provider.auth`, `provider.quota`, `provider.content-filter`, `provider.invalid-request`, `provider.unsupported-operation`, `provider.no-route`, `provider.invalid-output`, `aborted`, `permission.rejected`, `tool.execution` | never retried |

1. A host `retry: false` is **final** and is never changed to `true` (all classes).
2. A per-session burst gate vetoes the retry when **6** hook observations already happened inside the last **60 s** (`veto-burst`); the tracked window is capped at 6 timestamps.
3. Only `rate-limited`/`provider-internal` keep a retry; every other class returns `retry: false` (`veto-class`).
4. A valid finite non-negative delay is capped **down** to `max_delay_ms` (never raised). Malformed delays (`NaN`, infinity, negative) are left byte-identical so the host applies its own computed-delay fallback.

The policy is pure: `decideRetry(input) -> { decision, class, action, window }`. The stateful wrapper keeps per-session windows only.

### Wiring (`src/opencode-v2/plugin.ts`)

`retryPolicyEnabled(options)` is true only for `retry.mode: "bounded"`. Only then does setup register `ctx.session.hook("retry", …)` (pushed into the existing registration cleanup list) and create the policy. The handler filters to `event.agent === options.orchestrator`, applies the policy, and leaves every other session untouched. The wrapper never throws: malformed events are ignored and any internal failure is caught after a bounded warning, so a retry hook can never break a model request.

### Recorded attempts (trace metadata only)

Attempts are recorded in a **separate** bounded retry trace record (`retryTraceSchema`, version 1) under `retry-trace/v1/<project>/<session>`, written through the existing `withSessionLock` in `trace.mode: "snapshot"` (memory only otherwise), exactly like S3 records. It carries counts, fixed enum values (`lastClass`, `lastAction`), and timestamps only — never prompts, transcripts, error messages, tool input/output, or credentials (the suite asserts no fixture error text appears in the persisted record).

The S3 trace summary's existing `retries` counter (host `session.retry.scheduled` events) is **unchanged and independent**: the two records are separate keys and never double count each other (`test/unit/observability.test.ts` locks this). The S3 runtime, its tool registration, and `shouldStartObservability` are untouched — `retry.mode: "bounded"` alone does not activate the S3 runtime.

### Default-off equivalence

- `retry.mode: "off"` registers no hook: the contract suite boots the real built plugin with default options and asserts only the existing `context` session hook is registered, that the host's uncapped proposal reaches a later probe hook unchanged, and that no `retry-trace/` record is written.
- With `mode: "bounded"` the contract suite observes the production hook end-to-end (capped 1 ms decision, ambiguous veto, terminal left final, worker sessions untouched, burst veto after six observations, bounded trace writes).

### Unchanged guarantees

D2 handoff fields, `reviewState` values, admission wording, handoff validation, S3 budget/review behavior, per-session gates, publication controls, worktree lifecycle, commands, tools, and prompts are untouched by this slice. No scheduler, event log, projection, publish, GitHub, or worktree logic is added. The default prompts are byte-identical (no prompt text was added).

## 4. Reproduce

```sh
bun run build                                     # dist/ is a prerequisite for the contract suite
bun test test/unit/retry.test.ts test/unit/observability.test.ts   # 58 pass, 0 fail, 351 expect() calls
bun test test/contract/phase-d-retry.test.ts      # 10 pass, 0 fail, 90 expect() calls
bun run typecheck                                 # clean
bun test                                          # 1010 pass, 1 skip, 0 fail (1011 tests, 37 files;
                                                  #  the skip is the pre-existing cross-volume case)
git diff --check                                  # clean
```

The probe suite is pin-specific (beta-19507): re-run it before relying on any measurement here. It uses no network and no credentials, and it changes no durable state outside its temporary roots.

## 5. Limitations and unmeasured items

- Pin-specific: measured on macOS with bun 1.3.3 against pinned `@opencode/plugin`/`@opencode/sdk` `0.0.0-beta-19507`. Hook ordering, error classification tags, schedule constants, and the event-duplication behavior can change on another pin.
- The deterministic provider is a **test-only override**; no real provider was called, so real-world classification mixes, provider retry-after headers, cost, and latency were not exercised.
- The burst window and attempts map are **process-local and in-memory**; they are never persisted and are not cleaned on `session.deleted` (the retry runtime does not own the event stream). Memory is bounded by the number of orchestration sessions with observed retries in one process.
- The retry trace record has **no reader surface in this slice**: `orchestrator_observability_get` and its output shape are unchanged, so the record is durable metadata for operators/future slices, not a tool result. The default tool contract/count is untouched.
- The embedded harness invokes direct plugin setup twice (location-scoped registrations); the production wiring therefore relies on the host de-duplicating location-scoped hooks, which was measured only at the contract-suite level.
- The policy never increases retries and never resurrects terminal decisions; the only behavioral deltas when enabled are fewer/shorter retries (capped delays, ambiguous-class vetoes, burst vetoes). "Bounded" never means "more retries than the host".
- No exactly-once claim: a retried model request is not deduplicated by this slice, and the policy has no durable retry ledger.
