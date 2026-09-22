import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"
import { activatePlugin } from "./helpers/activate-plugin.js"
import { loadBuiltPlugin } from "./helpers/build-plugin.js"

/**
 * Phase A pinned-host probe (measurement only; no N1/N2 enforcement).
 *
 * These contract tests record what the pinned 2.0.14 host actually does for
 * the three runtime-authority surfaces the plan's N1/N2 items depend on:
 *
 *   1. `session.hook("prompt")` mutations become the admitted prompt data.
 *   2. Resubmitting an already-admitted message ID does not re-run prompt hooks.
 *   3. `permission.hook("evaluate")` observes `allow`/`ask` and can change them
 *      to `deny`.
 *   4. A configured `deny` rule is final and bypasses the evaluation hook.
 *   5. Parent session permissions are inherited by a newly created child
 *      session and deny the tested action.
 *   6. Opt-in child-only admission probe (N2 direction): during the
 *      subagent-created child's own `session.hook("prompt")` admission, the
 *      probe can install — or deliberately fail to install — a deny rule on
 *      that child only, through the same awaited prompt hook.
 *
 * Harness facts:
 *   - Each test boots an isolated `OpenCode.create` host that directly loads a
 *     fresh test-owned bundle plus a test-only
 *     probe plugin registering the hooks under measurement.
 *   - No provider call is permitted. Every configured agent carries an
 *     unresolvable probe model, prompts are admitted with `delivery: "queue"`
 *     and `resume: false` (admission without an execution wake), and the probe's
 *     `http.request` hook throws before any provider HTTP send. Every test
 *     asserts zero `model.request`/`http.request` hook events.
 *   - The pinned public `session.create` surface drops `parentID` (verified
 *     directly), so child creation uses the host's own built-in `subagent` tool
 *     through the plugin `ToolEditor`. The probe aborts that tool at its first
 *     progress update: after `Session.create({ parentID })` and before any
 *     prompt admission or model dispatch.
 *   - The child-admission cases then admit queued prompts on that child via the
 *     public `session.prompt` surface; the child-only rule installer runs inside
 *     the child's prompt hook and is observed through probe state, the child's
 *     `session.get` rule set, and the final permission decision.
 */

const PROBE_MARK = "[phase-a-probe]"
const PROBE_MODEL = "phase-a-probe/none"
const CHILD_AGENT = "phase-a-child"
const CHILD_RULE_ACTION = "phase-a.child.admission"
const CHILD_RULE_FAILURE = "phase-a child rule installer failed"
/**
 * Per-case timeout for the five child-session cases that create a child through
 * the shared `createChildViaSubagent` helper.
 *
 * Bun's default per-test timeout is 5000 ms, and it is the only 5 s bound in
 * this file that distinguishes these five cases: the harness `waitFor`
 * activation poll is shared by all 13 tests and cannot explain a five-case
 * subset. Each child-session case boots a full embedded host (activation wait
 * plus SDK round trips) and then drives the host's own built-in `subagent` tool
 * through `Session.create({ parentID })` — several extra round trips on top of
 * the boot. On an idle machine a case finishes in well under a second, but
 * under a loaded full-suite run (several embedded-host files in parallel) they
 * can exceed the 5 s default and fail with "test timed out after 5000ms" while
 * measuring the same behavior. This only extends how long the runner waits for
 * that behavior: every assertion, sequence, and probe record is unchanged, and
 * the remaining cases keep the default budget so a genuine hang still fails
 * fast. 20 s keeps roughly 25x headroom over the observed runtime without
 * hiding a real deadlock for long.
 */
const CHILD_SESSION_TEST_TIMEOUT = 20_000

/**
 * Production Phase A authority surface under test (mirrors the constants in
 * `src/opencode-v2/authority/runtime.ts` and `src/core/permissions.ts`).
 */
const AUTHORITY_KEY = "opencode-orchestrator.authority"
const ENFORCED_ACTION = "orchestrator_validation"
const RECOVERY_ACTION = "orchestrator_observability"
const PROTECTED_ACTION = "orchestrator_worktree"
const UNRELATED_ACTION = "phase-a.unrelated"
const ROLE_CHILD_AGENT = "implementer"
const CONTAINMENT_ACTIONS = [
  "orchestrator_goal",
  "orchestrator_gh",
  "orchestrator_worktree",
  "orchestrator_validation",
  "orchestrator_observability",
  "orchestrator_publish",
  "orchestrator_peer",
  "orchestrator_gates",
] as const
/** Enforced, gate-refusing options: no token snapshot exists, so stop-between-steps fails closed. */
const REFUSING_OPTIONS = {
  authority: { mode: "enforce" },
  goal: { auto_continue: false },
  budget: { mode: "stop-between-steps", max_tokens: 10 },
}
/** Enforced options whose gate allows every dispatch (no budget/review refusal). */
const ALLOWING_OPTIONS = {
  authority: { mode: "enforce" },
  goal: { auto_continue: false },
}
/** Default-off options: the same refusing gate exists, but authority stays off. */
const DEFAULT_OFF_OPTIONS = {
  goal: { auto_continue: false },
  budget: { mode: "stop-between-steps", max_tokens: 10 },
}

function authorityMarker(dispatch: "command" | "continuation"): Record<string, unknown> {
  return { [AUTHORITY_KEY]: { version: 1, dispatch } }
}

type AuthorityFaults = {
  /** When set, the production plugin's child permission write fails for that session. */
  failRulesFor: string | undefined
}

/**
 * Boots the real built plugin with `authority.mode: "enforce"` (and any other
 * supplied options). The embedded SDK host registers directly-passed plugin
 * objects without per-plugin options (verified: `ctx.options` is always `{}`),
 * so the harness wraps the real `setup` with an options-injected context — the
 * production code path under test is unchanged. The same wrapper can inject a
 * fault into the plugin's `session.update` dependency for one armed session.
 */
function wrapAuthorityPlugin(
  built: unknown,
  options: Record<string, unknown>,
  faults: AuthorityFaults,
): { id: string; setup(ctx: any): Promise<unknown> } {
  const plugin = built as { id: string; setup(ctx: any): Promise<unknown> }
  return {
    id: plugin.id,
    setup(ctx) {
      return plugin.setup({
        ...ctx,
        options: { ...ctx.options, ...options },
        session: {
          ...ctx.session,
          update: async (input: { sessionID: string; permissions: unknown }) => {
            if (faults.failRulesFor !== undefined && faults.failRulesFor === input.sessionID) {
              throw new Error("phase-a authority fault: child rule installation refused")
            }
            return ctx.session.update(input)
          },
        },
      })
    },
  }
}

async function withAuthorityHost<T>(
  options: Record<string, unknown>,
  run: (input: {
    host: Awaited<ReturnType<typeof OpenCode.create>>
    directory: string
    probe: Probe
    faults: AuthorityFaults
  }) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-phase-a-authority-"))
  try {
    const probe = createProbe()
    const faults: AuthorityFaults = { failRulesFor: undefined }
    const host = await OpenCode.create({
      plugins: [wrapAuthorityPlugin(await loadBuiltPlugin(), options, faults) as any, probe.plugin],
      fs: { filewatcher: false },
      config: { directory, content: JSON.stringify({ agents: AGENTS }) },
    })
    try {
      await activatePlugin(host, directory)
      await waitFor(async () => {
        const plugins = (await host.plugin.list({ location: { directory } })).data as Array<{
          id: string
          status?: string
          state?: { status?: string }
        }>
        return plugins.some(
          (plugin) => plugin.id === "opencode-orchestrator" && (plugin.status ?? plugin.state?.status) === "active",
        )
      })
      probe.promptCalls.length = 0
      probe.evaluateCalls.length = 0
      probe.modelRequests.length = 0
      probe.httpRequests.length = 0
      return await run({ host, directory, probe, faults })
    } finally {
      await host.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
    expect(existsSync(directory)).toBe(false)
  }
}

type PromptCall = {
  sessionID: string
  messageID: string
  text: string
  delivery: string
  metadata?: Record<string, unknown>
}

type EvaluateCall = {
  action: string
  effect: string
  resources: readonly string[]
  message?: string
}

type ChildRuleMode = "install" | "fail"

type ChildAdmissionState = {
  /** Armed target; the installer runs only for this exact session ID. */
  target: { childID: string; mode: ChildRuleMode } | null
  installCalls: Array<{ sessionID: string; messageID: string }>
  /** Ordered markers recorded inside the hook (installer start/done). */
  sequence: string[]
  installedRules: Array<{ action: string; resource: string; effect: "deny" }> | null
  failure: string | null
}

/**
 * Opt-in child-only admission probe. Arming it makes the prompt hook install a
 * deny rule on exactly one session (the subagent-created child) and only while
 * that child's own prompt admission is running. Nothing is armed by default, so
 * the inheritance and hook-semantics cases are unaffected.
 */
function createChildAdmissionProbe() {
  const state: ChildAdmissionState = {
    target: null,
    installCalls: [],
    sequence: [],
    installedRules: null,
    failure: null,
  }

  return {
    state,
    arm(childID: string, mode: ChildRuleMode = "install"): void {
      state.target = { childID, mode }
    },
    isTarget(sessionID: string): boolean {
      return state.target !== null && state.target.childID === sessionID
    },
  }
}

function createProbe() {
  const promptCalls: PromptCall[] = []
  const evaluateCalls: EvaluateCall[] = []
  const modelRequests: string[] = []
  const httpRequests: string[] = []
  const childAdmission = createChildAdmissionProbe()
  let toolEditor: any

  const plugin = Plugin.define({
    id: "phase-a-host-probe",
    async setup(ctx) {
      await ctx.session.hook("prompt", async (event) => {
        promptCalls.push({
          sessionID: event.sessionID,
          messageID: event.messageID,
          text: event.prompt.text,
          delivery: event.delivery,
          // Snapshot: a later plugin hook must see an earlier hook's mutation.
          ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
        })
        event.prompt.text = `${event.prompt.text} ${PROBE_MARK}`

        // Child-only installation: an identical parent admission runs this same
        // hook but never reaches the installer because only the armed child
        // session ID matches.
        if (!childAdmission.isTarget(event.sessionID)) return

        const mode = childAdmission.state.target?.mode ?? "install"
        childAdmission.state.installCalls.push({ sessionID: event.sessionID, messageID: event.messageID })
        childAdmission.state.sequence.push("installer:start")
        if (mode === "fail") {
          childAdmission.state.failure = CHILD_RULE_FAILURE
          throw new Error(CHILD_RULE_FAILURE)
        }

        const rules = [{ action: CHILD_RULE_ACTION, resource: "*", effect: "deny" as const }]
        await ctx.session.update({ sessionID: event.sessionID, permissions: rules })
        childAdmission.state.installedRules = [...rules]
        childAdmission.state.sequence.push("installer:done")
      })
      await ctx.session.hook("model.request", (event) => {
        modelRequests.push(`${event.sessionID}:${event.kind}`)
      })
      await ctx.session.hook("http.request", (event) => {
        httpRequests.push(event.request.url)
        throw new Error("phase-a probe blocks provider HTTP")
      })
      await ctx.permission.hook("evaluate", (event) => {
        evaluateCalls.push({
          action: event.action,
          effect: event.effect,
          resources: [...event.resources],
          ...(typeof event.message === "string" ? { message: event.message } : {}),
        })
        if (event.action.startsWith("phase-a.probe.")) event.effect = "deny"
      })
      await ctx.tool.transform((editor) => {
        toolEditor = editor
      })
    },
  })

  return {
    plugin,
    promptCalls,
    evaluateCalls,
    modelRequests,
    httpRequests,
    childAdmission,
    getToolEditor: () => toolEditor,
  }
}

type Probe = ReturnType<typeof createProbe>

const AGENTS = {
  orchestrator: { mode: "primary", model: PROBE_MODEL },
  planner: { mode: "subagent", model: PROBE_MODEL },
  explore: { mode: "subagent", model: PROBE_MODEL },
  // The implementer carries an explicit allow for the containment target so the
  // session-rule effect is isolated from the agent-level rule the orchestrator
  // transform installs for worker agents: without the session deny the child is
  // allowed the protected action, and only the installed containment deny
  // changes that decision.
  implementer: {
    mode: "subagent",
    model: PROBE_MODEL,
    permissions: [
      { action: "orchestrator_worktree", resource: "*", effect: "allow" },
      { action: "*", resource: "*", effect: "allow" },
    ],
  },
  reviewer: { mode: "subagent", model: PROBE_MODEL },
  build: { mode: "primary", model: PROBE_MODEL },
  [CHILD_AGENT]: {
    mode: "subagent",
    model: PROBE_MODEL,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  },
}

async function withIsolatedHost<T>(
  run: (input: { host: Awaited<ReturnType<typeof OpenCode.create>>; directory: string; probe: Probe }) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-phase-a-"))
  try {
    const probe = createProbe()
    const host = await OpenCode.create({
      plugins: [(await loadBuiltPlugin()) as any, probe.plugin],
      fs: { filewatcher: false },
      config: { directory, content: JSON.stringify({ agents: AGENTS }) },
    })
    try {
      await activatePlugin(host, directory)
      await waitFor(async () => {
        const plugins = (await host.plugin.list({ location: { directory } })).data as Array<{
          id: string
          status?: string
          state?: { status?: string }
        }>
        return plugins.some(
          (plugin) => plugin.id === "opencode-orchestrator" && (plugin.status ?? plugin.state?.status) === "active",
        )
      })
      probe.promptCalls.length = 0
      probe.evaluateCalls.length = 0
      probe.modelRequests.length = 0
      probe.httpRequests.length = 0
      return await run({ host, directory, probe })
    } finally {
      await host.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
    expect(existsSync(directory)).toBe(false)
  }
}

async function createSession(
  host: Awaited<ReturnType<typeof OpenCode.create>>,
  directory: string,
  title: string,
): Promise<string> {
  const session = await host.session.create({ location: { directory }, title, agent: "build" })
  return session.id
}

async function waitFor(check: () => Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Timed out waiting for isolated host state")
}

/**
 * Creates a child session through the host's own built-in `subagent` tool and
 * aborts at the first progress update, after `Session.create({ parentID })` and
 * before any prompt admission or model dispatch.
 */
async function createChildViaSubagent(
  host: Awaited<ReturnType<typeof OpenCode.create>>,
  probe: Probe,
  parentID: string,
  messageID: string,
  agent: string = CHILD_AGENT,
): Promise<string> {
  const editor = probe.getToolEditor()
  expect(editor).toBeDefined()
  const subagentTool = editor.get("subagent")
  expect(subagentTool).toBeDefined()

  let childID: string | undefined
  await expect(
    subagentTool.execute(
      { agent, description: "phase-a child", prompt: "measurement only", background: true },
      {
        sessionID: parentID,
        agent: "build",
        messageID,
        id: `call_${messageID}`,
        progress: async (update: { sessionID: string }) => {
          childID = update.sessionID
          throw new Error("phase-a probe aborts after child creation")
        },
      },
    ),
  ).rejects.toThrow("phase-a probe aborts after child creation")
  expect(childID).toBeDefined()
  return childID as string
}

describe("phase A pinned-host hook contract", () => {
  test("admits prompt-hook mutations as the canonical prompt data", async () => {
    await withIsolatedHost(async ({ host, directory, probe }) => {
      const sessionID = await createSession(host, directory, "phase-a prompt")

      const admitted = await host.session.prompt({
        sessionID,
        text: "phase-a prompt admission",
        delivery: "queue",
        resume: false,
      })

      // The hook saw the pre-mutation draft exactly once...
      expect(probe.promptCalls).toHaveLength(1)
      expect(probe.promptCalls[0]).toMatchObject({
        sessionID,
        text: "phase-a prompt admission",
        delivery: "queue",
      })
      expect(probe.promptCalls[0]?.messageID).toBe(admitted.id)

      // ...and the mutation is the admitted data returned to the caller and
      // stored in the session inbox.
      expect(admitted.payload.text).toBe(`phase-a prompt admission ${PROBE_MARK}`)
      const inbox = (await host.session.inbox.list({ sessionID })) as Array<{
        id: string
        type: string
        payload: { text?: string }
      }>
      const admittedItems = inbox.filter((item) => item.type === "user")
      expect(admittedItems).toHaveLength(1)
      expect(admittedItems[0]?.id).toBe(admitted.id)
      expect(admittedItems[0]?.payload.text).toBe(`phase-a prompt admission ${PROBE_MARK}`)

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  })

  test("does not re-run prompt hooks when the same message ID is resubmitted", async () => {
    await withIsolatedHost(async ({ host, directory, probe }) => {
      const sessionID = await createSession(host, directory, "phase-a retry")

      const first = await host.session.prompt({
        sessionID,
        text: "phase-a original",
        delivery: "queue",
        resume: false,
      })
      expect(first.payload.text).toBe(`phase-a original ${PROBE_MARK}`)
      expect(probe.promptCalls).toHaveLength(1)

      const retry = await host.session.prompt({
        sessionID,
        id: first.id,
        text: "phase-a retry",
        delivery: "queue",
        resume: false,
      })

      // The retry returns the original admission and does not re-run the hook.
      expect(retry.id).toBe(first.id)
      expect(retry.payload.text).toBe(first.payload.text)
      expect(retry.payload.text).not.toContain("phase-a retry")
      expect(probe.promptCalls).toHaveLength(1)
      const inbox = await host.session.inbox.list({ sessionID })
      expect(inbox).toHaveLength(1)

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  })

  test("lets permission evaluation hooks observe allow and ask and change them to deny", async () => {
    await withIsolatedHost(async ({ host, directory, probe }) => {
      const sessionID = await createSession(host, directory, "phase-a permission")

      await host.session.update({
        sessionID,
        permissions: [{ action: "phase-a.probe.ask", resource: "*", effect: "ask" }],
      })

      // `phase-a.probe.allow` has no matching session rule, so the agent's
      // allow-all rule yields `allow`; the session `ask` rule wins for the
      // other action (last match wins). The hook sees both and flips both.
      const allow = await host.permission.create({ sessionID, action: "phase-a.probe.allow", resources: ["target"] })
      const ask = await host.permission.create({ sessionID, action: "phase-a.probe.ask", resources: ["target"] })
      expect(allow.effect).toBe("deny")
      expect(ask.effect).toBe("deny")

      expect(probe.evaluateCalls.filter((call) => call.action.startsWith("phase-a.probe."))).toEqual([
        { action: "phase-a.probe.allow", effect: "allow", resources: ["target"] },
        { action: "phase-a.probe.ask", effect: "ask", resources: ["target"] },
      ])

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  })

  test("keeps a configured deny final and bypasses the permission hook", async () => {
    await withIsolatedHost(async ({ host, directory, probe }) => {
      const sessionID = await createSession(host, directory, "phase-a configured deny")

      await host.session.update({
        sessionID,
        permissions: [
          { action: "phase-a.probe.ask", resource: "*", effect: "ask" },
          { action: "phase-a.probe.deny", resource: "*", effect: "deny" },
        ],
      })

      const denied = await host.permission.create({
        sessionID,
        action: "phase-a.probe.deny",
        resources: ["target"],
      })
      expect(denied.effect).toBe("deny")
      expect(probe.evaluateCalls.filter((call) => call.action === "phase-a.probe.deny")).toHaveLength(0)

      // The hook is live for the same session: the `ask` action still reaches it.
      const asked = await host.permission.create({ sessionID, action: "phase-a.probe.ask", resources: ["target"] })
      expect(asked.effect).toBe("deny")
      expect(probe.evaluateCalls.filter((call) => call.action === "phase-a.probe.ask")).toHaveLength(1)

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  })

  test("inherits parent permission rules into a newly created child session", async () => {
    await withIsolatedHost(async ({ host, directory, probe }) => {
      const parentID = await createSession(host, directory, "phase-a parent")
      const editor = probe.getToolEditor()
      expect(editor).toBeDefined()
      const subagentTool = editor.get("subagent")
      expect(subagentTool).toBeDefined()

      // The built-in subagent tool is the host's own `parentID` creation path.
      // Abort it at its first progress update so the child is created but never
      // prompted or woken: measurement without any model dispatch.
      const createChild = async (): Promise<string> => {
        let childID: string | undefined
        await expect(
          subagentTool.execute(
            { agent: CHILD_AGENT, description: "phase-a child", prompt: "measurement only", background: true },
            {
              sessionID: parentID,
              agent: "build",
              messageID: "msg_phase_a_child",
              id: "call_phase_a_child",
              progress: async (update: { sessionID: string }) => {
                childID = update.sessionID
                throw new Error("phase-a probe aborts after child creation")
              },
            },
          ),
        ).rejects.toThrow("phase-a probe aborts after child creation")
        expect(childID).toBeDefined()
        return childID as string
      }

      // Baseline: a child created while the parent has no rules is not denied.
      const childBefore = await createChild()
      const childBeforeSession = await host.session.get({ sessionID: childBefore })
      expect(childBeforeSession.parentID).toBe(parentID)
      expect(childBeforeSession.permissions ?? []).toEqual([])
      const baseline = await host.permission.create({
        sessionID: childBefore,
        action: "phase-a.child.blocked",
        resources: ["target"],
      })
      expect(baseline.effect).toBe("allow")

      const rules = [
        { action: "phase-a.probe.ask", resource: "*", effect: "ask" },
        { action: "phase-a.child.blocked", resource: "*", effect: "deny" },
      ]
      await host.session.update({ sessionID: parentID, permissions: rules })

      // A child created after the rule is set inherits the rule snapshot and
      // the inherited deny is final for the child session.
      const childAfter = await createChild()
      const childAfterSession = await host.session.get({ sessionID: childAfter })
      expect(childAfterSession.parentID).toBe(parentID)
      expect(childAfterSession.permissions).toEqual(rules)
      const inheritedDeny = await host.permission.create({
        sessionID: childAfter,
        action: "phase-a.child.blocked",
        resources: ["target"],
      })
      expect(inheritedDeny.effect).toBe("deny")
      expect(probe.evaluateCalls.filter((call) => call.action === "phase-a.child.blocked")).toEqual([
        { action: "phase-a.child.blocked", effect: "allow", resources: ["target"] },
      ])

      // Inheritance is a creation-time snapshot: the earlier child keeps its
      // inherited (empty) ruleset and does not observe the later parent rule.
      const stale = await host.session.get({ sessionID: childBefore })
      expect(stale.permissions ?? []).toEqual([])
      const staleDecision = await host.permission.create({
        sessionID: childBefore,
        action: "phase-a.child.blocked",
        resources: ["target"],
      })
      expect(staleDecision.effect).toBe("allow")

      const children = await host.session.list({ parentID: parentID })
      expect(children.data.map((session: { id: string }) => session.id).sort()).toEqual([childBefore, childAfter].sort())

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  })

  test("installs a child-only deny rule during the child's own prompt admission", async () => {
    await withIsolatedHost(async ({ host, directory, probe }) => {
      const parentID = await createSession(host, directory, "phase-a admission parent")
      const childID = await createChildViaSubagent(host, probe, parentID, "msg_phase_a_admission_child")
      const childBefore = await host.session.get({ sessionID: childID })
      expect(childBefore.parentID).toBe(parentID)
      expect(childBefore.permissions ?? []).toEqual([])

      probe.childAdmission.arm(childID, "install")

      // Child-only: an identical parent admission runs the same (armed) prompt
      // hook, but the installer never runs because only the child session ID
      // matches.
      const parentAdmitted = await host.session.prompt({
        sessionID: parentID,
        text: "phase-a parent admission",
        delivery: "queue",
        resume: false,
      })
      expect(probe.promptCalls.filter((call) => call.sessionID === parentID)).toHaveLength(1)
      expect(parentAdmitted.payload.text).toBe(`phase-a parent admission ${PROBE_MARK}`)
      expect(probe.childAdmission.state.installCalls).toEqual([])
      // ...and the parent's rule set stays empty.
      expect((await host.session.get({ sessionID: parentID })).permissions ?? []).toEqual([])

      // Baseline: with no rule on either session, the parent is allowed and the
      // evaluation hook observes that decision.
      const parentBefore = await host.permission.create({
        sessionID: parentID,
        action: CHILD_RULE_ACTION,
        resources: ["target"],
      })
      expect(parentBefore.effect).toBe("allow")
      const hookCallsBeforeChild = probe.evaluateCalls.filter((call) => call.action === CHILD_RULE_ACTION).length
      expect(hookCallsBeforeChild).toBe(1)

      // The child message admission runs the installer inside the child's prompt
      // hook; the hook is awaited, so admission cannot complete before
      // `session.update` has finished.
      const admitted = await host.session.prompt({
        sessionID: childID,
        text: "phase-a child admission",
        delivery: "queue",
        resume: false,
      })
      probe.childAdmission.state.sequence.push("test:admission-resolved")

      expect(probe.childAdmission.state.sequence).toEqual([
        "installer:start",
        "installer:done",
        "test:admission-resolved",
      ])
      expect(probe.childAdmission.state.installCalls).toEqual([{ sessionID: childID, messageID: admitted.id }])
      expect(probe.childAdmission.state.installedRules).toEqual([
        { action: CHILD_RULE_ACTION, resource: "*", effect: "deny" },
      ])
      expect(admitted.payload.text).toBe(`phase-a child admission ${PROBE_MARK}`)

      // The rule write is observable on the child immediately after admission,
      // with no polling.
      expect((await host.session.get({ sessionID: childID })).permissions).toEqual([
        { action: CHILD_RULE_ACTION, resource: "*", effect: "deny" },
      ])

      // The installed rule is final for the child's tested action: deny with no
      // new evaluation-hook event for that action.
      const childDecision = await host.permission.create({
        sessionID: childID,
        action: CHILD_RULE_ACTION,
        resources: ["target"],
      })
      expect(childDecision.effect).toBe("deny")
      expect(probe.evaluateCalls.filter((call) => call.action === CHILD_RULE_ACTION)).toHaveLength(hookCallsBeforeChild)

      // The parent remains allowed for the same action after the child's rule.
      const parentAfter = await host.permission.create({
        sessionID: parentID,
        action: CHILD_RULE_ACTION,
        resources: ["target"],
      })
      expect(parentAfter.effect).toBe("allow")
      expect(probe.evaluateCalls.filter((call) => call.action === CHILD_RULE_ACTION)).toHaveLength(
        hookCallsBeforeChild + 1,
      )

      // Resubmitting the same admitted child message ID returns the original
      // admission, does not re-run the installer, and adds no inbox item.
      const retry = await host.session.prompt({
        sessionID: childID,
        id: admitted.id,
        text: "phase-a child retry",
        delivery: "queue",
        resume: false,
      })
      expect(retry.id).toBe(admitted.id)
      expect(retry.payload.text).toBe(admitted.payload.text)
      expect(probe.childAdmission.state.installCalls).toEqual([{ sessionID: childID, messageID: admitted.id }])
      expect(probe.promptCalls.filter((call) => call.sessionID === childID)).toHaveLength(1)
      expect(await host.session.inbox.list({ sessionID: childID })).toHaveLength(1)

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  }, CHILD_SESSION_TEST_TIMEOUT)

  test("blocks child admission and creates no inbox item when the child rule installer fails", async () => {
    await withIsolatedHost(async ({ host, directory, probe }) => {
      const parentID = await createSession(host, directory, "phase-a failure parent")
      const childID = await createChildViaSubagent(host, probe, parentID, "msg_phase_a_failure_child")

      probe.childAdmission.arm(childID, "fail")

      // The host rejects the admission; the deliberate installer error is not
      // propagated verbatim (the pinned host wraps hook failures as
      // `UnexpectedStatus`), so the probe state below proves who failed.
      const admissionError = await host.session
        .prompt({
          sessionID: childID,
          text: "phase-a failing admission",
          delivery: "queue",
          resume: false,
        })
        .catch((error: unknown) => error as Error)
      expect(admissionError).toBeInstanceOf(Error)
      expect(admissionError.message).toBe("UnexpectedStatus")

      // The installer was attempted exactly once for the child and failed before
      // writing any rule.
      expect(probe.childAdmission.state.installCalls).toEqual([
        { sessionID: childID, messageID: expect.any(String) },
      ])
      expect(probe.childAdmission.state.failure).toBe(CHILD_RULE_FAILURE)
      expect(probe.childAdmission.state.installedRules).toBeNull()
      expect(probe.childAdmission.state.sequence).toEqual(["installer:start"])

      // The failed hook prevented admission: no inbox item and no child rule.
      expect(await host.session.inbox.list({ sessionID: childID })).toEqual([])
      expect((await host.session.get({ sessionID: childID })).permissions ?? []).toEqual([])

      // The failure is contained to the child; the parent stays allowed.
      const parentDecision = await host.permission.create({
        sessionID: parentID,
        action: CHILD_RULE_ACTION,
        resources: ["target"],
      })
      expect(parentDecision.effect).toBe("allow")

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  }, CHILD_SESSION_TEST_TIMEOUT)
})

/**
 * Phase A production authority: the same pinned host, booted with the real
 * built plugin under `authority.mode: "enforce"` (and default-off controls).
 *
 * `REFUSING_OPTIONS` configures `stop-between-steps` with a token limit and no
 * usage snapshot: the shared dispatch gate fails closed deterministically
 * without any provider call. `ALLOWING_OPTIONS` keeps the gate allowing.
 * Every admission uses `delivery: "queue"` with `resume: false`, and every
 * case asserts zero provider activity.
 */
describe("phase A production runtime authority (authority.mode enforce)", () => {
  test("admits a tagged plugin dispatch and appends bounded admission metadata", async () => {
    await withAuthorityHost(ALLOWING_OPTIONS, async ({ host, directory, probe }) => {
      const sessionID = await createSession(host, directory, "phase-a authority allow")

      const admitted = await host.session.prompt({
        sessionID,
        text: "phase-a authority dispatch",
        delivery: "queue",
        resume: false,
        metadata: { caller: "kept", ...authorityMarker("command") },
      })

      // Allowed tagged dispatch: caller metadata is preserved and the bounded
      // admission marker is appended.
      expect(admitted.payload.text).toBe(`phase-a authority dispatch ${PROBE_MARK}`)
      expect(admitted.payload.metadata).toEqual({
        caller: "kept",
        [AUTHORITY_KEY]: { version: 1, dispatch: "command", admitted: true },
      })
      const inbox = (await host.session.inbox.list({ sessionID })) as Array<{ payload: { metadata?: unknown } }>
      expect(inbox).toHaveLength(1)
      expect(inbox[0]?.payload.metadata).toEqual(admitted.payload.metadata)

      // The probe's later prompt hook observed the production hook's mutation,
      // and the parent (non-child) session gained no permission rules.
      expect(probe.promptCalls).toHaveLength(1)
      expect(probe.promptCalls[0]?.metadata).toEqual(admitted.payload.metadata)
      expect((await host.session.get({ sessionID })).permissions ?? []).toEqual([])

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  })

  test("blocks a tagged dispatch at a refusing gate and creates no inbox item", async () => {
    await withAuthorityHost(REFUSING_OPTIONS, async ({ host, directory, probe }) => {
      const sessionID = await createSession(host, directory, "phase-a authority block")

      // The hook throws before admission; the pinned host wraps hook failures.
      const firstError = await host.session
        .prompt({
          sessionID,
          text: "phase-a blocked dispatch",
          delivery: "queue",
          resume: false,
          metadata: authorityMarker("command"),
        })
        .catch((error: unknown) => error as Error)
      expect(firstError).toBeInstanceOf(Error)
      expect(firstError.message).toBe("UnexpectedStatus")
      expect(await host.session.inbox.list({ sessionID })).toEqual([])

      // Retries are not an exactly-once boundary: a second tagged attempt is
      // re-checked at admission and also refused, still with no inbox item.
      const secondError = await host.session
        .prompt({
          sessionID,
          text: "phase-a blocked dispatch retry",
          delivery: "queue",
          resume: false,
          metadata: authorityMarker("continuation"),
        })
        .catch((error: unknown) => error as Error)
      expect(secondError).toBeInstanceOf(Error)
      expect(await host.session.inbox.list({ sessionID })).toEqual([])
      expect(probe.promptCalls.filter((call) => call.sessionID === sessionID)).toHaveLength(0)

      // Enforcement is limited to tagged plugin-owned dispatches: an untagged
      // prompt is admitted normally even while the gate refuses.
      const untagged = await host.session.prompt({
        sessionID,
        text: "phase-a untagged prompt",
        delivery: "queue",
        resume: false,
      })
      expect(untagged.payload.text).toBe(`phase-a untagged prompt ${PROBE_MARK}`)
      expect(await host.session.inbox.list({ sessionID })).toHaveLength(1)

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  })

  test("downgrades selected plugin permission actions with a truthful message and keeps configured denies final", async () => {
    await withAuthorityHost(REFUSING_OPTIONS, async ({ host, directory, probe }) => {
      const sessionID = await createSession(host, directory, "phase-a authority permission")

      // Selected action: the production hook flips allow to deny and sets a
      // bounded truthful message; the later probe hook observes both.
      const enforced = await host.permission.create({ sessionID, action: ENFORCED_ACTION, resources: ["target"] })
      expect(enforced.effect).toBe("deny")
      const enforcedCall = probe.evaluateCalls.find((call) => call.action === ENFORCED_ACTION)
      expect(enforcedCall?.effect).toBe("deny")
      expect(enforcedCall?.message).toContain(`denied ${ENFORCED_ACTION}`)
      expect(enforcedCall?.message).toContain("budget exceeded")
      expect(enforcedCall?.message).toContain("stop-between-steps fails closed")
      expect(enforcedCall?.message?.length).toBeLessThanOrEqual(400)

      // Unrelated action: untouched by the production hook and still observed.
      const unrelated = await host.permission.create({ sessionID, action: UNRELATED_ACTION, resources: ["target"] })
      expect(unrelated.effect).toBe("allow")
      expect(probe.evaluateCalls.filter((call) => call.action === UNRELATED_ACTION).map((call) => call.effect)).toEqual([
        "allow",
      ])

      // The read-only bounded-review recovery surface stays available on
      // purpose: an open circuit must remain recoverable.
      const recovery = await host.permission.create({ sessionID, action: RECOVERY_ACTION, resources: ["target"] })
      expect(recovery.effect).toBe("allow")

      // Configured deny is final: it bypasses the whole evaluation hook chain,
      // including the production hook, while the same session's ask action
      // still reaches the chain.
      await host.session.update({
        sessionID,
        permissions: [
          { action: ENFORCED_ACTION, resource: "*", effect: "deny" },
          { action: UNRELATED_ACTION, resource: "*", effect: "ask" },
        ],
      })
      const hookCallsBefore = probe.evaluateCalls.filter((call) => call.action === ENFORCED_ACTION).length
      const configuredDeny = await host.permission.create({ sessionID, action: ENFORCED_ACTION, resources: ["target"] })
      expect(configuredDeny.effect).toBe("deny")
      expect(probe.evaluateCalls.filter((call) => call.action === ENFORCED_ACTION)).toHaveLength(hookCallsBefore)
      const asked = await host.permission.create({ sessionID, action: UNRELATED_ACTION, resources: ["target"] })
      expect(asked.effect).toBe("ask")
      expect(probe.evaluateCalls.filter((call) => call.action === UNRELATED_ACTION).length).toBeGreaterThan(1)

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  })

  test("installs child-only containment denies on a configured-role child during its own admission", async () => {
    await withAuthorityHost(ALLOWING_OPTIONS, async ({ host, directory, probe }) => {
      const parentID = await createSession(host, directory, "phase-a containment parent")
      const inherited = [{ action: "phase-a.keep", resource: "*", effect: "allow" as const }]
      await host.session.update({ sessionID: parentID, permissions: inherited })

      const childID = await createChildViaSubagent(host, probe, parentID, "msg_phase_a_role_child", ROLE_CHILD_AGENT)
      const childBefore = await host.session.get({ sessionID: childID })
      expect(childBefore.parentID).toBe(parentID)
      expect(childBefore.agent).toBe(ROLE_CHILD_AGENT)
      // The child inherited the parent's rule snapshot and is allowed the
      // protected action before containment is installed.
      expect(childBefore.permissions).toEqual(inherited)
      const childBaseline = await host.permission.create({
        sessionID: childID,
        action: PROTECTED_ACTION,
        resources: ["target"],
      })
      expect(childBaseline.effect).toBe("allow")
      expect(probe.evaluateCalls.filter((call) => call.action === PROTECTED_ACTION)).toHaveLength(1)

      const admitted = await host.session.prompt({
        sessionID: childID,
        text: "phase-a child containment",
        delivery: "queue",
        resume: false,
      })
      expect(admitted.payload.text).toBe(`phase-a child containment ${PROBE_MARK}`)

      // Existing child rules are preserved verbatim; exactly the missing exact
      // denies are appended once each.
      const childAfter = await host.session.get({ sessionID: childID })
      const childRules = (childAfter.permissions ?? []) as Array<{ action: string; resource: string; effect: string }>
      expect(childRules.slice(0, inherited.length)).toEqual(inherited)
      expect(childRules).toHaveLength(inherited.length + CONTAINMENT_ACTIONS.length)
      for (const action of CONTAINMENT_ACTIONS) {
        expect(
          childRules.filter((rule) => rule.action === action && rule.resource === "*" && rule.effect === "deny"),
          action,
        ).toHaveLength(1)
      }

      // The installed session deny is final for the protected action: deny with
      // no new evaluation-hook event for that action.
      const childDecision = await host.permission.create({
        sessionID: childID,
        action: PROTECTED_ACTION,
        resources: ["target"],
      })
      expect(childDecision.effect).toBe("deny")
      expect(probe.evaluateCalls.filter((call) => call.action === PROTECTED_ACTION)).toHaveLength(1)

      // The parent keeps its rule set and its allow decision: no parent rule is
      // installed or cleared.
      expect((await host.session.get({ sessionID: parentID })).permissions).toEqual(inherited)
      const parentDecision = await host.permission.create({
        sessionID: parentID,
        action: PROTECTED_ACTION,
        resources: ["target"],
      })
      expect(parentDecision.effect).toBe("allow")
      expect(probe.evaluateCalls.filter((call) => call.action === PROTECTED_ACTION)).toHaveLength(2)

      // A non-role child (custom agent, still parented) is never touched.
      const otherChildID = await createChildViaSubagent(host, probe, parentID, "msg_phase_a_nonrole_child")
      const otherBefore = await host.session.get({ sessionID: otherChildID })
      expect(otherBefore.parentID).toBe(parentID)
      expect(otherBefore.agent).toBe(CHILD_AGENT)
      const otherBaseline = await host.permission.create({
        sessionID: otherChildID,
        action: PROTECTED_ACTION,
        resources: ["target"],
      })
      expect(otherBaseline.effect).toBe("allow")
      await host.session.prompt({
        sessionID: otherChildID,
        text: "phase-a non-role child admission",
        delivery: "queue",
        resume: false,
      })
      expect((await host.session.get({ sessionID: otherChildID })).permissions ?? []).toEqual(inherited)

      // A later new message on the role child is idempotent: identical rule set,
      // no duplicate denies.
      await host.session.prompt({
        sessionID: childID,
        text: "phase-a child containment 2",
        delivery: "queue",
        resume: false,
      })
      const childAgain = await host.session.get({ sessionID: childID })
      expect(childAgain.permissions).toEqual(childAfter.permissions)
      expect(
        ((childAgain.permissions ?? []) as Array<{ action: string; resource: string; effect: string }>).filter(
          (rule) => rule.action === PROTECTED_ACTION && rule.resource === "*" && rule.effect === "deny",
        ),
      ).toHaveLength(1)

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  }, CHILD_SESSION_TEST_TIMEOUT)

  test("blocks child admission and creates no inbox item when containment installation fails", async () => {
    await withAuthorityHost(ALLOWING_OPTIONS, async ({ host, directory, probe, faults }) => {
      const parentID = await createSession(host, directory, "phase-a containment failure parent")
      const inherited = [{ action: "phase-a.keep", resource: "*", effect: "allow" as const }]
      await host.session.update({ sessionID: parentID, permissions: inherited })
      const childID = await createChildViaSubagent(host, probe, parentID, "msg_phase_a_containment_failure", ROLE_CHILD_AGENT)

      // Fault injection: only this child's rule write inside the production
      // prompt hook fails.
      faults.failRulesFor = childID

      const admissionError = await host.session
        .prompt({ sessionID: childID, text: "phase-a failing containment", delivery: "queue", resume: false })
        .catch((error: unknown) => error as Error)
      expect(admissionError).toBeInstanceOf(Error)
      expect(admissionError.message).toBe("UnexpectedStatus")

      // The failed hook prevented admission: no inbox item and no rule write.
      expect(await host.session.inbox.list({ sessionID: childID })).toEqual([])
      expect((await host.session.get({ sessionID: childID })).permissions).toEqual(inherited)

      // The failure is contained to the child; the parent is unchanged.
      expect((await host.session.get({ sessionID: parentID })).permissions).toEqual(inherited)

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  }, CHILD_SESSION_TEST_TIMEOUT)

  test("default off registers no authority behavior even with a refusing gate", async () => {
    await withAuthorityHost(DEFAULT_OFF_OPTIONS, async ({ host, directory, probe }) => {
      const sessionID = await createSession(host, directory, "phase-a default off")

      // A tagged prompt is admitted unchanged: no production admission marker
      // is appended and the caller metadata is byte-identical.
      const tagged = { caller: "kept", ...authorityMarker("command") }
      const admitted = await host.session.prompt({
        sessionID,
        text: "phase-a default-off dispatch",
        delivery: "queue",
        resume: false,
        metadata: tagged,
      })
      expect(admitted.payload.metadata).toEqual(tagged)
      expect(probe.promptCalls[0]?.metadata).toEqual(tagged)

      // No permission downgrade: the selected action stays allow.
      const enforced = await host.permission.create({ sessionID, action: ENFORCED_ACTION, resources: ["target"] })
      expect(enforced.effect).toBe("allow")
      expect(probe.evaluateCalls.find((call) => call.action === ENFORCED_ACTION)?.effect).toBe("allow")

      // No containment rules are installed on a configured-role child.
      const childID = await createChildViaSubagent(host, probe, sessionID, "msg_phase_a_default_off_child", ROLE_CHILD_AGENT)
      await host.session.prompt({ sessionID: childID, text: "phase-a default-off child", delivery: "queue", resume: false })
      expect((await host.session.get({ sessionID: childID })).permissions ?? []).toEqual([])
      const childDecision = await host.permission.create({
        sessionID: childID,
        action: PROTECTED_ACTION,
        resources: ["target"],
      })
      expect(childDecision.effect).toBe("allow")

      expect(probe.modelRequests).toEqual([])
      expect(probe.httpRequests).toEqual([])
    })
  }, CHILD_SESSION_TEST_TIMEOUT)
})
