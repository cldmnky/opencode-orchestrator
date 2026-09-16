# V4a — Redaction and Authority Threat Model

Status: **V4a implemented 2026-09-15** (canonical redactor, adversarial fixtures, this model).
**V4b — durable effective-authority snapshots — is explicitly deferred and not implemented.**

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
| `src/opencode-v2/orchestration/validation.ts` | `deps.redactFn ?? redact` | Serialized D2 handoff during C7 credential check (failure suppresses prose) | No (default pattern layer; tool accepts an injected `redact`) |
| `src/opencode-v2/peers/tools.ts` | `redactKnownPatterns` | Peer objective hint and bounded session/status/path fields | No |
| `src/opencode-v2/session/move.ts` | `redact` (V4a) | Target path, session/reported directories, and error messages in failure reasons | No (no secret input on this path) |

Verification surfaces pinning these claims: `test/unit/process.test.ts` (canonical API),
`test/unit/session-move.test.ts` (move-path behavior, including the no-exact-secret boundary),
`test/unit/orchestration-tools.test.ts` (C7), `test/unit/evidence.test.ts` (schema boundaries).

Known gap: the `secrets` deps exist on the GitHub/worktree tool declarations, but the plugin
wiring (`src/opencode-v2/plugin.ts`) passes none today, so production redaction is currently the
known-pattern layer only. Threading caller-known secrets is an available seam, not a wired
feature.

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
  gate tagged dispatches and install child-only deny rules, but it records no durable authority
  snapshot and is tool-action containment only. It is not evidence authentication.
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

## 10. V4b — deferred: durable effective-authority snapshots

V4b (effective authority = intersection of parent delegation, worker policy, and installed
session rules, recorded durably) is **not implemented**. Today:

- N2 containment rules exist only in opt-in enforce mode and are installed per child admission;
  no lifecycle install/clear around worktree enter/cleanup exists, and nothing computes the
  intersection.
- No snapshot schema, no durable `authority/v*` records, no retention/rotation policy, no CAS or
  append-only write semantics, and no admission integration exist.
- No enforcement decision anywhere consults a recorded authority value; admission and gates are
  unchanged by V4a.

Before V4b can be claimed, it needs its own slice with: an N2 rule lifecycle (install at
delegation/enter, clear at cleanup/exit) on the pinned host, a durable snapshot schema with
explicit unknown/missing states, replay-safe write semantics, and documented admission
integration. Even then, it would record host-enforced *tool-action* authority only — not
filesystem, process, or atomic child isolation.

## Related records

- `docs/orchestrator-improvements-plan.md` — V4/Phase C status and the V4b next step.
- `docs/phase-1/v3-capability-matrix.md` — evidence/authority vocabulary and admission.
- `docs/phase-1/assumptions.md` — A8 (redactor completeness) and adjacent assumptions.
