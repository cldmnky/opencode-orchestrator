import { existsSync, readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { COMMAND_NAMES, parseOptions } from "../core/config.js"
import { ROLE_DELEGATION, requiredAgentIds, type RoleName } from "../core/roles.js"
import { buildOrchestratorSystem, buildWorkerSystem } from "../core/prompts.js"
import {
  GATES_TOOL_PERMISSION,
  GH_TOOL_PERMISSION,
  GOAL_TOOL_PERMISSION,
  OBSERVABILITY_TOOL_PERMISSION,
  ORCHESTRATION_TOOL_PERMISSION,
  PEER_TOOL_PERMISSION,
  PUBLISH_TOOL_PERMISSION,
  REVIEW_SUBMIT_TOOL_PERMISSION,
  WORKTREE_TOOL_PERMISSION,
} from "../core/permissions.js"
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

/**
 * Aggregates check statuses: any `fail` makes the report an error, otherwise
 * any `warn` makes it a warning. Runtime checks are always `warn`-or-`pass`,
 * so they can never escalate a report to `error`.
 */
export function mergeStatus(checks: readonly DoctorCheck[]): DoctorReport["status"] {
  if (checks.some((check) => check.status === "fail")) return "error"
  if (checks.some((check) => check.status === "warn")) return "warning"
  return "ok"
}

export type DoctorProcessResult = { exitCode: number; stdout: string; stderr: string }

/**
 * Injectable local process probe for the advisory runtime checks. Tests inject
 * fakes so no live git/gh is ever spawned; the CLI default is a soft spawn
 * that never rejects.
 */
export type DoctorRunner = (cmd: string, args: readonly string[]) => Promise<DoctorProcessResult>

export type RuntimeCheckOptions = {
  /** Directory for local git/gh probes; defaults to `process.cwd()`. */
  cwd?: string
  /** Injectable process runner; defaults to `spawnSoft`. */
  runner?: DoctorRunner
}

export type DoctorApiResult = { exitCode: number; stdout: string; stderr: string }

/** Injectable `opencode2 api` runner. The default uses service discovery/auth. */
export type DoctorApiRunner = (args: readonly string[], cwd: string) => Promise<DoctorApiResult>

export type LiveCheckOptions = {
  directory: string
  expectedAgents?: readonly string[]
  expectedCommands?: readonly string[]
  runner?: DoctorApiRunner
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

  if (safePlugin) addPluginPathChecks(checks, path, safePlugin)

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
    addPermissionChecks(checks, id, item, options.orchestrator, options.roles)
    addPromptChecks(checks, id, item, options)
  }

  const configuredCommands = isRecord(document.commands) ? Object.keys(document.commands) : []
  if (document.commands !== undefined && !isRecord(document.commands)) {
    checks.push({ name: "commands-config", status: "fail", message: "commands must be an object" })
  }
  const removedCommands = configuredCommands.filter((name) => REMOVED_COMMAND_NAMES.has(name))
  if (removedCommands.length > 0) {
    checks.push({
      name: "removed-commands",
      status: "warn",
      message: `configuration contains removed command entries: ${removedCommands.sort().join(", ")}; use /orchestrate or /run-plan instead`,
    })
  }
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
      "doctor inspects only static config presence and reports name-level guidance only; it cannot prove the host's merged MCP config, remote GitHub MCP reachability, live tool capability, authentication, or permission grants. Host-configured GitHub MCP is separate from this plugin's opt-in server-side `gh` tools and must be configured and verified with the host; for the plugin's own tools, the server-side `github_capabilities` probe is authoritative. No headers, environment values, OAuth tokens, or other credentials are read or printed by doctor.",
  })

  const status = mergeStatus(checks)
  return { path, status, checks, agents: agentNames, configuredCommands, runtimeCommands }
}

/**
 * Live checks use the installed `opencode2 api` command rather than creating a
 * second HTTP client. That preserves the host's service discovery and auth
 * behavior, including remote TUI connections. Every request carries the V2
 * deep-object location query.
 */
export async function liveChecks(options: LiveCheckOptions): Promise<DoctorCheck[]> {
  const directory = resolve(options.directory)
  const runner = options.runner ?? spawnApiSoft
  const expectedAgents = options.expectedAgents ?? []
  const expectedCommands = options.expectedCommands ?? COMMAND_NAMES
  const checks: DoctorCheck[] = []
  const location = `location[directory]=${encodeURIComponent(directory)}`

  const plugin = await apiJson(runner, ["api", "get", `/api/plugin?${location}`], directory)
  if (!plugin.ok) {
    checks.push({ name: "live-plugin", status: "fail", message: `opencode2 api plugin request exited ${plugin.exitCode}` })
    return checks
  }
  const plugins = arrayData(plugin.value)
  const active = plugins.find((item) => isRecord(item) && item.id === "opencode-orchestrator")
  if (!isRecord(active)) {
    checks.push({ name: "live-plugin", status: "fail", message: "the orchestrator plugin is not active for the requested directory" })
  } else if (!isActivePlugin(active)) {
    checks.push({ name: "live-plugin", status: "fail", message: "the orchestrator plugin is registered but not active for the requested directory" })
  } else {
    checks.push({ name: "live-plugin", status: "pass", message: "orchestrator plugin is active for the requested directory" })
    if (isRecord(active.features) && active.features.tui === true) {
      checks.push({ name: "live-tui", status: "pass", message: "the active plugin reports a TUI export" })
    } else {
      checks.push({ name: "live-tui", status: "warn", message: "the active plugin does not report an observable TUI export" })
    }
  }

  const commands = await apiJson(runner, ["api", "get", `/api/command?${location}`], directory)
  if (!commands.ok) {
    checks.push({ name: "live-commands", status: "fail", message: `opencode2 api command request exited ${commands.exitCode}` })
  } else {
    const registered = new Set(arrayData(commands.value).flatMap((item) => (isRecord(item) && typeof item.name === "string" ? [item.name] : [])))
    const missing = expectedCommands.filter((name) => !registered.has(name))
    checks.push(
      missing.length === 0
        ? { name: "live-commands", status: "pass", message: `${expectedCommands.length} expected commands are registered` }
        : { name: "live-commands", status: "fail", message: `missing registered commands: ${missing.join(", ")}` },
    )
  }

  const agents = await apiJson(runner, ["api", "get", `/api/agent?${location}`], directory)
  if (!agents.ok) {
    checks.push({ name: "live-agents", status: "fail", message: `opencode2 api agent request exited ${agents.exitCode}` })
  } else {
    const registered = new Set(arrayData(agents.value).flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : [])))
    const missing = expectedAgents.filter((id) => !registered.has(id))
    checks.push(
      missing.length === 0
        ? { name: "live-agents", status: "pass", message: `${expectedAgents.length} configured agents are effective` }
        : { name: "live-agents", status: "fail", message: `missing effective agents: ${missing.join(", ")}` },
    )
  }

  const diagnostics = await apiJson(
    runner,
    [
      "api",
      "post",
      `/api/rpc/opencode-orchestrator.diagnostics/get?${location}`,
      "--data",
      JSON.stringify({ input: {} }),
    ],
    directory,
  )
  if (!diagnostics.ok) {
    checks.push({ name: "live-capabilities", status: "warn", message: `server diagnostics RPC is unavailable (opencode2 api exited ${diagnostics.exitCode})` })
  } else {
    const view = unwrapRpcOutput(diagnostics.value)
    const github = isRecord(view) && isRecord(view.githubCapabilityProbe) ? view.githubCapabilityProbe.available === true : undefined
    const worktree = isRecord(view) && isRecord(view.worktreeTools) ? view.worktreeTools.available === true : undefined
    checks.push({
      name: "live-github-capability",
      status: github === true ? "pass" : "warn",
      message: github === undefined ? "server diagnostics did not expose the GitHub capability probe" : github ? "server-side GitHub capability probe is registered" : "server-side GitHub capability probe is disabled by configuration",
    })
    checks.push({
      name: "live-worktree-tools",
      status: worktree === true ? "pass" : "warn",
      message: worktree === undefined ? "server diagnostics did not expose worktree tool availability" : worktree ? "server-side worktree tools are registered" : "server-side worktree tools are disabled by configuration",
    })
    const legacyCount = isRecord(view) && typeof view.legacyStateCount === "number" ? view.legacyStateCount : undefined
    if (legacyCount !== undefined && legacyCount > 0) {
      checks.push({ name: "legacy-state", status: "warn", message: `${legacyCount} legacy V1 state record(s) are discoverable; inspect them before reset or archive` })
    }
  }

  return checks
}

/**
 * Advisory local runtime checks (stage 5). These probe *this machine's* PATH
 * and directory only — they can never prove what the remote server's session
 * can do, so every check is `warn`-or-`pass` and the server-side
 * `orchestrator_github_capabilities` probe plus worktree status tools remain
 * authoritative. All `gh` output is suppressed: only exit codes and fixed
 * wording are reported, so no headers, environment values, or tokens can leak
 * into a report.
 */
export async function runtimeChecks(options: RuntimeCheckOptions = {}): Promise<DoctorCheck[]> {
  const cwd = options.cwd ?? process.cwd()
  const runner = options.runner ?? ((cmd, args) => spawnSoft(cmd, args, cwd))
  const checks: DoctorCheck[] = []

  const git = await runRuntimeProbe(runner, "git", ["--version"])
  if (git.exitCode !== 0) {
    checks.push({
      name: "git",
      status: "warn",
      message: "git is not available on this CLI's PATH; the server-side worktree tools are authoritative for the live session",
    })
  } else {
    checks.push({ name: "git", status: "pass", message: `git available: ${firstLine(git.stdout)}` })
  }

  const gh = await runRuntimeProbe(runner, "gh", ["--version"])
  if (gh.exitCode !== 0) {
    checks.push({
      name: "gh",
      status: "warn",
      message: "gh is not available on this CLI's PATH; the server-side github tools are authoritative for the live session",
    })
  } else {
    checks.push({ name: "gh", status: "pass", message: `gh available: ${firstLine(gh.stdout)}` })
  }

  if (gh.exitCode === 0) {
    // Exit code only: `gh auth status` output can embed credential state, so
    // it is never captured into the report.
    const auth = await runRuntimeProbe(runner, "gh", ["auth", "status"])
    if (auth.exitCode === 0) {
      checks.push({ name: "gh-auth", status: "pass", message: "gh auth status exited 0 (authenticated); command output is suppressed" })
    } else {
      checks.push({
        name: "gh-auth",
        status: "warn",
        message: `gh auth status exited ${auth.exitCode}; gh may not be authenticated on this machine. Command output is suppressed — doctor prints no headers, environment values, or tokens. The server-side github_capabilities tool is authoritative for the live session.`,
      })
    }
  }

  if (gh.exitCode === 0 && checks.some((check) => check.name === "gh-auth" && check.status === "pass")) {
    // Read-only probe of the repository behind the current directory.
    const repo = await runRuntimeProbe(runner, "gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
    if (repo.exitCode === 0) {
      checks.push({ name: "gh-repo-view", status: "pass", message: `resolved ${firstLine(repo.stdout)} from ${cwd} via read-only gh repo view` })
    } else {
      checks.push({
        name: "gh-repo-view",
        status: "warn",
        message: `could not resolve a GitHub repository from ${cwd} via read-only gh repo view; this is expected outside a repository checkout. Output is suppressed. The server-side github_capabilities tool is authoritative.`,
      })
    }
  }

  const worktree = await runRuntimeProbe(runner, "git", ["worktree", "list", "--porcelain"])
  if (worktree.exitCode === 0) {
    checks.push({ name: "git-worktree-list", status: "pass", message: "local read-only git worktree list --porcelain succeeded" })
  } else {
    checks.push({
      name: "git-worktree-list",
      status: "warn",
      message: `local git worktree list --porcelain failed (exit ${worktree.exitCode}); ${cwd} may not be a git repository. No output is printed. The server-side worktree tools are authoritative.`,
    })
  }

  checks.push({
    name: "runtime-authority",
    status: "warn",
    message:
      "CLI doctor runtime checks are advisory: they probe this machine's PATH and directory, not the remote server's. The server-side github_capabilities tool and worktree status are authoritative for actual session availability, authentication, and permissions. No headers, environment values, OAuth tokens, or other credentials are read or printed by doctor.",
  })

  return checks
}

const RUNTIME_CHECK_TIMEOUT_MS = 10_000
const RUNTIME_OUTPUT_CAP = 4096
const API_OUTPUT_CAP = 512 * 1024
const REMOVED_COMMAND_NAMES = new Set(["cd", "restructure", "polish", "stress-plan"])

const REQUIRED_PERMISSION_ACTIONS = [
  GOAL_TOOL_PERMISSION,
  GH_TOOL_PERMISSION,
  WORKTREE_TOOL_PERMISSION,
  ORCHESTRATION_TOOL_PERMISSION,
  OBSERVABILITY_TOOL_PERMISSION,
  PUBLISH_TOOL_PERMISSION,
  PEER_TOOL_PERMISSION,
  GATES_TOOL_PERMISSION,
  REVIEW_SUBMIT_TOOL_PERMISSION,
] as const

function addPermissionChecks(
  checks: DoctorCheck[],
  id: string,
  agent: Record<string, any>,
  orchestrator: string,
  roles: Record<RoleName, string>,
): void {
  const permissions = agent.permissions
  if (!Array.isArray(permissions)) {
    checks.push({ name: `permissions:${id}`, status: "warn", message: "agent has no explicit permission array; generated plugin permission families are not inspectable" })
    return
  }
  const rules = permissions.filter(isPermissionRule)
  const missing = REQUIRED_PERMISSION_ACTIONS.filter((action) => !rules.some((rule) => rule.action === action))
  const removed = rules
    .filter((rule) => rule.action.includes("orchestrator_cd") || rule.action.includes("orchestrator_session_move"))
    .map((rule) => rule.action)
  if (missing.length > 0) {
    checks.push({
      name: `permissions:${id}`,
      status: "warn",
      message: `missing generated permission families: ${missing.join(", ")}; run install --migrate (explicit rules remain authoritative)`,
    })
  } else if (removed.length > 0) {
    checks.push({ name: `permissions:${id}`, status: "warn", message: `removed permission families remain: ${[...new Set(removed)].join(", ")}; run install --migrate` })
  } else {
    checks.push({ name: `permissions:${id}`, status: "pass", message: "plugin permission families are present" })
  }

  const expectedTargets = new Set<string>()
  if (id === orchestrator) {
    for (const target of Object.values(roles)) expectedTargets.add(target)
  } else {
    for (const [role, roleID] of Object.entries(roles) as Array<[RoleName, string]>) {
      if (roleID !== id) continue
      for (const target of ROLE_DELEGATION[role]) expectedTargets.add(roles[target])
    }
  }
  const configuredTargets = new Set(
    rules
      .filter((rule) => rule.action === "subagent" && rule.effect === "allow" && rule.resource !== "*")
      .map((rule) => rule.resource),
  )
  const staleTargets = [...configuredTargets].filter((target) => !expectedTargets.has(target))
  const missingTargets = [...expectedTargets].filter((target) => !configuredTargets.has(target))
  const hasDelegationDeny = rules.some((rule) => rule.action === "subagent" && rule.resource === "*" && rule.effect === "deny")
  if (staleTargets.length > 0 || missingTargets.length > 0 || !hasDelegationDeny) {
    checks.push({
      name: `delegation:${id}`,
      status: "warn",
      message: `generated delegation graph differs (missing: ${missingTargets.sort().join(", ") || "none"}; stale: ${staleTargets.sort().join(", ") || "none"}; broad deny: ${hasDelegationDeny ? "present" : "missing"}); run install --migrate`,
    })
  }
}

function addPromptChecks(checks: DoctorCheck[], id: string, agent: Record<string, any>, options: ReturnType<typeof parseOptions>): void {
  if (typeof agent.system !== "string") return
  const staleNames = ["task_complexity_classify", "admission_transition", "orchestrator_lead_board", "orchestrator_github_issue"].filter((name) => agent.system.includes(name))
  if (staleNames.length > 0) {
    checks.push({ name: `prompt:${id}`, status: "warn", message: `agent prompt contains removed names: ${staleNames.join(", ")}; run install --migrate` })
    return
  }
  const role = (Object.entries(options.roles) as Array<[RoleName, string]>).find(([, roleID]) => roleID === id)?.[0]
  const generated = id === options.orchestrator
    ? buildOrchestratorSystem(options)
    : role
      ? buildWorkerSystem(role, options)
      : undefined
  const marker = id === options.orchestrator ? "You are the conductor, not a worker of last resort." : "Worker handoff format:"
  if (generated && !agent.system.includes(generated) && !agent.system.includes(marker)) {
    checks.push({
      name: `prompt:${id}`,
      status: "warn",
      message: "agent system prompt does not contain the current generated section; run install --migrate or review custom prompt ownership",
    })
  }
}

function addPluginPathChecks(checks: DoctorCheck[], configPath: string, plugin: string | Record<string, unknown>): void {
  const reference = typeof plugin === "string" ? plugin : typeof plugin.package === "string" ? plugin.package : undefined
  if (!reference || !isLocalReference(reference)) return
  const normalizedReference = reference.replaceAll("\\", "/")
  let entry: string
  try {
    entry = normalizedReference.startsWith("file://")
      ? fileURLToPath(normalizedReference)
      : isAbsolute(normalizedReference)
        ? normalizedReference
        : resolve(dirname(configPath), normalizedReference)
  } catch {
    checks.push({ name: "plugin-entrypoint", status: "warn", message: "plugin file reference is not a valid local path" })
    return
  }
  if (!existsSync(entry)) {
    checks.push({ name: "plugin-entrypoint", status: "warn", message: "plugin file reference does not currently resolve on disk" })
    return
  }
  checks.push({ name: "plugin-entrypoint", status: "pass", message: "plugin file reference resolves on disk" })
  if (!entry.replaceAll("\\", "/").endsWith("/dist/index.js")) return
  const dist = dirname(entry)
  const missing = ["tui.js", "commands.js", "installer.js", "cli/index.js"].filter((file) => !existsSync(join(dist, file)))
  checks.push(
    missing.length === 0
      ? { name: "packed-entrypoints", status: "pass", message: "packed plugin entrypoints are present" }
      : { name: "packed-entrypoints", status: "warn", message: `packed install is missing entrypoints: ${missing.join(", ")}` },
  )
}

function isLocalReference(reference: string): boolean {
  const normalized = reference.replaceAll("\\", "/")
  return (
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith("file://") ||
    isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes("/src/") ||
    normalized.includes("/dist/")
  )
}

function isPermissionRule(value: unknown): value is { action: string; resource: string; effect: string } {
  return isRecord(value) && typeof value.action === "string" && typeof value.resource === "string" && typeof value.effect === "string"
}

function isActivePlugin(value: Record<string, unknown>): boolean {
  return isRecord(value.state) && value.state.status === "active"
}

function arrayData(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value.data)) return value.data
  return []
}

function unwrapRpcOutput(value: unknown): unknown {
  return isRecord(value) && Object.hasOwn(value, "output") ? value.output : value
}

type ParsedApiResult = { ok: true; value: unknown; exitCode: number } | { ok: false; exitCode: number }

async function apiJson(runner: DoctorApiRunner, args: readonly string[], cwd: string): Promise<ParsedApiResult> {
  let result: DoctorApiResult
  try {
    result = await runner(args, cwd)
  } catch {
    return { ok: false, exitCode: -1 }
  }
  if (
    !result ||
    typeof result.exitCode !== "number" ||
    typeof result.stdout !== "string" ||
    result.stdout.length > API_OUTPUT_CAP
  ) {
    return { ok: false, exitCode: -1 }
  }
  if (result.exitCode !== 0) return { ok: false, exitCode: result.exitCode }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as unknown, exitCode: result.exitCode }
  } catch {
    return { ok: false, exitCode: result.exitCode }
  }
}

function spawnApiSoft(args: readonly string[], cwd: string): Promise<DoctorApiResult> {
  return spawnSoft("opencode2", args, cwd, API_OUTPUT_CAP)
}

/** Execute an OpenCode API command through the host CLI's service client. */
export function runOpenCodeApi(args: readonly string[], cwd = process.cwd()): Promise<DoctorApiResult> {
  return spawnApiSoft(args, cwd)
}

/**
 * Soft spawn for advisory probes: never rejects. A spawn failure resolves with
 * exit code -1, a timeout with exit code 124, and output is byte-capped per
 * stream — users of the result decide what (if anything) is worth printing.
 */
function spawnSoft(cmd: string, args: readonly string[], cwd: string, outputCap = RUNTIME_OUTPUT_CAP): Promise<DoctorProcessResult> {
  return new Promise<DoctorProcessResult>((resolvePromise) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (value: DoctorProcessResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise(value)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"], cwd })
    } catch (error) {
      settle({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) })
      return
    }

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = bounded(stdout, chunk, outputCap)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = bounded(stderr, chunk, outputCap)
    })
    child.on("error", () => settle({ exitCode: -1, stdout, stderr }))
    child.on("close", (code) => settle({ exitCode: code ?? 1, stdout, stderr }))
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      settle({ exitCode: 124, stdout, stderr })
    }, RUNTIME_CHECK_TIMEOUT_MS)
  })
}

function bounded(accumulated: string, chunk: Buffer, outputCap: number): string {
  if (accumulated.length >= outputCap) return accumulated
  return (accumulated + chunk.toString("utf8")).slice(0, outputCap)
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0].trim()
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

async function runRuntimeProbe(runner: DoctorRunner, cmd: string, args: readonly string[]): Promise<DoctorProcessResult> {
  try {
    return await runner(cmd, args)
  } catch {
    return { exitCode: -1, stdout: "", stderr: "" }
  }
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
