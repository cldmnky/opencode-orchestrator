# N4 — Sessionless `ctx.generate.text` Contract Probe (pinned beta-19507)

**Date:** 2026-09-15
**Status:** Phase C contract probe **complete** — measurement plus production-wiring decision. **No production wiring, no configuration, no tools, no trace fields, and no runtime behavior change** in this slice.
**Scope:** the probe suite `test/contract/phase-c-generate.test.ts` (new), this record, and the N4 / Phase C / A18 notes in [`../orchestrator-improvements-plan.md`](../orchestrator-improvements-plan.md).
**Decision summary:** **pilot-only.** The measured surface is sessionless and behaves as declared, and failures are catchable, but **production advisory wiring is not authorized** by this probe: only a test-only provider override was measured, no real provider call (network, credentials, cost, latency, nondeterminism) was exercised, and the declared input has no timeout/abort control. A future opt-in advisory pilot is the largest defensible step and needs its own explicit authorization.

## 1. Question

The plan's N4 asks whether `ctx.generate.text` can back checks that need judgment but not a session (semantic D2 lint, review-rubric structuring, D4 adjudication) without a child session. The open questions were:

1. What is the exact accepted input and returned output shape?
2. Is the surface actually sessionless — no session, no inbox item, no history, no tool call?
3. Can a deterministic in-process provider be injected so the suite needs no network and no credentials?
4. What do safe failures look like, and are they catchable without session-side effects?
5. Does a future opt-in advisory integration remain safe to plan?

## 2. Method and harness boundaries

- **Runtime evidence:** `test/contract/phase-c-generate.test.ts` boots embedded `OpenCode.create` hosts (pinned `@opencode/sdk` `0.0.0-beta-19507`) in throwaway directories and calls the captured `ctx.generate.text` from a directly-passed probe plugin. Each contract case owns its host, its fixture root, and its fetch guard; the cleanup regression case owns its fixture root and guard and never reaches a live host.
- **Type evidence (installed pinned declarations):** `node_modules/@opencode/client/dist/effect/api/api.d.ts` (`GenerateTextInput { prompt; model?: Model.Ref }`, `GenerateTextOutput { text }`, `GenerateApi.text`), `node_modules/@opencode/client/dist/promise/client.d.ts` (`generate: { text }`), `node_modules/@opencode/plugin/dist/promise/plugin.d.ts` (`Context.generate: GenerateApi`), `node_modules/@opencode/plugin/dist/promise/session.d.ts` (`SessionHooks`: `generate`, `model.request`, `http.request`), `node_modules/@opencode/plugin/dist/promise/aisdk.d.ts` (`AISDKHooks.sdk`/`language`, `AISDKDomain.hook`), and the compiled pinned host wiring (`@opencode/core` `Generate` service layer, `ModelResolver`, `AISDK.language`, and the generic built-in dynamic provider plugin). No source-level behavior is claimed beyond what the running host did.
- **No external network, no host-reachable credential:** each host boots with `models.fetch: false`, which disables the host's external catalog refresh (the pinned bundled snapshot still populates the catalog). A process-wide fetch guard records every call and **rejects any non-loopback URL before a real send**; the guard is self-tested in the suite (an external URL must be recorded and rejected), so a passing "no external traffic" assertion cannot be vacuous. The ambient `OPENCODE_API_KEY` variable is removed for each probe host's lifetime, so no live credential is reachable by the probe host; its value is captured only so the variable can be restored on cleanup, and it is never passed to the host, logged, or persisted.
- **Hermeticity:** one `mkdtemp` root per test; the host's `database.path` points inside it; the root is removed in cleanup. Cleanup covers every path, including a rejected embedded-host creation: the fetch guard is restored, the ambient credential variable is restored (or left absent when it was absent), and the temporary root is deleted even when host creation fails. `test/contract/phase-c-generate.test.ts` carries a focused regression case that rejects host creation through a deterministic offline test-only factory (standing in for an `OpenCode.create` rejection on the same cleanup path) and asserts all three restorations plus the removed root, using the fake sentinel credential value defined in the suite. No worktree, no session fixture, and no repository state is touched.
- **Measured harness facts (not assumptions):**
  - The host's built-in generic provider plugin registers the **first** `ctx.aisdk.hook("sdk")` and loads `evt.package` from npm when no earlier hook supplied an SDK; a directly-passed plugin's hook then overwrites `evt.sdk`. A probe provider whose package name is not installed fails inside that built-in load before any probe hook runs (directly observed: an invented package name produced a registry load attempt, while the pinned `@ai-sdk/openai-compatible` dependency resolved locally). The suite therefore pins `aisdk:@ai-sdk/openai-compatible` with no `baseURL` — the pin's native mapping leaves that combination unmapped, which routes resolution through `ctx.aisdk` hooks.
  - Boot-time loopback provider detection (local model-server ports) is the only fetch activity the probe host performs; it is recorded and allowed by the guard and never occurs during a generation call.
  - Exploratory runs showed the resolved language for a provider is cached by the host, so the `sdk`/`language` hooks fire once per model; the committed suite therefore boots a fresh host per case and asserts hook records per case.

## 3. Measured behavior

Every row below is direct runtime observation unless marked otherwise.

| Surface | Measured result |
|---|---|
| `ctx.generate.text({ prompt, model })` | Resolves to exactly `{ text }` (single key) carrying the injected fixture output. |
| Accepted input shape | The injected language model observed exactly `{ prompt: [{ role: "user", content: [{ type: "text", text: <fixture prompt> }] }], tools: [] }` — a single user text message, no system parts, no history, no tools, exactly one model call per generation. |
| Model selection | An explicit `model: { providerID, id }` resolves the probe provider. An unknown model id rejects with `Generate.ModelSelectionError` (`_tag` observed) and message `Model unavailable: <provider>/<id>` **before** the injected provider is called (the suite asserts an empty injected-call record, no generation-phase fetch, and zero external attempts). |
| Provider failure | A failure thrown by the injected provider rejects with `Generate.UnavailableError` (`_tag` observed) carrying the thrown message; the rejection is catchable. |
| Sessionless | No session is created; `session.active()` stays empty; a pre-existing session's `message.list` and `inbox.list` snapshots are unchanged across a generation call; the session-scoped `generate`, `model.request`, and `http.request` hooks never fire. |
| No tool execution | `tool.hook("execute.before")` and `tool.hook("execute.after")` record nothing, and the language-model call carries `tools: []`. |
| Network | Zero fetch calls during generation; zero non-loopback fetch attempts in the whole probe lifetime (guard record asserted). |
| Deterministic injection seam | `ctx.aisdk.hook("sdk")` + `ctx.aisdk.hook("language")` scoped to the probe provider intercept that provider only. The hooks fire once per resolved model (the host caches resolved languages), which is why the suite uses a fresh host per case. |

Declaration-level (not measured at runtime): the input type has no `signal`, timeout, or abort field, and no other request-shaping options.

## 4. The deterministic injection seam is test-only

The mechanism that makes this probe deterministic is a **host-wide provider override registered by a plugin**: the `sdk`/`language` hooks replace the language model the host would otherwise build for a provider. That is legitimate for measurement, but it is not a production seam — a production plugin registering it would hijack real provider calls for every session in the host. A production N4 integration would call `generate.text` with a real configured model, where network, credentials, cost, latency, model choice, and output nondeterminism all apply. None of those were measured here.

## 5. Decision

**Pilot-only.**

- **Production advisory wiring is not authorized by this probe.** The surface contract is proven; the production operating envelope is not.
- Reasons, in order of weight:
  1. **No real provider call was exercised.** A production N4 check would need a configured model, a live credential, and network access; those were deliberately excluded, so cost, latency, and output quality remain unmeasured. Output must be treated as advisory, parsed defensively, and never replace deterministic schema/semantic checks.
  2. **No timeout or abort control exists.** The declared input (`prompt`, `model?`) has no signal/timeout field, so a caller cannot bound a generation call. A pilot must define how it avoids unbounded waits and must not claim cancellation it cannot deliver.
  3. **The only deterministic seam is a test-only provider override**, and **provider packaging is pin-coupled**: a config-declared provider package passes the built-in dynamic npm loader before plugin hooks can supply an SDK, so the injection path must be re-verified on every pin bump.
- **Permitted future work (requires a new explicit slice):** at most one **opt-in advisory post-step** wired behind a new switch, with explicit model selection, no transcripts or secrets in prompts, results recorded in the trace summary as metadata only, deterministic checks first, and its own network/cost policy. Nothing in this probe authorizes it.
- **Unchanged by this slice:** D2 v1, D4 v1, admission states, review behavior, current defaults, publication controls, and every production file. No `src/**` change was made.

## 6. Reproduce

```sh
bun run build
bun test test/contract/phase-c-generate.test.ts   # 6 pass, 0 fail, 67 expect() calls
bun run typecheck                                 # clean
git diff --check                                  # clean
bun test                                          # 899 pass, 1 skip, 0 fail, 6918 expect() calls
                                                  # (900 tests / 34 files; skip is the pre-existing cross-volume case)
```

This probe suite has no build dependency (it does not load `dist/index.js`). `bun run build` is a prerequisite only for the full suite, because the pre-existing Phase A contract file loads the built entrypoint.

The suite is measurement-only: it registers no production hook, changes no durable state outside its temp roots, and its assertions are pin-specific (beta-19507) — re-run it before relying on any claim here.

## 7. Limitations and unmeasured items

- Pin-specific: measured on macOS with bun 1.3.3 against pinned `@opencode/plugin`/`@opencode/sdk` `0.0.0-beta-19507`. Hook ordering, the built-in dynamic provider load, and error tags can change on another pin.
- Real provider generation with a configured model, default-model resolution (`generate.text({ prompt })` without a model), streaming, tool-capable models, concurrent calls, and usage/cost accounting were **not** exercised.
- No abort/timeout path could be measured because the declared input has no such control.
- The injected provider is a test-only override; it does not demonstrate that a production caller can obtain deterministic output from a real provider.
- Only the `{ text }` envelope and sessionlessness are stable claims; production output text itself is model-nondeterministic.
- The probe does not measure prompt-injection resistance, redaction, or retention: any future pilot must not place transcripts or secrets in prompts (unchanged plan constraint).
