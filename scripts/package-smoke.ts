import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/sdk"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageName = "opencode-v2-agent-orchestrator"
const temporary = mkdtempSync(join(tmpdir(), "opencode-orchestrator-package-"))
const packed = join(temporary, "packed")
const extracted = join(temporary, "extracted")
const consumer = join(temporary, "consumer")

try {
  mkdirSync(packed)
  mkdirSync(extracted)
  mkdirSync(join(consumer, "node_modules"), { recursive: true })

  const pack = spawnSync("npm", ["pack", "--pack-destination", packed], { cwd: root, encoding: "utf8" })
  if (pack.status !== 0) throw new Error(`npm pack failed:\n${pack.stdout}\n${pack.stderr}`)
  const tarballName = pack.stdout.trim().split(/\r?\n/).at(-1)
  if (!tarballName) throw new Error("npm pack did not report a tarball")
  const tarball = join(packed, tarballName)

  const extract = spawnSync("tar", ["-xzf", tarball, "-C", extracted], { encoding: "utf8" })
  if (extract.status !== 0) throw new Error(`tar extraction failed:\n${extract.stdout}\n${extract.stderr}`)
  const packageDirectory = join(extracted, "package")
  if (!existsSync(join(packageDirectory, "dist", "index.js"))) throw new Error("packed package has no dist/index.js")
  symlinkSync(join(root, "node_modules"), join(packageDirectory, "node_modules"), "dir")
  symlinkSync(packageDirectory, join(consumer, "node_modules", packageName), "dir")

  // Resolve peer dependencies from the repository installation without
  // downloading anything during the smoke test.
  for (const dependency of ["@opencode", "@opentui", "solid-js"]) {
    const source = join(root, "node_modules", dependency)
    if (!existsSync(source)) continue
    const target = join(consumer, "node_modules", dependency)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, "dir")
  }

  const probe = [
    `const names = [${[packageName, `${packageName}/tui`, `${packageName}/commands`, `${packageName}/installer`].map((value) => JSON.stringify(value)).join(", ")}]`,
    "for (const name of names) { const module = await import(name); if (!module || Object.keys(module).length === 0) throw new Error(`empty package export: ${name}`) }",
  ].join("; ")
  const run = spawnSync("node", ["--input-type=module", "-e", probe], { cwd: consumer, encoding: "utf8" })
  if (run.status !== 0) throw new Error(`packed package import failed:\n${run.stdout}\n${run.stderr}`)

  const packageJSON = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>
  }
  for (const subpath of [".", "./tui", "./commands", "./installer"]) {
    expectExport(packageJSON.exports, subpath)
    expectTypedExport(packageJSON.exports, subpath)
  }

  const packedServer = await import(pathToFileURL(join(packageDirectory, "dist", "index.js")).href)
  const packedTui = await import(pathToFileURL(join(packageDirectory, "dist", "tui.js")).href)
  const packedInstaller = await import(pathToFileURL(join(packageDirectory, "dist", "installer.js")).href)
  const plugin = packedServer.default ?? packedServer.orchestratorPlugin
  if (!plugin || plugin.id !== "opencode-orchestrator" || plugin.tui !== true) {
    throw new Error("packed server plugin did not expose the V2 plugin definition")
  }
  if (!packedTui.default || packedTui.default.id !== "opencode-orchestrator") {
    throw new Error("packed TUI export did not resolve to the CLI plugin")
  }

  const configPath = join(temporary, "installer", "opencode.jsonc")
  packedInstaller.installConfig(configPath, {}, packageName)
  if (!existsSync(configPath)) throw new Error("packed installer did not write a config")
  const installedConfig = JSON.parse(readFileSync(configPath, "utf8")) as { plugins?: Array<{ package?: string }> }
  if (installedConfig.plugins?.[0]?.package !== packageName) {
    throw new Error("packed installer did not write the canonical package reference")
  }

  await verifyEmbeddedHost(plugin, temporary)
  await verifyDeclarations(consumer, packageName)
  console.log("Packed package smoke test passed.")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

function expectExport(exports: Record<string, unknown> | undefined, subpath: string): void {
  if (!exports || !(subpath in exports)) throw new Error(`package exports missing ${subpath}`)
}

function expectTypedExport(exports: Record<string, unknown> | undefined, subpath: string): void {
  const entry = exports?.[subpath]
  if (!entry || typeof entry !== "object" || typeof (entry as { types?: unknown }).types !== "string") {
    throw new Error(`package export is missing types: ${subpath}`)
  }
}

async function verifyEmbeddedHost(plugin: unknown, root: string): Promise<void> {
  const directory = join(root, "embedded")
  mkdirSync(directory, { recursive: true })
  const agents = Object.fromEntries(
    ["orchestrator", "planner", "explore", "implementer", "reviewer"].map((id) => [
      id,
      { mode: id === "orchestrator" ? "primary" : "subagent", model: "opencode/big-pickle" },
    ]),
  )
  const host = await OpenCode.create({
    plugins: [plugin] as any,
    fs: { filewatcher: false },
    config: { directory, content: JSON.stringify({ agents }) },
  })
  try {
    await waitFor(async () => {
      const commands = await host.command.list({ location: { directory } })
      return commands.data.some((command: { name: string }) => command.name === "orchestrate")
    })
    await waitFor(async () => {
      const plugins = (await host.plugin.list({ location: { directory } })).data as Array<{
        id: string
        status?: string
        state?: { status?: string }
      }>
      return plugins.some((candidate) => candidate.id === "opencode-orchestrator" && (candidate.status ?? candidate.state?.status) === "active")
    })
  } finally {
    await host.close()
  }
}

async function verifyDeclarations(consumer: string, packageName: string): Promise<void> {
  const source = join(consumer, "index.ts")
  const config = join(consumer, "tsconfig.json")
  writeFileSync(
    source,
    `import plugin, { OrchestratorOptionsSchema, orchestratorPlugin, parseOptions, type OrchestratorOptions } from ${JSON.stringify(packageName)}\n` +
      `import { tuiPlugin } from ${JSON.stringify(`${packageName}/tui`)}\n` +
      `import { commandDefinitions, type CommandSpec } from ${JSON.stringify(`${packageName}/commands`)}\n` +
      `import { installConfig, type InstallSummary } from ${JSON.stringify(`${packageName}/installer`)}\n\n` +
      `const options: OrchestratorOptions = parseOptions({})\n` +
      `const commands: CommandSpec[] = commandDefinitions(options)\n` +
      `const schema = OrchestratorOptionsSchema\n` +
      `const summary: typeof installConfig = installConfig\n` +
      `const pluginID: string = orchestratorPlugin.id\n` +
      `const tuiID: string = tuiPlugin.id\n` +
      `const defaultPluginID: string = plugin.id\n` +
      `const installResult: InstallSummary | undefined = undefined\n` +
      `void [commands, schema, summary, pluginID, tuiID, defaultPluginID, installResult]\n`,
    "utf8",
  )
  writeFileSync(
    config,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["index.ts"],
      },
      null,
      2,
    ),
    "utf8",
  )
  const tsc = join(root, "node_modules", ".bin", "tsc")
  const run = spawnSync(tsc, ["-p", config], { cwd: consumer, encoding: "utf8" })
  if (run.status !== 0) throw new Error(`packed declarations failed to typecheck:\n${run.stdout}\n${run.stderr}`)
}

async function waitFor(check: () => Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Timed out waiting for packed embedded host state")
}
