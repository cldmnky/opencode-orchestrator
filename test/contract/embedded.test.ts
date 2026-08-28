import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { OpenCode } from "@opencode-ai/sdk"

describe("embedded V2 host", () => {
  test("loads the source plugin and config-backed agents without an HTTP listener", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-sdk-"))
    const plugin = fileURLToPath(new URL("../../src/index.ts", import.meta.url))
    const agents = Object.fromEntries(
      ["orchestrator", "planner", "explore", "implementer", "reviewer"].map((id) => [
        id,
        {
          mode: id === "orchestrator" ? "primary" : "subagent",
          model: "opencode/big-pickle",
        },
      ]),
    )
    const host = await OpenCode.create({
      config: {
        directory,
        content: JSON.stringify({
          plugins: [{ package: resolve(plugin), options: { strict_agents: true, goal: { auto_continue: false } } }],
          agents,
        }),
      },
    })

    try {
      await host.agent.list({ location: { directory } })
      await waitFor(async () => {
        const commands = await host.command.list({ location: { directory } })
        return commands.data.some((command: { name: string }) => command.name === "orchestrate")
      })

      const loadedAgents = (await host.agent.list({ location: { directory } })).data
      const orchestrator = loadedAgents.find((agent: { id: string }) => agent.id === "orchestrator")
      expect(orchestrator?.description).toContain("Coordinates specialized agents")
      expect(orchestrator?.model?.id).toBe("big-pickle")
      expect((await host.plugin.list({ location: { directory } })).data).toContainEqual(
        expect.objectContaining({ id: "opencode-orchestrator", status: "active" }),
      )

      const session = await host.session.create({ location: { directory } })
      await host.session.command({ sessionID: session.id, command: "goal", text: "ship the change", delivery: "queue" })
      await waitFor(async () => {
        const messages = await host.message.list({ sessionID: session.id })
        return messages.data.some(
          (message: { type: string; text?: string }) => message.type === "synthetic" && message.text?.includes("ship the change") === true,
        )
      })
    } finally {
      await host.close()
    }
  })
})

async function waitFor(check: () => Promise<boolean>, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Timed out waiting for embedded OpenCode state")
}
