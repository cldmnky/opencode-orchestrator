import { existsSync, readFileSync } from "node:fs"
import { parse, type ParseError } from "jsonc-parser"
import { COMMAND_NAMES, parseOptions } from "../core/config.js"
import { requiredAgentIds } from "../core/roles.js"
import { DISTRIBUTION_NAME, LEGACY_DISTRIBUTION_NAME, SCOPED_DISTRIBUTION_NAME } from "../core/package-identity.js"

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
    checks.push({ name: "plugin", status: "fail", message: `${DISTRIBUTION_NAME} is not registered; run the installer` })
  } else if (legacyPlugin && !safePlugin) {
    checks.push({
      name: "plugin",
      status: "fail",
      message: `the registered plugin entry "${LEGACY_DISTRIBUTION_NAME}" is this plugin's legacy distribution name; install the current ${DISTRIBUTION_NAME} package and run the installer again to write a config-relative local file reference`,
    })
  } else if (legacyPlugin) {
    checks.push({
      name: "plugin",
      status: "warn",
      message: `plugins also contains a legacy "${LEGACY_DISTRIBUTION_NAME}" entry; rerun the installer to migrate it to the current distribution reference`,
    })
  }

  let options
  if (legacyPlugin && !safePlugin) {
    checks.push({
      name: "options",
      status: "fail",
      message: `plugin options were not validated because the registered entry is a legacy distribution name; install the current ${DISTRIBUTION_NAME} package and reinstall locally first`,
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
  checks.push({
    name: "mcp-github",
    status: "warn",
    message:
      "doctor inspects only static config presence and reports name-level guidance only; it cannot prove the host's merged MCP config, remote GitHub MCP reachability, live tool capability, authentication, or permission grants. Host-configured GitHub MCP is not a plugin feature — configure and verify it with the host (this plugin exposes no GitHub operation API). No headers, environment values, OAuth tokens, or other credentials are read or printed by doctor.",
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
 * a config-local source (`/src/index.ts`) or built (`/dist/index.js`) file, the
 * current bare distribution name, or this repository's scoped package.
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
 * First plugin entry still using the legacy distribution name
 * 'opencode-orchestrator' — the previous npm name for this repository, never
 * this plugin's current distribution.
 */
function findLegacyBarePlugin(value: unknown): string | Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.find((entry) => {
    if (entry === LEGACY_DISTRIBUTION_NAME) return true
    return isRecord(entry) && entry.package === LEGACY_DISTRIBUTION_NAME
  }) as string | Record<string, unknown> | undefined
}

function isSafePluginReference(value: string): boolean {
  const reference = normalizePackageReference(value)
  // The legacy distribution name is migratable, never safe in place.
  if (reference === LEGACY_DISTRIBUTION_NAME) return false
  // The current distribution name and this repository's own scoped package.
  // Arbitrary scopes could be unrelated packages, so they must not be treated
  // as this plugin.
  if (reference === DISTRIBUTION_NAME || reference === SCOPED_DISTRIBUTION_NAME) return true
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
