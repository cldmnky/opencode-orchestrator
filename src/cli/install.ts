import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { commandDefinitions } from "../opencode-v2/commands/index.js"
import { buildOrchestratorSystem, buildWorkerSystem } from "../core/prompts.js"
import { GOAL_TOOL_PERMISSION, orchestratorOnlyPermissionRules } from "../core/permissions.js"
import { DEFAULT_ROLES, ROLE_DELEGATION, type RoleName } from "../core/roles.js"
import { parseOptions, type OrchestratorOptions } from "../core/config.js"
import { parseModelReference } from "../core/model-reference.js"
import { DISTRIBUTION_NAME, LEGACY_DISTRIBUTION_NAME, SCOPED_DISTRIBUTION_NAME } from "../core/package-identity.js"

export type InstallTarget = "project" | "global"
export type AgentModelReferences = Record<string, string>

/**
 * Maps a runtime file (the installer CLI or the exported installer bundle) to
 * the plugin entry it ships with. Only exact layouts are supported; separators
 * are normalized first so Windows paths match too:
 * - `src/cli/index.ts` or `src/cli/install.ts` -> `<root>/src/index.ts`
 * - `dist/cli/index.js` or `dist/installer.js` -> `<root>/dist/index.js`
 * Any other layout throws so a misconfigured runtime cannot silently write a
 * reference to a file that does not exist.
 *
 * Suffix lengths differ (`dist/installer.js` is two levels below root,
 * `dist/cli/index.js` is three), so the root is derived by stripping the exact
 * matched suffix.
 */
const RUNTIME_LAYOUTS = [
  { suffix: "/src/cli/index.ts", entry: "src/index.ts" },
  { suffix: "/src/cli/install.ts", entry: "src/index.ts" },
  { suffix: "/dist/cli/index.js", entry: "dist/index.js" },
  { suffix: "/dist/installer.js", entry: "dist/index.js" },
] as const

export function pluginEntryForRuntimeFile(runtimeFile: string): string {
  const normalized = runtimeFile.split(sep).join("/")
  for (const { suffix, entry } of RUNTIME_LAYOUTS) {
    if (normalized.endsWith(suffix)) {
      return join(normalized.slice(0, -suffix.length), entry)
    }
  }
  throw new Error(
    `Unsupported installer layout: ${runtimeFile}; expected src/cli/index.ts, src/cli/install.ts, dist/cli/index.js, or dist/installer.js`,
  )
}

/**
 * A plugin reference the installer writes into the config: POSIX-style and
 * relative to the config file, prefixed with `./` unless already dot-prefixed.
 * When the config and the plugin entry live on different volumes,
 * `path.relative` returns an absolute path; that normalized absolute path is
 * kept as-is because `./`-prefixing it would corrupt it.
 */
export function configRelativePluginReference(configPath: string, pluginEntry: string): string {
  const from = dirname(resolve(configPath))
  const relativePath = relative(from, pluginEntry)
  const reference = relativePath.split(sep).join("/")
  if (isAbsolute(relativePath)) return reference
  return reference.startsWith(".") ? reference : `./${reference}`
}

/**
 * True when the reference points at a local file (dot-relative, `file://` URL,
 * or absolute) rather than a bare package name resolved against node_modules.
 */
export function isLocalPluginReference(packageReference: string): boolean {
  return (
    packageReference.startsWith("./") ||
    packageReference.startsWith("../") ||
    packageReference.startsWith("file://") ||
    isAbsolute(packageReference)
  )
}

export function defaultConfigPath(target: InstallTarget, cwd = process.cwd()): string {
  if (target === "project") return join(cwd, "opencode.jsonc")
  const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "~", ".config")
  return join(configHome, "opencode", "opencode.jsonc")
}

/**
 * Native V2 subagent nesting depth written by the installer.
 *
 * OpenCode's `experimental.subagent_depth` defaults to 1 ("Maximum subagent
 * nesting depth. Defaults to 1, which prevents subagents from launching
 * subagents"), which would block the approved deepest bounded-delegation path
 * `orchestrator -> implementation -> planning -> research` (three subagent
 * hops). The installer writes this value only when the property is absent and
 * never enforces depth itself; an explicit user value always wins.
 */
const REQUIRED_SUBAGENT_DEPTH = 3

export function installConfig(
  path: string,
  options: unknown = {},
  packageReference?: string,
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
  // Without an explicit reference, derive the local plugin entry from this
  // file's own location: `src/cli/install.ts` -> `<root>/src/index.ts` in a
  // source checkout, `dist/installer.js` -> `<root>/dist/index.js` in the
  // bundled package. Defaulting to a bare package name would be unsafe because
  // the legacy `opencode-orchestrator` name is ambiguous migration input: the
  // exact name this package shipped under before the current rename.
  const effectivePackageReference =
    packageReference ?? configRelativePluginReference(resolved, pluginEntryForRuntimeFile(fileURLToPath(import.meta.url)))
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
  if (document.experimental !== undefined && !isRecord(document.experimental)) {
    throw new Error(`Invalid experimental entry at ${resolved}: expected an object`)
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
  // Legacy entries are migrated/removed only when the installer is writing a
  // reference it owns: a config-local file, or the current bare/scoped
  // distribution name passed explicitly. Other bare references are left alone.
  const legacyIndexes =
    isLocalPluginReference(effectivePackageReference) || isCanonicalPluginReference(effectivePackageReference)
      ? legacyBarePluginIndexes(existingPlugins)
      : []
  // A canonical entry for the current distribution (bare or scoped) means this
  // plugin is already configured: keep it as-is and never add a duplicate.
  const canonicalAlreadyPresent = hasCanonicalPlugin(existingPlugins)
  const localAlreadyPresent = hasPlugin(existingPlugins, effectivePackageReference)
  const alreadyPresent = canonicalAlreadyPresent || localAlreadyPresent
  if (legacyIndexes.length > 0) {
    const migrateIndex = legacyIndexes[0]
    for (const index of [...legacyIndexes].reverse()) {
      if (index === migrateIndex && !alreadyPresent) {
        result = migrateLegacyPluginEntry(result, index, existingPlugins![index], effectivePackageReference, merged)
      } else {
        result = removePluginEntry(result, index)
      }
    }
  } else if (!alreadyPresent) {
    result = applyEdits(
      result,
      modify(
        result,
        existingPlugins ? ["plugins", existingPlugins.length] : ["plugins"],
        existingPlugins
          ? { package: effectivePackageReference, options: pluginOptions(merged) }
          : [{ package: effectivePackageReference, options: pluginOptions(merged) }],
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
  // Native V2 subagent nesting depth defaults to 1, which stops a subagent
  // from launching another subagent. The approved deepest delegation path —
  // orchestrator -> implementation -> planning -> research — is three subagent
  // hops, so a fresh install needs top-level `experimental.subagent_depth: 3`.
  // This is a native OpenCode setting, not a plugin-enforced one: the installer
  // only writes it when the property is absent, an explicitly authored value
  // (any value) is the user's policy and is preserved untouched, and every
  // other key inside an existing `experimental` object is preserved.
  if (isRecord(document.experimental)) {
    if (!Object.hasOwn(document.experimental, "subagent_depth")) {
      result = applyEdits(
        result,
        modify(result, ["experimental", "subagent_depth"], REQUIRED_SUBAGENT_DEPTH, { formattingOptions }),
      )
    }
  } else {
    result = applyEdits(result, modify(result, ["experimental"], { subagent_depth: REQUIRED_SUBAGENT_DEPTH }, { formattingOptions }))
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
      system: buildWorkerSystem(role as RoleName, options),
      permissions: workerPermissions(role as RoleName, options.roles),
    }
  }
  return entries
}

function orchestratorPermissions(options: OrchestratorOptions): Array<Record<string, string>> {
  return [
    { action: "*", resource: "*", effect: "deny" },
    // Keep the goal tools visible and callable despite the deny-all above.
    // They share one explicit permission action declared on each tool.
    { action: GOAL_TOOL_PERMISSION, resource: "*", effect: "allow" },
    // Surface the orchestrator-only feature family (github/worktree): one
    // explicit permission action per family declared on each tool, so discrete
    // rules grant or revoke each set while workers stay denied.
    ...orchestratorOnlyPermissionRules("allow"),
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "websearch", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    // Orchestrator→all configured roles: a broad deny first, then one exact
    // allow per configured role agent (last-match-wins), mirroring the
    // worker-side graph edges written by workerPermissions.
    { action: "subagent", resource: "*", effect: "deny" },
    ...Array.from(new Set(Object.values(options.roles)), (id) => ({ action: "subagent", resource: id, effect: "allow" })),
    ...sensitiveReadPermissions(),
  ]
}

/**
 * Permission defaults for a freshly installed worker agent.
 *
 * Nested delegation follows the bounded role graph (ROLE_DELEGATION): a broad
 * `subagent` deny comes first, then one exact target-specific allow per
 * in-graph target agent so V2's last-match-wins ordering yields exactly the
 * role's own edges — research gets no allow at all and answers directly with
 * webfetch/websearch. Existing (preserved) agents are never rewritten by the
 * installer or the agent transform; operators migrate them by hand.
 */
function workerPermissions(role: RoleName, roles: Record<RoleName, string>): Array<Record<string, string>> {
  const common = [
    { action: "*", resource: "*", effect: "deny" },
    // Workers must never see or drive orchestration goal tools or the
    // orchestrator-only feature tools, even when the installed allow rules
    // above change: the denies keep them invisible.
    { action: GOAL_TOOL_PERMISSION, resource: "*", effect: "deny" },
    ...orchestratorOnlyPermissionRules("deny"),
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    // Broad subagent deny first, then exact target-specific allows for the
    // role's own graph edges only (last-match-wins keeps the denies effective
    // for every other agent).
    { action: "subagent", resource: "*", effect: "deny" },
    ...ROLE_DELEGATION[role].map((target) => ({ action: "subagent", resource: roles[target], effect: "allow" })),
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

/**
 * True when the config already carries a canonical entry for the current
 * distribution: either the bare distribution name or its scoped spelling, in
 * string or object form. Such entries are recognized and preserved rather than
 * migrated or duplicated.
 */
function hasCanonicalPlugin(existing: readonly unknown[] | undefined): boolean {
  return Boolean(
    existing?.some(
      (entry) =>
        isCanonicalPluginReference(typeof entry === "string" ? entry : isRecord(entry) && typeof entry.package === "string" ? entry.package : ""),
    ),
  )
}

/**
 * True when the reference names the current distribution's canonical forms:
 * the bare distribution name or its scoped spelling. These are the spelling
 * variants doctor and the installer treat as "this plugin" in place.
 */
function isCanonicalPluginReference(reference: string): boolean {
  return reference === DISTRIBUTION_NAME || reference === SCOPED_DISTRIBUTION_NAME
}

/**
 * Indexes of config plugin entries that name the legacy distribution
 * 'opencode-orchestrator' — the exact name this repository shipped under before
 * the current rename (legacy/ambiguous migration input), never a local file
 * reference.
 */
function legacyBarePluginIndexes(plugins: readonly unknown[] | undefined): number[] {
  if (!plugins) return []
  const indexes: number[] = []
  for (let index = 0; index < plugins.length; index += 1) {
    const entry = plugins[index]
    if (
      entry === LEGACY_DISTRIBUTION_NAME ||
      (isRecord(entry) && entry.package === LEGACY_DISTRIBUTION_NAME)
    ) {
      indexes.push(index)
    }
  }
  return indexes
}

/**
 * Replaces a legacy bare 'opencode-orchestrator' entry in place: a bare string
 * becomes a full object with the local reference and fresh options, while an
 * existing object keeps its options and any other fields and only the package
 * reference is swapped.
 */
function migrateLegacyPluginEntry(
  result: string,
  index: number,
  legacy: unknown,
  packageReference: string,
  options: OrchestratorOptions,
): string {
  if (isRecord(legacy)) {
    return applyEdits(result, modify(result, ["plugins", index, "package"], packageReference, { formattingOptions }))
  }
  return applyEdits(result, modify(result, ["plugins", index], { package: packageReference, options: pluginOptions(options) }, { formattingOptions }))
}

function removePluginEntry(result: string, index: number): string {
  return applyEdits(result, modify(result, ["plugins", index], undefined, { formattingOptions }))
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
    try {
      parseModelReference(typeof reference === "string" ? reference : "")
    } catch {
      throw new Error(`Invalid model reference for ${agent}: expected provider/model[#variant]`)
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" as const }
