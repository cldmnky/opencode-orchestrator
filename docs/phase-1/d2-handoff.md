# D2 versioned structured handoff — draft schema, runtime mirror, and compatibility notes

> Status: **design draft (issue #8) + implemented runtime contract (issue #10).**
> Plan item D2. Design deliverables: `d2-handoff.schema.json` (Draft 2020-12 JSON Schema,
> version `1`), `d2-handoff.example.json` (validating illustrative example), and this document.
> Issue #10 implements the contract as a **strict runtime mirror plus prompt/tool integration**:
> `src/core/contracts.ts` (Zod mirror, deterministic parse, semantic validation, safety helpers,
> five-heading renderer), `orchestrator_handoff_validate` (`src/opencode-v2/orchestration/validation.ts`),
> and the prompt guidance in `src/core/policy.ts` (`STRUCTURED_HANDOFF_GUIDANCE`) with tests in
> `test/unit/contracts.test.ts` and `test/unit/orchestration-tools.test.ts`. The five-field prose
> `HANDOFF_FORMAT` still governs every worker's prose handoff. The validator is **callable, not
> automatic**: no hook intercepts child output, and no completion gate is enforced.

## 1. The current five-field prose handoff

`src/core/policy.ts` defines `HANDOFF_FORMAT` (lines 19–25) as plain text:

| Field | Prose contract |
| --- | --- |
| Outcome | what was achieved or discovered |
| Files | files read or changed, with scope |
| Verification | commands run and their results |
| Risks | known uncertainty or regression risk |
| Follow-up | the next concrete action |

`orchestrationRules()` embeds the constant verbatim into generated prompts
(`src/core/policy.ts:114`, `src/core/prompts.ts:28`). Since issue #10, prompt generation also asks
workers for the version-1 structured envelope **in addition to** this prose
(`STRUCTURED_HANDOFF_GUIDANCE`, `src/core/policy.ts:82-89`), and the parent is told to call
`orchestrator_handoff_validate` before using a handoff downstream — an explicit tool call, not an
automatic gate.

## 2. Mapping five-field prose → structured envelope

| Prose field | Structured field(s) | Notes |
| --- | --- | --- |
| Outcome | `outcome` | Same content, now a single validated string (1–8000 chars). |
| Files | `filesRead[]`, `filesChanged[]` | Split by direction; each entry is `{ path, scope }` with a relative repository path and a scope string. |
| Verification | `verification[]` | Each entry is `{ command, status, result, evidence? }`. Statuses `not-run`, `blocked`, `fail`, `pass` allow honest reports, including skipped checks on docs-only changes. |
| Risks | `risks[]` | Each entry is `{ severity, statement }` with severity `low`/`medium`/`high`/`critical`. |
| Follow-up | `followUp` | Same content, validated string (1–4000 chars). |

Rendering the envelope back to the five-field prose is lossless for those five
fields; see §4. The implemented renderer (`renderD2Handoff`,
`src/core/contracts.ts`) reproduces exactly the five headings `Outcome`, `Files`,
`Verification`, `Risks`, `Follow-up` and preserves the read/changed distinction,
per-file scope, command/status/result, and risk severity.

## 3. Added fields and why

The D2 proposal adds fields the prose format cannot express unambiguously:

- `version` — envelope schema version, constrained to `1` by the schema. Any
  incompatible change must bump the version and document migration.
- `taskId` — stable identifier that correlates the handoff across parent/child
  hops and repeated runs.
- `status` — lifecycle state (`in-progress`, `blocked`, `completed`, `failed`).
  `completed` may legitimately coexist with `not-run` verification entries when
  those checks do not apply to the delivered change.
- `facts[]` — established facts, each with a `statement` and **at least one**
  evidence reference (`minItems: 1`), so claims carry pointers instead of prose
  assertions.
- `assumptions[]` — explicitly labeled assumptions with `id`, `statement`, and
  status `Verified` / `Partially verified` / `Unverified` / `Not supported`.
  Evidence may be empty while an assumption is `Unverified` — that emptiness is
  the honest state. This implements the orchestration rule "label every
  assumption explicitly and verify it before relying on it."
- `artifactRefs[]` — path-safe references to stored artifacts instead of raw
  transcripts: `kind: "file"` must reference a relative repository path; `kind:
  "url"` must reference an `https` URL.
- `reviewState` — review workflow state: `not-requested`, `pending`, `approved`,
  `changes-requested`, `blocked`.

## 4. Human-readable rendering

The structured envelope renders to the existing five-field prose with a small
template, plus optional §3 extras:

```
Outcome: <outcome>
Files: read <filesRead paths>; changed <filesChanged paths>
Verification:
  - pass    <command>: <result>
  - not-run <command>: <result>
Risks:
  - <severity>: <statement>
Follow-up: <followUp>
```

The mapping in §2 guarantees the five prose fields survive a
structured → prose round trip. Rendering is implemented as a one-way function
(`renderD2Handoff`, `src/core/contracts.ts`); prose → structured is **not**
supported: the runtime mirror validates and renders envelopes but never parses
prose back into structured form.

## 5. Schema notes (Draft 2020-12)

- `$schema` is `https://json-schema.org/draft/2020-12/schema`; definitions live
  under `$defs` and are referenced as `#/$defs/...`.
- The envelope and **every object definition** set `additionalProperties: false`
  — unknown fields are validation errors, which is deliberate strictness (see §6
  for the evolution trade-off).
- Path safety: `fileRef.path` and `artifactRef` references of kind `file` share
  one definition (`$defs/relativeRepoPath`): **relative repository paths** — no
  leading `/`, no `.` or `..` path segments, no `://` scheme prefix, no quotes or
  control characters. Names with spaces or dots (e.g. `opencode.example.jsonc`)
  are allowed, so valid repo paths are not rejected. Kind `url` references must
  match `^https://` (no `http://`, no whitespace) via `if`/`then` applicators on
  the `artifactRef` definition.
- Evidence references are either relative repository paths with an optional
  `#anchor` (e.g. `src/core/policy.ts#L19-25`) or `https` URLs; any string
  containing `://` must be an `https` URL, so `http://...` cannot sneak in as a
  path-shaped string.
- Length caps are generous (paths ≤ 1024, refs ≤ 2048, statements/risks ≤ 2000,
  results ≤ 4000, outcome ≤ 8000) and never reject plausible paths or URLs.

## 6. Compatibility and evolution

- **Information preservation:** every datum required by the five-field handoff
  has a validated home in the envelope. The implemented runtime emits the
  five-heading prose from the structured envelope with `renderD2Handoff`
  (`src/core/contracts.ts`) and asks workers for the envelope via
  `STRUCTURED_HANDOFF_GUIDANCE` (`src/core/policy.ts:82-89`).
- **Strictness trade-off:** `additionalProperties: false` means adding fields in
  a later draft is a breaking change for writers and readers alike. The draft
  accepts that cost because the whole point of D2 is that downstream agents can
  rely on validated structure; migration is handled by bumping `version`. The
  runtime mirror is equally strict: the Zod schemas reject unknown fields at
  every object depth and fail closed (deterministic issue paths).
- **Neither schema draft nor example is byte-lineage of the prose contract**: the
  prose constant remains the operative contract today, and this contract does not
  promise that existing prose handoffs parse into envelopes (prose → structured
  is not supported).

## 7. Verification performed on this draft (issue #8, historical)

> This section records the **issue #8 draft verification** with the original
> ephemeral scratch approach, preserved for history. The maintained in-repo
> runtime verification and tests are in §9 below.

The example was checked with an ephemeral Bun script (kept outside the repo):

1. `JSON.parse` of the schema and example — both are well-formed JSON.
2. A minimal deterministic validator implementing exactly the keyword subset the
   schema uses (`type`, `const`, `enum`, `required`, `additionalProperties`,
   `properties`, `items`, `minItems`, `minLength`, `maxLength`, `pattern`,
   `$ref`, `allOf`, `if`/`then`) validated the example with zero errors and
   rejected twelve targeted negative mutations (wrong `version`, extra top-level
   property, empty fact evidence, invalid assumption status, invalid
   verification status, absolute and `..` paths, `http://` artifact URL,
   missing risk severity, invalid `reviewState`, …).
3. An independent Zod model of the envelope parsed the example successfully.
4. Keyword coverage of the schema was checked against the published Draft
   2020-12 metaschema (fetched at validation time; if offline, a hardcoded
   keyword list was used — see `Risks`).

**Limitation, stated honestly:** steps 2–4 are a scratch validator, not a full
Draft 2020-12 implementation (no `format`, `unevaluatedProperties`,
`prefixItems`, `$dynamicRef`, …). Full metaschema compliance of the schema
document itself was asserted by keyword coverage rather than by running the
official metaschema against it. No lint or formatter is configured in this
repository, so no lint claim is made. At the time of issue #8, `bun run
typecheck && bun test && bun run build` was intentionally **not** run because
that phase changed no runtime code; the example records that decision as a
`not-run` verification entry.

## 8. Runtime adoption boundary (issue #10)

The D2 contract is now implemented as a **strict runtime mirror plus prompt/tool
integration** — and the boundaries of that adoption are explicit:

- **Prompt integration:** workers are asked to emit the version-1 JSON envelope
  in addition to the unchanged five-field prose, and the parent is told to call
  `orchestrator_handoff_validate` before using a handoff downstream
  (`STRUCTURED_HANDOFF_GUIDANCE`, `src/core/policy.ts:82-89`; context hook text
  in `src/opencode-v2/plugin.ts:97`).
- **Callable tool, not an automatic gate:** the validator runs **only when the
  orchestrator invokes it**. No plugin hook intercepts worker output, nothing
  routes worker output through `parseD2Handoff`/`validateHandoff` automatically,
  and no completion gate is enforced (`src/opencode-v2/orchestration/validation.ts`).
- **The validator never runs a shell** and can never re-run a required command
  itself; at orchestrator level, contracts that name required commands
  deterministically produce `blocked-unknown` (O3 `checkRerun`) until the parent
  independently re-runs them with its own tools. URL evidence refs likewise
  always block at orchestrator level (O6 `checkAuthority`) because typed
  `EvidenceRecord` input is not accepted in this version.
- **One-way rendering:** `renderD2Handoff` renders structured → the five-heading
  prose; prose → structured is not supported.
- **Schema strictness preserved in code:** the runtime Zod mirror
  (`src/core/contracts.ts`) mirrors the Draft 2020-12 schema verbatim
  (`D2_HANDOFF_SCHEMA`, `D2_REQUIRED_KEYS`, length caps, regexes, enums,
  `additionalProperties: false` at every object depth) and is the single
  structural authority the validation tool uses. The JSON schema file itself is a
  **contract/reference document** — it is not loaded or interpreted by the plugin
  at runtime.
- **Not changed by this adoption:** the plan's "at least 40% token reduction"
  figure remains an unverified external claim; real worker handoffs are not
  guaranteed to be emitted as envelopes (the model is asked, not forced); and
  nothing here claims runtime enforcement, persistence, or exactly-once behavior.

## 9. Runtime verification (issue #10)

The maintained in-repo runtime mirror supersedes the §7 scratch checker for
structural validation:

1. `test/unit/contracts.test.ts` validates the example through
   `parseD2Handoff`/`D2_HANDOFF_SCHEMA`, rejects unknown/unsafe data with
   deterministic issue paths (including per-key `unrecognized_keys` issues),
   tests the safety helpers (`isSafeRelativeRepoPath`,
   `isSafeEvidenceRef`), semantic validation (`validateD2Semantics` —
   assumption-evidence, review-state self-declared warning, pass-without-evidence
   warning), and the five-heading renderer (`renderD2Handoff`).
2. `test/unit/orchestration-tools.test.ts` covers `orchestrator_handoff_validate`
   at both levels with injected deterministic dependencies (session location,
   VCS status, path existence, realpath, redaction).
3. Parent-verified repository checks (see the [phase-1 README §6](./README.md)): `bun run typecheck`
   passed; the full `bun test` suite **456 pass / 1 skip / 0 fail** (457 tests across 18 files;
   the skip is the pre-existing cross-volume platform case — the D2 `contracts` and
   `orchestration-tools` tests are part of it and pass); `bun run build` passed all five bundles;
   the packed `dist/index.js` import exposed and executed the D2 runtime exports. This is **not** a
   claim of a shared-service live plugin load (the probe was inconclusive and the service was not
   restarted). The final independent aggregate review passed with no blocking or major findings.
