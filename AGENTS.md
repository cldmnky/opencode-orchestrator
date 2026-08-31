# Repository Instructions

## OpenCode V2 Contract

- This repository targets OpenCode V2 only. Before changing plugin or API integration code, re-read the current [plugin guide](https://opencode.ai/v2/docs/build/plugins), [CLI plugin guide](https://opencode.ai/v2/docs/build/plugins/cli), and [HTTP API reference](https://opencode.ai/v2/docs/api); the API is beta/experimental and the README's "V2 Boundary" section is already stale.
- The repository is pinned to `@opencode-ai/plugin` `0.0.0-beta-18684` and `@opencode-ai/sdk` `0.0.0-dev-18683` for integration tests. Production code uses `Plugin.define` and the Promise plugin contract from the installed packages; do not mix package generations without updating the contract suite.
- The existing default export is a server plugin, not a terminal UI plugin. A V2 CLI plugin imports `@opencode-ai/plugin/tui` directly, is exported as `./tui`, and is auto-loaded from the main plugin only when that plugin sets `tui: true`.
- Put a CLI-only plugin in global `cli.json`, not project `opencode.json(c)`; this is the form that remains active when the TUI connects to a remote server. Add the OpenTUI/Solid peer dependencies only when rendering JSX.
- In a CLI plugin, use `context.client` for the connected server and `context.data.on`/`listen` for typed events. Return cleanup functions for subscriptions, slots, routes, renderers, and other owned resources.
- Treat `https://opencode.ai/v2/openapi.json` as the HTTP contract. For local inspection use `opencode2 api <method> <path>` so service discovery and authentication match the TUI; do not construct a separate unauthenticated localhost client.
- The GitHub (via `gh`) and git worktree tool families are orchestrator-only and disabled by default (`github.enabled`, `worktree.enabled`). `src/cli/doctor.ts` adds advisory local runtime checks (git/gh presence, `gh auth status` exit-code-only, read-only `gh repo view`, `git worktree list --porcelain`); they never fail the report, never print `gh` output, and the server-side `orchestrator_github_capabilities` probe is authoritative for live session PATH/auth/permissions.

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

- Run one test file with `bun test test/unit/core.test.ts` or `bun test test/unit/installer.test.ts`; focus a test by name with `bun test -t 'is idempotent'`. `test/unit/installer.test.ts` also covers `doctor`'s runtime checks with an injected fake runner — tests never invoke live git/gh.
- There is no configured lint or formatter command. Do not claim lint verification.
- Use `bun run dev:setup && bun run dev:v2` for an isolated `opencode2 --standalone` harness. It redirects XDG config/data/cache under `dev/state` and does not exercise global config or the shared service.

## Live Reload (repo root)

- There is no repo-level `opencode.jsonc`; the global config (`~/.config/opencode/opencode.json`, nix-managed from `~/.config/nix/dotfiles/opencode/opencode.json`) is the single source of truth and loads the plugin from this repo's `src` directory. Saving `src/**` still triggers the server's file watcher — no restart for most changes. Watch `~/.local/share/opencode/log/opencode.log` for `loading plugin .../src/index.ts` and `agent.updated`/`command.updated`. Plugin option changes go through the nix dotfiles plus `darwin-rebuild switch` and need a service restart.
- If `/orchestrate`/`/goal` disappear in the TUI, restart the shared service and reopen from the repo: `opencode2 service restart` then `cd repo && opencode2`. Verify with `opencode2 api get /api/plugin | jq -r '.data // . | .[].id'` and `bun run src/cli/index.ts doctor`.
- Do not set `OPENCODE_CONFIG` in normal dev; it overrides discovery.

## Ship

- Verify first: `bun run typecheck && bun test && bun run build`. `build` emits `dist/index.js`, `dist/tui.js`, `dist/commands.js`, `dist/installer.js`, `dist/cli/index.js`; `dist/` is gitignored but included in `npm pack`.
- Commit/push: `git add -A && git commit -m "chore: ..."` then `git push origin main`.
- The distribution name is `opencode-v2-agent-orchestrator`; the runtime plugin ID stays `opencode-orchestrator` (`src/opencode-v2/plugin.ts`, `src/tui.ts`) for compatibility. Local source-build/`npm pack` installation is verified. Tagging releases (`git tag vX.Y.Z && git push origin vX.Y.Z`, `gh release create`) and publishing to the npm registry (`npm publish`) are supported when cutting a release.

## Known Verification Traps

- `bun run dev:v2:dist` rewrites the generated config to `../../dist/index.js`; inspect `dev/project/opencode.jsonc` when verifying which entrypoint is loaded.
- `bun run build` emits the package's published bundle entrypoints under `dist/`; a successful build does not replace the packed-package smoke test.
- The plugin defaults to `strict_agents: true`; config-backed agents are materialized after external plugins during beta startup, so the complete dev template or installer is required for strict validation.
- `opencode2 api get /api/plugin` is location-scoped. Run it from the repo `cwd` (`cd repo && opencode2 api get /api/plugin`) — `?directory=` is ignored on `beta-18684`.
