#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { defaultConfigPath, installConfig, configRelativePluginReference, pluginEntryForRuntimeFile, type AgentModelReferences } from "./install.js"
import { inspectConfig } from "./doctor.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const cliFile = fileURLToPath(import.meta.url)
const devProject = join(root, "dev", "project")
const devState = join(root, "dev", "state")

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === "install") return install(args)
  if (command === "doctor") return doctor(args)
  if (command === "dev-setup") return devSetup()
  if (command === "dev-reset") return devReset()
  if (command === "dev-run") return devRun(args)
  printHelp()
}

function install(args: string[]): void {
  const target = args.includes("--global") ? "global" : "project"
  const models = modelReferences(args)
  const pathArg = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--model")
  const path = pathArg ? resolve(pathArg) : undefined
  const configPath = path ?? defaultConfigPath(target)
  const packageReference = configRelativePluginReference(configPath, pluginEntryForRuntimeFile(cliFile))
  const result = installConfig(configPath, {}, packageReference, models)
  console.log(`Installed OpenCode Orchestrator in ${result.path}`)
  console.log(`Plugin: ${packageReference}`)
  console.log(`Added agents: ${result.addedAgents.join(", ") || "none"}`)
  console.log(`Preserved agents: ${result.preservedAgents.join(", ") || "none"}`)
  console.log("Commands: registered by the V2 plugin at runtime")
  if (result.preservedCommands.length > 0) {
    console.warn(`Existing command names take precedence: ${result.preservedCommands.join(", ")}`)
  }
}

function modelReferences(args: readonly string[]): AgentModelReferences {
  const references: AgentModelReferences = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--model" && (args[index + 1] === undefined || args[index + 1].startsWith("--"))) {
      throw new Error("--model requires agent=provider/model[#variant]")
    }
    const value = argument === "--model" ? args[++index] : argument.startsWith("--model=") ? argument.slice("--model=".length) : undefined
    if (value === undefined) continue
    const separator = value.indexOf("=")
    if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid --model value: ${value}; expected agent=provider/model[#variant]`)
    references[value.slice(0, separator)] = value.slice(separator + 1)
  }
  return references
}

function doctor(args: string[]): void {
  const target = args.includes("--global") ? "global" : "project"
  const pathArg = args.find((arg) => !arg.startsWith("--"))
  const config = pathArg ? resolve(pathArg) : defaultConfigPath(target)
  const report = inspectConfig(config)
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`OpenCode Orchestrator doctor: ${report.path}`)
    for (const check of report.checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`)
    console.log(`Agents: ${report.agents.join(", ") || "none"}`)
    console.log(`Configured command entries: ${report.configuredCommands.join(", ") || "none"}`)
    console.log(`Runtime commands: ${report.runtimeCommands.join(", ") || "none"}`)
  }
  if (report.status === "error") process.exitCode = 1
}

function devSetup(): void {
  mkdirSync(devProject, { recursive: true })
  const configPath = join(devProject, "opencode.jsonc")
  if (existsSync(configPath)) {
    console.log(`Keeping existing ${configPath}`)
    return
  }
  const template = readFileSync(join(devProject, "opencode.example.jsonc"), "utf8")
  const config = template.replaceAll("__PLUGIN_ENTRY__", "../../src/index.ts")
  writeFileSync(configPath, config, "utf8")
  console.log(`Wrote ${configPath}`)
}

function devReset(): void {
  rmSync(devState, { recursive: true, force: true })
  rmSync(join(devProject, "opencode.jsonc"), { force: true })
  console.log("Removed generated local OpenCode state and config.")
}

function devRun(args: string[]): void {
  if (!existsSync(join(devProject, "opencode.jsonc"))) devSetup()
  mkdirSync(devState, { recursive: true })
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(devState, "config"),
    XDG_DATA_HOME: join(devState, "data"),
    XDG_CACHE_HOME: join(devState, "cache"),
    OPENCODE_CONFIG: join(devProject, "opencode.jsonc"),
  }
  const pluginEntry = args.includes("--dist") ? "../../dist/index.js" : "../../src/index.ts"
  const configPath = join(devProject, "opencode.jsonc")
  const source = readFileSync(configPath, "utf8")
  const config = replacePluginEntry(source, pluginEntry)
  if (config !== source) writeFileSync(configPath, config, "utf8")
  const child = spawn("opencode2", ["--standalone"], { cwd: devProject, env, stdio: "inherit" })
  child.on("exit", (code) => {
    process.exitCode = code ?? 1
  })
}

function replacePluginEntry(source: string, entry: string): string {
  const placeholder = source.replaceAll("__PLUGIN_ENTRY__", entry)
  if (placeholder !== source) return placeholder
  return placeholder.replace(/("package"\s*:\s*")[^"]+("\s*[,}])/, `$1${entry}$2`)
}

function printHelp(): void {
  console.log("Usage: opencode-orchestrator install [--global] [--model agent=provider/model[#variant]]")
  console.log("       opencode-orchestrator <doctor|dev-setup|dev-run|dev-reset>")
}

await main()
