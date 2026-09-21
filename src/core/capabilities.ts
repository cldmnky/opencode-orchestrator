/**
 * Shared vocabulary for describing what the plugin knows and what it merely
 * asks the model to do. A claim must not be described as enforced unless a
 * runtime boundary actually refuses the operation without it.
 */
export const CAPABILITY_LEVELS = ["guidance", "recorded", "observed", "enforced"] as const
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number]

export type CapabilityStatement = {
  id: string
  level: CapabilityLevel
  statement: string
}

export const CAPABILITY_VOCABULARY = [
  "Capability vocabulary:",
  "guidance means prompt-only preference and may be overridden by the user or model.",
  "recorded means strict state was supplied to a plugin operation, but actor provenance is not proven.",
  "observed means the plugin received and validated a host, process, Git, or GitHub observation.",
  "enforced means a runtime operation refuses without the required observed or configured state.",
  "Never describe guidance or recorded state as observed or enforced.",
].join("\n")

/** Current boundaries after shell receipts, reviewer-child provenance, and dispatch admission. */
export const CURRENT_CAPABILITY_STATEMENTS: readonly CapabilityStatement[] = [
  {
    id: "parallel-dispatch",
    level: "enforced",
    statement: "max_parallel refuses excess configured-role subagent calls per root session in this plugin process; it is not a scheduler, cross-process limit, or filesystem boundary.",
  },
  {
    id: "lead-command-checks",
    level: "enforced",
    statement: "lead validation refuses required commands unless plugin-observed shell receipts match the lead, exact revision, lifecycle, and freshness bounds; caller-supplied pass labels remain diagnostic.",
  },
  {
    id: "bounded-review-identity",
    level: "observed",
    statement: "bounded review approval records contain plugin-observed reviewer agent and child-session provenance; legacy V1 records remain unproven.",
  },
  {
    id: "publication-revision-gates",
    level: "enforced",
    statement: "publication exact-revision, remote-state, capability, and gate checks are runtime-enforced.",
  },
]

export function renderCapabilityGuidance(statements: readonly CapabilityStatement[] = CURRENT_CAPABILITY_STATEMENTS): string {
  return [CAPABILITY_VOCABULARY, ...statements.map((entry) => `${entry.id} (${entry.level}): ${entry.statement}`)].join("\n")
}
