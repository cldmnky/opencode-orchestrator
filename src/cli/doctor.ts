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

  const safePlugin = findSafePlugin(document.plugins)
  const legacyPlugin = findLegacyBarePlugin(document.plugins)
  const plugin = safePlugin ?? legacyPlugin
  if (!plugin) {
    checks.push({ name: "plugin", status: "fail", message: "opencode-orchestrator is not registered; run the installer" })
  } else if (legacyPlugin && !safePlugin) {
    checks.push({
      name: "plugin",
      status: "fail",
      message:
        'the registered plugin entry "opencode-orchestrator" is the unrelated npm registry package (owned by agnusdei1207); build this repository from source, install the freshly built tarball into the project, and run the installer again to write a config-relative local file reference',
    })
  } else if (legacyPlugin) {
    checks.push({
      name: "plugin",
      status: "warn",
      message: 'plugins also contains a legacy "opencode-orchestrator" registry entry; rerun the installer to migrate it to a local file reference',
    })
  }

  let options
  if (legacyPlugin && !safePlugin) {
    checks.push({
      name: "options",
      status: "fail",
      message: "plugin options were not validated because the registered entry is the unrelated npm registry package; reinstall locally first",
    })
    options = parseOptions({})
  } else {
    try {
      options = parseOptions(plugin && isRecord(plugin) ? plugin.options : {})
      checks.push({ name: "options", status: "pass", message: "plugin options are valid" })
    } catch (error) {
      checks.push({ name: "options", status: "fail", message: error instanceof Error ? error.message : String(error) })
      options = parseOptions({})
    }
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

/**
 * First plugin entry that resolves to this repository's plugin, in either V2
 * form: a bare string or an object with a `package` field. Safe references are
 * a config-local source (`/src/index.ts`) or built (`/dist/index.js`) file, or
 * this repository's future scoped package `@cldmnky/opencode-orchestrator`.
 * Separators are normalized before matching so Windows-style configs are
 * recognized too.
 */
function findSafePlugin(value: unknown): string | Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.find((entry): entry is string | Record<string, unknown> => {
    if (typeof entry === "string") return isSafePluginReference(entry)
    if (!isRecord(entry) || typeof entry.package !== "string") return false
    return isSafePluginReference(entry.package)
  })
}

/**
 * First plugin entry still using the legacy bare registry name
 * 'opencode-orchestrator' — the unrelated npm package, never this repository.
 */
function findLegacyBarePlugin(value: unknown): string | Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.find((entry) => {
    if (entry === "opencode-orchestrator") return true
    return isRecord(entry) && entry.package === "opencode-orchestrator"
  }) as string | Record<string, unknown> | undefined
}

function isSafePluginReference(value: string): boolean {
  const reference = normalizePackageReference(value)
  if (reference === "opencode-orchestrator") return false
  // Only this repository's own future scoped package. Arbitrary scopes could
  // be unrelated packages, so they must not be treated as this plugin.
  if (reference === "@cldmnky/opencode-orchestrator") return true
  return reference.endsWith("/src/index.ts") || reference.endsWith("/dist/index.js")
}

function normalizePackageReference(value: string): string {
  return value.replaceAll("\\", "/")
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
