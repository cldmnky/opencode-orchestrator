import { COMMAND_NAMES, isCommandEnabled, type CommandName, type OrchestratorOptions } from "../../core/config.js"
import type { CommandInvocation } from "@opencode-ai/plugin/promise/command"

export { COMMAND_NAMES }
export type { CommandName } from "../../core/config.js"

export type CommandInvocationLike = CommandInvocation

export type CommandDefinitionLike = {
  name: string
  description: string
  execute(input: CommandInvocationLike): Promise<void>
}

export type CommandSpec = {
  name: CommandName
  description: string
  requiredRoles: readonly ("orchestrator" | "planning" | "research" | "implementation" | "review")[]
  requiresArgument: boolean
}

export function commandDefinitions(options: OrchestratorOptions): CommandSpec[] {
  return COMMAND_NAMES.filter((name) => isCommandEnabled(options, name)).map((name) => ({
    name,
    description: descriptions[name],
    requiredRoles: requiredRoles[name],
    requiresArgument: requiresArgument.has(name),
  }))
}

export function applyCommandTransform(
  draft: { add(definition: CommandDefinitionLike): void },
  options: OrchestratorOptions,
  execute: (name: CommandName, input: CommandInvocationLike) => Promise<void>,
  existingNames: ReadonlySet<string> = new Set(),
  availableRoles: ReadonlySet<string> = new Set(["orchestrator", ...Object.keys(options.roles)]),
): { collisions: string[]; unavailable: string[] } {
  const collisions: string[] = []
  const unavailable: string[] = []
  for (const definition of commandDefinitions(options)) {
    if (definition.requiredRoles.some((role) => !availableRoles.has(role))) {
      unavailable.push(definition.name)
      continue
    }
    if (existingNames.has(definition.name)) {
      collisions.push(definition.name)
      continue
    }
    draft.add({
      name: definition.name,
      description: definition.description,
      execute: (input) => execute(definition.name, input),
    })
  }
  return { collisions, unavailable }
}

const descriptions: Record<CommandName, string> = {
  orchestrate: "Coordinate a task through specialized agents and verification",
  goal: "Set, show, pause, resume, or clear the active session goal",
  restructure: "Perform a conservative, test-backed code restructuring",
  "run-plan": "Execute or resume a plan from .orchestrator/plans",
  halt: "Stop automated goal or plan continuation without deleting state",
  handover: "Create a factual continuation brief from session and VCS context",
  polish: "Make narrowly scoped quality improvements and review the result",
  "stress-plan": "Draft and independently critique a multi-agent execution plan",
}

const requiredRoles: Record<CommandName, CommandSpec["requiredRoles"]> = {
  orchestrate: ["orchestrator", "planning", "research", "implementation", "review"],
  goal: ["orchestrator"],
  restructure: ["orchestrator", "planning", "research", "implementation", "review"],
  "run-plan": ["orchestrator", "planning", "implementation", "review"],
  halt: ["orchestrator"],
  handover: ["orchestrator"],
  polish: ["orchestrator", "research", "implementation", "review"],
  "stress-plan": ["orchestrator", "planning", "research", "review"],
}

const requiresArgument = new Set<CommandName>(["orchestrate", "restructure", "stress-plan"])
