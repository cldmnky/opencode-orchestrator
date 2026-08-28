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
