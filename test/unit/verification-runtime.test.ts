import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { verificationCommandDigest } from "../../src/core/verification.js"
import { startVerificationRuntime } from "../../src/opencode-v2/verification/runtime.js"
import { listVerificationReceipts, parseVerificationReceipt } from "../../src/opencode-v2/verification/state.js"

const location = { directory: "/workspace", project: { id: "project" } }
const HEAD = "a".repeat(40)

function harness() {
  const values = new Map<string, unknown>()
  const hooks = new Map<string, (event: unknown) => Promise<void> | void>()
  const disposed: string[] = []
  const storage = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => void values.set(key, value),
    remove: async (key: string) => void values.delete(key),
    scan: async ({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) => {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit ?? 100)
        .map(([key, value]) => ({ key, value }))
      return { entries }
    },
  }
  const tool = {
    hook: async (name: "execute.before" | "execute.after", callback: (event: unknown) => Promise<void> | void) => {
      hooks.set(name, callback)
      return { dispose: async () => void disposed.push(name) }
    },
  }
  const session = {
    get: async ({ sessionID }: { sessionID: string }) =>
      sessionID === "child"
        ? { id: "child", parentID: "root", location: { directory: "/workspace" } }
        : { id: "root", location: { directory: "/workspace" } },
  }
  const runner = {
    run: async (_cmd: string, args: readonly string[]) => ({
      exitCode: 0,
      stdout: args[1] === "--show-toplevel" ? "/workspace\n" : `${HEAD}\n`,
      stderr: "",
    }),
  }
  return { values, hooks, disposed, storage, tool, session, runner }
}

describe("verification runtime", () => {
  test("writes a bounded pass receipt only after a paired observed shell call", async () => {
    const h = harness()
    const runtime = await startVerificationRuntime({ options: parseOptions({}), location, ...h, redact: (value) => value })
    await h.hooks.get("execute.before")!({
      id: "call-1",
      tool: "shell",
      sessionID: "child",
      agent: "orchestrator",
      messageID: "message-1",
      input: { command: "bun test" },
    })
    await h.hooks.get("execute.after")!({
      id: "call-1",
      tool: "shell",
      sessionID: "child",
      agent: "orchestrator",
      messageID: "message-1",
      input: { command: "bun test" },
      status: "completed",
      result: { output: { exit: 0, status: "completed" }, metadata: { exit: 0 } },
    })
    const receipts = await listVerificationReceipts(h.storage, location, "root")
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      rootSessionID: "root",
      sessionID: "child",
      agentID: "orchestrator",
      status: "pass",
      exitCode: 0,
      repository: { headSha: HEAD },
      commandDigest: verificationCommandDigest("bun test"),
    })
    expect(parseVerificationReceipt(receipts[0])).toEqual(receipts[0])
    await runtime.dispose()
    expect(h.disposed).toEqual(["execute.after", "execute.before"])
  })

  test("persists non-zero exits only as failed receipts and rejects unknown shapes", async () => {
    const h = harness()
    const runtime = await startVerificationRuntime({ options: parseOptions({}), location, ...h })
    const before = h.hooks.get("execute.before")!
    const after = h.hooks.get("execute.after")!
    await before({ id: "fail", tool: "shell", sessionID: "root", agent: "orchestrator", messageID: "m", input: { command: "false" } })
    await after({
      id: "fail",
      tool: "shell",
      sessionID: "root",
      agent: "orchestrator",
      messageID: "m",
      input: { command: "false" },
      status: "completed",
      result: { output: { exit: 7 }, metadata: { exit: 7 } },
    })
    await before({ id: "unknown", tool: "shell", sessionID: "root", agent: "orchestrator", messageID: "m", input: {} })
    await after({ id: "unknown", tool: "shell", sessionID: "root", agent: "orchestrator", messageID: "m", status: "completed", result: {} })
    const receipts = await listVerificationReceipts(h.storage, location, "root")
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.status).toBe("fail")
    expect(receipts[0]?.exitCode).toBe(7)
    await runtime.dispose()
  })

  test("drops out-of-order, mismatched, moved, and missing-Git observations", async () => {
    const h = harness()
    let moved = false
    h.session.get = async ({ sessionID }: { sessionID: string }) =>
      sessionID === "child"
        ? { id: "child", parentID: "root", location: { directory: moved ? "/moved" : "/workspace" } }
        : { id: "root", location: { directory: "/workspace" } }
    const runtime = await startVerificationRuntime({ options: parseOptions({}), location, ...h })
    const before = h.hooks.get("execute.before")!
    const after = h.hooks.get("execute.after")!

    await after({
      id: "orphan",
      tool: "shell",
      sessionID: "root",
      agent: "orchestrator",
      messageID: "m",
      status: "completed",
      result: { output: { exit: 0 }, metadata: { exit: 0 } },
    })
    await before({ id: "mismatch", tool: "shell", sessionID: "root", agent: "orchestrator", messageID: "m", input: { command: "true" } })
    await after({
      id: "mismatch",
      tool: "shell",
      sessionID: "root",
      agent: "orchestrator",
      messageID: "other-message",
      status: "completed",
      result: { output: { exit: 0 }, metadata: { exit: 0 } },
    })
    await before({ id: "moved", tool: "shell", sessionID: "child", agent: "orchestrator", messageID: "m", input: { command: "true" } })
    moved = true
    await after({
      id: "moved",
      tool: "shell",
      sessionID: "child",
      agent: "orchestrator",
      messageID: "m",
      status: "completed",
      result: { output: { exit: 0 }, metadata: { exit: 0 } },
    })
    h.runner.run = async () => ({ exitCode: 1, stdout: "", stderr: "git unavailable" })
    await before({ id: "nogit", tool: "shell", sessionID: "root", agent: "orchestrator", messageID: "m", input: { command: "true" } })
    await after({
      id: "nogit",
      tool: "shell",
      sessionID: "root",
      agent: "orchestrator",
      messageID: "m",
      status: "completed",
      result: { output: { exit: 0 }, metadata: { exit: 0 } },
    })
    expect(await listVerificationReceipts(h.storage, location, "root")).toEqual([])
    await runtime.dispose()
  })

  test("redacts bounded command labels and preserves active-board receipt references", async () => {
    const h = harness()
    const runtime = await startVerificationRuntime({ options: parseOptions({}), location, ...h })
    const before = h.hooks.get("execute.before")!
    const after = h.hooks.get("execute.after")!
    const secretCommand = "printf 'token=ghp_abcdefghijklmnopqrstuv'"
    await before({ id: "secret", tool: "shell", sessionID: "root", agent: "orchestrator", messageID: "m", input: { command: secretCommand } })
    await after({
      id: "secret",
      tool: "shell",
      sessionID: "root",
      agent: "orchestrator",
      messageID: "m",
      status: "completed",
      result: { output: { exit: 0 }, metadata: { exit: 0 } },
    })
    const secretReceipt = (await listVerificationReceipts(h.storage, location, "root"))[0]!
    expect(secretReceipt.commandLabel).toContain("token: [redacted]")
    expect(secretReceipt.commandLabel).not.toContain("ghp_abcdefghijklmnopqrstuv")
    expect(secretReceipt.commandLabel.length).toBeLessThanOrEqual(256)

    const protectedID = secretReceipt.receiptID
    h.values.set("lead-board/v1/project/root", {
      version: 1,
      boardID: "board",
      leadSessionID: "root",
      projectID: "project",
      goalGeneration: 1,
      objective: "test",
      status: "active",
      boardRevision: 1,
      tasks: [
        {
          version: 1,
          taskID: "task",
          title: "task",
          owner: { sessionID: "root", role: "lead" },
          scope: { version: 1, root: "project", readPaths: [], writePaths: [], broad: true },
          dependencies: [],
          status: "awaiting-validation",
          attempt: 1,
          evidence: [],
          lifecycleVersion: 1,
          idempotencyKey: "board/task",
          replay: { kind: "none" },
          validation: { leadSessionID: "root", validatedAt: 1, revision: HEAD, checkIDs: ["c4:pass"], receiptIDs: [protectedID] },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    })
    await runtime.dispose()
    expect((await listVerificationReceipts(h.storage, location, "root"))[0]?.receiptID).toBe(protectedID)
  })

  test("bounds pending before/after state and drops the oldest unmatched call", async () => {
    const h = harness()
    const runtime = await startVerificationRuntime({ options: parseOptions({}), location, ...h })
    const before = h.hooks.get("execute.before")!
    const after = h.hooks.get("execute.after")!
    for (let index = 0; index <= 512; index += 1) {
      await before({
        id: `call-${index}`,
        tool: "shell",
        sessionID: "root",
        agent: "orchestrator",
        messageID: "m",
        input: { command: `echo ${index}` },
      })
    }
    const result = (id: string) => ({
      id,
      tool: "shell",
      sessionID: "root",
      agent: "orchestrator",
      messageID: "m",
      status: "completed",
      result: { output: { exit: 0 }, metadata: { exit: 0 } },
    })
    await after(result("call-0"))
    await after(result("call-512"))
    const receipts = await listVerificationReceipts(h.storage, location, "root")
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.commandLabel).toBe("echo 512")
    await runtime.dispose()
  })
})
