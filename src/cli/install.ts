import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { commandDefinitions } from "../opencode-v2/commands/index.js"
import { buildOrchestratorSystem, buildWorkerSystem } from "../core/prompts.js"
import {
  GOAL_TOOL_PERMISSION,
  REVIEW_SUBMIT_TOOL_PERMISSION,
  orchestratorOnlyPermissionRules,
  type PermissionRuleLike,
} from "../core/permissions.js"
import { DEFAULT_ROLES, ROLE_DELEGATION, type RoleName } from "../core/roles.js"
import { parseOptions, type OrchestratorOptions } from "../core/config.js"
import { parseModelReference } from "../core/model-reference.js"
import { DISTRIBUTION_NAME, LEGACY_DISTRIBUTION_NAME, SCOPED_DISTRIBUTION_NAME } from "../core/package-identity.js"

export type InstallTarget = "project" | "global"
export type AgentModelReferences = Record<string, string>

export type InstallSummary = {
  addedAgents: string[]
  preservedAgents: string[]
  addedCommands: string[]
  preservedCommands: string[]
  path: string
}

export type InstallPlan = InstallSummary & {
  source: string
  content: string
  changed: boolean
}

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
  const normalized = runtimeFile.replaceAll("\\", "/").split(sep).join("/")
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
 * OpenCode 2.0.14 reads `experimental.subagent_depth` ("Maximum subagent
 * nesting depth", default 1, which prevents subagents from launching
 * subagents), which would block the approved deepest bounded-delegation path
 * `orchestrator -> implementation -> planning -> research` (three subagent
 * hops). The installer writes this value only when neither spelling is present
 * and never enforces depth itself; an explicit user value always wins.
 *
 * A **top-level** `subagent_depth` is unsupported legacy config on 2.0.14 and
 * is dropped at startup (A17/G4), so a legacy top-level value is migrated into
 * `experimental` (value preserved, stale top-level key removed).
 */
const REQUIRED_SUBAGENT_DEPTH = 3

/** Permission actions emitted by pre-V2 surface consolidation installers. */
export const REMOVED_PERMISSION_FAMILIES = ["orchestrator_cd", "orchestrator_session_move"] as const

export function planInstallConfig(
  path: string,
  options: unknown = {},
  packageReference?: string,
  modelReferences: AgentModelReferences = {},
): InstallPlan {
  const resolved = resolve(path)
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
  if (document.commands !== undefined && !isRecord(document.commands)) {
    throw new Error(`Invalid commands entry at ${resolved}: expected an object`)
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
  // Native 2.0.14 subagent nesting depth lives at `experimental.subagent_depth`
  // and defaults to 1, which stops a subagent from launching another subagent.
  // The approved deepest delegation path — orchestrator -> implementation ->
  // planning -> research — is three subagent hops, so a fresh install needs
  // `experimental.subagent_depth: 3`. This is a native OpenCode setting, not a
  // plugin-enforced one: an explicitly authored nested value (any value) is the
  // user's policy and is preserved untouched.
  //
  // A top-level `subagent_depth` is unsupported legacy config on 2.0.14 — the
  // server drops it at startup — so a legacy top-level value migrates into
  // `experimental` (value preserved, stale key removed) only when no nested
  // value exists. When both spellings are present the nested value is live and
  // the dead top-level value is left untouched rather than deleted.
  const hasNestedDepth = isRecord(document.experimental) && Object.hasOwn(document.experimental, "subagent_depth")
  if (!isRecord(document.experimental)) {
    result = applyEdits(result, modify(result, ["experimental"], {}, { formattingOptions }))
  }
  if (!hasNestedDepth) {
    const depth = Object.hasOwn(document, "subagent_depth") ? document.subagent_depth : REQUIRED_SUBAGENT_DEPTH
    result = applyEdits(result, modify(result, ["experimental", "subagent_depth"], depth, { formattingOptions }))
    if (Object.hasOwn(document, "subagent_depth")) {
      result = applyEdits(result, modify(result, ["subagent_depth"], undefined, { formattingOptions }))
    }
  }
  validatePlannedConfig(result, resolved)
  return {
    addedAgents,
    preservedAgents,
    addedCommands: [],
    preservedCommands,
    path: resolved,
    source,
    content: result,
    changed: source !== result,
  }
}

/**
 * Apply the normal installer plan. Planning is deliberately separate so the
 * CLI's `install --check` mode can use exactly the same JSONC edits without
 * creating a directory, temporary config, or backup.
 */
export function installConfig(
  path: string,
  options: unknown = {},
  packageReference?: string,
  modelReferences: AgentModelReferences = {},
): InstallSummary {
  const plan = planInstallConfig(path, options, packageReference, modelReferences)
  mkdirSync(dirname(plan.path), { recursive: true })
  if (plan.changed) atomicWrite(plan.path, plan.content)
  return summary(plan)
}

/**
 * Migrate an existing installation's plugin-owned agent fields. User-authored
 * permission rules remain in place; generated rules and stale delegation
 * edges are refreshed. A backup is created before the first write.
 */
export function migrateConfig(
  path: string,
  options: unknown = {},
  packageReference?: string,
  modelReferences: AgentModelReferences = {},
): InstallSummary & { backupPath?: string; changed: boolean } {
  const resolved = resolve(path)
  if (!existsSync(resolved)) throw new Error(`Cannot migrate missing configuration: ${resolved}`)

  const source = readFileSync(resolved, "utf8")
  const migrationOptions = migrationOptionsFromSource(source, options)
  const plan = planInstallConfig(resolved, migrationOptions, packageReference, modelReferences)
  const content = migratePluginOwnedAgents(plan.content, parseOptions(migrationOptions), modelReferences)
  validatePlannedConfig(content, resolved)
  const changed = content !== source
  if (!changed) return { ...summary(plan), changed }

  const backupPath = createBackup(resolved)
  atomicWrite(resolved, content)
  return { ...summary(plan), path: resolved, backupPath, changed }
}

/** Create a collision-safe sibling backup without overwriting an older backup. */
export function createBackup(path: string): string {
  const resolved = resolve(path)
  if (!existsSync(resolved)) throw new Error(`Cannot back up missing configuration: ${resolved}`)
  let candidate = `${resolved}.bak`
  let suffix = 1
  while (existsSync(candidate)) candidate = `${resolved}.bak.${suffix++}`
  copyFileSync(resolved, candidate)
  chmodSync(candidate, statSync(resolved).mode & 0o7777)
  return candidate
}

function summary(plan: InstallPlan): InstallSummary {
  return {
    addedAgents: plan.addedAgents,
    preservedAgents: plan.preservedAgents,
    addedCommands: plan.addedCommands,
    preservedCommands: plan.preservedCommands,
    path: plan.path,
  }
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

function migrationOptionsFromSource(source: string, explicit: unknown): unknown {
  if (isNonEmptyRecord(explicit)) return explicit
  const errors: ParseError[] = []
  const document = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(document) || !Array.isArray(document.plugins)) return explicit
  const entry = document.plugins.find((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.options)) return false
    const packageName = typeof candidate.package === "string" ? candidate.package : ""
    return (
      packageName === DISTRIBUTION_NAME ||
      packageName === SCOPED_DISTRIBUTION_NAME ||
      packageName === LEGACY_DISTRIBUTION_NAME ||
      isLocalPluginReference(packageName)
    )
  })
  return isRecord(entry) && isRecord(entry.options) ? entry.options : explicit
}

/**
 * Refresh only fields generated by this plugin. The JSONC object itself is
 * edited field-by-field so unrelated agent properties and comments stay in the
 * document. Permission arrays are the one bounded replacement because their
 * generated graph must be reconciled as a unit.
 */
function migratePluginOwnedAgents(
  source: string,
  options: OrchestratorOptions,
  modelReferences: AgentModelReferences,
): string {
  const errors: ParseError[] = []
  const document = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(document)) {
    throw new Error("Invalid JSONC generated during agent migration")
  }
  if (!isRecord(document.agents)) return source

  const desiredAgents = agentDefinitions(options, modelReferences)
  let result = source
  for (const [id, rawDesired] of Object.entries(desiredAgents)) {
    const current = document.agents[id]
    if (!isRecord(current) || !isRecord(rawDesired)) continue

    const desiredSystem = typeof rawDesired.system === "string" ? rawDesired.system : undefined
    const currentSystem = typeof current.system === "string" ? current.system : undefined
    if (desiredSystem && shouldRefreshPrompt(currentSystem, desiredSystem)) {
      result = applyEdits(result, modify(result, ["agents", id, "system"], migratePrompt(currentSystem, desiredSystem), { formattingOptions }))
    }

    const desiredPermissions = Array.isArray(rawDesired.permissions) ? rawDesired.permissions : undefined
    if (desiredPermissions) {
      const currentPermissions = current.permissions
      const migration = planPermissionMigration(currentPermissions, desiredPermissions, id, options)
      if (!sameJson(currentPermissions, migration.final)) {
        if (Array.isArray(currentPermissions)) {
          result = applyPermissionMigrationEdits(result, ["agents", id, "permissions"], currentPermissions, migration)
        } else {
          result = applyEdits(result, modify(result, ["agents", id, "permissions"], migration.final, { formattingOptions }))
        }
      }
    }

    // Descriptions are generated metadata. Only the known installer defaults
    // are replaced; a custom description remains user-authored.
    if (typeof rawDesired.description === "string") {
      const oldDefault = id === options.orchestrator ? "Coordinates specialized agents and verifies their work." : undefined
      if (current.description === undefined || current.description === oldDefault) {
        result = applyEdits(result, modify(result, ["agents", id, "description"], rawDesired.description, { formattingOptions }))
      }
    }
  }
  return result
}

function shouldRefreshPrompt(current: string | undefined, desired: string): boolean {
  if (!current || current === desired) return !current
  if (
    current.includes("task_complexity_classify") ||
    current.includes("admission_transition") ||
    current.includes("orchestrator_lead_board") ||
    current.includes("orchestrator_github_issue")
  ) return true
  return (
    current.includes("Worker handoff format:") ||
    current.includes("You are the conductor, not a worker of last resort.") ||
    current.includes("Bounded nested delegation graph")
  )
}

function migratePrompt(current: string | undefined, desired: string): string {
  if (!current || current === desired) return desired
  const removed = ["task_complexity_classify", "admission_transition", "orchestrator_lead_board", "orchestrator_github_issue"]
  const retained = current
    .split(/\r?\n/)
    .filter((line) => !isOwnedRemovedPromptLine(line, removed))
    .join("\n")
    .trim()
  // Prompt ownership cannot be proven for arbitrary prose: a user may have
  // copied a removed tool name into a custom instruction. Remove only legacy
  // lines with the generated wording we recognize, retain all other text, and
  // append the current generated prompt once. This is intentionally
  // conservative; migration must not erase user-authored guidance.
  if (retained.includes(desired)) return retained
  return retained.length > 0 ? `${retained}\n\n${desired}` : desired
}

function isOwnedRemovedPromptLine(line: string, removed: readonly string[]): boolean {
  const trimmed = line.trim()
  if (!removed.some((name) => trimmed.includes(name))) return false
  return (
    trimmed.startsWith("Parent:") ||
    trimmed.startsWith("Reach ") ||
    trimmed.startsWith("Map ") ||
    trimmed.startsWith("Work the task ") ||
    trimmed.startsWith("Use orchestrator_") ||
    trimmed.startsWith("Call orchestrator_")
  )
}

type PermissionMigration = {
  final: unknown[]
  removeIndices: number[]
  additions: PermissionRuleLike[]
}

function planPermissionMigration(
  current: unknown,
  desired: readonly unknown[],
  agentID: string,
  options: OrchestratorOptions,
): PermissionMigration {
  if (!Array.isArray(current)) {
    const additions = desired.filter(isPermissionRule)
    return { final: [...additions], removeIndices: [], additions }
  }
  const knownRoleIDs = new Set([...Object.values(DEFAULT_ROLES), ...Object.values(options.roles)])
  const desiredRules = desired.filter(isPermissionRule)
  const expectedTargets = expectedDelegationTargets(agentID, options)
  const removeIndices: number[] = []
  const preserved = current.filter((candidate, index) => {
    const action = isRecord(candidate) && typeof candidate.action === "string" ? candidate.action : undefined
    const partial = action ? (candidate as PermissionRuleLike) : undefined
    if (partial && (isRemovedPermissionRule(partial) || isOldPipedPermissionRule(partial))) {
      removeIndices.push(index)
      return false
    }
    if (!isPermissionRule(candidate)) return true
    if (isStaleDelegationRule(candidate, expectedTargets, knownRoleIDs)) {
      removeIndices.push(index)
      return false
    }
    // An exact rule already present in the user's config remains authoritative,
    // including an explicit `ask` or `deny` override. Missing generated rules
    // are appended below instead of replacing that exact scope.
    return true
  })

  const additions = desiredRules.filter(
    (rule) => !preserved.some((candidate) => isPermissionRule(candidate) && samePermissionScope(candidate, rule)),
  )
  return { final: [...preserved, ...additions], removeIndices, additions }
}

function applyPermissionMigrationEdits(
  source: string,
  path: (string | number)[],
  current: readonly unknown[],
  migration: PermissionMigration,
): string {
  let result = source
  for (const index of [...migration.removeIndices].sort((left, right) => right - left)) {
    result = applyEdits(result, modify(result, [...path, index], undefined, { formattingOptions }))
  }
  let length = current.length - migration.removeIndices.length
  for (const rule of migration.additions) {
    result = applyEdits(result, modify(result, [...path, length], rule, { formattingOptions }))
    length += 1
  }
  return result
}

function expectedDelegationTargets(agentID: string, options: OrchestratorOptions): ReadonlySet<string> {
  if (agentID === options.orchestrator) return new Set(Object.values(options.roles))
  const role = (Object.entries(options.roles) as Array<[RoleName, string]>).find(([, id]) => id === agentID)?.[0]
  return new Set(role ? ROLE_DELEGATION[role].map((target) => options.roles[target]) : [])
}

function isPermissionRule(value: unknown): value is PermissionRuleLike & Record<string, unknown> {
  return isRecord(value) && typeof value.action === "string" && typeof value.resource === "string" && typeof value.effect === "string"
}

function samePermissionScope(left: PermissionRuleLike, right: PermissionRuleLike): boolean {
  return left.action === right.action && left.resource === right.resource
}

function isStaleDelegationRule(
  rule: PermissionRuleLike,
  expectedTargets: ReadonlySet<string>,
  knownRoleIDs: ReadonlySet<string>,
): boolean {
  return (
    rule.action === "subagent" &&
    rule.effect === "allow" &&
    rule.resource !== "*" &&
    typeof rule.resource === "string" &&
    knownRoleIDs.has(rule.resource) &&
    !expectedTargets.has(rule.resource)
  )
}

function isRemovedPermissionRule(rule: PermissionRuleLike): boolean {
  return typeof rule.action === "string" && REMOVED_PERMISSION_FAMILIES.includes(rule.action as (typeof REMOVED_PERMISSION_FAMILIES)[number]) && (rule.resource === "*" || rule.resource === undefined)
}

function isOldPipedPermissionRule(rule: PermissionRuleLike): boolean {
  const action = rule.action
  if (typeof action !== "string" || !action.includes("|")) return false
  return REMOVED_PERMISSION_FAMILIES.some((family) => action.split("|").includes(family)) && rule.resource === "*" && (rule.effect === "allow" || rule.effect === "deny")
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function orchestratorPermissions(options: OrchestratorOptions): Array<Record<string, string>> {
  return [
    { action: "*", resource: "*", effect: "deny" },
    // The orchestrator owns clarification and may use the native question
    // tool; workers remain covered by their deny-all policy.
    { action: "question", resource: "*", effect: "allow" },
    // Keep the goal tools visible and callable despite the deny-all above.
    // They share one explicit permission action declared on each tool.
    { action: GOAL_TOOL_PERMISSION, resource: "*", effect: "allow" },
    // Surface the orchestrator-only feature family (github/worktree): one
    // explicit permission action per family declared on each tool, so discrete
    // rules grant or revoke each set while workers stay denied.
    ...orchestratorOnlyPermissionRules("allow"),
    { action: REVIEW_SUBMIT_TOOL_PERMISSION, resource: "*", effect: "deny" },
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
    { action: REVIEW_SUBMIT_TOOL_PERMISSION, resource: "*", effect: "deny" },
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
    return [
      ...common,
      ...(role === "review" ? [{ action: REVIEW_SUBMIT_TOOL_PERMISSION, resource: "*", effect: "allow" }] : []),
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "deny" },
      ...sensitiveReadPermissions(),
    ]
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

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0
}

function validatePlannedConfig(source: string, path: string): void {
  const errors: ParseError[] = []
  const document = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(document)) throw new Error(`Invalid JSONC generated for ${path}`)
  if (document.plugins !== undefined && !Array.isArray(document.plugins)) {
    throw new Error(`Invalid generated plugins entry at ${path}`)
  }
  if (document.agents !== undefined && !isRecord(document.agents)) {
    throw new Error(`Invalid generated agents entry at ${path}`)
  }
  if (document.commands !== undefined && !isRecord(document.commands)) {
    throw new Error(`Invalid generated commands entry at ${path}`)
  }
  if (document.experimental !== undefined && !isRecord(document.experimental)) {
    throw new Error(`Invalid generated experimental entry at ${path}`)
  }
}

/**
 * Stable, bounded line diff for `install --check`. It intentionally avoids a
 * wall-clock or temporary-file based diff so identical inputs always produce
 * identical output. The full proposed document is shown only when it fits the
 * output cap; the installer itself never truncates the content it would write.
 */
export function formatInstallDiff(path: string, source: string, content: string): string {
  if (source === content) return `No changes required for ${path}`
  const before = source.split(/\r?\n/)
  const after = content.split(/\r?\n/)
  const first = commonPrefix(before, after)
  const last = commonSuffix(before, after, first)
  const removed = before.slice(first, before.length - last)
  const added = after.slice(first, after.length - last)
  const lines = [
    `--- ${path}`,
    `+++ ${path} (planned)`,
    `@@ ${first + 1},${removed.length} -> ${first + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ]
  const output = lines.join("\n")
  if (output.length <= INSTALL_DIFF_OUTPUT_CAP) return output
  const note = `\n... install diff truncated at ${INSTALL_DIFF_OUTPUT_CAP} bytes; --check does not write the planned content`
  return `${output.slice(0, Math.max(0, INSTALL_DIFF_OUTPUT_CAP - note.length))}${note}`
}

function commonPrefix(before: readonly string[], after: readonly string[]): number {
  let index = 0
  while (index < before.length && index < after.length && before[index] === after[index]) index += 1
  return index
}

function commonSuffix(before: readonly string[], after: readonly string[], prefix: number): number {
  let count = 0
  while (
    count < before.length - prefix &&
    count < after.length - prefix &&
    before[before.length - 1 - count] === after[after.length - 1 - count]
  ) {
    count += 1
  }
  return count
}

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" as const }
const INSTALL_DIFF_OUTPUT_CAP = 32 * 1024
