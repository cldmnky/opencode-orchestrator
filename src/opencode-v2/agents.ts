import type { OrchestratorOptions } from "../core/config.js"
import {
  GOAL_TOOL_PERMISSION,
  goalToolPermissionRule,
  hasExactPermissionRule,
  type PermissionRuleLike,
} from "../core/permissions.js"
import { buildOrchestratorSystem, buildWorkerSystem } from "../core/prompts.js"
import { requiredAgentIds, ROLE_DESCRIPTIONS, ROLE_NAMES, type RoleName } from "../core/roles.js"

export type AgentInfoLike = {
  id: string
  mode: "subagent" | "primary" | "all"
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  system?: string
  description?: string
}

export type AgentDraftLike = {
  list(): readonly MutableAgentLike[]
  get(id: string): MutableAgentLike | undefined
  update(id: string, update: (agent: MutableAgentLike) => void): void
}

type MutableAgentLike = {
  id: unknown
  system?: string
  description?: string
  permissions?: PermissionRuleLike[]
}

export function validateAgentSet(agents: readonly AgentInfoLike[], options: OrchestratorOptions): string[] {
  const issues: string[] = []
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  for (const id of requiredAgentIds(options.orchestrator, options.roles)) {
    const agent = byId.get(id)
    if (!agent) {
      issues.push(`missing agent ${id}`)
      continue
    }

    if (id === options.orchestrator) {
      if (agent.mode !== "primary" && agent.mode !== "all") issues.push(`agent ${id} must use mode primary or all`)
      continue
    }

    if (agent.mode !== "subagent" && agent.mode !== "all") issues.push(`agent ${id} must use mode subagent or all`)
  }
  return issues
}

export function applyAgentTransform(draft: AgentDraftLike, options: OrchestratorOptions): string[] {
  const missing: string[] = []
  const agents = draft.list()

  for (const id of requiredAgentIds(options.orchestrator, options.roles)) {
    if (!agents.some((agent) => String(agent.id) === id)) missing.push(id)
  }

  const orchestrator = draft.get(options.orchestrator)
  if (orchestrator) {
    draft.update(options.orchestrator, (agent) => {
      agent.description = appendOnce(agent.description, "Coordinates specialized agents and verifies their work.")
      agent.system = appendOnce(agent.system, buildOrchestratorSystem(options))
      // The orchestrator may call the goal tools. Preserved agents that
      // predate the shared permission action need the allow rule appended;
      // an exact user rule for the action is never overridden.
      agent.permissions = appendGoalToolPermission(agent.permissions, "allow")
    })
  }

  for (const role of ROLE_NAMES) {
    const id = options.roles[role]
    if (!draft.get(id)) continue
    draft.update(id, (agent) => {
      agent.description = appendOnce(agent.description, roleDescription(role))
      agent.system = appendOnce(agent.system, buildWorkerSystem(role))
      // Fail closed: workers must never see or drive goal tools, even when a
      // preserved worker predates the explicit deny or lacks any deny-all.
      agent.permissions = appendGoalToolPermission(agent.permissions, "deny")
    })
  }

  return missing
}

function appendGoalToolPermission(
  permissions: PermissionRuleLike[] | undefined,
  effect: "allow" | "deny",
): PermissionRuleLike[] {
  const existing = permissions ? [...permissions] : []
  if (hasExactPermissionRule(existing, GOAL_TOOL_PERMISSION)) return existing
  existing.push(goalToolPermissionRule(effect))
  return existing
}

function appendOnce(existing: string | undefined, addition: string): string {
  if (!existing) return addition
  return existing.includes(addition) ? existing : `${existing}\n\n${addition}`
}

function roleDescription(role: RoleName): string {
  return ROLE_DESCRIPTIONS[role]
}
