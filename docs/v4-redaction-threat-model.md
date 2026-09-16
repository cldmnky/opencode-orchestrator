# V4a — Redaction and Authority Threat Model

Status: **V4a implemented 2026-09-15** (canonical redactor, adversarial fixtures, this model).
**V4b — durable effective-authority snapshots — implemented 2026-09-16** in the Phase C close
(opt-in `authority.mode: "enforce"` only; snapshots are records and never gate).
**N4 generation hints — implemented 2026-09-16** as an opt-in, default-off, metadata-only
post-step (`hints.mode: "advisory"`). All three remain under the limits recorded below.

This is a threat model for the plugin's redaction and evidence/authority surfaces, not a
compliance document. It states what the current code does, what it cannot do, and which claims
must not be made. It contains no process output, no user prompt text, and no credential-shaped
fixtures; every example is described by shape only.

## 1. Asset boundary

Assets in scope:

- **Caller-known secrets** threaded through tool dependencies (`secrets` on the GitHub and
  worktree tool deps), plus their URI-encoded forms.
- **Raw subprocess output** from the `git` and `gh` CLIs (stdout/stderr), including error text
  and JSON snippets.
- **Host-provided text** that can echo any of the above: session history excerpts, VCS status
  and diffs, session directories, error messages, peer goal objectives, D2 handoff payloads.
- **Model-generated hint text** from the opt-in generation post-step: parsed defensively,
  canonical-redactor-redacted, single-line bounded, and recorded only as a capped metadata field.

Out of scope as assets the plugin can protect:

- **Ambient credentials in the host environment.** `SpawnRunner` merges `process.env` and
  passes it to every child by default (`mergedEnv` in `src/opencode-v2/process/runner.ts`), so a
  spawned `gh`/`git` inherits the environment exactly as the host configured it. The plugin never
  reads or logs those values itself, but it cannot prevent a child process from printing them.
- **Host persistence.** Transcripts, event logs, and session metadata are host-owned; the
  plugin controls only the text it shapes and the storage keys it writes.
- **OS-level containment or isolation.** Redaction is not containment; see §10.

The trust boundary this model describes is narrow: **text the plugin shapes before returning it
to the model or writing it to plugin storage**. Redaction reduces accidental echo inside that
text. It is not a secret boundary, a sandbox, or an authentication mechanism.

## 2. Canonical redactor and current consumers

`src/opencode-v2/process/redact.ts` is the single implementation. V4a removed the duplicate
private redactor that previously lived in `src/opencode-v2/session/move.ts`; that file now
imports the canonical `redact`.

| Consumer | API used | Text it redacts | Exact-secret channel |
|---|---|---|---|
| `src/opencode-v2/commands/runtime.ts` | `redact` | Handover summary: focus text, last session-history excerpt, VCS status lines, working diff, error messages | No (pattern layer only) |
| `src/opencode-v2/gh/tools.ts` | `createRedactor(deps.secrets)` | Binds the redactor into `GhContext` for all `gh` results | Yes (deps `secrets`, currently unwired) |
| `src/opencode-v2/gh/client.ts` | bound redactor; `redact` fallback | Raw `gh` stdout/stderr after every run, JSON error snippets, GraphQL error text, `GhError` fields | Via bound redactor |
| `src/opencode-v2/worktree/tools.ts` | `createRedactor(deps.secrets)` | Binds the redactor into `GitContext` | Yes (deps `secrets`, currently unwired) |
| `src/opencode-v2/worktree/git.ts` | `ctx.redact` in `run()` | Every `git` invocation's stdout/stderr before any caller sees the result | Via bound redactor |
| `src/opencode-v2/orchestration/validation.ts` | `deps.redactFn ?? redact` | Serialized D2 handoff during C7 credential check (failure suppresses prose); generated hint text in the opt-in N4 post-step before it is bounded into a hint record | No (default pattern layer; tool accepts an injected `redact`) |
| `src/opencode-v2/peers/tools.ts` | `redactKnownPatterns` | Peer objective hint and bounded session/status/path fields | No |
| `src/opencode-v2/session/move.ts` | `redact` (V4a) | Target path, session/reported directories, and error messages in failure reasons | No (no secret input on this path) |

Verification surfaces pinning these claims: `test/unit/process.test.ts` (canonical API, including
the hint-path shape and no-secret control), `test/unit/session-move.test.ts` (move-path behavior,
including the no-exact-secret boundary), `test/unit/orchestration-tools.test.ts` (C7 and the hint
post-step), `test/unit/evidence.test.ts` (schema boundaries plus the hints/snapshots-are-not-evidence
pins).

Known gap: the `secrets` deps exist on the GitHub/worktree tool declarations, but the plugin
wiring (`src/opencode-v2/plugin.ts`) passes none today, so production redaction is currently the
known-pattern layer only. Threading caller-known secrets is an available seam, not a wired
feature; the N4 hint post-step reuses the same seam (`redact` on the orchestration tool deps) and
threads no secrets of its own.

## 3. Raw process-output entry paths

1. **`SpawnRunner.run` (`src/opencode-v2/process/runner.ts`)** is the only spawn site for `git`
   and `gh`: `shell: false`, per-stream 1 MiB cap with a truncation marker, 30 s default timeout,
   inherited environment. It returns **raw** stdout/stderr by design; redaction is layered by
   consumers.
2. **`git.ts run()`** redacts both streams through the bound `GitContext.redact` before returning
   them, so a failed `git worktree add` raises already-redacted output text.
3. **`gh/client.ts run()`** applies the bound redactor to stdout/stderr; `requireZero` builds the
   `GhError` message from the redacted copies, and `parseJson`/GraphQL error paths redact snippets
   before raising.
4. **`session/move.ts`** spawns nothing; it redacts error messages and target/directory strings
   that come from the injected session/storage or the host API.
5. **`commands/runtime.ts`** redacts host-provided strings (session context, VCS status/diff) —
   these are not subprocess output, but they can echo one.

Boundary notes:

- `ProcessTimeoutError` carries raw `stdout`/`stderr` as fields on the error object; the message
  itself contains only the command name and args. Current consumers surface errors via
  `error.message` (for example `message()` in the worktree/gh tools), so those fields stay
  in-process. Any future consumer that serializes the full error object must redact first.
- The 1 MiB truncation cap means bytes beyond the cap never reach any redactor. A secret that
  straddles the boundary can appear as a partial token; a complete secret beyond the cap is
  never inspected at all.
- The environment inheritance in item 1 is the largest structural gap: a child that prints its
  environment produces credential-like text that only the known-pattern layer can catch.

## 4. Two layers: known patterns vs caller-known exact secrets

**Layer 1 — known patterns (`redactKnownPatterns`).** Ordered replacements intended to keep
structure readable: keyed `key: value` / `key=value` credential pairs (key preserved), credential
URL query parameters (parameter name preserved), GitHub token prefixes, GitHub PAT prefix, Slack
token prefixes, and `Bearer`-style tokens. This layer is a heuristic; see §8. It runs first and
alone whenever no secret list is supplied.

**Layer 2 — caller-known exact secrets (`redactExact`).** Plain split/join replacement of each
supplied secret plus its single-pass `encodeURIComponent` form (so a token echoed inside a URL is
caught). Empty entries are skipped; matching is case-sensitive and literal, so no regex escaping
is needed. `redact(text, secrets)` composes both layers; `createRedactor(secrets)` binds a fixed
set; `redactProcessResult(result, secrets)` returns a copy with both streams redacted and the
exit code/truncation flag preserved.

The exact layer is only as good as what the caller knows and threads. It catches unknown token
formats **when threaded**, and it catches nothing when the secret list is empty — which is the
current production wiring for every consumer. `session/move.ts` has no secret input at all;
`test/unit/session-move.test.ts` pins that limitation explicitly.

## 5. Data never stored

The redaction consumers never write the following to plugin storage:

- Raw `git`/`gh` stdout/stderr (returned redacted; `GhError` fields are redacted copies).
- Session-history excerpts, diffs, or handover summaries (emitted as transient status text only).
- Tokens, authorization headers, environment secrets, or OAuth credentials (never read by the
  plugin, never written).
- Evidence records: `src/opencode-v2/orchestration/evidence.ts` shapes **metadata only**
  (marker, freshness, authority, version, source, optional sessionID, capturedAt, optional
  mutation proof) and is attached to successful tool results; evidence is returned to the model,
  not persisted.
- Generation-hint records (opt-in `hints.mode: "advisory"`; schema in
  `observability/trace.ts`): bounded metadata only — status, a fixed reason enum, level/verdict,
  check count, a `providerID/id` model label, prompt/output character counts, redaction and
  truncation flags, duration, capture time, and an optional single-line hint that has been passed
  through the canonical redactor and capped at 280 characters. Raw model output, the prompt text,
  provider error text, and credentials are never recorded. The record is attached to the
  `handoff_validate` result; the plugin does not persist it.
- Authority snapshots (`authority/state.ts`, keyed `authority/v1/<project>/<session>`): session
  and parent session IDs, the configured role agent ID, a capture timestamp, mode/rule-scope
  literals, per-action effect enums for family-wide (`resource: "*"`) tool-action rules, and the
  explicit unknown-dimension list. They store rule **effects**, not rule resources, prompts,
  transcripts, tool payloads, error text, or credentials.
- Session-move durable state (`session/state.ts`, `worktree/state.ts`) stores session IDs,
  project IDs, directory paths, workspace IDs, subpaths, statuses, and timestamps. It stores no
  error text or process output. Directory strings are stored as supplied; the failure-reason
  redactor does not mutate stored state.

Honest caveats: the **host** may persist transcripts or event metadata containing plugin output;
the plugin cannot audit or erase that. Mutation proof records contain a GitHub `id`/`number`/`url`
— intentionally durable identifiers, not secrets.

## 6. Transient evidence and authority limitations

- Evidence is **transient**: it is returned on the current tool result and is not stored, replayed,
  or compared across invocations. `assessEvidence` is the single admission gate, but it is
  caller-invoked — no hook routes evidence through it automatically, and no completion gate
  depends on it.
- Authority labels (`authoritative-for-tested-fields`, `advisory`, `documented-pinned`,
  `documented-live`, `declared-absent`) are **producer-declared enum metadata**. They are
  validated for vocabulary, not authenticated against a live source.
- In D2 validation, O6 blocks URL evidence claims (authority/freshness cannot be authenticated
  from string refs) and never treats marker text as proof; typed `EvidenceRecord` input is not
  accepted by `orchestrator_handoff_validate`. Local evidence file refs prove existence only —
  not freshness or authorship.
- The Phase A runtime authority surface (opt-in `authority.mode: "enforce"`, default `off`) can
  gate tagged dispatches and install child-only deny rules. The Phase C close adds durable
  effective-authority snapshots under `authority/v1/<project>/<session>`: parent rules, the
  plugin's static worker policy, the child's installed rules, and their per-action intersection
  with explicit unknown states, written after rule install during the child's own admission and
  cleared when the enforcing runtime exits. Snapshots are **records, never decisions** — no
  admission, permission, gate, review, or publication path reads them — and they remain
  tool-action containment metadata only. They are not evidence authentication, not provenance,
  and not filesystem, process, worktree, or atomic child isolation.
- The durable publication capability record (`publish/v1`) is authorization policy for the
  orchestrator, not per-operation provenance; there is no durable GitHub operation ledger.

## 7. Peer-hint limitation

`orchestrator_peer_list` returns bounded metadata for sessions in the same stable project:
session ID, goal status, and a redacted/truncated objective hint. Specific limits:

- The objective hint is the **only** objective-derived text that leaves the query; it is collapsed
  to one line, known-pattern-redacted, and truncated to a fixed length with an ellipsis.
- Redaction at this boundary uses `redactKnownPatterns` only: there is no caller-known exact-secret
  channel, so an unknown-format secret present in a goal objective could survive into the hint.
- Records of other projects are never read; sessions without a readable goal record do not appear;
  the scan is bounded and reports `complete: false` truthfully when storage scanning is
  unavailable or the cap is hit.
- Peer discovery is metadata only (no messaging) and is not a provenance or authority signal.

## 8. Regex limitation (A8)

**Pattern coverage is not a secret boundary.** Known-pattern redaction is deliberately
best-effort and can be evaded by, among others:

- token formats the patterns do not enumerate (custom schemes, opaque secrets, bare JWT bodies
  without a `Bearer` prefix, basic-auth payloads);
- secrets split by whitespace, newlines, punctuation, encoding other than URI (base64,
  double-encoding), or Unicode tricks;
- secrets that never appear in text the plugin shapes (host logs, files, other processes);
- output beyond the 1 MiB stream cap, or a token cut by truncation;
- secrets known only to the caller when no secret list is threaded.

The V4a fixtures prove the canonical API behaves correctly on the hostile **safe** fixtures it
documents; they do not prove completeness. No entropy heuristic, decoder, or ML classifier is
used. Treat every redaction claim as "reduces known-shape echo", never as "no secret can leak".

## 9. V4a scope — delivered

- `src/opencode-v2/session/move.ts` imports the canonical `redact`; the duplicate private
  implementation is deleted. The replacement is not an unconditional strict superset: canonical
  coverage is broader for documented credential shapes (GitHub/Slack/PAT/Bearer formats,
  credential query parameters, and more keyed names), and keyed output now uses the canonical
  `key: [redacted]` form; but whole-word matching intentionally stops matching credential
  keywords embedded in longer identifiers (for example `session_token` or `my_secret`), which the
  prior boundary-less helper caught incidentally. Pattern redaction remains a heuristic (§8), not
  a secret boundary; the move path threads no exact secrets (see §4).
- Adversarial fixtures for the public redactor API: encoded exact secrets, query-like text,
  multiline mixed output, substring preservation, empty secret lists, and
  `redactProcessResult`.
- Direct session-move tests: GitHub-token-shaped and Bearer-shaped fixtures, plus an explicit
  test pinning the absence of an exact-secret channel on the move path.
- D2 C7 cases: safe GitHub-token-shaped and Bearer-shaped fixtures fail closed with no echo, and a
  no-secret control passes with prose rendered.
- Evidence schema tests only for enforced boundaries (non-empty `source`/`sessionID`, integer
  `capturedAt`), plus a test documenting that **no** credential-shape rejection exists on
  `source`. Evidence was never claimed to be a redaction boundary, and now that claim is pinned.
- Unchanged: option defaults, D2 v1 fields, admission vocabulary, review semantics, publication
  preconditions and gates, handoff validation semantics outside C7's now-canonical redactor.

V4a does **not** record authority, persist evidence, add options, add tools, add trace fields, or
change session rules.

## 10. V4b — implemented (Phase C close, 2026-09-16)

V4b (effective authority = the intersection of parent rules, worker policy, and installed session
rules, recorded durably) is implemented as a Phase C close slice. Exact semantics:

- **Schema and key.** One strict version-1 record per configured-role child session under
  `authority/v1/<project>/<session>` (`src/opencode-v2/authority/state.ts`). The record carries
  `sessionID`, optional `parentSessionID`, `roleAgent`, `capturedAt`, `authorityMode: "enforce"`,
  `ruleScope: "family-wide"`, one entry per tracked tool-action family (the eight containment
  actions), and an explicit `unknownDimensions` list.
- **Dimensions and intersection.** Each entry records `parent` (the delegating parent's
  family-wide rules as observed at snapshot time), `worker-policy` (the plugin's static
  containment denies for configured-role children), `installed` (the child's own rules read back
  after install), and `effective` (the strictest of the three: `unknown` if any dimension is
  unknown, else `deny` > `ask` > `allow` > `unconstrained`). Only `resource: "*"` rules
  participate; scoped-resource rules are outside the record.
- **Lifecycle.** The record is written during the child's own prompt admission, after the N2
  containment rules are ensured, under the existing process-local `withSessionLock`. Recording is
  best-effort and **never** changes the admission decision; a failed read, build, or write is
  logged and admission proceeds. On runtime disposal (plugin teardown) every snapshot the runtime
  had recorded by disposal time is cleared under the same lock, so no recorded authority outlives
  the process that enforced it. Install/clear is deliberately **not** tied to worktree
  enter/cleanup in this slice; an absent or cleared record is `unknown`, never inferred.
- **Read surface.** `orchestrator_authority_get` (registered only in enforce mode, orchestrator
  role only, reusing the read-only `orchestrator_observability` permission action so no installer
  or agent-transform rule changes) returns the record or an explicit `unknown` with
  `missing`/`malformed`/`unreadable` reasons, plus the plain limits. It never writes.
- **No admission integration.** Snapshots are records, not decisions: no admission, permission,
  gate, review, or publication path reads them. That is a deliberate boundary of this slice, not
  an omission to be "fixed" later without its own evidence and authorization.
- **Stay honest about strength.** A snapshot records host-enforced *tool-action* authority only.
  It is **not** filesystem, process, worktree, or atomic child isolation; parallel children still
  share the parent filesystem. Storage is one current record per session with a process-local
  lock only — no CAS, transaction, retention, or cross-process guarantee.

Verification surfaces pinning these claims: `test/unit/authority.test.ts` (schema/key,
last-match-wins family effects, intersection strictness, unknown/malformed/unreadable reads,
recording after rule install, best-effort failure, clear-on-dispose, tool registration and role
rejection) and `test/unit/evidence.test.ts` (snapshots are not EvidenceRecords and evidence never
parses as a snapshot).

## 11. Generation hints — N4 pilot (Phase C close, 2026-09-16)

The N4 sessionless-generation post-step is now wired as an opt-in, **default-off** advisory
metadata record:

- **Opt-in only.** `hints: { mode: "off" | "advisory", model?: { providerID, id } }`; default
  `{ mode: "off" }`. `advisory` requires an explicit model reference (the plugin never resolves a
  host default), and with hints off `handoff_validate` output is byte-identical and no generation
  call is made.
- **Deterministic first.** The generation call runs only when the deterministic D2 checks already
  returned `pass`; a failing or blocked receipt produces a bounded `skipped` record and no call.
- **Prompt content.** The prompt is built from check ids and verdicts only
  (`<check-id>=<verdict>` lines plus fixed instruction text). Check details — which can contain
  command strings or paths — are never included, and no session text, transcript, secret, URL, or
  payload is placed in the prompt. The prompt is hard-capped at 1200 characters (over-cap prompts
  are skipped, never truncated).
- **Output handling.** The `{ text }` envelope is parsed defensively (exact shape, single-line
  normalization, control-character collapse), hard-capped at 600 characters, passed through the
  canonical credential redactor, and bounded to a 280-character single-line advisory string. The
  record's reason vocabulary is a fixed enum, so provider error text, URLs, and payload echoes
  cannot be recorded.
- **Bounding.** The declared surface has **no abort/timeout control**; the post-step therefore
  races the call against a 2 s external timeout. A timeout abandons the wait — it cannot cancel
  the underlying generation, and the record says `timed-out`.
- **No gating.** The hint record never changes the validator verdict, admission state, checks,
  prose, a gate, or any other decision. It is trace-shaped bounded metadata (schema in
  `observability/trace.ts`) attached to the `handoff_validate` result; the plugin does not write
  it into the session trace summary and does not persist it.
- **No secret channel of its own.** Caller-known exact secrets are threaded only through the
  already-injected redactor seam (`redact` on the orchestration tool deps); the production wiring
  threads none, so the pattern layer is the only production redaction. The hint record is not
  evidence, not authority, and not a review artifact.
- **Unmeasured envelope.** No real provider call (network, credentials, cost, latency,
  nondeterminism) is measured by this slice; the new tests use deterministic fakes only. The
  production operating envelope of the generation surface remains as unmeasured as the N4
  decision record states.

## Related records

- `docs/orchestrator-improvements-plan.md` — V4/Phase C status and the evidence ledger.
- `docs/phase-1/n4-sessionless-generate-compatibility.md` — the N4 measured surface and its
  pilot-only decision (unchanged by this slice).
- `docs/phase-1/v3-capability-matrix.md` — evidence/authority vocabulary and admission.
- `docs/phase-1/assumptions.md` — A8 (redactor completeness) and adjacent assumptions.
