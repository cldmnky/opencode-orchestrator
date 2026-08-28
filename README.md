# OpenCode Orchestrator

OpenCode Orchestrator is a V2-only TypeScript plugin for coordinating specialized agents. It uses native OpenCode subagent delegation and native per-agent model configuration.

## Install

From a project:

```sh
npx opencode-orchestrator install
# or install the server plugin globally
npx opencode-orchestrator install --global
```

The installer adds the plugin and five agents without overwriting existing agent configuration. Workflow commands are registered by the V2 server plugin at runtime, so the installer does not write `commands` entries:

- `/orchestrate`
- `/goal`
- `/restructure`
- `/run-plan`
- `/halt`
- `/handover`
- `/polish`
- `/stress-plan`

Configure each agent independently with `provider/model#variant` under `agents.<id>.model`. The plugin deliberately does not put model choices in its options.

## V2 Boundary

The current V2 native `subagent` API does not atomically accept both a parent session and a plugin-created worktree. This plugin therefore does not pretend to enforce per-agent worktree or GitHub issue/PR isolation; `doctor` reports that boundary as a warning. Do not treat prompt instructions as a filesystem security boundary.

## Development

```sh
bun install
bun run dev:setup
bun run dev:v2
bun run typecheck
bun test
```

The local launcher uses a standalone `opencode2` process and repository-local state under `dev/state`. It does not use global OpenCode configuration or the shared service. Run `bun run dev:v2:dist` to test the built artifact.

## V2 Compatibility

This package targets the tested V2 beta server/TUI contract:

- `@opencode-ai/plugin` `0.0.0-beta-18414`
- `@opencode-ai/sdk` `0.0.0-dev-18560` for integration tests only

The main plugin sets `tui: true` and publishes `./tui`, allowing the TUI command layer to connect to the server selected by OpenCode. CLI-only plugin configuration belongs in global `cli.json`; this package is dual-surface and is normally enabled through the main plugin registration.

This project is behaviorally inspired by multi-agent orchestration work in `oh-my-openagent` at commit `64d89819ef1fde81712630f8e5d798be9e4e8867`. It is an independent implementation, has no affiliation with that project, and does not copy its templates or branding.
