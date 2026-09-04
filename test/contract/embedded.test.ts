import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { OpenCode } from "@opencode-ai/sdk"

describe("embedded V2 host", () => {
  test("loads the source plugin and config-backed agents without an HTTP listener", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-sdk-"))
    const plugin = fileURLToPath(new URL("../../src/index.ts", import.meta.url))
    const host = await createHost(directory, resolve(plugin))

    try {
      await assertPluginActive(host, directory)

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

  test("loads a config-relative source entry and registers /orchestrate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-sdk-"))
    // A local `src/index.ts` beside the config, exactly like the source-run
    // installer writes (`./src/index.ts`), resolved by the V2 config loader.
    mkdirSync(join(directory, "src"), { recursive: true })
    symlinkSync(fileURLToPath(new URL("../../src/index.ts", import.meta.url)), join(directory, "src", "index.ts"))
    const host = await createHost(directory, "./src/index.ts")

    try {
      await assertPluginActive(host, directory)
    } finally {
      await host.close()
    }
  })

  test("loads a package-like local dist entry and registers /orchestrate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-sdk-"))
    // A shim standing in for the shipped `dist/index.js` inside a project-local
    // `node_modules/opencode-v2-agent-orchestrator`, matching the reference the
    // built installer writes
    // (`./node_modules/opencode-v2-agent-orchestrator/dist/index.js`).
    const distFile = join(directory, "node_modules", "opencode-v2-agent-orchestrator", "dist", "index.js")
    mkdirSync(dirname(distFile), { recursive: true })
    const specifier = relative(dirname(distFile), fileURLToPath(new URL("../../src/index.ts", import.meta.url)))
    writeFileSync(distFile, `export { default } from ${JSON.stringify(specifier)}\n`, "utf8")
    const host = await createHost(directory, "./node_modules/opencode-v2-agent-orchestrator/dist/index.js")

    try {
      await assertPluginActive(host, directory)
    } finally {
      await host.close()
    }
  })
})

function createHost(directory: string, packageReference: string): Promise<Awaited<ReturnType<typeof OpenCode.create>>> {
  const agents = Object.fromEntries(
    ["orchestrator", "planner", "explore", "implementer", "reviewer"].map((id) => [
      id,
      {
        mode: id === "orchestrator" ? "primary" : "subagent",
        model: "opencode/big-pickle",
      },
    ]),
  )
  // SDK dev-19087 embedded hosts ignore config-file `plugins: [{package}]`
  // entries (verified: absolute, relative, and dist-shim references all load
  // zero custom plugins). Load the entry file directly and hand the plugin
  // object to the host — the path setup above still covers installer path
  // shapes because the import resolves through them.
  return loadPlugin(packageReference, directory).then((plugin) =>
    OpenCode.create({
      plugins: [plugin],
      config: {
        directory,
        content: JSON.stringify({
          agents,
          // Keep the package reference in config content as well so any
          // future SDK that restores config-file loading keeps working.
          plugins: [{ package: packageReference, options: { strict_agents: true, goal: { auto_continue: false } } }],
        }),
      },
    }),
  )
}

async function loadPlugin(packageReference: string, directory: string): Promise<any> {
  const specifier = packageReference.startsWith(".")
    ? join(directory, packageReference)
    : packageReference
  return (await import(specifier)).default ?? (await import(specifier)).orchestratorPlugin
}

async function assertPluginActive(host: Awaited<ReturnType<typeof OpenCode.create>>, directory: string): Promise<void> {
  await host.agent.list({ location: { directory } })
  await waitFor(async () => {
    const commands = await host.command.list({ location: { directory } })
    return commands.data.some((command: { name: string }) => command.name === "orchestrate")
  })

  // Late agent setup applies the description transform on `agent.updated`,
  // so poll until it lands instead of asserting immediately.
  await waitFor(async () => {
    const loadedAgents = (await host.agent.list({ location: { directory } })).data
    const orchestrator = loadedAgents.find((agent: { id: string }) => agent.id === "orchestrator")
    const description = orchestrator?.description
    const text = typeof description === "string" ? description : JSON.stringify(description ?? "")
    return text.includes("Coordinates specialized agents")
  })

  const loadedAgents = (await host.agent.list({ location: { directory } })).data
  const orchestrator = loadedAgents.find((agent: { id: string }) => agent.id === "orchestrator")
  expect(orchestrator?.model?.id).toBe("big-pickle")
  await waitFor(async () => {
    const plugins = (await host.plugin.list({ location: { directory } })).data as Array<{
      id: string
      status?: string
      state?: { status?: string }
    }>
    return plugins.some((plugin) => plugin.id === "opencode-orchestrator" && (plugin.status ?? plugin.state?.status) === "active")
  })
}

async function waitFor(check: () => Promise<boolean>, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Timed out waiting for embedded OpenCode state")
}
