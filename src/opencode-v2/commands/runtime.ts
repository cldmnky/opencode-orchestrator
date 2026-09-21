import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Model } from "@opencode/schema/model"
import type { CommandName, CommandInvocationLike } from "./index.js"
import { commandDefinitions } from "./index.js"
import type { OrchestratorOptions } from "../../core/config.js"
import { buildCommandPrompt } from "../../core/prompts.js"
import { HANDOFF_SUMMARY_FIELDS } from "../../core/policy.js"
import type { DispatchGate } from "../observability/runtime.js"
import { authorityDispatchMetadata } from "../authority/runtime.js"
import { redact } from "../process/redact.js"
import { formatModelReference } from "../../core/model-reference.js"
import { parseWorkerModelAssignment, type WorkerModelRuntime } from "../worker-models/runtime.js"
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
import { publicationStatus, setPublicationEnabled, type PublicationStatusView } from "../publish/state.js"
import {
  createLeadBoardV2,
  hydrateLeadBoardV2,
  leadBoardV2KeyedLocation,
  leadBoardV2StorageKey,
  migrateLeadBoardV1Storage,
  parseLeadBoardV2,
  pauseLeadBoardV2,
  removeLeadBoardV2,
  resumeLeadBoardV2,
  writeLeadBoardV2,
} from "../orchestration/lead-board-v2.js"
import {
  clearGates,
  gateChangeMessage,
  gateStatuses,
  isSessionGate,
  setGateDisabled,
  SESSION_GATES,
  type GateStatus,
} from "../gates/state.js"

type ModelRefLike = {
  id: string
  providerID: string
  variant?: string
}

/**
 * User-facing plain-language template (G3 Phase 0; see
 * docs/g3-communication-contract.md). Every prose status message answers what
 * happened, what it means, and — when there is one — what happens next or what
 * the user can do. The sentence budget is asserted in the unit suite.
 *
 * Model-facing detail is never softened here: raw refusal reasons stay in the
 * "what happened" line so a gate/limit explanation is still verbatim.
 */
export function statusMessage(input: { happened: string; means: string; next?: string }): string {
  return [
    `What happened: ${input.happened}`,
    `What it means: ${input.means}`,
    ...(input.next ? [`What's next: ${input.next}`] : []),
  ].join("\n")
}

/**
 * Data collected for the readable `/handover` summary. Every field is
 * optional so a failed read is reported truthfully instead of being omitted.
 */
export type HandoverSummaryInput = {
  focus: string
  context?: string
  contextError?: string
  files?: readonly string[]
  filesError?: string
  diff?: string
  diffError?: string
}

/**
 * Readable handover summary derived from the D2 handoff fields (see
 * `HANDOFF_SUMMARY_FIELDS`): Outcome, Files, Verification, Risks, Follow-up.
 * The same five-field skeleton is used by worker handoffs and the orchestrator
 * finish summary, so a reader can move between them without relearning the
 * structure. Rendering only: no D2 field, schema, or validation changes.
 */
export function formatHandoverSummary(input: HandoverSummaryInput): string {
  const files = input.filesError
    ? [`Unavailable: ${input.filesError}`]
    : input.files && input.files.length > 0
      ? input.files.map((file) => `- ${file}`)
      : ["Working copy is clean."]
  const sections: string[] = [
    "# Handover summary",
    `Focus: ${input.focus}`,
    "",
    `${HANDOFF_SUMMARY_FIELDS[0]} — what this session did and where it left the work:`,
    input.context ?? `Unavailable: ${input.contextError ?? "no session context was returned."}`,
    "",
    `${HANDOFF_SUMMARY_FIELDS[1]} — what was read or changed, with scope:`,
    ...files,
    "",
    `${HANDOFF_SUMMARY_FIELDS[2]} — the commands run and their results:`,
    "Not captured in this handover; run the checks this work needs and record the results.",
    "",
    `${HANDOFF_SUMMARY_FIELDS[3]} — what is uncertain or unverified:`,
    "This summary was assembled from session context and VCS state; it does not prove that any check passed.",
    "",
    `${HANDOFF_SUMMARY_FIELDS[4]} — the next concrete action:`,
    `Continue with: ${input.focus}. Re-read the Outcome section and verify the working copy before changing it.`,
  ]
  if (input.diff || input.diffError) {
    sections.push("", "Current diff (raw evidence):", input.diff ?? `Unavailable: ${input.diffError}`)
  }
  return sections.join("\n")
}

export async function runCommand(
  context: Context,
  options: Parameters<typeof commandDefinitions>[0],
  name: CommandName,
  input: CommandInvocationLike,
  orchestratorModel: ModelRefLike | undefined,
  gate?: DispatchGate,
  workerModels?: WorkerModelRuntime,
): Promise<void> {
  const args = input.prompt.text.trim()
  const spec = commandDefinitions(options).find((item) => item.name === name)
  if (!spec) return

  if (spec.requiresArgument && !args) {
    await emitStatus(
      context,
      input.sessionID,
      statusMessage({
        happened: `/${name} needs an argument, so nothing ran.`,
        means: "No work was started and nothing changed.",
        next: `Run /${name} with the argument it needs.`,
      }),
    )
    return
  }

  if (name === "worker-models") {
    await runWorkerModelsCommand(context, input.sessionID, args, workerModels)
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
  if (name === "publish") {
    await runPublishCommand(context, input.sessionID, args, options)
    return
  }
  if (name === "gates") {
    await runGatesCommand(context, input.sessionID, args, options)
    return
  }
  if (name === "handover") {
    await runHandover(context, input.sessionID, args)
    return
  }

  // stop-between-steps budget checks run before any plan run is activated or
  // any prompt is delivered, so a blocked dispatch never starts new work.
  if (gate) {
    const decision = await gate.allowDispatch(input.sessionID, "command")
    if (!decision.allow) {
      await emitStatus(
        context,
        input.sessionID,
        statusMessage({
          happened: `Dispatch blocked by configured controls: ${decision.reason}`,
          means: "The command was not delivered, so no new work started.",
          next: "Inspect the controls with /gates or orchestrator_observability_get, then retry.",
        }),
      )
      return
    }
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
      text: buildCommandPrompt(name, commandArguments, options),
      delivery: input.delivery,
      // Phase A N1: a plugin-created command dispatch carries the bounded
      // authority marker only in enforce mode. The pinned `CommandInvocation`
      // prompt has no metadata field, so there is no caller metadata to merge
      // here; `withAuthorityDispatchMetadata` preserves caller keys where a
      // caller supplies them.
      ...(options.authority.mode === "enforce" ? { metadata: authorityDispatchMetadata("command") } : {}),
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
  const summary: HandoverSummaryInput = { focus: redact(focus.trim() || "general continuation") }
  try {
    const history = await context.session.context({ sessionID })
    const messages = arrayData(history)
      .map(messageText)
      .filter((text): text is string => Boolean(text))
      .slice(-8)
    if (messages.length > 0) summary.context = redact(messages.join("\n\n")).slice(0, 8_000)
  } catch (error) {
    summary.contextError = redact(errorMessage(error))
  }

  const vcs = context.vcs
  const sessionRoot = await sessionLocation(context, sessionID)
  const location = { location: { directory: sessionRoot.directory, workspace: sessionRoot.workspaceID } }
  try {
    const status = await vcs.status(location)
    summary.files = arrayData(status).map((item) => {
      const value = asRecord(item)
      return value ? `${value.status ?? "changed"} ${value.file ?? "unknown"}` : undefined
    }).filter((value): value is string => Boolean(value)).map((value) => redact(value))
  } catch (error) {
    summary.filesError = redact(errorMessage(error))
  }
  try {
    const diff = await vcs.diff({ ...location, mode: "working", context: 3 })
    const patches = arrayData(diff).map((item) => {
      const value = asRecord(item)
      return value ? `${value.file ?? "unknown"}\n${value.patch ?? ""}` : undefined
    }).filter((value): value is string => Boolean(value))
    if (patches.length > 0) summary.diff = redact(patches.join("\n\n")).slice(0, 12_000)
  } catch (error) {
    summary.diffError = redact(errorMessage(error))
  }
  await emitStatus(context, sessionID, formatHandoverSummary(summary).slice(0, 24_000))
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
      await emitStatus(
        context,
        sessionID,
        statusMessage({
          happened: "Polish scope must contain only relative paths inside the current project.",
          means: "Nothing ran, so no file was changed.",
          next: "Re-run /polish with one or more relative paths inside the project.",
        }),
      )
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
  await emitStatus(
    context,
    sessionID,
    statusMessage({
      happened: "No changed files were found for /polish.",
      means: "There is nothing to polish in the working copy.",
      next: "Pass an explicit relative scope, or make a change first.",
    }),
  )
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
      await emitStatus(
        context,
        sessionID,
        statusMessage({
          happened: "/restructure received an unknown option, so nothing ran.",
          means: "No restructuring prompt was delivered and no file was changed.",
          next: "Usage: /restructure <target> [--scope=file|module|project] [--risk=conservative|broad]",
        }),
      )
      return undefined
    }
    target.push(token)
  }

  const targetText = target.join(" ")
  if (!targetText || !["file", "module", "project"].includes(scope) || !["conservative", "broad"].includes(risk)) {
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: "/restructure received options that do not match the target, so nothing ran.",
        means: "No restructuring prompt was delivered and no file was changed.",
        next: "Usage: /restructure <target> [--scope=file|module|project] [--risk=conservative|broad]",
      }),
    )
    return undefined
  }
  if (targetText.includes("\0") || isAbsolute(targetText)) {
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: "Restructure target must be a relative path inside the current project.",
        means: "Nothing ran, so no file was changed.",
        next: "Re-run /restructure with a relative path inside the project.",
      }),
    )
    return undefined
  }
  const projectRootTarget = scope === "project" && (targetText === "." || targetText === "project")
  const resolvedTarget = resolve(sessionRoot.directory, projectRootTarget ? "." : targetText)
  const remainder = relative(sessionRoot.directory, resolvedTarget)
  if ((!remainder && !projectRootTarget) || remainder === ".." || remainder.startsWith(`..${pathSeparator()}`) || isAbsolute(remainder)) {
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: "Restructure target must be a relative path inside the current project.",
        means: "Nothing ran, so no file was changed.",
        next: "Re-run /restructure with a relative path inside the project.",
      }),
    )
    return undefined
  }
  const targetInfo = await stat(resolvedTarget).catch(() => undefined)
  if (!targetInfo || (scope === "file" && !targetInfo.isFile())) {
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: "Restructure target must exist and match the selected scope.",
        means: "Nothing ran, so no file was changed.",
        next: "Check the path, then retry with --scope=file, --scope=module, or --scope=project.",
      }),
    )
    return undefined
  }
  if (!(await isSafeProjectPath(sessionRoot.directory, projectRootTarget ? "." : targetText))) {
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: "Restructure target must remain inside the current project.",
        means: "Nothing ran, so no file was changed.",
        next: "Re-run /restructure with a target inside the project.",
      }),
    )
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
    if (!current) {
      await emitStatus(
        context,
        sessionID,
        statusMessage({
          happened: "No orchestration goal is set for this session.",
          means: "Nothing is tracking an objective, so automatic continuation will not run.",
          next: "Set one with /goal <objective>.",
        }),
      )
      return
    }
    await emitStatus(
      context,
      sessionID,
      `${statusMessage({
        happened: "This is the current orchestration goal record.",
        means: "It is the stored goal state for this session.",
        next: "Pause it with /goal pause, or clear it with /goal clear.",
      })}\n\nGoal record:\n${JSON.stringify(current, null, 2)}`,
    )
    return
  }

  if (args === "clear") {
    await context.storage.remove(key)
    await context.storage.remove(stopStorageKey(context.location, sessionID))
    await removeBoardForSession(context, sessionID)
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: "Orchestration goal cleared.",
        means: "The goal, its stop flag, and its lead board were removed for this session.",
        next: "Set a new goal with /goal <objective> when you are ready.",
      }),
    )
    return
  }

  if (args === "pause" || args === "resume") {
    if (!current) {
      await emitStatus(
        context,
        sessionID,
        statusMessage({
          happened: "No orchestration goal is set for this session.",
          means: "There is nothing to pause or resume.",
          next: "Set one with /goal <objective>.",
        }),
      )
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
    // Goal commands remain the pause/halt/replacement control plane for the
    // board: pause narrows board dispatch, resume restores it, and a board can
    // never unpause itself. A completed board stays complete.
    await setBoardPaused(context, sessionID, args === "pause")
    if (args === "resume") await context.storage.remove(stopStorageKey(context.location, sessionID))
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: `Orchestration goal ${args}d.`,
        means: args === "pause"
          ? "Automatic continuation is stopped until you resume it."
          : "Automatic continuation may continue the objective again.",
        next: args === "pause" ? "Resume with /goal resume." : "Pause with /goal pause.",
      }),
    )
    return
  }

  const goal = newGoal(sessionID, args)
  await context.storage.set(key, goal)
  await context.storage.remove(stopStorageKey(context.location, sessionID))
  // A new goal generation gets a NEW deterministic board: a fresh boardID,
  // fresh idempotency keys, and a single planned root lead task. A board write
  // failure is reported truthfully; the goal then runs on the legacy
  // board-missing path until an explicit /goal set or board init succeeds.
  let boardNote = ""
  try {
    const board = await ensureBoardForGoal(context, sessionID, goal)
    boardNote = board ? `\n\nLead board: ${board.boardID} (1 planned root task).` : "\n\nLead board: not created (an existing board was kept)."
  } catch (error) {
    boardNote = `\n\nLead board: not created (${errorMessage(error)}); the goal continues on the legacy board-missing path.`
  }
  await emitStatus(
    context,
    sessionID,
    `${statusMessage({
      happened: "Orchestration goal set.",
      means: "The orchestrator will keep working toward this objective automatically.",
      next: "Pause it with /goal pause, or clear it with /goal clear.",
    })}\n\nObjective: ${goal.objective}${boardNote}`,
  )
}

/**
 * Board enrollment for one goal generation: creates the deterministic board
 * when it is absent, replaces it only when the goal generation changed, and
 * otherwise keeps the existing ledger untouched. The board is keyed by the
 * session's stable origin project exactly like goal/run/halt records.
 */
async function ensureBoardForGoal(
  context: Context,
  sessionID: string,
  goal: GoalRecord,
): Promise<{ boardID: string } | undefined> {
  const keyedLocation = await leadBoardV2KeyedLocation(context.storage, context.location, sessionID)
  const hydration = await hydrateLeadBoardV2(context.storage, context.location, sessionID)
  if (hydration.status === "unavailable") {
    throw new Error(hydration.warning ?? "the lead board is unavailable")
  }
  if (hydration.status === "ok" && hydration.board?.goalGeneration === goal.createdAt) return undefined
  if (hydration.status === "legacy" && hydration.board?.goalGeneration === goal.createdAt) {
    const migrated = await migrateLeadBoardV1Storage(context.storage, context.location, sessionID, { goalGeneration: goal.createdAt })
    if (migrated.status !== "migrated" || !migrated.board) throw new Error(migrated.message)
    return { boardID: migrated.board.boardID }
  }
  const board = createLeadBoardV2({
    projectID: keyedLocation.project.id,
    leadSessionID: sessionID,
    goalGeneration: goal.createdAt,
    objective: goal.objective,
  })
  await writeLeadBoardV2(context.storage, keyedLocation, board)
  return { boardID: board.boardID }
}

async function setBoardPaused(context: Context, sessionID: string, paused: boolean): Promise<void> {
  try {
    const keyedLocation = await leadBoardV2KeyedLocation(context.storage, context.location, sessionID)
    const key = leadBoardV2StorageKey(keyedLocation, sessionID)
    const board = parseLeadBoardV2(await context.storage.get(key))
    if (!board || board.status === "complete") return
    const next = paused ? pauseLeadBoardV2(board) : resumeLeadBoardV2(board)
    if (next !== board) await writeLeadBoardV2(context.storage, keyedLocation, next)
  } catch (error) {
    console.warn(`opencode-orchestrator could not update the lead board pause state for ${sessionID}`, error)
  }
}

async function removeBoardForSession(context: Context, sessionID: string): Promise<void> {
  try {
    await removeLeadBoardV2(context.storage, context.location, sessionID)
  } catch (error) {
    console.warn(`opencode-orchestrator could not remove the lead board for ${sessionID}`, error)
  }
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
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: "/halt did not run because the target was not recognized.",
        means: "No goal, plan run, or automation state was changed.",
        next: "Usage: /halt [goal|run|all]",
      }),
    )
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
  await emitStatus(
    context,
    sessionID,
    statusMessage({
      happened: `Automation halted (${messages.join(", ")}).`,
      means: "Automatic continuation will not start new work for this session.",
      next: "Resume with /goal resume or /run-plan when you are ready.",
    }),
  )
}

/**
 * `/publish [status|enable|disable]` — inspects or toggles the durable
 * project-scoped publication authorization policy.
 *
 * This is a capability toggle, not caller authentication: enabling writes a
 * durable record that authorizes future autonomous push, draft PR creation,
 * ready transition, verified approval after internal review, and — after every
 * merge precondition passes at the exact revision — the merge itself. It never
 * authorizes issue creation. It does not prove a human invoked it, it never
 * mutates Git or GitHub, and it never weakens the static
 * `github.enabled` / `github.allow_mutations` / `worktree.enabled` /
 * `worktree.allow_mutations` gates or the per-session gate narrowing.
 *
 * `enable` additionally requires the `publish.enabled` config master switch
 * (default off); `disable` and `status` always work so a stale durable
 * authorization can always be inspected and revoked.
 */
async function runPublishCommand(context: Context, sessionID: string, args: string, options: OrchestratorOptions): Promise<void> {
  await withSessionLock(context.location, sessionID, () => mutatePublishCommand(context, sessionID, args, options))
}

async function mutatePublishCommand(
  context: Context,
  sessionID: string,
  args: string,
  options: OrchestratorOptions,
): Promise<void> {
  const verb = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status"
  if (verb !== "status" && verb !== "enable" && verb !== "disable") {
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: "/publish did not run because the action was not recognized.",
        means: "The durable publication policy was not changed.",
        next: "Usage: /publish [status|enable|disable]",
      }),
    )
    return
  }

  if (verb === "status") {
    const status = await publicationStatus(context.storage, context.location, sessionID, options)
    await emitStatus(context, sessionID, formatPublicationStatus(status))
    return
  }

  const enabling = verb === "enable"
  if (enabling && !options.publish.enabled) {
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: "/publish enable refused: the publication capability is disabled by plugin configuration (publish.enabled: false).",
        means: "The durable project policy cannot be enabled while the capability is off, so nothing changed.",
        next: "An operator must set publish.enabled: true in the plugin options first.",
      }),
    )
    return
  }

  const toggle = await setPublicationEnabled(context.storage, context.location, sessionID, enabling)
  if (!toggle.changed && !enabling && !toggle.record.enabled) {
    // Disabling an already-disabled record: still report the policy truth.
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: `Publication is already disabled for project "${toggle.record.projectID}"; no change written.`,
        means: "The saved policy already matches your request.",
        next: "Run /publish status to see the current policy.",
      }),
    )
    return
  }
  if (!toggle.changed) {
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: `Publication is already enabled for project "${toggle.record.projectID}"; no change written.`,
        means: "The saved policy already authorizes the publication steps.",
        next: "Run /publish status to see the exact capabilities.",
      }),
    )
    return
  }
  if (enabling) {
    await emitStatus(
      context,
      sessionID,
      `${statusMessage({
        happened: `Publication enabled for project "${toggle.record.projectID}" (durable policy updated).`,
        means: "The orchestrator may now push, open a draft PR, mark it ready, approve after internal review, and merge after every merge check passes.",
        next: "Use /gates to narrow any step for this session only. Issue creation is never authorized.",
      })}\n\nDetails:\n` +
        `- authorized capabilities: ${toggle.record.capabilities.join(", ")}.\n` +
        "- This is a capability toggle, not caller authentication.\n" +
        "- No Git or GitHub mutation happened, and the static github/worktree gates are unchanged.",
    )
    return
  }
  await emitStatus(
    context,
    sessionID,
    `${statusMessage({
      happened: `Publication disabled for project "${toggle.record.projectID}" (durable policy updated; authorized capabilities: none).`,
      means: "Future push, draft PR creation, ready transition, approval, and merge steps are no longer authorized by this capability.",
      next: "Run /publish enable to authorize them again.",
    })}\n\nNo Git or GitHub mutation happened.`,
  )
}

function formatPublicationStatus(status: PublicationStatusView): string {
  const durable = status.durable
  const state = durable.enabled ? "enabled" : "disabled"
  const changed = durable.updatedAt !== undefined
    ? ` (last changed by session ${durable.updatedBy ?? "unknown"} at ${new Date(durable.updatedAt).toISOString()})`
    : " (never changed; absent records count as disabled)"
  const capabilities = durable.enabled && durable.capabilities.length > 0
    ? `Authorized capabilities (when enabled): ${durable.capabilities.join(", ")}.`
    : "Authorized capabilities (when enabled): push, pr-draft-create, pr-ready-transition, approve-after-review, merge."
  return [
    `Publication capability — project "${status.projectID}"`,
    statusMessage({
      happened: `Durable policy: ${state}${changed}.`,
      means: durable.enabled
        ? "The orchestrator may run the authorized publication steps without asking again."
        : "The orchestrator may not run autonomous publication steps for this project.",
      next: durable.enabled ? "Use /gates to narrow a step for this session." : "Run /publish enable to authorize those steps.",
    }),
    "Details:",
    `- ${capabilities}`,
    "- Never authorized: issue creation (still requires the static github gates plus confirm: true).",
    `- Static gates: publish.enabled=${status.config.enabled}; github.enabled=${status.staticGates.githubEnabled}; ` +
      `github.allow_mutations=${status.staticGates.githubAllowMutations}; worktree.enabled=${status.staticGates.worktreeEnabled}; ` +
      `worktree.allow_mutations=${status.staticGates.worktreeAllowMutations}.`,
    "- Note: /publish toggles authorization policy only. It is not caller authentication, it does not prove a human invoked it, and it never mutates Git or GitHub. Session-level narrowing is handled separately by /gates.",
  ].join("\n")
}

/**
 * `/gates [status|reset|<gate>=on|off]` — inspects or narrows the per-session
 * orchestrator gates.
 *
 * A session can only narrow the project/config ceiling: turning a gate off is
 * always honored; turning one on only removes the session narrowing and still
 * requires the ceiling (durable project publish capability, or the static
 * `github.allow_mutations` / `worktree.allow_mutations` switches) to allow it.
 * The command never mutates Git or GitHub and never widens a ceiling.
 */
async function runGatesCommand(
  context: Context,
  sessionID: string,
  args: string,
  options: OrchestratorOptions,
): Promise<void> {
  await withSessionLock(context.location, sessionID, () => mutateGatesCommand(context, sessionID, args, options))
}

async function mutateGatesCommand(
  context: Context,
  sessionID: string,
  args: string,
  options: OrchestratorOptions,
): Promise<void> {
  const value = args.trim()

  if (!value || value === "show" || value === "status") {
    const statuses = await gateStatuses(context.storage, context.location, sessionID, options)
    await emitStatus(context, sessionID, formatGatesStatus(sessionID, statuses))
    return
  }

  if (value === "reset") {
    await clearGates(context.storage, sessionID)
    const statuses = await gateStatuses(context.storage, context.location, sessionID, options)
    await emitStatus(
      context,
      sessionID,
      `${statusMessage({
        happened: "Session gates reset to the project ceiling.",
        means: "Session-only narrowing was removed; the project ceiling still applies.",
        next: "Run /gates <gate>=off to narrow a step again.",
      })}\n\n${formatGatesStatus(sessionID, statuses)}`,
    )
    return
  }

  const separator = value.indexOf("=")
  const gate = separator > 0 ? value.slice(0, separator).trim() : ""
  const verb = separator > 0 ? value.slice(separator + 1).trim().toLowerCase() : ""
  if (!gate || !isSessionGate(gate) || (verb !== "on" && verb !== "off")) {
    await emitStatus(
      context,
      sessionID,
      `${statusMessage({
        happened: "/gates did not run because the request was not understood.",
        means: "No session gate was changed.",
        next: "Usage: /gates [status|reset|<gate>=on|off]",
      })}\nGates: ${SESSION_GATES.join(", ")}`,
    )
    return
  }

  const disabled = verb === "off"
  await setGateDisabled(context.storage, sessionID, gate, disabled)
  const statuses = await gateStatuses(context.storage, context.location, sessionID, options)
  const status = statuses.find((candidate) => candidate.gate === gate)
  const confirmation = status ? gateChangeMessage(status) : `'${gate}' updated for this session`
  await emitStatus(
    context,
    sessionID,
    `${statusMessage({
      happened: `${confirmation}.`,
      means: disabled
        ? "That step is now off for this session only; the project ceiling is unchanged."
        : "This session now follows the project ceiling for that step.",
      next: "Run /gates to see every gate for this session.",
    })}\n\n${formatGatesStatus(sessionID, statuses)}`,
  )
}

function formatGatesStatus(sessionID: string, statuses: readonly GateStatus[]): string {
  const lines = statuses.map((status) => {
    if (status.enabled) {
      const source = status.ceilingSource === "project" ? "project capability" : "config"
      return `- [on ] ${status.gate} — allowed by the ${source}`
    }
    if (status.sessionDisabled) {
      return `- [off] ${status.gate} — disabled for this session; re-enable with /gates ${status.gate}=on`
    }
    return `- [off] ${status.gate} — unavailable: ${status.ceilingReason ?? "the ceiling is off"}`
  })
  return [
    `Session gates — ${sessionID}`,
    statusMessage({
      happened: "This is the effective gate state for this session.",
      means: "Gates are safety steps, and each one can be narrowed for this session only.",
      next: "Run /gates <gate>=off to narrow one, or /gates reset to follow the project ceiling.",
    }),
    "Steps:",
    ...lines,
    "Gates can only narrow the project ceiling. They can never widen it, and they do not carry into other sessions.",
  ].join("\n")
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
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: !plan && resumable
          ? "The stored plan run could not be resumed; specify one plan from .orchestrator/plans/."
          : "Specify one plan from .orchestrator/plans/; no sole incomplete plan was available.",
        means: "No plan run was started or changed.",
        next: "Run /run-plan <plan> with an explicit plan name.",
      }),
    )
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
  // A new plan-run generation enrolls the current goal generation on its lead
  // board: init when absent, replace only when the goal generation changed, and
  // never clobber a live ledger of the same generation.
  try {
    const goal = await readGoal(context.storage, goalStorageKey(context.location, sessionID))
    if (goal) await ensureBoardForGoal(context, sessionID, goal)
  } catch (error) {
    console.warn(`opencode-orchestrator could not enroll the lead board for ${sessionID}`, error)
  }
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
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: `Plan run paused; ${redact(reason)}`,
        means: "The plan run will not continue automatically until it is resumed.",
        next: "Fix the failure, then run /run-plan to resume it.",
      }),
    )
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

async function runWorkerModelsCommand(
  context: Context,
  sessionID: string,
  args: string,
  workerModels: WorkerModelRuntime | undefined,
): Promise<void> {
  if (!workerModels) {
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: "Worker model selection is unavailable in this plugin instance.",
        means: "No worker model override can be read or changed here.",
        next: "Check the plugin configuration and reload the session.",
      }),
    )
    return
  }

  try {
    const assignment = parseWorkerModelAssignment(args)
    if (assignment.kind === "list") {
      const statuses = await workerModels.list()
      const lines = statuses.map((status) => {
        const selected = status.override ? formatModelReference(status.override) : "configured default"
        const configured = status.configured ? formatModelReference(status.configured) : "OpenCode fallback"
        const effective = status.effective ? formatModelReference(status.effective) : configured
        return `- ${status.agentID}: ${selected} (configured: ${configured}; effective: ${effective})`
      })
      await emitStatus(
        context,
        sessionID,
        `${statusMessage({
          happened: `Worker models for ${statuses.length} roles.`,
          means: "Each role uses its override, its configured model, or the OpenCode fallback.",
          next: "Set one with /worker-models <agent>=<provider>/<model>.",
        })}\n\n${lines.join("\n")}`,
      )
      return
    }

    if (assignment.kind === "reset") {
      await workerModels.reset()
      await emitStatus(
        context,
        sessionID,
        statusMessage({
          happened: "Worker model overrides reset; configured agent models apply to future children.",
          means: "Children spawned from now on use their configured models.",
          next: "Set an override again with /worker-models <agent>=<provider>/<model>.",
        }),
      )
      return
    }

    if (assignment.model) {
      await workerModels.set(assignment.agentID, assignment.model)
      await emitStatus(
        context,
        sessionID,
        statusMessage({
          happened: `${assignment.agentID} → ${formatModelReference(assignment.model)}; applies to children spawned after this point.`,
          means: "Children spawned after this point use the selected model.",
          next: "Revert with /worker-models <agent>=default.",
        }),
      )
    } else {
      await workerModels.clear(assignment.agentID)
      await emitStatus(
        context,
        sessionID,
        statusMessage({
          happened: `${assignment.agentID} reset to its configured model for future children.`,
          means: "Children spawned after this point use the configured model again.",
          next: "Set an override again with /worker-models <agent>=<provider>/<model>.",
        }),
      )
    }
  } catch (error) {
    await emitStatus(
      context,
      sessionID,
      statusMessage({
        happened: `Worker model selection failed: ${errorMessage(error)}`,
        means: "No worker model override was changed.",
        next: "Check the agent and model names, then retry.",
      }),
    )
  }
}

/**
 * Transport for user-facing command output. Prose status messages must be
 * rendered through `statusMessage` so the plain-language template holds;
 * long-form reports (status listings, handover, model lists) pass their own
 * structured text.
 */
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
