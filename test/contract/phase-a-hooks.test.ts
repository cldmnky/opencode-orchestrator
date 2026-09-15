import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"

/**
 * Phase A pinned-host probe (measurement only; no N1/N2 enforcement).
 *
 * These contract tests record what the pinned beta-19507 host actually does for
 * the three runtime-authority surfaces the plan's N1/N2 items depend on:
 *
 *   1. `session.hook("prompt")` mutations become the admitted prompt data.
 *   2. Resubmitting an already-admitted message ID does not re-run prompt hooks.
 *   3. `permission.hook("evaluate")` observes `allow`/`ask` and can change them
 *      to `deny`.
 *   4. A configured `deny` rule is final and bypasses the evaluation hook.
 *   5. Parent session `permission.rules` are inherited by a newly created child
 *      session and deny the tested action.
 *   6. Opt-in child-only admission probe (N2 direction): during the
 *      subagent-created child's own `session.hook("prompt")` admission, the
 *      probe can install — or deliberately fail to install — a deny rule on
 *      that child only, through the same awaited prompt hook.
 *
 * Harness facts:
 *   - Each test boots an isolated `OpenCode.create` host that directly loads the
 *     built `dist/index.js` entry (run `bun run build` first) plus a test-only
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
const BUILT_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url))

type PromptCall = {
  sessionID: string
  messageID: string
  text: string
  delivery: string
}

type EvaluateCall = {
  action: string
  effect: string
  resources: readonly string[]
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
        await ctx.permission.rules({ sessionID: event.sessionID, permissions: rules })
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
  implementer: { mode: "subagent", model: PROBE_MODEL },
  reviewer: { mode: "subagent", model: PROBE_MODEL },
  build: { mode: "primary", model: PROBE_MODEL },
  [CHILD_AGENT]: { mode: "subagent", model: PROBE_MODEL },
}

let cachedBuiltPlugin: unknown

async function loadBuiltPlugin(): Promise<unknown> {
  if (!existsSync(BUILT_ENTRY)) {
    throw new Error(`missing built entry ${BUILT_ENTRY}; run \`bun run build\` before this contract suite`)
  }
  if (cachedBuiltPlugin === undefined) cachedBuiltPlugin = (await import(BUILT_ENTRY)).default
  return cachedBuiltPlugin
}

async function withIsolatedHost<T>(
  run: (input: { host: Awaited<ReturnType<typeof OpenCode.create>>; directory: string; probe: Probe }) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-phase-a-"))
  try {
    const probe = createProbe()
    const host = await OpenCode.create({
      plugins: [(await loadBuiltPlugin()) as any, probe.plugin],
      config: { directory, content: JSON.stringify({ agents: AGENTS }) },
    })
    try {
      await host.plugin.awaitActivation()
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
): Promise<string> {
  const editor = probe.getToolEditor()
  expect(editor).toBeDefined()
  const subagentTool = editor.get("subagent")
  expect(subagentTool).toBeDefined()

  let childID: string | undefined
  await expect(
    subagentTool.execute(
      { agent: CHILD_AGENT, description: "phase-a child", prompt: "measurement only", background: true },
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

      await host.permission.rules({
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

      await host.permission.rules({
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
      await host.permission.rules({ sessionID: parentID, permissions: rules })

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
      // `permission.rules` has finished.
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
  })

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
  })
})
