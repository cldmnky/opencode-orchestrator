/**
 * Shared permission action for the namespaced orchestration goal tools.
 *
 * The goal tools are registered under the `orchestrator` namespace with
 * effective names like `orchestrator_goal_get`. Because V2 permission rules
 * match the full namespaced action, a deny-all rule (which the installer
 * writes for every agent) would hide them from the model. Declaring one
 * explicit `permission` action on every goal tool lets the installer and the
 * agent transform grant or revoke the whole goal-tool family with a single
 * rule, while any exact user-authored rule for the action is always respected.
 *
 * An exact rule (including `ask`) affects visibility only: it controls whether
 * the model can see and invoke the goal tools. V2's public Promise plugin API
 * does not expose `permission.assert`, so the goal tools cannot trigger
 * interactive runtime "ask" prompting. Do not rely on an `ask` rule to produce
 * a prompt, and do not claim undocumented enforcements beyond visibility.
 */
export const GOAL_TOOL_PERMISSION = "orchestrator_goal"

/**
 * Namespaced permission actions for the orchestrator-only feature tools.
 *
 * Like the goal tools, these tools are registered under the `orchestrator`
 * namespace. Declaring one explicit `permission` action per family lets the
 * installer and the agent transform grant or revoke the whole family with a
 * single rule, while any exact user-authored rule is always respected. They
 * are orchestrator-only (goal-style `allow`) so worker agents cannot see or
 * invoke them unless the operator grants the action explicitly.
 */
export const GH_TOOL_PERMISSION = "orchestrator_gh"
export const WORKTREE_TOOL_PERMISSION = "orchestrator_worktree"
export const CD_TOOL_PERMISSION = "orchestrator_cd"
export const SESSION_MOVE_PERMISSION = "orchestrator_session_move"

export type PermissionEffect = "allow" | "deny" | "ask"

export type PermissionRule = {
  action: string
  resource: string
  effect: PermissionEffect
}

export type PermissionRuleLike = {
  action?: unknown
  resource?: unknown
  effect?: unknown
}

/** Build the deny-all rule the installer writes to hide the feature tools from non-orchestrator agents. */
export function orchestratorOnlyPermissionRule(effect: PermissionEffect): PermissionRule {
  // Kept for backward compatibility in tests that assert the legacy piped shape;
  // new code should use orchestratorOnlyPermissionRules.
  return {
    action: [GH_TOOL_PERMISSION, WORKTREE_TOOL_PERMISSION, CD_TOOL_PERMISSION, SESSION_MOVE_PERMISSION].join("|"),
    resource: "*",
    effect,
  }
}

export function orchestratorOnlyPermissionRules(effect: PermissionEffect): PermissionRule[] {
  return [
    { action: GH_TOOL_PERMISSION, resource: "*", effect },
    { action: WORKTREE_TOOL_PERMISSION, resource: "*", effect },
    { action: CD_TOOL_PERMISSION, resource: "*", effect },
    { action: SESSION_MOVE_PERMISSION, resource: "*", effect },
  ]
}

export function goalToolPermissionRule(effect: PermissionEffect): PermissionRule {
  return { action: GOAL_TOOL_PERMISSION, resource: "*", effect }
}

/**
 * True when `permissions` already carries a rule for exactly `action`.
 *
 * Used before augmenting an agent: an exact rule expresses an explicit user
 * (or previous install) allow/deny/ask for the goal tools, and appending
 * another rule would change which effect wins under last-match-wins.
 */
export function hasExactPermissionRule(
  permissions: readonly PermissionRuleLike[] | undefined,
  action: string,
): boolean {
  if (!permissions || permissions.length === 0) return false
  return permissions.some((rule) => Boolean(rule) && typeof rule === "object" && rule.action === action)
}
