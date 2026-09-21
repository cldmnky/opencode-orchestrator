# Architecture

OpenCode Orchestrator is a V2 server plugin with a separate V2 CLI plugin.
The server owns model-visible tools and durable state; the CLI owns local TUI
rendering and talks to the connected server through typed RPC only.

## Published entrypoints

| Entrypoint | Owner | Purpose |
|---|---|---|
| `src/index.ts` / `dist/index.js` | server plugin | Registers agents, commands, tools, hooks, and server RPCs. |
| `src/tui.ts` / `dist/tui.js` | CLI plugin | Adds the worker-model picker, gate picker, session sidebar, and progress detail view. |
| `src/commands.ts` / `dist/commands.js` | package facade | Exposes the supported command catalog to package consumers. |
| `src/installer.ts` / `dist/installer.js` | package facade | Exposes JSONC installation and migration helpers. |
| `src/cli/index.ts` / `dist/cli/index.js` | installer CLI | Installs, migrates, diagnoses, and recovers an installation. |

The root package export is the server plugin. The plugin definition sets
`tui: true`, so the host can associate the published `./tui` CLI entrypoint
with it. The CLI-only entrypoint is configured in global `cli.json`, which
keeps it active when the TUI connects to a remote server.

## Source layers

- `src/core/` contains configuration schemas, role policy, prompt generation,
  pure contract schemas, and deterministic transitions. It does not read the
  filesystem, spawn processes, or access OpenCode storage.
- `src/opencode-v2/` is the server integration layer. It adapts the core
  policy to the Promise plugin contract and owns storage-backed goals, lead
  boards, reviews, receipts, gates, worktrees, publication, and diagnostics.
- `src/cli/` contains the package CLI and JSONC installer. Installer writes are
  planned and validated before an atomic replacement; migration creates a
  backup and preserves explicit user-owned fields.
- `src/tui/` contains pure renderers and sidebar/progress formatting. The
  wiring in `src/tui.ts` owns subscriptions, RPC calls, slots, and cleanup.

## Server lifecycle

On setup, the server plugin:

1. Parses and validates plugin options.
2. Discovers the configured agents and applies the orchestrator/worker prompt
   and permission transforms.
3. Registers the canonical commands and always-on tools, then conditionally
   registers GitHub, worktree, authority, observability, publication, and
   peer-discovery surfaces according to configuration.
4. Registers read-only gates, diagnostics, progress, and state-recovery RPCs.
5. Starts only the opt-in runtimes and host hooks required by the options.

Every registration returns a disposable handle. Plugin cleanup disposes
registrations, stops continuations and runtimes, and releases process-local
admission state. A host reload therefore does not leave the previous plugin
generation owning hooks or durable writes.

## Durable state flow

Goals and plan runs enroll a versioned lead board under the stable project and
session identity. Board reservations are dependency-ordered and use declared
read/write scopes to conservatively serialize overlapping work. A worker
handoff is not completion: the lead must validate the bounded D2 envelope,
select plugin-observed verification receipts, and match an approved V2 review
to the exact revision before completing the board or publishing.

State is read strictly. Missing state has a documented default where safe;
malformed, unavailable, or identity-mismatched state remains unknown and is
never silently repaired or upgraded into publication proof. See
[`state-migrations.md`](state-migrations.md) and
[`operations/state-recovery.md`](operations/state-recovery.md).

## Server/TUI boundary

The TUI does not receive `ctx.storage` and does not import durable-state
implementations. It calls `context.client.rpc(progressRpcDefinition)` or the
gates RPC against the connected server and caches only bounded projections.
The progress projection redacts and truncates objective hints, task titles,
branch labels, counts, and limitations. A missing, malformed, unavailable, or
incomplete response is rendered as unknown rather than guessed as complete.

The model-facing `orchestrator_status` tool remains a separate read-only
surface. The progress RPC exists for the CLI plugin and is not a replacement
for canonical model tools.

## External boundaries

GitHub operations go through the validated `gh` runner and worktree operations
go through the safe Git client. Native shell and subagent hooks are observation
boundaries: receipts are created only from paired, validated host events and
fresh revision observations. The plugin does not provide a shell bypass,
filesystem sandbox, cross-process transaction, native child scheduler, or
exactly-once external mutation semantics.

For the supported package API and packed-install checks, see
[`contracts/package-api.md`](contracts/package-api.md).
