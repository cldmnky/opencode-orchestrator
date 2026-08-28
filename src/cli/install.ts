import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { commandDefinitions } from "../opencode-v2/commands/index.js"
import { buildOrchestratorSystem, buildWorkerSystem } from "../core/prompts.js"
import { DEFAULT_ROLES, type RoleName } from "../core/roles.js"
import { parseOptions, type OrchestratorOptions } from "../core/config.js"

export type InstallTarget = "project" | "global"
export type AgentModelReferences = Record<string, string>

export function defaultConfigPath(target: InstallTarget, cwd = process.cwd()): string {
  if (target === "project") return join(cwd, "opencode.jsonc")
  const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "~", ".config")
  return join(configHome, "opencode", "opencode.jsonc")
}

export function installConfig(
  path: string,
  options: unknown = {},
  packageReference = "opencode-orchestrator",
  modelReferences: AgentModelReferences = {},
): {
  addedAgents: string[]
  preservedAgents: string[]
  addedCommands: string[]
  preservedCommands: string[]
  path: string
} {
  const resolved = resolve(path)
  mkdirSync(dirname(resolved), { recursive: true })
  const source = existsSync(resolved) ? readFileSync(resolved, "utf8") : "{\n}\n"
  const errors: ParseError[] = []
  const parsed = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(parsed)) {
    throw new Error(`Invalid JSONC configuration at ${resolved}`)
  }
  const document = parsed
  const merged = parseOptions(options)
  validateModelReferences(modelReferences)
  if (document.plugins !== undefined && !Array.isArray(document.plugins)) {
    throw new Error(`Invalid plugins entry at ${resolved}: expected an array`)
  }
  if (document.agents !== undefined && !isRecord(document.agents)) {
    throw new Error(`Invalid agents entry at ${resolved}: expected an object`)
  }
  const existingAgents = isRecord(document.agents) ? document.agents : {}
  const existingCommands = isRecord(document.commands) ? document.commands : {}
  const addedAgents: string[] = []
  const preservedAgents: string[] = []

  const agents: Record<string, unknown> = { ...existingAgents }
  const agentDefaults = agentDefinitions(merged, modelReferences)
  for (const [id, value] of Object.entries(agentDefaults)) {
    if (Object.hasOwn(agents, id)) preservedAgents.push(id)
    else {
      agents[id] = value
      addedAgents.push(id)
    }
  }

  const preservedCommands = commandDefinitions(merged)
    .map((command) => command.name)
    .filter((name) => Object.hasOwn(existingCommands, name))

  let result = source
  const existingPlugins = Array.isArray(document.plugins) ? document.plugins : undefined
  if (!hasPlugin(existingPlugins, packageReference)) {
    result = applyEdits(
      result,
      modify(
        result,
        existingPlugins ? ["plugins", existingPlugins.length] : ["plugins"],
        existingPlugins ? { package: packageReference, options: pluginOptions(merged) } : [{ package: packageReference, options: pluginOptions(merged) }],
        { formattingOptions },
      ),
    )
  }

  if (!isRecord(document.agents)) {
    result = applyEdits(result, modify(result, ["agents"], {}, { formattingOptions }))
  }
  for (const [id, value] of Object.entries(agentDefaults)) {
    if (Object.hasOwn(existingAgents, id)) continue
    result = applyEdits(result, modify(result, ["agents", id], value, { formattingOptions }))
  }
  atomicWrite(resolved, result)
  return { addedAgents, preservedAgents, addedCommands: [], preservedCommands, path: resolved }
}

function agentDefinitions(options: OrchestratorOptions, modelReferences: AgentModelReferences): Record<string, unknown> {
  const knownAgents = new Set([options.orchestrator, ...Object.values(options.roles)])
  for (const agent of Object.keys(modelReferences)) {
    if (!knownAgents.has(agent)) throw new Error(`Unknown agent in model reference: ${agent}`)
  }
  const entries: Record<string, unknown> = {
    [options.orchestrator]: {
      mode: "primary",
      ...(modelReferences[options.orchestrator] ? { model: modelReferences[options.orchestrator] } : {}),
      permissions: orchestratorPermissions(options),
      description: "Coordinates specialized agents and verifies their work.",
      system: buildOrchestratorSystem(options),
    },
  }
  for (const [role, id] of Object.entries(options.roles)) {
    if (Object.hasOwn(entries, id)) continue
    entries[id] = {
      mode: "subagent",
      ...(modelReferences[id] ? { model: modelReferences[id] } : {}),
      description: `${role} specialist managed by the orchestrator.`,
      system: buildWorkerSystem(role as RoleName),
      permissions: workerPermissions(role),
    }
  }
  return entries
}

function orchestratorPermissions(options: OrchestratorOptions): Array<Record<string, string>> {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "websearch", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "subagent", resource: "*", effect: "deny" },
    ...Array.from(new Set(Object.values(options.roles)), (id) => ({ action: "subagent", resource: id, effect: "allow" })),
    ...sensitiveReadPermissions(),
  ]
}

function workerPermissions(role: string): Array<Record<string, string>> {
  const common = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
  ]
  if (role === "research") {
    return [...common, { action: "webfetch", resource: "*", effect: "allow" }, { action: "websearch", resource: "*", effect: "allow" }, ...sensitiveReadPermissions()]
  }
  if (role === "planning" || role === "review") {
    return [...common, { action: "shell", resource: "*", effect: "ask" }, { action: "edit", resource: "*", effect: "deny" }, ...sensitiveReadPermissions()]
  }
  return [
    ...common,
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "websearch", resource: "*", effect: "allow" },
    ...sensitiveReadPermissions(),
  ]
}

function pluginOptions(options: OrchestratorOptions): Record<string, unknown> {
  return { ...options, roles: { ...DEFAULT_ROLES, ...options.roles } }
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`
  const mode = existsSync(path) ? statSync(path).mode & 0o7777 : undefined
  try {
    writeFileSync(temporary, content, "utf8")
    if (mode !== undefined) chmodSync(temporary, mode)
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function hasPlugin(existing: readonly unknown[] | undefined, packageReference: string): boolean {
  return Boolean(existing?.some((entry) => entry === packageReference || (isRecord(entry) && entry.package === packageReference)))
}

function sensitiveReadPermissions(): Array<Record<string, string>> {
  return [
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
  ]
}

function validateModelReferences(references: AgentModelReferences): void {
  for (const [agent, reference] of Object.entries(references)) {
    const value = typeof reference === "string" ? reference.trim() : ""
    if (!/^[^/\s#]+\/[^/\s#]+(?:#[^\s#]+)?$/.test(value)) {
      throw new Error(`Invalid model reference for ${agent}: expected provider/model[#variant]`)
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" as const }
