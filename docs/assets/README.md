# Demo assets

This folder holds the GIFs/screenshots shown in the root `README.md`.

- `demo-placeholder.svg` — checked-in placeholder so the README renders before you record. Replace the image link in `README.md` once you have real recordings.
- `orchestrate-demo.gif` — **not checked in yet** — record a 20–40s flow of `/orchestrate ...` in the TUI.
- `goal-demo.gif` — **not checked in yet** — record `/goal` + idle continuations.

## Quick VHS tape (optional)

Install [VHS](https://github.com/charmbracelet/vhs), then:

```tape
Output docs/assets/orchestrate-demo.gif
Set Width 1200
Set Height 700
Set FontSize 14
Set Theme "Catppuccin Mocha"

Type "opencode2"
Enter
Sleep 2s
Type "/orchestrate add input validation to the user form and cover it with tests"
Enter
Sleep 25s
```

Alternatives: **Screen Studio**, **Peek** (`peek` on Linux), or macOS `Cmd+Shift+5` → save as GIF via `ffmpeg`.

Keep GIFs under ~5 MB and 800px wide for GitHub rendering.

After recording, update `README.md`:

```md
![Orchestrate demo](docs/assets/orchestrate-demo.gif)
![Goal demo](docs/assets/goal-demo.gif)
```
