# Published package API

The package has four supported import surfaces:

| Import | Runtime | Types |
| --- | --- | --- |
| `opencode-v2-agent-orchestrator` | `dist/index.js` | `dist/index.d.ts` |
| `opencode-v2-agent-orchestrator/tui` | `dist/tui.js` | `dist/tui.d.ts` |
| `opencode-v2-agent-orchestrator/commands` | `dist/commands.js` | `dist/commands.d.ts` |
| `opencode-v2-agent-orchestrator/installer` | `dist/installer.js` | `dist/installer.d.ts` |

The root export is the V2 server plugin, option schema/types, and the small
versioned D2/D4/admission pure-contract surface. Command catalog and installer
helpers are intentionally subpath exports. Durable state helpers and other
implementation modules are not supported package API.

The server and installer bundles externalize direct package dependencies that
are installed with the package (`@opencode/plugin`, `zod`, and
`jsonc-parser`). The TUI continues to externalize host-provided OpenTUI and
Solid dependencies. `bun run test:package` packs the package, extracts it into
an isolated consumer, imports every subpath, loads the server plugin in an
embedded host, invokes the installer, and typechecks a small consumer against
the packed declarations.

## Bundle comparison

Measured with Bun 1.3.3 from the Phase 9 merge (`4c18920`) versus the Phase 10
build. Declaration files are additional package output and are not included in
the JavaScript byte counts.

| Entry | Before | Phase 10 | Change |
| --- | ---: | ---: | ---: |
| `dist/index.js` | 1,825,285 | 581,036 | -68.2% |
| `dist/tui.js` | 496,411 | 44,515 | -91.0% |
| `dist/commands.js` | 458,126 | 6,129 | -98.7% |
| `dist/installer.js` | 561,221 | 65,370 | -88.4% |
| `dist/cli/index.js` | 595,667 | 99,762 | -83.3% |

Correctness takes precedence over these measurements: the packed smoke test is
the acceptance check for dependency resolution.
