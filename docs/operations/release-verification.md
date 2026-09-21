# Release verification

Run these checks from a clean checkout before tagging or publishing. The
package's release script runs the typecheck, full test suite, build, packed
smoke test, and `npm pack --dry-run` before it reaches `npm publish`.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run scripts/package-smoke.ts
npm pack --dry-run
```

The packed smoke test is distinct from a source import. It packs the current
tarball, extracts it into an isolated consumer, resolves every supported
subpath, loads the packed server plugin in the pinned embedded host, resolves
the TUI export, invokes the installer, checks shipped documentation, and
typechecks a strict TypeScript consumer against the packed declarations.

## OpenCode checks

When `opencode` is installed, use the isolated harness so generated state and
configuration stay under `dev/state`:

```sh
bun run dev:setup
bun run dev:v2
# In a second terminal, inspect the isolated project with the documented TUI
# commands and location-scoped `opencode api` requests.
```

Verify the source entrypoint and the packed `dist/index.js` entrypoint
separately. In the TUI, verify `/orchestrate`, `/goal`, `/run-plan`, `/halt`,
`/handover`, `/worker-models`, `/publish`, and `/gates`; then exercise the
reviewer-child submission, shell receipt/revision-drift refusal, default-off
GitHub/worktree behavior, and publication refusal without review or receipts.

If `opencode` is unavailable, do not substitute an unauthenticated localhost
client or claim live verification. Report the environment limitation and rely
on the pinned embedded-host contract suite plus the packed smoke test until the
binary is available.

Finally, inspect `git status --short`, confirm no generated `dev/state` or
`dist` output is tracked, and create the tag only after package creation and
publication verification. The publish script intentionally creates/pushes the
tag after `npm publish` succeeds.
