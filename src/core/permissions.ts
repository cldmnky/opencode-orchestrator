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

/**
 * Shared permission actions for the publication policy and peer-orchestrator
 * discovery tools.
 *
 * `orchestrator_publish_policy_get` (publish family) and
 * `orchestrator_peer_list` (peer family) declare these explicit actions so a
 * single rule grants or revokes each family, while any exact user-authored
 * rule is respected. They are orchestrator-only (goal-style `allow`); worker
 * agents cannot see or invoke them unless the operator grants the action
 * explicitly, and each execute handler rejects non-orchestrator agents
 * regardless of visibility.
 *
 * Both actions ARE part of `orchestratorOnlyPermissionRules`: the installer
 * writes the allow (orchestrator) / deny (workers) rules for fresh installs
 * and the agent transform appends them on preserved agents without touching
 * exact user-authored rules. Neither family mutates Git or GitHub on its own
 * (publish is read-only policy inspection; peer is a read-only metadata
 * query), so the rules control visibility exactly like the other families.
 */
export const PUBLISH_TOOL_PERMISSION = "orchestrator_publish"
export const PEER_TOOL_PERMISSION = "orchestrator_peer"

/**
 * Shared permission action for the S3/V1 observability and review tools.
 *
 * The conditional runtime tools (observability_get, review_get,
 * review_transition) are registered under the `orchestrator` namespace only
 * when their modes are enabled, and share this one explicit `permission`
 * action so a single rule grants or revokes the whole family. They are
 * orchestrator-only: a worker that somehow reaches an execute handler is
 * rejected regardless of visibility rules.
 */
export const OBSERVABILITY_TOOL_PERMISSION = "orchestrator_observability"

/**
 * Shared permission action for the serialized orchestration validation tools.
 *
 * The serialized runtime tools (task_complexity_classify, handoff_validate,
 * admission_transition) are registered under the `orchestrator` namespace and
 * share this one explicit `permission` action so a single rule grants or
 * revokes the whole family. They are orchestrator-only: worker agents cannot
 * see or invoke them unless the operator grants the action explicitly. The
 * tools are callable validation primitives, not automatic hooks — this
 * permission controls visibility only, exactly like the goal/feature families.
 */
export const ORCHESTRATION_TOOL_PERMISSION = "orchestrator_validation"

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
    action: [
      GH_TOOL_PERMISSION,
      WORKTREE_TOOL_PERMISSION,
      ORCHESTRATION_TOOL_PERMISSION,
      OBSERVABILITY_TOOL_PERMISSION,
      PUBLISH_TOOL_PERMISSION,
      PEER_TOOL_PERMISSION,
    ].join("|"),
    resource: "*",
    effect,
  }
}

export function orchestratorOnlyPermissionRules(effect: PermissionEffect): PermissionRule[] {
  return [
    { action: GH_TOOL_PERMISSION, resource: "*", effect },
    { action: WORKTREE_TOOL_PERMISSION, resource: "*", effect },
    { action: ORCHESTRATION_TOOL_PERMISSION, resource: "*", effect },
    { action: OBSERVABILITY_TOOL_PERMISSION, resource: "*", effect },
    { action: PUBLISH_TOOL_PERMISSION, resource: "*", effect },
    { action: PEER_TOOL_PERMISSION, resource: "*", effect },
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
