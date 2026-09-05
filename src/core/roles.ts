export const ROLE_NAMES = ["planning", "research", "implementation", "review"] as const

export type RoleName = (typeof ROLE_NAMES)[number]

export const DEFAULT_ROLES: Record<RoleName, string> = {
  planning: "planner",
  research: "explore",
  implementation: "implementer",
  review: "reviewer",
}

/**
 * Bounded nested-delegation graph: the roles each role may delegate to.
 *
 * The orchestrator sits above the graph and may delegate to every configured
 * role. Workers may delegate only along these edges, and `research` is the
 * leaf: it never delegates and answers with direct `webfetch`/`websearch`
 * instead. The installer mirrors these edges as exact target-specific
 * `subagent` allow rules written after a broad deny; prompts restate the same
 * graph so a delegating worker stays inside its role boundary.
 */
export const ROLE_DELEGATION: Record<RoleName, readonly RoleName[]> = {
  planning: ["research"],
  research: [],
  implementation: ["planning", "research"],
  review: ["research"],
}

/**
 * One-line deterministic summary of the bounded graph, e.g.
 * `orchestrator→all configured roles; planning→research; research→no delegation`.
 * Pure string building so prompts, the runtime context hook, and tests can
 * share one truthful rendering of ROLE_DELEGATION.
 */
export function delegationGraphSummary(): string {
  return [
    "orchestrator→all configured roles",
    ...ROLE_NAMES.map((role) => {
      const targets = ROLE_DELEGATION[role]
      return targets.length > 0 ? `${role}→${targets.join(",")}` : `${role}→no delegation`
    }),
  ].join("; ")
}

export const ROLE_GUIDANCE: Record<RoleName | "orchestrator", string> = {
  orchestrator:
    "Coordinates the work. Explore first, delegate by role, keep write scopes disjoint, verify every claim, and own the final result. You may delegate to every configured role.",
  planning:
    "Builds an executable plan from repository facts. Do not edit files. You may delegate only the research role; never launch any other agent.",
  research:
    "Maps relevant code, tests, constraints, and documentation using webfetch and websearch directly. Do not edit files and never launch subagents; report findings yourself instead of delegating.",
  implementation:
    "Makes only the requested changes, keeps edits focused, runs targeted verification, and reports evidence. You may delegate only the planning and research roles; never launch any other agent.",
  review:
    "Audits correctness, security, regressions, scope, and missing tests. Do not edit files. You may delegate only the research role; never launch any other agent.",
}

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  planning: "Plans work from repository facts without editing; may delegate research only.",
  research: "Maps code, tests, constraints, and documentation with direct web lookups; never delegates.",
  implementation: "Implements focused changes and reports verification; may delegate planning and research only.",
  review: "Independently reviews correctness, security, regressions, and tests; may delegate research only.",
}

export function requiredAgentIds(orchestrator: string, roles: Record<RoleName, string>): string[] {
  return [...new Set([orchestrator, ...Object.values(roles)])]
}

export function workerAgentIds(orchestrator: string, roles: Record<RoleName, string>): string[] {
  return [...new Set(Object.values(roles))].filter((id) => id !== orchestrator)
}

export function workerAgentRoles(orchestrator: string, roles: Record<RoleName, string>): ReadonlyMap<string, string[]> {
  const result = new Map<string, string[]>()
  for (const [role, agentID] of Object.entries(roles)) {
    if (agentID === orchestrator) continue
    const names = result.get(agentID) ?? []
    names.push(role)
    result.set(agentID, names)
  }
  return result
}
