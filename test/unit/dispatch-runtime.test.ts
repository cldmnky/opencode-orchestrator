import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { startDispatchAdmission, DISPATCH_ADMISSION_LIMITS } from "../../src/opencode-v2/dispatch/runtime.js"

type HookName = "execute.before" | "execute.after"

function harness(maxParallel = 2) {
  const hooks = new Map<HookName, (event: unknown) => Promise<void> | void>()
  const disposed: string[] = []
  const sessions = new Map<string, unknown>()
  const tool = {
    async hook(name: HookName, callback: (event: unknown) => Promise<void> | void) {
      hooks.set(name, callback)
      return {
        async dispose() {
          disposed.push(name)
        },
      }
    },
  }
  return {
    hooks,
    disposed,
    sessions,
    tool,
    options: parseOptions({ max_parallel: maxParallel }),
  }
}

function event(id: string, sessionID: string, agent = "orchestrator", target = "implementer") {
  return {
    id,
    tool: "subagent",
    sessionID,
    agent,
    messageID: `message-${id}`,
    input: { agent: target, description: "test", prompt: "test", background: false },
  }
}

async function start(h: ReturnType<typeof harness>) {
  const runtime = await startDispatchAdmission({
    options: h.options,
    session: { get: async ({ sessionID }) => h.sessions.get(sessionID) },
    tool: h.tool,
  })
  return runtime
}

describe("dispatch admission runtime", () => {
  test("admits up to max_parallel per root and releases on after", async () => {
    const h = harness(2)
    h.sessions.set("root", { id: "root" })
    const runtime = await start(h)
    const before = h.hooks.get("execute.before")!
    const after = h.hooks.get("execute.after")!

    await before(event("one", "root"))
    await before(event("two", "root"))
    await expect(before(event("three", "root"))).rejects.toThrow("max_parallel=2")
    await after({ ...event("one", "root"), status: "error", error: { message: "child failed" } })
    await before(event("three", "root"))
    await runtime.dispose()
    expect(h.disposed).toEqual(["execute.after", "execute.before"])
  })

  test("nested configured-role sessions share the root ceiling", async () => {
    const h = harness(1)
    h.sessions.set("root", { id: "root" })
    h.sessions.set("child", { id: "child", parentID: "root" })
    const runtime = await start(h)
    const before = h.hooks.get("execute.before")!
    const after = h.hooks.get("execute.after")!

    await before(event("root-call", "root"))
    await expect(before(event("nested-call", "child", "implementer"))).rejects.toThrow("max_parallel=1")
    await after({ ...event("root-call", "root"), status: "completed", result: {} })
    await before(event("nested-call", "child", "implementer"))
    await runtime.dispose()
  })

  test("different roots do not block one another", async () => {
    const h = harness(1)
    h.sessions.set("root-a", { id: "root-a" })
    h.sessions.set("root-b", { id: "root-b" })
    const runtime = await start(h)
    const before = h.hooks.get("execute.before")!

    await before(event("a", "root-a"))
    await before(event("b", "root-b"))
    await runtime.dispose()
  })

  test("ignores unrelated tools and agents but refuses unreadable plugin-owned parents", async () => {
    const h = harness(1)
    h.sessions.set("root", { id: "root" })
    const runtime = await start(h)
    const before = h.hooks.get("execute.before")!

    await before({ ...event("other-tool", "root"), tool: "shell" })
    await before(event("other-agent", "root", "external-agent", "external-agent"))
    await expect(before(event("unknown-parent", "missing"))).rejects.toThrow("could not resolve")
    await runtime.dispose()
  })

  test("bounds are explicit and disposal clears admission state", async () => {
    expect(DISPATCH_ADMISSION_LIMITS.maxSessionDepth).toBe(32)
    expect(DISPATCH_ADMISSION_LIMITS.maxActiveCalls).toBe(1024)
    const h = harness(1)
    h.sessions.set("root", { id: "root" })
    const runtime = await start(h)
    const before = h.hooks.get("execute.before")!
    await before(event("one", "root"))
    await runtime.dispose()
    const restarted = await start(h)
    await h.hooks.get("execute.before")!(event("two", "root"))
    await restarted.dispose()
  })
})
