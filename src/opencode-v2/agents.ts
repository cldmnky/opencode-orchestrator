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
      // an exact user rule for the action is never overridden. When the agent
      // has no `permissions` field at all, V2 would normally fall back to a
      // deny-all; we must seed that explicitly so the appended goal rule does
      // not widen every other action. An explicit array — even `[]` — is the
      // user's policy and is preserved as-is.
      agent.permissions = appendGoalToolPermission(agent.permissions, "allow")
    })
  }

  for (const role of ROLE_NAMES) {
    const id = options.roles[role]
    if (!draft.get(id)) continue
    draft.update(id, (agent) => {
      agent.description = appendOnce(agent.description, roleDescription(role))
      agent.system = appendOnce(agent.system, buildWorkerSystem(role))
      // Fail closed by default: workers get goal tools denied unless an exact
      // user-authored rule for the action already exists. The installer appends
      // the deny rule only when no exact user rule is present, so an explicit
      // user allow/ask remains authoritative. The same deny-all seeding applies
      // so the deny target is not the only rule in a sparse array that would
      // widen every other action.
      agent.permissions = appendGoalToolPermission(agent.permissions, "deny")
    })
  }

  return missing
}

function appendGoalToolPermission(
  permissions: PermissionRuleLike[] | undefined,
  effect: "allow" | "deny",
): PermissionRuleLike[] {
  // Pinned V2 permission semantics: with an explicit ruleset — even an empty
  // `[]` — a resource not matched by any rule defaults to effect `ask`, and
  // only an *absent* `permissions` field triggers the built-in
  // `missingAgentPermissions` deny-all fallback. An explicit existing array —
  // including `[]` — is the user's policy and is preserved verbatim. So when
  // the field is missing we seed an explicit deny-all before appending the
  // goal rule; otherwise the sparse one-rule array we would write widens every
  // other action. When an existing array is present, leave it untouched and
  // append the goal rule only when no exact user rule for that action already
  // exists.
  if (permissions === undefined) {
    return [{ action: "*", resource: "*", effect: "deny" }, goalToolPermissionRule(effect)]
  }
  const existing = [...permissions]
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
