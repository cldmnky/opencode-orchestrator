# Local V2 Harness

This directory is an isolated OpenCode V2 development project.

```sh
bun run dev:setup
bun run dev:v2
```

The launcher starts `opencode2 --standalone` with XDG config, data, cache, and service state under `dev/state`. It does not use the shared OpenCode service or the user's global OpenCode configuration.

Use `bun run dev:v2:dist` to build and run the packaged plugin entrypoint. `bun run dev:reset` removes only generated local files.

The model entries are placeholders. Replace them with connected provider/model references when exercising real model calls.
