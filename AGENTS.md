# Repository Instructions

## OpenCode V2 Contract

- This repository targets OpenCode V2 only. Before changing plugin or API integration code, re-read the current [plugin guide](https://opencode.ai/v2/docs/build/plugins), [CLI plugin guide](https://opencode.ai/v2/docs/build/plugins/cli), and [HTTP API reference](https://opencode.ai/v2/docs/api); the API is beta/experimental and the README's "V2 Beta Boundary" is already stale.
- The repository is pinned to `@opencode-ai/plugin` `0.0.0-beta-18414` and `@opencode-ai/sdk` `0.0.0-dev-18560` for integration tests. Production code uses `Plugin.define` and the Promise plugin contract from the installed packages; do not mix package generations without updating the contract suite.
- The existing default export is a server plugin, not a terminal UI plugin. A V2 CLI plugin imports `@opencode-ai/plugin/tui` directly, is exported as `./tui`, and is auto-loaded from the main plugin only when that plugin sets `tui: true`.
- Put a CLI-only plugin in global `cli.json`, not project `opencode.json(c)`; this is the form that remains active when the TUI connects to a remote server. Add the OpenTUI/Solid peer dependencies only when rendering JSX.
- In a CLI plugin, use `context.client` for the connected server and `context.data.on`/`listen` for typed events. Return cleanup functions for subscriptions, slots, routes, renderers, and other owned resources.
- Treat `https://opencode.ai/v2/openapi.json` as the HTTP contract. For local inspection use `opencode2 api <method> <path>` so service discovery and authentication match the TUI; do not construct a separate unauthenticated localhost client.

## Layout

- `src/index.ts` is the published server-plugin entrypoint; `src/opencode-v2/plugin.ts` registers the agent and command transforms.
- `src/core/` owns option validation, role policy, and prompt generation. Keep it independent of CLI filesystem/process concerns.
- `src/cli/index.ts` is both the published installer CLI and the isolated development launcher; `src/cli/install.ts` mutates JSONC without overwriting existing agents or commands.
- Command data is intentionally split: names exist in both `src/core/config.ts` and `src/opencode-v2/commands/index.ts`, while descriptions and prompts live in `commands/index.ts` and `src/core/prompts.ts`. Update all of them when adding or renaming a command.
- `dev/project/opencode.example.jsonc` is the local harness template. `dev/project/opencode.jsonc` and all of `dev/state/` are generated and ignored.

## Commands

```sh
bun install
bun run typecheck
bun test
bun run build
```

- Run one test file with `bun test test/unit/core.test.ts` or `bun test test/unit/installer.test.ts`; focus a test by name with `bun test -t 'is idempotent'`.
- There is no configured lint or formatter command. Do not claim lint verification.
- Use `bun run dev:setup && bun run dev:v2` for an isolated `opencode2 --standalone` harness. It redirects XDG config/data/cache under `dev/state` and does not exercise global config or the shared service.

## Known Verification Traps

- `bun run dev:v2:dist` rewrites the generated config to `../../dist/index.js`; inspect `dev/project/opencode.jsonc` when verifying which entrypoint is loaded.
- `bun run build` emits the package's published bundle entrypoints under `dist/`; a successful build does not replace the packed-package smoke test.
- The plugin defaults to `strict_agents: true`; config-backed agents are materialized after external plugins during beta startup, so the complete dev template or installer is required for strict validation.
