import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import type { Model } from "@opencode-ai/schema/model"
import type { CommandName, CommandInvocationLike } from "./index.js"
import { commandDefinitions } from "./index.js"
import { buildCommandPrompt } from "../../core/prompts.js"
import { moveSessionToDirectory } from "../session/move.js"
import {
  goalStorageKey,
  newGoal,
  readGoal,
  readPlanRun,
  runStorageKey,
  stopStorageKey,
  withSessionLock,
  type GoalRecord,
  type PlanRunRecord,
} from "../goal/state.js"

type ModelRefLike = {
  id: string
  providerID: string
  variant?: string
}

export async function runCommand(
  context: Context,
  options: Parameters<typeof commandDefinitions>[0],
  name: CommandName,
  input: CommandInvocationLike,
  orchestratorModel: ModelRefLike | undefined,
): Promise<void> {
  const args = input.prompt.text.trim()
  const spec = commandDefinitions(options).find((item) => item.name === name)
  if (!spec) return

  if (spec.requiresArgument && !args) {
    await emitStatus(context, input.sessionID, `/${name} requires an argument.`)
    return
  }

  if (name === "goal") {
    await runGoalCommand(context, input.sessionID, args)
    return
  }
  if (name === "halt") {
    await runHaltCommand(context, input.sessionID, args)
    return
  }
  if (name === "handover") {
    await runHandover(context, input.sessionID, args)
    return
  }
  if (name === "cd") {
    await runCdCommand(context, input.sessionID, args, input.delivery)
    return
  }

  const planSelection = name === "run-plan" ? await startPlanRun(context, input.sessionID, args) : undefined
  if (name === "run-plan" && !planSelection) return
  const validatedArguments = name === "restructure"
    ? await validateRestructure(context, args, input.sessionID)
    : name === "polish"
      ? await polishScope(context, args, input.sessionID)
      : args
  if (validatedArguments === undefined) return

  try {
    const model = orchestratorModel ?? (await configuredModel(context, options.orchestrator))
    await activateOrchestrator(context, input.sessionID, options.orchestrator, model)
    const commandArguments = planSelection ? `${planSelection.relativePath}\n\nValidated plan:\n${planSelection.content}` : validatedArguments
    await context.session.prompt({
      sessionID: input.sessionID,
      text: buildCommandPrompt(name, commandArguments),
      delivery: input.delivery,
      // Rebuild the prompt instead of spreading input.prompt: the native command
      // invocation carries explicit undefined arrays for files/agents/skills, which
      // the SessionPrompt schema rejects, and the rewritten text invalidates any
      // mention offsets in the original text.
      ...(Array.isArray(input.prompt.files) ? { files: rebuildFiles(input.prompt.files) } : {}),
      ...(Array.isArray(input.prompt.agents) ? { agents: rebuildAgents(input.prompt.agents) } : {}),
      ...(Array.isArray(input.prompt.skills) ? { skills: rebuildSkills(input.prompt.skills) } : {}),
    })
  } catch (error) {
    // A selected plan is already recorded as active; never leave it falsely
    // active when activation or delivery fails after that point.
    if (planSelection) {
      await pausePlanRunOnFailure(context, input.sessionID, planSelection, errorMessage(error))
    }
    throw error
  }
}

type FileAttachmentLike = { uri: string; name?: string; description?: string; mention?: unknown }
type AgentAttachmentLike = { name: string; mention?: unknown }
type SkillAttachmentLike = { id: string; mention?: unknown }

// Keep attachment identity and metadata fields allowed by PromptInput, but drop
// `mention`: its start/end offsets point into the original text that
// buildCommandPrompt replaced.
function rebuildFiles(files: readonly FileAttachmentLike[]): Array<{ uri: string; name?: string; description?: string }> {
  return files.map((file) => ({
    uri: file.uri,
    ...(typeof file.name === "string" ? { name: file.name } : {}),
    ...(typeof file.description === "string" ? { description: file.description } : {}),
  }))
}

function rebuildAgents(agents: readonly AgentAttachmentLike[]): Array<{ name: string }> {
  return agents.map((agent) => ({ name: agent.name }))
}

function rebuildSkills(skills: readonly SkillAttachmentLike[]): Array<{ id: string }> {
  return skills.map((skill) => ({ id: skill.id }))
}

async function runHandover(context: Context, sessionID: string, focus: string): Promise<void> {
  const sections: string[] = ["# OpenCode Orchestrator Handover", `Focus: ${redact(focus.trim() || "general continuation")}`]
  try {
    const history = await context.session.context({ sessionID })
    const messages = arrayData(history)
      .map(messageText)
      .filter((text): text is string => Boolean(text))
      .slice(-8)
    if (messages.length > 0) sections.push("## Recent session context", messages.join("\n\n").slice(0, 8_000))
  } catch (error) {
    sections.push(`## Session context\nUnavailable: ${redact(errorMessage(error))}`)
  }

  const vcs = context.vcs
  const sessionRoot = await sessionLocation(context, sessionID)
  const location = { location: { directory: sessionRoot.directory, workspace: sessionRoot.workspaceID } }
  try {
    const status = await vcs.status(location)
    const files = arrayData(status).map((item) => {
      const value = asRecord(item)
      return value ? `${value.status ?? "changed"} ${value.file ?? "unknown"}` : undefined
    }).filter((value): value is string => Boolean(value))
    sections.push("## VCS status", files.length > 0 ? files.join("\n") : "Working copy is clean.")
  } catch (error) {
    sections.push(`## VCS status\nUnavailable: ${redact(errorMessage(error))}`)
  }
  try {
    const diff = await vcs.diff({ ...location, mode: "working", context: 3 })
    const patches = arrayData(diff).map((item) => {
      const value = asRecord(item)
      return value ? `${value.file ?? "unknown"}\n${value.patch ?? ""}` : undefined
    }).filter((value): value is string => Boolean(value))
    if (patches.length > 0) sections.push("## Current diff", redact(patches.join("\n\n")).slice(0, 12_000))
  } catch (error) {
    sections.push(`## Current diff\nUnavailable: ${redact(errorMessage(error))}`)
  }
  await emitStatus(context, sessionID, sections.join("\n\n").slice(0, 24_000))
}

async function runCdCommand(
  context: Context,
  sessionID: string,
  args: string,
  delivery: CommandInvocationLike["delivery"],
): Promise<void> {
  const outcome = await moveSessionToDirectory(
    {
      session: context.session,
      storage: context.storage,
      location: context.location,
    },
    { sessionID, target: args, delivery: delivery ?? null },
  )
  if (!outcome.ok) {
    await emitStatus(context, sessionID, `/cd rejected: ${redact(outcome.reason)}`)
    return
  }
  await emitStatus(
    context,
    sessionID,
    `Session moved to ${outcome.session.location?.directory ?? "unknown"}; session ${outcome.session.id} and history preserved.`,
  )
}

// Resolve the session's *current* location so post-move commands operate where
// the session actually lives, falling back to the plugin's load-time location
// when the session cannot be read (pre-created or unavailable sessions).
async function sessionLocation(
  context: Context,
  sessionID: string,
): Promise<{ directory: string; workspaceID?: string }> {
  try {
    const session = unwrapSession(await context.session.get({ sessionID }))
    const directory = session?.location?.directory
    if (typeof directory === "string" && directory.length > 0) {
      const workspaceID = typeof session?.location?.workspaceID === "string" ? session.location.workspaceID : undefined
      return { directory, ...(workspaceID !== undefined ? { workspaceID } : {}) }
    }
  } catch {
    // Fall back to the plugin location; the model can still inspect the default scope.
  }
  return {
    directory: context.location.directory,
    ...(context.location.workspaceID !== undefined ? { workspaceID: context.location.workspaceID } : {}),
  }
}

function unwrapSession(value: unknown): { location?: { directory?: unknown; workspaceID?: unknown } } | undefined {
  if (!value || typeof value !== "object") return undefined
  if (Array.isArray((value as { data?: unknown }).data)) return undefined
  const source = (value as { data?: unknown }).data && typeof (value as { data: unknown }).data === "object"
    ? (value as { data: unknown }).data
    : value
  if (!source || typeof source !== "object") return undefined
  const session = source as { location?: unknown }
  if (!session.location || typeof session.location !== "object") return undefined
  return { location: session.location as { directory?: unknown; workspaceID?: unknown } }
}

async function polishScope(context: Context, args: string, sessionID: string): Promise<string | undefined> {
  const sessionRoot = await sessionLocation(context, sessionID)
  if (args.trim()) {
    const scopes = args
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean)
    const safeScopes = await Promise.all(scopes.map((scope) => isSafeProjectPath(sessionRoot.directory, scope)))
    if (scopes.length === 0 || scopes.some((scope, index) => scope.startsWith("--") || !safeScopes[index])) {
      await emitStatus(context, sessionID, "Polish scope must contain only relative paths inside the current project.")
      return undefined
    }
    return `Explicit scope: ${scopes.join(", ")}`
  }
  try {
    const status = await context.vcs.status({ location: { directory: sessionRoot.directory, workspace: sessionRoot.workspaceID } })
    const files = arrayData(status).map((item) => asRecord(item)?.file).filter((value): value is string => typeof value === "string")
    if (files.length > 0) return `Changed files only: ${files.join(", ")}`
  } catch {
    // The model can still inspect the default working-copy scope.
  }
  await emitStatus(context, sessionID, "No changed files were found for /polish.")
  return undefined
}

async function isSafeProjectPath(directory: string, value: string): Promise<boolean> {
  if (!value || value.includes("\0") || isAbsolute(value)) return false
  const target = await realpath(resolve(directory, value)).catch(() => undefined)
  const root = await realpath(directory).catch(() => undefined)
  if (!target || !root) return false
  const remainder = relative(root, target)
  return remainder !== ".." && !remainder.startsWith(`..${pathSeparator()}`) && !isAbsolute(remainder)
}

async function validateRestructure(
  context: Context,
  args: string,
  sessionID: string,
): Promise<string | undefined> {
  const sessionRoot = await sessionLocation(context, sessionID)
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let scope = "file"
  let risk = "conservative"
  const target: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.startsWith("--scope=")) {
      scope = token.slice("--scope=".length)
      continue
    }
    if (token === "--scope") {
      scope = tokens[++index] ?? ""
      continue
    }
    if (token.startsWith("--risk=")) {
      risk = token.slice("--risk=".length)
      continue
    }
    if (token === "--risk") {
      risk = tokens[++index] ?? ""
      continue
    }
    if (token.startsWith("--")) {
      await emitStatus(context, sessionID, "Usage: /restructure <target> [--scope=file|module|project] [--risk=conservative|broad]")
      return undefined
    }
    target.push(token)
  }

  const targetText = target.join(" ")
  if (!targetText || !["file", "module", "project"].includes(scope) || !["conservative", "broad"].includes(risk)) {
    await emitStatus(context, sessionID, "Usage: /restructure <target> [--scope=file|module|project] [--risk=conservative|broad]")
    return undefined
  }
  if (targetText.includes("\0") || isAbsolute(targetText)) {
    await emitStatus(context, sessionID, "Restructure target must be a relative path inside the current project.")
    return undefined
  }
  const projectRootTarget = scope === "project" && (targetText === "." || targetText === "project")
  const resolvedTarget = resolve(sessionRoot.directory, projectRootTarget ? "." : targetText)
  const remainder = relative(sessionRoot.directory, resolvedTarget)
  if ((!remainder && !projectRootTarget) || remainder === ".." || remainder.startsWith(`..${pathSeparator()}`) || isAbsolute(remainder)) {
    await emitStatus(context, sessionID, "Restructure target must be a relative path inside the current project.")
    return undefined
  }
  const targetInfo = await stat(resolvedTarget).catch(() => undefined)
  if (!targetInfo || (scope === "file" && !targetInfo.isFile())) {
    await emitStatus(context, sessionID, "Restructure target must exist and match the selected scope.")
    return undefined
  }
  if (!(await isSafeProjectPath(sessionRoot.directory, projectRootTarget ? "." : targetText))) {
    await emitStatus(context, sessionID, "Restructure target must remain inside the current project.")
    return undefined
  }
  return `Target: ${targetText}\nScope: ${scope}\nRisk: ${risk}`
}

export async function activateOrchestrator(
  context: Pick<Context, "session">,
  sessionID: string,
  agent: string,
  model: ModelRefLike | undefined,
): Promise<void> {
  await context.session.switchAgent({ sessionID, agent })
  if (model) {
    await context.session.switchModel({ sessionID, model: model as Model.Ref })
  }
}

async function runGoalCommand(
  context: Context,
  sessionID: string,
  args: string,
): Promise<void> {
  await withSessionLock(context.location, sessionID, () => mutateGoalCommand(context, sessionID, args))
}

async function mutateGoalCommand(
  context: Context,
  sessionID: string,
  args: string,
): Promise<void> {
  const key = goalStorageKey(context.location, sessionID)
  const current = await readGoal(context.storage, key)

  if (!args) {
    await emitStatus(context, sessionID, current ? JSON.stringify(current, null, 2) : "No active orchestration goal.")
    return
  }

  if (args === "clear") {
    await context.storage.remove(key)
    await context.storage.remove(stopStorageKey(context.location, sessionID))
    await emitStatus(context, sessionID, "Orchestration goal cleared.")
    return
  }

  if (args === "pause" || args === "resume") {
    if (!current) {
      await emitStatus(context, sessionID, "No active orchestration goal.")
      return
    }
    const updated: GoalRecord = {
      ...current,
      status: args === "pause" ? "paused" : "active",
      updatedAt: Date.now(),
    }
    if (args === "resume") {
      delete updated.completedAt
      delete updated.completionEvidence
    }
    await context.storage.set(key, updated)
    if (args === "resume") await context.storage.remove(stopStorageKey(context.location, sessionID))
    await emitStatus(context, sessionID, `Orchestration goal ${args}d.`)
    return
  }

  const goal = newGoal(sessionID, args)
  await context.storage.set(key, goal)
  await context.storage.remove(stopStorageKey(context.location, sessionID))
  await emitStatus(context, sessionID, `Orchestration goal set:\n${goal.objective}`)
}

async function runHaltCommand(
  context: Context,
  sessionID: string,
  args: string,
): Promise<void> {
  await withSessionLock(context.location, sessionID, () => mutateHaltCommand(context, sessionID, args))
}

async function mutateHaltCommand(
  context: Context,
  sessionID: string,
  args: string,
): Promise<void> {
  const target = args || "all"
  if (target !== "goal" && target !== "run" && target !== "all") {
    await emitStatus(context, sessionID, "Usage: /halt [goal|run|all]")
    return
  }

  const messages: string[] = []
  if (target === "goal" || target === "all") {
    const key = goalStorageKey(context.location, sessionID)
    const goal = await readGoal(context.storage, key)
    if (goal) {
      await context.storage.set(key, { ...goal, status: "paused", updatedAt: Date.now() })
      messages.push("goal paused")
    } else {
      messages.push("no goal")
    }
  }

  if (target === "run" || target === "all") {
    const key = runStorageKey(context.location, sessionID)
    const run = await readPlanRun(context.storage, key)
    if (run) {
      await context.storage.set(key, { ...run, status: "paused", updatedAt: Date.now() })
      messages.push("plan run paused")
    } else {
      messages.push("no plan run")
    }
  }

  if (target === "all") {
    await context.storage.set(stopStorageKey(context.location, sessionID), {
      version: 1,
      sessionID,
      stoppedAt: Date.now(),
    })
    messages.push("automatic continuation stopped")
  }
  await emitStatus(context, sessionID, `Automation halted (${messages.join(", ")}).`)
}

type PlanSelection = {
  relativePath: string
  content: string
}

async function startPlanRun(context: Context, sessionID: string, plan: string): Promise<PlanSelection | undefined> {
  return withSessionLock(context.location, sessionID, () => mutateStartPlanRun(context, sessionID, plan))
}

async function mutateStartPlanRun(context: Context, sessionID: string, plan: string): Promise<PlanSelection | undefined> {
  const key = runStorageKey(context.location, sessionID)
  const current = await readPlanRun(context.storage, key)
  const resumable = current && (current.status === "active" || current.status === "paused") ? current.plan ?? "" : ""
  const sessionRoot = await sessionLocation(context, sessionID)
  const selected = await selectPlan(sessionRoot.directory, plan || resumable)
  if (!selected) {
    if (!plan && resumable) {
      await emitStatus(context, sessionID, "The stored plan run could not be resumed; specify one plan from .orchestrator/plans/.")
    } else {
      await emitStatus(context, sessionID, "Specify one plan from .orchestrator/plans/; no sole incomplete plan was available.")
    }
    return undefined
  }
  const now = Date.now()
  const run: PlanRunRecord = {
    version: 1,
    sessionID,
    plan: selected.relativePath,
    status: "active",
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  }
  await context.storage.set(key, run)
  return selected
}

async function pausePlanRunOnFailure(context: Context, sessionID: string, selection: PlanSelection, reason: string): Promise<void> {
  await withSessionLock(context.location, sessionID, async () => {
    const key = runStorageKey(context.location, sessionID)
    const run = await readPlanRun(context.storage, key)
    // Pause only the run this invocation activated; a concurrent command may
    // have replaced or completed it since selection.
    if (!run || run.status !== "active" || run.plan !== selection.relativePath) return
    await context.storage.set(key, { ...run, status: "paused", updatedAt: Date.now() })
    await emitStatus(context, sessionID, `Plan run paused; ${redact(reason)}`)
  })
}

async function selectPlan(directory: string, requested: string): Promise<PlanSelection | undefined> {
  const planDirectory = resolve(directory, ".orchestrator", "plans")
  let relativePath = normalizePlanName(requested)
  if (!relativePath) {
    const candidates = await incompletePlans(planDirectory)
    if (candidates.length !== 1) return undefined
    relativePath = candidates[0]
  }

  const fileName = relativePath.endsWith(".md") ? relativePath : `${relativePath}.md`
  const path = resolve(planDirectory, fileName)
  const withinPlanDirectory = relative(planDirectory, path)
  if (!withinPlanDirectory || withinPlanDirectory === ".." || withinPlanDirectory.startsWith(`..${pathSeparator()}`) || isAbsolute(withinPlanDirectory)) {
    return undefined
  }
  // Resolve symlinks canonically so an explicitly selected plan cannot escape
  // .orchestrator/plans through a link that lexically looks contained.
  if (!(await isWithinCanonical(planDirectory, path))) return undefined
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  if (!content.trim() || isCompletePlan(content)) return undefined
  return {
    relativePath: `.orchestrator/plans/${withinPlanDirectory.replaceAll(pathSeparator(), "/")}`,
    content: content.trim().slice(0, 120_000),
  }
}

function normalizePlanName(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/")
  return normalized.startsWith(".orchestrator/plans/") ? normalized.slice(".orchestrator/plans/".length) : normalized
}

async function incompletePlans(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    try {
      const content = await readFile(resolve(directory, entry.name), "utf8")
      if (content.trim() && !isCompletePlan(content)) candidates.push(entry.name)
    } catch {
      // A disappearing plan is not a selectable plan.
    }
  }
  return candidates.sort()
}

async function isWithinCanonical(root: string, target: string): Promise<boolean> {
  const canonicalRoot = await realpath(root).catch(() => undefined)
  const canonicalTarget = await realpath(target).catch(() => undefined)
  if (!canonicalRoot || !canonicalTarget) return false
  const remainder = relative(canonicalRoot, canonicalTarget)
  return remainder !== ".." && !remainder.startsWith(`..${pathSeparator()}`) && !isAbsolute(remainder)
}

function isCompletePlan(content: string): boolean {
  const frontMatter = content.match(/^---\s*[\s\S]*?\nstatus\s*:\s*([^\s]+)[\s\S]*?\n---/i)?.[1]
  const heading = content.match(/^#+\s*status\s*\n+\s*([^\s]+)/im)?.[1]
  return [frontMatter, heading].some((value) => {
    // YAML frontmatter may quote the status value, e.g. status: "complete".
    const candidate = value?.trim().replace(/^["']|["']$/g, "")
    return candidate !== undefined && /^(complete|completed|done)$/i.test(candidate)
  })
}

function pathSeparator(): string {
  return resolve(".").includes("\\") ? "\\" : "/"
}

function arrayData(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: unknown[] }).data
  }
  return []
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function messageText(value: unknown): string | undefined {
  const message = asRecord(value)
  if (!message) return undefined
  if (typeof message.text === "string") return `${String(message.type ?? "message")}: ${redact(message.text)}`
  if (message.type === "assistant" && Array.isArray(message.content)) {
    const text = message.content
      .map((part) => asRecord(part)?.text)
      .filter((part): part is string => typeof part === "string")
      .join("")
    return text ? `assistant: ${redact(text)}` : undefined
  }
  if (message.type === "shell") {
    const output = asRecord(message.output)?.output
    return typeof output === "string" ? `shell: ${redact(output)}` : undefined
  }
  if (message.type === "compaction") {
    const summary = typeof message.summary === "string" ? message.summary : typeof message.recent === "string" ? message.recent : undefined
    return summary ? `compaction: ${redact(summary)}` : undefined
  }
  return undefined
}

function redact(value: string): string {
  return value.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function configuredModel(context: Context, agentID: string): Promise<ModelRefLike | undefined> {
  const response = await context.agent.get({ agentID })
  const value = response && typeof response === "object" && "data" in response ? response.data : response
  if (!value || typeof value !== "object") return undefined
  const model = (value as { model?: unknown }).model
  if (!model || typeof model !== "object") return undefined
  const candidate = model as { id?: unknown; providerID?: unknown; variant?: unknown }
  if (typeof candidate.id !== "string" || typeof candidate.providerID !== "string") return undefined
  return {
    id: candidate.id,
    providerID: candidate.providerID,
    ...(typeof candidate.variant === "string" ? { variant: candidate.variant } : {}),
  }
}

async function emitStatus(context: Context, sessionID: string, text: string): Promise<void> {
  try {
    await context.session.synthetic({
      sessionID,
      text,
      metadata: { source: "opencode-orchestrator" },
    })
  } catch (error) {
    console.warn(`opencode-orchestrator could not report command status for ${sessionID}`, error)
  }
}
