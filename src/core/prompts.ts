import {
  BUDGET_GUIDANCE,
  BOUNDED_REVIEW_GUIDANCE,
  CHILD_TASK_CONTRACT,
  CLARIFY_GUIDANCE,
  GITHUB_LIFECYCLE_GUIDANCE,
  HANDOFF_FORMAT,
  REMOTE_ORCHESTRATION_GUIDANCE,
  STRUCTURED_HANDOFF_GUIDANCE,
  WORKTREE_LIFECYCLE_GUIDANCE,
  orchestrationCapabilities,
  orchestrationRules,
} from "./policy.js"
import type { OrchestratorOptions } from "./config.js"
import { ROLE_GUIDANCE } from "./roles.js"
import { buildOrchestrationPrompt } from "./prompt-builder.js"

export function buildOrchestratorSystem(options: OrchestratorOptions): string {
  const sections = [
    ROLE_GUIDANCE.orchestrator,
    "",
    "You are the conductor, not a worker of last resort. Understand the task, gather facts, then delegate focused work.",
    `Role map: planning=${options.roles.planning}; research=${options.roles.research}; implementation=${options.roles.implementation}; review=${options.roles.review}.`,
    orchestrationRules(options.max_parallel, options.require_review, orchestrationCapabilities(options)),
    "",
    STRUCTURED_HANDOFF_GUIDANCE,
  ]
  if (options.review.mode === "bounded") sections.push("", BOUNDED_REVIEW_GUIDANCE)
  if (options.budget.mode === "stop-between-steps") sections.push("", BUDGET_GUIDANCE)
  if (options.clarify.mode !== "off") sections.push("", CLARIFY_GUIDANCE)
  return sections.join("\n")
}

export function buildWorkerSystem(role: keyof typeof ROLE_GUIDANCE, options?: OrchestratorOptions): string {
  return [
    ROLE_GUIDANCE[role],
    "",
    CHILD_TASK_CONTRACT,
    REMOTE_ORCHESTRATION_GUIDANCE,
    featureGuidance(options),
    "",
    "Worker handoff format:",
    HANDOFF_FORMAT,
    "",
    STRUCTURED_HANDOFF_GUIDANCE,
  ]
    .filter((section) => section.length > 0)
    .join("\n")
}

export function buildCommandPrompt(name: string, argumentsText: string, options?: OrchestratorOptions): string {
  const args = argumentsText.trim() || "(no arguments)"
  const common = [
    "Use the configured orchestration roles and native OpenCode subagent delegation.",
    "Do not claim completion without evidence.",
    REMOTE_ORCHESTRATION_GUIDANCE,
    featureGuidance(options),
    STRUCTURED_HANDOFF_GUIDANCE,
    controlsGuidance(options),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n")

  const prompts: Record<string, string> = {
    // The orchestrate prompt is built from the initial prompt (the objective)
    // by the prompt builder; clarification follows the clarify mode.
    orchestrate: buildOrchestrationPrompt({
      objective: args,
      clarifyEnabled: options?.clarify?.mode !== "off",
    }),
    goal: `Manage the session goal deterministically. The argument is: ${args}. Use the namespaced goal tools orchestrator_goal_get, orchestrator_goal_set, and orchestrator_goal_update with plugin-owned durable storage: set, show, pause, resume, or clear only the current session goal. Continue only while it is active, and mark complete through orchestrator_goal_update with auditable evidence.`,
    restructure: `Perform a conservative, test-backed restructuring of: ${args}. Research references and tests first, write a phased plan under .orchestrator/plans/, execute the phases in order with behavior-preserving edits only, then run a reviewer pass over the aggregate change.`,
    "run-plan": `Execute the requested plan from .orchestrator/plans/: ${args}. Read the complete plan before changing files, follow the plan's phase order, track each step, delegate safe independent work only with disjoint write scopes, verify every step, and audit the aggregate result with the review role.`,
    halt: `Stop automated work for this session. Interpret this control request: ${args}. Preserve recoverable .orchestrator state and do not delete user work.`,
    handover: `Create a self-contained continuation handover for: ${args}. Read the current session context and VCS state, preserve user requirements accurately, redact secrets, separate established facts from assumptions, and include completed work, pending work, decisions, verification, and blockers.`,
    polish: `Polish the requested scope without changing behavior: ${args}. Inspect changed files, make only justified cleanup edits, verify each affected area, and request an independent aggregate review of the full change.`,
    "stress-plan": `Create a robust plan for: ${args}. Gather repository facts, draft the plan, obtain independent critiques covering correctness, scope, security, and feasibility, then synthesize one revised plan with an explicit phase order under .orchestrator/plans/.`,
  }

  return `${prompts[name] ?? `Execute ${name}: ${args}`}\n\n${common}`
}

export function buildContinuationPrompt(objective: string, continuationCount: number, options?: OrchestratorOptions): string {
  return [
    "Continue the active orchestration goal.",
    `Objective: ${objective}`,
    `This is continuation ${continuationCount}. Inspect the current repository and session state before acting.`,
    "Make concrete progress, delegate safely when useful, and stop only after the objective is complete or a blocker requires the user.",
    "Read and update the goal with the namespaced tools orchestrator_goal_get, orchestrator_goal_set, and orchestrator_goal_update.",
    "Completion requires a direct verification result and an evidence string through orchestrator_goal_update.",
    REMOTE_ORCHESTRATION_GUIDANCE,
    featureGuidance(options),
    STRUCTURED_HANDOFF_GUIDANCE,
    controlsGuidance(options),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n")
}

/**
 * Feature-specific lifecycle guidance, embedded only for enabled features:
 * the worktree lifecycle text appears only when `worktree.enabled` and the
 * GitHub lifecycle text only when `github.enabled`. The universal guidance
 * (catalog preflight, secrets, the no-atomic-child-isolation boundary) is
 * already embedded separately in every prompt kind.
 */
function featureGuidance(options: OrchestratorOptions | undefined): string {
  if (!options) return ""
  const sections: string[] = []
  if (options.worktree.enabled) sections.push(WORKTREE_LIFECYCLE_GUIDANCE)
  if (options.github.enabled) sections.push(GITHUB_LIFECYCLE_GUIDANCE)
  return sections.join("\n")
}

function controlsGuidance(options: OrchestratorOptions | undefined): string {
  if (!options) return ""
  const sections: string[] = []
  if (options.review.mode === "bounded") sections.push(BOUNDED_REVIEW_GUIDANCE)
  if (options.budget.mode === "stop-between-steps") sections.push(BUDGET_GUIDANCE)
  return sections.join("\n")
}
