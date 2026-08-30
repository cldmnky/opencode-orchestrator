# D2 versioned structured handoff — draft schema, example, and compatibility notes

> Status: **design-only draft** for issue #8 (plan item D2).
> Deliverables: `d2-handoff.schema.json` (Draft 2020-12 JSON Schema, version `1`),
> `d2-handoff.example.json` (validating illustrative example), and this document.
> **No runtime adoption is claimed or implied.** `src/core/policy.ts` and
> `src/core/prompts.ts` are unchanged; `HANDOFF_FORMAT` still governs generated
> prompts; and no parser, renderer, or prompt integration consumes these files.

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
(`src/core/policy.ts:94`, `src/core/prompts.ts:28`). There is no structured
handoff parser or runtime gate in `src/`; the field exists purely as prompt
text.

## 2. Mapping five-field prose → structured envelope

| Prose field | Structured field(s) | Notes |
| --- | --- | --- |
| Outcome | `outcome` | Same content, now a single validated string (1–8000 chars). |
| Files | `filesRead[]`, `filesChanged[]` | Split by direction; each entry is `{ path, scope }` with a relative repository path and a scope string. |
| Verification | `verification[]` | Each entry is `{ command, status, result, evidence? }`. Statuses `not-run`, `blocked`, `fail`, `pass` allow honest reports, including skipped checks on docs-only changes. |
| Risks | `risks[]` | Each entry is `{ severity, statement }` with severity `low`/`medium`/`high`/`critical`. |
| Follow-up | `followUp` | Same content, validated string (1–4000 chars). |

Rendering the envelope back to the five-field prose is lossless for those five
fields; see §4.

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
structured → prose round trip. Rendering is a presentation concern only: this
draft defines the data contract, not a renderer.

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
  has a validated home in the envelope, so a future runtime could emit both the
  structured envelope and the prose rendering from one source.
- **Strictness trade-off:** `additionalProperties: false` means adding fields in
  a later draft is a breaking change for writers and readers alike. The draft
  accepts that cost because the whole point of D2 is that downstream agents can
  rely on validated structure; migration is handled by bumping `version`.
- **Neither schema draft nor example is byte-lineage of the prose contract**: the
  prose constant remains the operative contract today, and this draft does not
  promise that existing prose handoffs parse into envelopes.

## 7. Verification performed on this draft

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
repository, so no lint claim is made. `bun run typecheck && bun test && bun run
build` was intentionally **not** run: this task changes no runtime code, and the
example records that decision as a `not-run` verification entry.

## 8. No runtime adoption

This is a design-only deliverable. It does not:

- change `src/core/policy.ts` or `src/core/prompts.ts`, or any other source file;
- introduce a parser, validator call site, or prompt integration;
- claim that real worker handoffs are (or will be) emitted as envelopes;
- repeat the plan's "at least 40% token reduction" figure as a measured result —
  that claim is unverified and external (see the example's `Not supported`
  assumption).

The next concrete action if this draft is accepted: implement a runtime contract
module (candidate `src/core/contracts.ts`) and emit the envelope from prompt
generation while keeping the five-field prose rendering.