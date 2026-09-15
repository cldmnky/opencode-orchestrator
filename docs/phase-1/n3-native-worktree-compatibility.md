# N3 — Native Worktree Domain Compatibility Probe (pinned beta-19507)

**Date:** 2026-09-15
**Status:** Phase B compatibility probe **complete** — measurement plus adapter decision. **No adapter, no strategy registration, no cutover, no production behavior change** in this slice.
**Scope:** the probe suite `test/contract/phase-b-worktree.test.ts` (new), this record, and the N3 / Phase B / A16 notes in [`../orchestrator-improvements-plan.md`](../orchestrator-improvements-plan.md).
**Decision summary:** **cutover is blocked.** The measured native inventory is not equivalent to the managed `worktree/v2` lifecycle (no branch creation, no ownership, no dirty/moved/orphaned states, `refresh` result dropped at the plugin surface, destructive `force`). The largest defensible future step is a **read-only inventory observation pilot** that keeps `worktree/v2` authoritative; that pilot is **not implemented** here and needs explicit authorization. No child filesystem or process isolation is claimed anywhere.

## 1. Question

The plan's N3 asks whether the pinned `ctx.worktree` domain can replace the plugin's own git-subprocess worktree lifecycle. The open questions were:

1. What do native `list`/`refresh`/`worktree.updated` actually do on beta-19507?
2. What does native `create` return, and what is the identity of the created worktree?
3. What happens on clean removal, and what is the shape of a dirty-removal refusal — is `forceRequired` real and directly observable?
4. Is the native inventory project-scoped, and can a probe avoid provider traffic entirely?
5. How does native inventory map onto the managed lifecycle states (`pending`, `ready`, `dirty`, `moved`, `orphaned`, `cleanup-failed`)?

## 2. Method and harness boundaries

- **Runtime evidence:** `test/contract/phase-b-worktree.test.ts` boots embedded `OpenCode.create` hosts (pinned `@opencode/sdk` `0.0.0-beta-19507`) in temporary Git repositories and calls the probe plugin's captured `ctx.worktree` domain. All calls pass an explicit `location: { directory: <temp repo> }`, which the pinned host resolves through `atWorktree` to a location-scoped worktree service.
- **Type evidence:** installed pinned declarations — `node_modules/@opencode/plugin/dist/promise/worktree.d.ts` (`WorktreeDomain`, `WorktreeDefinition`), `node_modules/@opencode/plugin/dist/worktree.d.ts` (`WorktreeCreateInput`/`RemoveInput`/`Result`/`Entry`), `node_modules/@opencode/schema/dist/worktree.d.ts` (`OperationError { message, forceRequired? }`, `Event.Updated`/`Event.Resolved`), `node_modules/@opencode/client/dist/promise/generated/types.d.ts` (`WorktreeList`, `WorktreeDirectory`), and the compiled pinned host wiring (`@opencode/core` `PluginHost` worktree domain + worktree service + git strategy + `@opencode/server` worktree handler).
- **No provider traffic:** no session is created, no prompt is admitted, and the probe registers `session.hook("http.request")` (which throws) and `session.hook("model.request")`; every test asserts both recorders are empty.
- **Hermeticity:** all worktrees are created in `mkdtemp` fixture roots; the suite asserts each returned directory is inside the fixture, that the created worktree is linked to the fixture repository (`git worktree list --porcelain`), and that the repository's current checkout is **not** in the linkage. Repeated runs left the current checkout's worktree admin directory unchanged.
- **Measured harness facts (not assumptions):**
  - `OpenCode.create({ config: { directory } })` does **not** move the host's default location: the plugin's boot `ctx.location` is the process working directory. The native domain does support per-call `location` routing, and that is what the probe uses.
  - The directly-passed plugin object is instantiated **once per active location** (measured `setupCount: 2`: boot location + routed fixture location). Because both instances subscribe to the same bus, a `worktree.updated` event id can be delivered more than once in this harness; the suite dedupes by event id, and this is a harness artifact rather than a host delivery guarantee.
- **Unmeasured by design:** the default creation destination (`<global data>/worktree/<project prefix>/<slug>`) was **not** exercised because it would write outside temporary test directories. No `ctx.worktree.transform` strategy registration was attempted (out of scope for this probe).

## 3. Measured behavior

Every row below is direct runtime observation unless marked otherwise.

| Surface | Measured result |
|---|---|
| `list(location)` | Project-scoped rows: the project root appears as `{ directory: <canonical repo> }` with **no strategy**; created worktrees appear as `{ directory: <canonical dir>, strategy: "git" }`. `list` refreshes first, then reads stored rows. Two repositories' inventories are disjoint. |
| `refresh(location)` | Resolves to `undefined` at the plugin surface (typed `void`); the core service's `{ updated, removed }` result is **not reachable** through `ctx.worktree.refresh`. A refresh with no changes emits no event; a refresh that discovers/removes emits `worktree.updated`. |
| `create({ location, directory, name })` | Returns exactly `{ directory }`, the **canonical** path (`realpath`), e.g. `<trees>/native/probe`; a same-name collision becomes `<trees>/native/probe-2`. The worktree is linked to the routed repository and is **detached** (`git rev-parse --abbrev-ref HEAD` = `HEAD`, `branch --show-current` empty). `branch`/`from` are starting refs, not new branch names: `branch: "main"` produced a detached worktree at the repository HEAD. |
| `create` failure | Unknown starting ref → `Git.WorktreeError` with `{ _tag: "Git.WorktreeError", operation: "create", directory, forceRequired: false }`, message `fatal: invalid reference: no-such-ref`; no destination directory is left behind. |
| `remove(force:false)` on a clean tree | Resolves to `undefined`; the directory is gone, `git worktree list --porcelain` drops the linkage, and a later `list` drops the row. |
| `remove(force:false)` on a dirty tree | Rejects with `Git.WorktreeError`: `{ _tag: "Git.WorktreeError", name: "Git.WorktreeError", operation: "remove", directory: <canonical dir>, forceRequired: true }`; message `fatal: '<dir>' contains modified or untracked files, use --force to delete it`. **`forceRequired: true` was directly observed** — this is the only basis for claiming it. The failure is fail-closed: directory, git linkage, and inventory row all remain, and no update event is emitted. |
| `remove(force:true)` | Succeeds on the dirty tree; the directory is deleted and the row is dropped. |
| Unknown directory / main checkout removal | `Worktree.InvalidDirectoryError` (`_tag` observed; it carries `directory`). The project root row (no strategy) is refused the same way. |
| Workspace-scoped location | `location: { directory, workspace: "wrk_…" }` → the routed call rejects with `Worktree.UnsupportedLocationError` (`name` and `_tag` directly asserted). |
| `worktree.updated` | Ephemeral event `{ id, created, type: "worktree.updated", location: { directory }, data: { projectID } }`; the probe asserts a string `id`, numeric `created`, the literal type, the routing directory, and the `data.projectID` field. It does **not** assert `data` key exclusivity, so the claim that `data` carries nothing further — no per-worktree directory, no action — is declaration-level (`node_modules/@opencode/schema/dist/worktree.d.ts`, `Event.Updated` types `data` as `{ projectID }` only), not measured. One unique event per mutating operation (create/remove/forced remove/discovery/row removal); no event for a dirty refusal or a no-op refresh. |
| `worktree.resolved` | **Declaration/source evidence only — the committed probe asserts no `worktree.resolved` instance.** Pinned `node_modules/@opencode/schema/dist/worktree.d.ts` (`Event.Resolved`) declares `{ type: "worktree.resolved", durable: { aggregateID, seq, version }, data: { projectID, directory, previous, adopted? } }`, i.e. project-resolution bookkeeping (a location resolving/adopting a project directory), not session ownership. |
| External worktrees | A worktree created outside the domain with `git worktree add --detach` is **adopted** by the next `list` (which refreshes first) as `{ directory, strategy: "git" }`. A tracked directory deleted behind the host's back is **silently dropped** from inventory on the next `list`; git reports the leftover admin entry as `prunable`. There is no persistent orphaned record. |
| Project scoping | Routing `location` to repo B from a host booted on repo A returns only repo B's inventory; neither inventory contains the other's directories. |

## 4. Mapping onto the managed `worktree/v2` lifecycle

| Managed state | Native equivalent (measured) | Verdict |
|---|---|---|
| `pending` | None. Native `create` is synchronous and writes the stored row before returning. | **Unsupported** |
| `ready` (clean) | A stored row plus an existing directory. No owner/session, no branch, no sync receipt, no base/head revision. | **Partial — directory inventory only** |
| `dirty` | Not a state. Native inventory never reports dirtiness; the condition surfaces only as a failed `remove` with `forceRequired: true`. | **Unsupported** (an adapter would still need its own `git status` check, exactly like today) |
| `moved` (session relocated; record stays origin-anchored) | No equivalent. Native rows are keyed to the resolving project; `worktree.resolved`/`previous` (declaration-level) describe project adoption, not an owning session that moved. | **Unsupported** |
| `orphaned` (record kept for a vanished directory) | Native **deletes** the row during refresh and exposes no orphan record at the plugin surface (the core `removed` list is unreachable through `ctx.worktree.refresh`). | **Unsupported — and lossier than the current model** |
| `cleanup-failed` | None. A failed removal persists nothing. | **Unsupported** |
| Ownership / foreign-worktree refusal | None. Native `remove` refuses only unknown directories (`Worktree.InvalidDirectoryError`); it has no session-owner concept and `force: true` deletes dirty trees. | **Unsupported** |
| Error signal for dirty cleanup | `forceRequired: true` on a directly observed `Git.WorktreeError`. | **Supported** — the one native signal worth adopting |

Also note which documented error class was **not** observed on the plugin surface: the plan's N3 text anticipated `Worktree.OperationError({ forceRequired })`; the measured plugin-surface dirty-removal failure is the lower-level `Git.WorktreeError`. The HTTP server handler maps errors into a `WorktreeError { name, data: { message, forceRequired } }` response (declaration/source evidence only; not exercised here — the probe measured the in-process plugin surface).

## 5. Adapter decision

**Cutover is blocked.** The measured native domain cannot back the managed lifecycle:

1. **Identity mismatch:** native create is detached, returns only a directory, and never creates or tracks the feature branch that sync/push/PR steps depend on.
2. **Inventory mismatch:** no owner session, no `pending`/`ready`/`dirty`/`moved`/`orphaned`/`cleanup-failed`, no sync receipt, and vanished directories are silently forgotten instead of recorded as `orphaned`.
3. **Observation mismatch:** `ctx.worktree.refresh` discards the detailed `{ updated, removed }` result; `worktree.updated` carries a project-scoped `projectID` (the probe does not assert `data` key exclusivity) rather than a per-worktree action; `worktree.resolved` (declaration-level) is project resolution, not session movement.
4. **Destructive semantics mismatch:** native `force: true` deletes dirty worktrees; the managed lifecycle is deliberately fail-closed (refuse dirty cleanup). Any adapter must keep `force: false` and treat `forceRequired` as a signal, never auto-confirm.
5. **Containment mismatch:** native create accepts any absolute directory and defaults under the global data root; the configured `worktree.root` containment has no native counterpart, so the adapter would still own path safety.

**Permitted follow-up (not implemented, needs authorization):** a **read-only inventory observation pilot** — `list` and `worktree.updated` watching as an advisory cross-check behind a new opt-in switch, with `worktree/v2` records authoritative, no native `create`/`remove`, no strategy registration, no force, and a documented dedupe-by-event-id requirement. Any future proposal that turns native inventory into the source of truth must first show equivalence for ownership, dirty detection, orphan persistence, and branch identity — none of which this probe found.

**Isolation boundary (unchanged):** none of this provides child filesystem, process, or atomic worktree isolation. Managed ownership covers the current session only; parallel children still share the parent filesystem. Executed child sessions are never namespaced to a native worktree by this work.

## 6. Reproduce

```sh
bun run build
bun test test/contract/phase-b-worktree.test.ts   # 6 pass, 0 fail, 95 expect() calls
bun run typecheck                                 # clean
git diff --check                                  # clean
bun test                                          # 893 pass, 1 skip, 0 fail, 6851 expect() calls
                                                  # (894 tests / 33 files; skip is the pre-existing cross-volume case)
```

`bun run build` is a prerequisite for the full suite, not for this probe: the pre-existing Phase A contract file loads `dist/index.js`, so running the whole suite before a build fails those 13 tests instantly with the missing-entry error. This probe suite itself has no build dependency.

The suite is measurement-only: it registers no strategy, changes no durable state outside its temp repositories, and asserts zero `model.request`/`http.request` hook events. Its assertions are pin-specific (beta-19507); re-run it before relying on any claim here.

## 7. Limitations and unmeasured items

- None of the results are a platform or cross-pin contract: measured on macOS with git 2.51.2 against pinned `@opencode/plugin`/`@opencode/sdk` `0.0.0-beta-19507`.
- The default create destination, project `start`-command execution on create, `ctx.worktree.transform` strategy registration, concurrent multi-process refresh, and the HTTP server `WorktreeError` translation were not exercised.
- Duplicate event delivery was observed in this harness and is explained by per-location plugin instantiation; the probe makes no at-least-once/at-most-once host guarantee either way.
- The probe uses the in-process plugin surface. The public HTTP client surface (`host.worktree.*`) and the server error mapping are declared-compatible but were not probed at runtime.
