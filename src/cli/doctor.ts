import { existsSync, readFileSync } from "node:fs"
import { spawn } from "node:child_process"
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

  const status = mergeStatus(checks)
  return { path, status, checks, agents: agentNames, configuredCommands, runtimeCommands }
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

  const git = await runner("git", ["--version"])
  if (git.exitCode !== 0) {
    checks.push({
      name: "git",
      status: "warn",
      message: "git is not available on this CLI's PATH; the server-side worktree tools are authoritative for the live session",
    })
  } else {
    checks.push({ name: "git", status: "pass", message: `git available: ${firstLine(git.stdout)}` })
  }

  const gh = await runner("gh", ["--version"])
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
    const auth = await runner("gh", ["auth", "status"])
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
    const repo = await runner("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
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

  const worktree = await runner("git", ["worktree", "list", "--porcelain"])
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

/**
 * Soft spawn for advisory probes: never rejects. A spawn failure resolves with
 * exit code -1, a timeout with exit code 124, and output is byte-capped per
 * stream — users of the result decide what (if anything) is worth printing.
 */
function spawnSoft(cmd: string, args: readonly string[], cwd: string): Promise<DoctorProcessResult> {
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
      stdout = bounded(stdout, chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = bounded(stderr, chunk)
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

function bounded(accumulated: string, chunk: Buffer): string {
  if (accumulated.length >= RUNTIME_OUTPUT_CAP) return accumulated
  return (accumulated + chunk.toString("utf8")).slice(0, RUNTIME_OUTPUT_CAP)
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0].trim()
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
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
