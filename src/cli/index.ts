#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  configRelativePluginReference,
  defaultConfigPath,
  formatInstallDiff,
  installConfig,
  migrateConfig,
  planInstallConfig,
  pluginEntryForRuntimeFile,
  type AgentModelReferences,
} from "./install.js"
import { inspectConfig, liveChecks, mergeStatus, runOpenCodeApi, runtimeChecks } from "./doctor.js"
import { DISTRIBUTION_NAME } from "../core/package-identity.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const cliFile = fileURLToPath(import.meta.url)
const devProject = join(root, "dev", "project")
const devState = join(root, "dev", "state")

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === "install") return install(args)
  if (command === "doctor") return doctor(args)
  if (command === "state") return state(args)
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
  const check = args.includes("--check")
  const migrate = args.includes("--migrate")
  if (check && migrate) throw new Error("install --check and install --migrate cannot be combined")
  if (check) {
    const plan = planInstallConfig(configPath, {}, packageReference, models)
    console.log(formatInstallDiff(plan.path, plan.source, plan.content))
    if (plan.changed) process.exitCode = 1
    return
  }
  if (migrate) {
    const result = migrateConfig(configPath, {}, packageReference, models)
    console.log(`Migrated OpenCode Orchestrator in ${result.path}`)
    console.log(`Backup: ${result.backupPath ?? "not needed; configuration already converged"}`)
    console.log(`Added agents: ${result.addedAgents.join(", ") || "none"}`)
    console.log(`Preserved agents: ${result.preservedAgents.join(", ") || "none"}`)
    return
  }
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

async function doctor(args: string[]): Promise<void> {
  const target = args.includes("--global") ? "global" : "project"
  const pathArg = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--directory")
  const config = pathArg ? resolve(pathArg) : defaultConfigPath(target)
  const report = inspectConfig(config)
  const runtime = await runtimeChecks({ cwd: dirname(resolve(config)) })
  const requestedDirectory = directoryArgument(args) ?? dirname(resolve(config))
  const live = args.includes("--live")
    ? await liveChecks({ directory: requestedDirectory, expectedAgents: report.agents, expectedCommands: report.runtimeCommands })
    : []
  const checks = [...report.checks, ...runtime, ...live]
  const merged = { ...report, checks, status: mergeStatus(checks) }
  if (args.includes("--json")) {
    console.log(JSON.stringify(merged, null, 2))
  } else {
    console.log(`OpenCode Orchestrator doctor: ${merged.path}`)
    for (const check of merged.checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`)
    console.log(`Agents: ${merged.agents.join(", ") || "none"}`)
    console.log(`Configured command entries: ${merged.configuredCommands.join(", ") || "none"}`)
    console.log(`Runtime commands: ${merged.runtimeCommands.join(", ") || "none"}`)
  }
  if (merged.status === "error") process.exitCode = 1
}

async function state(args: string[]): Promise<void> {
  const operation = args.find((arg) => !arg.startsWith("--"))
  if (operation !== "export" && operation !== "validate" && operation !== "archive" && operation !== "reset") {
    throw new Error("Usage: state <export|validate|archive|reset> --session <id> [--family <family>] [--yes]")
  }
  const sessionID = optionValue(args, "--session")
  if (!sessionID) throw new Error("state recovery requires an explicit --session <id>")
  const family = optionValue(args, "--family")
  if (operation === "reset" && !family) throw new Error("state reset requires an explicit --family <family>")
  if (operation === "reset" && !args.includes("--yes") && !args.includes("--confirm")) {
    throw new Error("state reset requires --yes (or --confirm); no state was changed")
  }

  const directory = directoryArgument(args) ?? process.cwd()
  const location = `location[directory]=${encodeURIComponent(resolve(directory))}`
  const input = {
    sessionID,
    ...(family ? { family } : {}),
    ...(operation === "reset" ? { confirm: true } : {}),
  }
  const result = await runOpenCodeApi(
    [
      "api",
      "post",
      `/api/rpc/opencode-orchestrator.state/${operation}?${location}`,
      "--data",
      JSON.stringify({ input }),
    ],
    resolve(directory),
  )
  if (result.exitCode !== 0) throw new Error(`state ${operation} request failed: opencode2 api exited ${result.exitCode}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(`state ${operation} request returned an invalid JSON response`)
  }
  // The RPC is deliberately bounded and redacted server-side. Print only the
  // structured output envelope, never headers, stderr, or an unbounded body.
  const output = parsed && typeof parsed === "object" && Object.hasOwn(parsed, "output") ? (parsed as { output: unknown }).output : parsed
  console.log(JSON.stringify(output, null, 2))
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : undefined
  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  return inline?.slice(prefix.length) || undefined
}

function directoryArgument(args: readonly string[]): string | undefined {
  return optionValue(args, "--directory")
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
  console.log(`Usage: ${DISTRIBUTION_NAME} install [--global] [--check|--migrate] [--model agent=provider/model[#variant]]`)
  console.log(`       ${DISTRIBUTION_NAME} doctor [--live] [--directory <dir>] [--global]`)
  console.log(`       ${DISTRIBUTION_NAME} state <export|validate|archive|reset> --session <id> [--family <family>] [--yes]`)
  console.log("doctor checks the local config and advisory local git/gh status; --live uses opencode2 api service discovery/authentication. Plugin commands (/orchestrate, /goal, ...) exist only at runtime inside OpenCode — they are not CLI subcommands.")
}

await main()
