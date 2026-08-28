import { existsSync, readFileSync } from "node:fs"
import { parse, type ParseError } from "jsonc-parser"
import { COMMAND_NAMES, parseOptions } from "../core/config.js"
import { requiredAgentIds } from "../core/roles.js"

export type DoctorCheck = {
  name: string
  status: "pass" | "warn" | "fail"
  message: string
}

export type DoctorReport = {
  path: string
  status: "ok" | "warning" | "error"
  checks: DoctorCheck[]
  agents: string[]
  configuredCommands: string[]
  runtimeCommands: string[]
}

export function inspectConfig(path: string): DoctorReport {
  const checks: DoctorCheck[] = []
  if (!existsSync(path)) {
    return {
      path,
      status: "error",
      checks: [{ name: "config", status: "fail", message: "configuration file does not exist" }],
      agents: [],
      configuredCommands: [],
      runtimeCommands: [],
    }
  }

  const source = readFileSync(path, "utf8")
  const errors: ParseError[] = []
  const document = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(document)) {
    return {
      path,
      status: "error",
      checks: [{ name: "config", status: "fail", message: "configuration is not valid JSONC" }],
      agents: [],
      configuredCommands: [],
      runtimeCommands: [],
    }
  }

  const plugin = findPlugin(document.plugins)
  if (!plugin) {
    checks.push({ name: "plugin", status: "fail", message: "opencode-orchestrator is not registered" })
  }

  let options
  try {
    options = parseOptions(plugin && isRecord(plugin) ? plugin.options : {})
    checks.push({ name: "options", status: "pass", message: "plugin options are valid" })
  } catch (error) {
    checks.push({ name: "options", status: "fail", message: error instanceof Error ? error.message : String(error) })
    options = parseOptions({})
  }

  const agents = isRecord(document.agents) ? document.agents : {}
  if (document.agents !== undefined && !isRecord(document.agents)) {
    checks.push({ name: "agents", status: "fail", message: "agents must be an object" })
  }
  const agentNames = Object.keys(agents)
  for (const id of requiredAgentIds(options.orchestrator, options.roles)) {
    const item = agents[id]
    if (!isRecord(item)) {
      checks.push({ name: `agent:${id}`, status: "fail", message: "required agent is missing" })
      continue
    }
    const expected = id === options.orchestrator ? ["primary", "all"] : ["subagent", "all"]
    if (typeof item.mode !== "string" || !expected.includes(item.mode)) {
      checks.push({ name: `agent:${id}`, status: "fail", message: `mode must be ${expected.join(" or ")}` })
    } else {
      checks.push({ name: `agent:${id}`, status: "pass", message: `mode ${item.mode}` })
    }
    if (!hasModel(item.model)) {
      checks.push({ name: `model:${id}`, status: "warn", message: "no native agents.<id>.model is configured; OpenCode fallback may apply" })
    }
  }

  const configuredCommands = isRecord(document.commands) ? Object.keys(document.commands) : []
  const runtimeCommands = COMMAND_NAMES.filter((name) => options.commands[name] !== false)
  checks.push({
    name: "commands",
    status: "pass",
    message: `${runtimeCommands.length} enabled commands are supplied by the server plugin at runtime`,
  })
  checks.push({
    name: "catalog",
    status: "warn",
    message: "model catalog availability is not queried by doctor; inspect it with opencode2 api GET /api/model",
  })
  checks.push({
    name: "workflow-boundary",
    status: "warn",
    message: "native V2 subagent sessions cannot receive a plugin-controlled worktree atomically; worktree and GitHub coordination are advisory",
  })

  const status = checks.some((check) => check.status === "fail")
    ? "error"
    : checks.some((check) => check.status === "warn")
      ? "warning"
      : "ok"
  return { path, status, checks, agents: agentNames, configuredCommands, runtimeCommands }
}

function findPlugin(value: unknown): Record<string, unknown> | string | undefined {
  if (!Array.isArray(value)) return undefined
  return value.find((entry) => {
    if (entry === "opencode-orchestrator") return true
    if (!isRecord(entry) || typeof entry.package !== "string") return false
    return (
      entry.package === "opencode-orchestrator" ||
      entry.package.endsWith("/opencode-orchestrator") ||
      entry.package.endsWith("/src/index.ts") ||
      entry.package.endsWith("/dist/index.js")
    )
  }) as Record<string, unknown> | string | undefined
}

function hasModel(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0
  return (
    isRecord(value) &&
    typeof value.providerID === "string" &&
    (typeof value.id === "string" || typeof value.model === "string")
  )
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
