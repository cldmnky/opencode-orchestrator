import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"

/**
 * Phase B pinned-host contract probe for the native `ctx.worktree` domain.
 *
 * Measurement only: no adapter, no strategy registration, no production
 * behavior change. Every probe runs in an embedded beta-19507 host against a
 * throwaway Git repository under the OS temp directory, and every native call
 * is routed to that repository through the domain's `location` input so the
 * repository's current checkout is never touched.
 *
 * Measured surface (see `docs/phase-1/n3-native-worktree-compatibility.md`):
 *   - project-scoped `list` inventory and the `refresh` result shape,
 *   - `create` return value, canonicalization, detached-HEAD semantics, and
 *     collision suffixing,
 *   - clean removal and dirty removal with the observed host error shape
 *     (`Git.WorktreeError.forceRequired` is only asserted because it was
 *     directly observed),
 *   - `worktree.updated` event delivery for the routed project,
 *   - discovery of externally created worktrees and silent row removal for
 *     vanished directories,
 *   - create/remove error classes and workspace-scoped location rejection.
 *
 * Harness facts measured here, not assumed:
 *   - `OpenCode.create({ config: { directory } })` does not move the host's
 *     default location: the plugin's boot `ctx.location` is the process working
 *     directory (this checkout), so every worktree call passes
 *     `location: { directory: <temp repo> }`. The domain resolves that ref to a
 *     location-scoped worktree service (`atWorktree`), and the plugin is
 *     instantiated once per active location (measured `setupCount: 2`), which is
 *     why event ids can be delivered more than once to a directly-passed plugin
 *     object; assertions dedupe by event id.
 *   - A provider call is impossible: no session is created, no prompt is
 *     admitted, and `session.hook("http.request")`/`model.request` record every
 *     attempt. Every test asserts both recorders are empty.
 */

const TEST_TIMEOUT = 20_000
const AGENTS = {
  orchestrator: { mode: "primary", model: "phase-b-probe/none" },
}

type WorktreeEvent = {
  id?: string
  type?: string
  created?: number
  data?: { projectID?: string }
  location?: { directory?: string }
}

type Domain = {
  list(input?: unknown): Promise<Array<{ directory: string; strategy?: string }>>
  create(input?: unknown): Promise<{ directory: string }>
  remove(input: { directory: string; force: boolean }): Promise<void>
  refresh(input?: unknown): Promise<unknown>
}

type Probe = {
  plugin: ReturnType<typeof Plugin.define>
  events: WorktreeEvent[]
  eventTypes: string[]
  httpRequests: string[]
  modelRequests: string[]
  /** Boot location captured at the first (ambient) setup. */
  bootProjectID: string | undefined
  /** Native worktree domain captured at setup (equivalent across setups). */
  domain: Domain | undefined
  setupCount: number
  started: Promise<void>
  stop: () => void
}

function createWorktreeProbe(): Probe {
  const events: WorktreeEvent[] = []
  const eventTypes: string[] = []
  const httpRequests: string[] = []
  const modelRequests: string[] = []
  const controller = new AbortController()
  let resolveStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })

  const probe: Probe = {
    plugin: undefined as never,
    events,
    eventTypes,
    httpRequests,
    modelRequests,
    bootProjectID: undefined,
    domain: undefined,
    setupCount: 0,
    started,
    stop: () => controller.abort(),
  }

  probe.plugin = Plugin.define({
    id: "phase-b-worktree-probe",
    async setup(ctx) {
      probe.setupCount += 1
      probe.bootProjectID ??= ctx.location.project.id
      probe.domain = ctx.worktree as unknown as Domain

      await ctx.session.hook("http.request", (event) => {
        httpRequests.push(event.request.url)
        throw new Error("phase-b probe blocks provider HTTP")
      })
      await ctx.session.hook("model.request", (event) => {
        modelRequests.push(`${event.sessionID}:${event.kind}`)
      })

      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            const typed = event as WorktreeEvent
            eventTypes.push(String(typed.type))
            if (typed.type === "worktree.updated") events.push(typed)
          }
        } catch {
          // Cleanup aborts the stream.
        }
      })()
      resolveStarted()

      return () => controller.abort()
    },
  })

  return probe
}

type Fixture = { root: string; repo: string; trees: string; canonicalRepo: string; canonicalRoot: string }

function makeRepo(label: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `orchestrator-phase-b-${label}-`))
  const repo = join(root, "repo")
  const trees = join(root, "trees")
  mkdirSync(repo, { recursive: true })
  mkdirSync(trees, { recursive: true })
  git(repo, ["init", "-q", "-b", "main"])
  writeFileSync(join(repo, "README.md"), "# phase-b probe\n", "utf8")
  git(repo, ["add", "README.md"])
  git(repo, ["-c", "user.email=probe@example.invalid", "-c", "user.name=Phase B Probe", "commit", "-q", "-m", "init"])
  return { root, repo, trees, canonicalRepo: realpathSync(repo), canonicalRoot: realpathSync(root) }
}

function git(cwd: string, args: string[]): string {
  // Keep git's progress chatter off the test output; stdout stays captured.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

/** Read-only linkage check against the throwaway repository. */
function worktreePorcelain(repo: string): string {
  return git(repo, ["worktree", "list", "--porcelain"])
}

function ambientCheckout(): string {
  return realpathSync(git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim())
}

async function withHost<T>(
  fixture: Fixture,
  run: (input: { host: Awaited<ReturnType<typeof OpenCode.create>>; probe: Probe; domain: Domain; at: object }) => Promise<T>,
): Promise<T> {
  const probe = createWorktreeProbe()
  const host = await OpenCode.create({
    plugins: [probe.plugin],
    fs: { filewatcher: false },
    config: { directory: fixture.repo, content: JSON.stringify({ agents: AGENTS }) },
  })
  try {
    await host.plugin.awaitActivation()
    await probe.started
    const domain = probe.domain as unknown as Domain
    return await run({ host, probe, domain, at: { location: { directory: fixture.repo } } })
  } finally {
    probe.stop()
    await host.close()
  }
}

/** Unique `worktree.updated` events routed through the fixture repository. */
function updateEvents(probe: Probe, fixture: Fixture): WorktreeEvent[] {
  const unique = new Map<string, WorktreeEvent>()
  for (const event of probe.events) {
    const directory = event.location?.directory
    if (typeof directory !== "string") continue
    if (realpathSync(directory) !== fixture.canonicalRepo) continue
    if (typeof event.id === "string") unique.set(event.id, event)
  }
  return [...unique.values()]
}

function updatedIds(probe: Probe, fixture: Fixture): string[] {
  return updateEvents(probe, fixture).map((event) => event.id as string)
}

async function waitFor(check: () => boolean, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out waiting for embedded host state")
}

async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reject an operation and return the raw thrown value for shape assertions. */
async function captureFailure(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  return promise.then(
    () => {
      throw new Error("expected the native worktree operation to fail")
    },
    (error: unknown) => error as Record<string, unknown>,
  )
}

describe("phase B native worktree contract (pinned beta-19507)", () => {
  test("scopes inventory to the routed project and returns a void refresh on a stable repository", async () => {
    const fixture = makeRepo("scope")
    const other = makeRepo("scope-other")
    try {
      await withHost(fixture, async ({ probe, domain, at }) => {
        const initial = await domain.list(at)

        // The first routed call resolves the repository's project: the inventory
        // holds exactly that project's root entry, with no strategy and no
        // other project's worktrees.
        expect(initial).toHaveLength(1)
        expect(initial[0]?.directory).toBe(fixture.canonicalRepo)
        expect(initial[0]?.strategy).toBeUndefined()
        for (const entry of initial) expect(entry.directory.startsWith(fixture.canonicalRoot + sep)).toBe(true)

        // The plugin refresh surface resolves to void even though the core
        // service computes { updated, removed }.
        expect(await domain.refresh(at)).toBeUndefined()
        const afterRefresh = await domain.list(at)
        expect(afterRefresh).toHaveLength(1)
        expect(afterRefresh[0]?.directory).toBe(fixture.canonicalRepo)
        await settle()
        // Liveness guard: the zero-update assertion below would pass vacuously
        // if the event subscription were dead.
        expect(probe.eventTypes.length).toBeGreaterThan(0)
        expect(updatedIds(probe, fixture)).toHaveLength(0)

        // A different project's inventory is disjoint, in both directions.
        // Location routing is asynchronous on the pinned embedded host. Give
        // the first non-current location a bounded opportunity to settle before
        // asserting its exact one-row inventory.
        let otherInventory = await domain.list({ location: { directory: other.repo } })
        for (let attempt = 0; attempt < 8 && otherInventory.length !== 1; attempt += 1) {
          await settle(100)
          otherInventory = await domain.list({ location: { directory: other.repo } })
        }
        expect(otherInventory).toHaveLength(1)
        expect(otherInventory[0]?.directory).toBe(other.canonicalRepo)
        const fixtureInventory = await domain.list(at)
        expect(fixtureInventory).toHaveLength(1)
        expect(fixtureInventory[0]?.directory).toBe(fixture.canonicalRepo)
        expect(fixtureInventory.some((entry) => entry.directory === other.canonicalRepo)).toBe(false)
        expect(otherInventory.some((entry) => entry.directory === fixture.canonicalRepo)).toBe(false)

        // A workspace-scoped location is rejected before any worktree operation.
        const workspaceError = await captureFailure(
          domain.list({ location: { directory: fixture.repo, workspace: "wrk_phasebprobe" } }) as Promise<unknown>,
        )
        expect(workspaceError.name).toBe("Worktree.UnsupportedLocationError")
        expect(workspaceError._tag).toBe("Worktree.UnsupportedLocationError")

        // Routing bound a second plugin instantiation (one per active location);
        // assertion counting dedupes by event id because both instances observe
        // the same bus.
        expect(probe.setupCount).toBeGreaterThanOrEqual(2)
        expect(probe.httpRequests).toEqual([])
        expect(probe.modelRequests).toEqual([])
      })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
      rmSync(other.root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT)

  test("creates a detached worktree, canonicalizes the returned directory, and lists it with the git strategy", async () => {
    const fixture = makeRepo("create")
    const ambient = ambientCheckout()
    try {
      await withHost(fixture, async ({ probe, domain, at }) => {
        const baseline = updatedIds(probe, fixture).length
        const created = await domain.create({ ...at, directory: join(fixture.trees, "native"), name: "probe" })

        // The result is exactly { directory } and is the canonical path.
        expect(Object.keys(created)).toEqual(["directory"])
        const expectedDir = realpathSync(join(fixture.trees, "native", "probe"))
        expect(created.directory).toBe(expectedDir)
        expect(created.directory.startsWith(fixture.canonicalRoot + sep)).toBe(true)
        expect(existsSync(join(created.directory, ".git"))).toBe(true)

        // The worktree is linked to the routed repository, never the checkout
        // running this suite.
        expect(worktreePorcelain(fixture.repo)).toContain(`worktree ${created.directory}`)
        expect(worktreePorcelain(ambient)).not.toContain(created.directory)

        // Native create starts a detached HEAD at the repository HEAD: it does
        // not create a branch, so `branch`/`from` are starting refs only.
        const repoHead = git(fixture.repo, ["rev-parse", "HEAD"]).trim()
        expect(git(created.directory, ["rev-parse", "HEAD"]).trim()).toBe(repoHead)
        expect(git(created.directory, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("HEAD")
        expect(git(created.directory, ["branch", "--show-current"]).trim()).toBe("")

        // Inventory reports the canonical directory with the git strategy.
        expect(await domain.list(at)).toContainEqual({ directory: created.directory, strategy: "git" })

        // A second create with the same name collides into a deterministic
        // `-2` suffix instead of failing.
        const collision = await domain.create({ ...at, directory: join(fixture.trees, "native"), name: "probe" })
        expect(collision.directory).toBe(realpathSync(join(fixture.trees, "native", "probe-2")))

        // One unique update event per create, all scoped to the routed project.
        await waitFor(() => updatedIds(probe, fixture).length >= baseline + 2)
        await settle()
        const events = updateEvents(probe, fixture)
        expect(events).toHaveLength(2)
        for (const event of events) {
          expect(event.type).toBe("worktree.updated")
          expect(typeof event.created).toBe("number")
          expect(event.data?.projectID).toMatch(/^[0-9a-f]{40}$/)
          expect(event.data?.projectID).not.toBe(probe.bootProjectID)
        }
        expect(new Set(events.map((event) => event.data?.projectID)).size).toBe(1)

        expect(probe.httpRequests).toEqual([])
        expect(probe.modelRequests).toEqual([])
      })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT)

  test("removes a clean worktree without force and updates inventory", async () => {
    const fixture = makeRepo("remove")
    try {
      await withHost(fixture, async ({ probe, domain, at }) => {
        const created = await domain.create({ ...at, directory: join(fixture.trees, "native"), name: "clean" })
        await waitFor(() => updatedIds(probe, fixture).length >= 1)
        await settle()
        const baseline = updatedIds(probe, fixture).length
        await domain.list(at)

        expect(await domain.remove({ ...at, directory: created.directory, force: false })).toBeUndefined()
        expect(existsSync(created.directory)).toBe(false)
        expect(worktreePorcelain(fixture.repo)).not.toContain(created.directory)

        const inventory = await domain.list(at)
        expect(inventory.some((entry) => entry.directory === created.directory)).toBe(false)

        await waitFor(() => updatedIds(probe, fixture).length >= baseline + 1)
        await settle()
        expect(updatedIds(probe, fixture)).toHaveLength(baseline + 1)

        expect(probe.httpRequests).toEqual([])
        expect(probe.modelRequests).toEqual([])
      })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT)

  test("refuses dirty removal with a directly observed forceRequired error and removes with force", async () => {
    const fixture = makeRepo("dirty")
    try {
      await withHost(fixture, async ({ probe, domain, at }) => {
        const created = await domain.create({ ...at, directory: join(fixture.trees, "native"), name: "dirty" })
        writeFileSync(join(created.directory, "untracked.txt"), "dirty\n", "utf8")
        await waitFor(() => updatedIds(probe, fixture).length >= 1)
        await settle()
        const baseline = updatedIds(probe, fixture).length
        await domain.list(at)

        const error = await captureFailure(
          domain.remove({ ...at, directory: created.directory, force: false }) as Promise<unknown>,
        )

        // Directly observed shape: a Git.WorktreeError whose forceRequired flag
        // is the force confirmation signal, not a Worktree.OperationError.
        expect(error).toBeInstanceOf(Error)
        expect(error.name).toBe("Git.WorktreeError")
        expect(error._tag).toBe("Git.WorktreeError")
        expect(error.operation).toBe("remove")
        expect(error.directory).toBe(created.directory)
        expect(error.forceRequired).toBe(true)
        expect(String(error.message)).toContain("contains modified or untracked files")
        expect(String(error.message)).toContain(created.directory)

        // The failed removal is fail-closed: directory, git linkage, and
        // inventory are all unchanged, and no update event is emitted.
        expect(existsSync(created.directory)).toBe(true)
        expect(worktreePorcelain(fixture.repo)).toContain(`worktree ${created.directory}`)
        expect((await domain.list(at)).some((entry) => entry.directory === created.directory)).toBe(true)
        await settle()
        expect(updatedIds(probe, fixture)).toHaveLength(baseline)

        // force: true removes the dirty worktree and updates inventory.
        expect(await domain.remove({ ...at, directory: created.directory, force: true })).toBeUndefined()
        expect(existsSync(created.directory)).toBe(false)
        expect((await domain.list(at)).some((entry) => entry.directory === created.directory)).toBe(false)
        await waitFor(() => updatedIds(probe, fixture).length >= baseline + 1)
        await settle()
        expect(updatedIds(probe, fixture)).toHaveLength(baseline + 1)

        expect(probe.httpRequests).toEqual([])
        expect(probe.modelRequests).toEqual([])
      })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT)

  test("discovers externally created worktrees and drops vanished directories without an orphan state", async () => {
    const fixture = makeRepo("discover")
    try {
      await withHost(fixture, async ({ probe, domain, at }) => {
        await domain.list(at)
        const baseline = updatedIds(probe, fixture).length

        // A worktree created outside the native domain is adopted by list (the
        // native list refreshes first); refresh itself returns void.
        const external = join(fixture.trees, "external")
        git(fixture.repo, ["worktree", "add", "--detach", "--", external, "HEAD"])
        const discoveredDir = realpathSync(external)
        expect(await domain.list(at)).toContainEqual({ directory: discoveredDir, strategy: "git" })
        expect(await domain.refresh(at)).toBeUndefined()
        await waitFor(() => updatedIds(probe, fixture).length >= baseline + 1)

        // Removing it outside the native domain drops the inventory row on the
        // next list; there is no persistent orphaned record.
        const beforeRemovalIds = updatedIds(probe, fixture).length
        git(fixture.repo, ["worktree", "remove", external])
        const afterExternal = await domain.list(at)
        expect(afterExternal.some((entry) => entry.directory === discoveredDir)).toBe(false)
        expect(afterExternal).toHaveLength(1)
        expect(afterExternal[0]?.directory).toBe(fixture.canonicalRepo)
        await waitFor(() => updatedIds(probe, fixture).length >= beforeRemovalIds + 1)

        // A tracked directory deleted behind the host's back is dropped from
        // inventory as well (git reports the admin entry as prunable), again
        // without an orphaned lifecycle state.
        const vanished = await domain.create({ ...at, directory: join(fixture.trees, "native"), name: "vanished" })
        rmSync(vanished.directory, { recursive: true, force: true })
        const afterVanished = await domain.list(at)
        expect(afterVanished.some((entry) => entry.directory === vanished.directory)).toBe(false)
        expect(worktreePorcelain(fixture.repo)).toContain("prunable")

        expect(probe.httpRequests).toEqual([])
        expect(probe.modelRequests).toEqual([])
      })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT)

  test("treats branch as a starting ref and reports create and remove failures by class", async () => {
    const fixture = makeRepo("errors")
    try {
      await withHost(fixture, async ({ probe, domain, at }) => {
        // An existing branch ref selects the starting commit; the worktree is
        // still detached, so the native domain never creates a branch.
        const created = await domain.create({
          ...at,
          directory: join(fixture.trees, "refs"),
          name: "at-main",
          branch: "main",
        })
        expect(git(created.directory, ["rev-parse", "HEAD"]).trim()).toBe(git(fixture.repo, ["rev-parse", "HEAD"]).trim())
        expect(git(created.directory, ["branch", "--show-current"]).trim()).toBe("")

        // An unknown starting ref fails as a Git.WorktreeError with
        // forceRequired explicitly false and no directory left behind.
        const refError = await captureFailure(
          domain.create({
            ...at,
            directory: join(fixture.trees, "refs"),
            name: "missing",
            branch: "no-such-ref",
          }) as Promise<unknown>,
        )
        expect(refError.name).toBe("Git.WorktreeError")
        expect(refError._tag).toBe("Git.WorktreeError")
        expect(refError.operation).toBe("create")
        expect(refError.forceRequired).toBe(false)
        expect(String(refError.message)).toContain("invalid reference")
        expect(existsSync(join(fixture.trees, "refs", "missing"))).toBe(false)

        // A directory that is not in the native inventory cannot be removed;
        // the main checkout root row is refused the same way.
        const unknown = join(fixture.trees, "unknown")
        mkdirSync(unknown)
        const unknownError = await captureFailure(
          domain.remove({ ...at, directory: unknown, force: false }) as Promise<unknown>,
        )
        expect(unknownError.name).toBe("Worktree.InvalidDirectoryError")
        expect(unknownError._tag).toBe("Worktree.InvalidDirectoryError")
        expect(unknownError.directory).toBe(realpathSync(unknown))
        expect(existsSync(unknown)).toBe(true)

        const rootError = await captureFailure(
          domain.remove({ ...at, directory: fixture.repo, force: true }) as Promise<unknown>,
        )
        expect(rootError._tag).toBe("Worktree.InvalidDirectoryError")
        expect(existsSync(fixture.repo)).toBe(true)

        // The valid worktree is still removable.
        expect(await domain.remove({ ...at, directory: created.directory, force: false })).toBeUndefined()
        expect(existsSync(created.directory)).toBe(false)

        expect(probe.httpRequests).toEqual([])
        expect(probe.modelRequests).toEqual([])
      })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT)
})
