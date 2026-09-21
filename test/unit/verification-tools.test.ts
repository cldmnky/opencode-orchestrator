import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { addVerificationTools } from "../../src/opencode-v2/verification/tools.js"
import { verificationCommandDigest } from "../../src/core/verification.js"
import { verificationStorageKey } from "../../src/opencode-v2/verification/state.js"

const location = { directory: "/workspace", project: { id: "project" } }
const options = parseOptions({})

function storage(values: Map<string, unknown>) {
  return {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => void values.set(key, value),
    remove: async (key: string) => void values.delete(key),
    scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => ({
      entries: [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit)
        .map(([key, value]) => ({ key, value })),
    }),
  }
}

describe("verification receipt tool", () => {
  test("exposes only bounded metadata for the current root session", async () => {
    const values = new Map<string, unknown>()
    values.set(verificationStorageKey("project", "root", "receipt-1"), {
      version: 1,
      receiptID: "receipt-1",
      rootSessionID: "root",
      sessionID: "root",
      agentID: "orchestrator",
      messageID: "message",
      commandDigest: verificationCommandDigest("bun test"),
      commandLabel: "bun test",
      status: "pass",
      exitCode: 0,
      startedAt: 1,
      completedAt: 2,
      repository: { rootDigest: "c".repeat(64), headSha: "a".repeat(40) },
    })
    const tools: any[] = []
    addVerificationTools(
      { add: (tool) => tools.push(tool) },
      {
        options,
        location,
        storage: storage(values),
        session: {
          get: async ({ sessionID }: { sessionID: string }) =>
            sessionID === "child"
              ? { id: "child", parentID: "root", location: { directory: "/workspace" } }
              : { id: "root", location: { directory: "/workspace" } },
        },
      },
    )
    const result = JSON.parse(
      (await tools[0].execute({}, { sessionID: "child", agent: "orchestrator" })).content,
    ) as { rootSessionID: string; receipts: Array<Record<string, unknown>> }
    expect(result.rootSessionID).toBe("root")
    expect(result.receipts).toHaveLength(1)
    expect(result.receipts[0]).toMatchObject({ receiptID: "receipt-1", status: "pass", headSha: "a".repeat(40) })
    expect(result.receipts[0]).not.toHaveProperty("stdout")
    expect(result.receipts[0]).not.toHaveProperty("stderr")
  })

  test("rejects worker access regardless of the read-only surface", async () => {
    const tools: any[] = []
    addVerificationTools({ add: (tool) => tools.push(tool) }, { options, location, storage: storage(new Map()) })
    await expect(tools[0].execute({}, { sessionID: "root", agent: "explore" })).rejects.toThrow(/only to the orchestrator/)
  })
})
