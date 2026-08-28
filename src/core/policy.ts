import type { RoleName } from "./roles.js"

export type DelegationMode = "foreground" | "background"

export type DelegationRule = {
  role: RoleName
  mode: DelegationMode
  writes: boolean
  parallelSafe: boolean
}

export const DELEGATION_RULES: Record<RoleName, DelegationRule> = {
  planning: { role: "planning", mode: "foreground", writes: false, parallelSafe: true },
  research: { role: "research", mode: "background", writes: false, parallelSafe: true },
  implementation: { role: "implementation", mode: "foreground", writes: true, parallelSafe: false },
  review: { role: "review", mode: "foreground", writes: false, parallelSafe: true },
}

export const HANDOFF_FORMAT = [
  "Outcome: what was achieved or discovered",
  "Files: files read or changed, with scope",
  "Verification: commands run and their results",
  "Risks: known uncertainty or regression risk",
  "Follow-up: the next concrete action",
].join("\n")

export function orchestrationRules(maxParallel: number, requireReview: boolean): string {
  return [
    `At most ${maxParallel} independent child tasks may run at once.`,
    "Route by the configured semantic role map, never by model name.",
    "Explore before planning when repository facts are unknown.",
    "Include the relevant context, constraints, and expected handoff in every child prompt.",
    "The current V2 native subagent API does not expose an atomic plugin-controlled child worktree; never claim that this plugin provided isolation.",
    "Start independent read-only work in parallel/background mode.",
    "Keep disjoint write scopes. Serialize implementation tasks when file ownership overlaps; parallelize writes only with explicit disjoint scopes.",
    "Record the original branch, HEAD, changed files, commits, and verification in the task ledger when those facts are available.",
    "Do not claim automated GitHub issue or pull request coordination unless the user explicitly performs and verifies those steps.",
    "Do not poll background tasks; consume native completion delivery.",
    "Keep a concise task ledger in the parent session.",
    requireReview ? "Implementation is incomplete until the review role audits the aggregate change." : "Review changed work before reporting completion.",
    "Verify worker claims directly before reporting completion.",
    "Own the final answer; do not concatenate raw worker responses.",
    "Return each worker result using the handoff format below.",
    HANDOFF_FORMAT,
  ].join("\n")
}
