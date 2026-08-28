export const ROLE_NAMES = ["planning", "research", "implementation", "review"] as const

export type RoleName = (typeof ROLE_NAMES)[number]

export const DEFAULT_ROLES: Record<RoleName, string> = {
  planning: "planner",
  research: "explore",
  implementation: "implementer",
  review: "reviewer",
}

export const ROLE_GUIDANCE: Record<RoleName | "orchestrator", string> = {
  orchestrator:
    "Coordinates the work. Explore first, delegate by role, keep write scopes disjoint, verify every claim, and own the final result.",
  planning:
    "Builds an executable plan from repository facts. Do not edit files or launch other agents.",
  research:
    "Maps relevant code, tests, constraints, and documentation. Do not edit files or launch other agents.",
  implementation:
    "Makes only the requested changes, keeps edits focused, runs targeted verification, and reports evidence. Do not launch other agents.",
  review:
    "Audits correctness, security, regressions, scope, and missing tests. Do not edit files or launch other agents.",
}

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  planning: "Plans work from repository facts without editing.",
  research: "Maps code, tests, constraints, and documentation without editing.",
  implementation: "Implements focused changes and reports verification without delegating.",
  review: "Independently reviews correctness, security, regressions, and tests without editing.",
}

export function requiredAgentIds(orchestrator: string, roles: Record<RoleName, string>): string[] {
  return [...new Set([orchestrator, ...Object.values(roles)])]
}
