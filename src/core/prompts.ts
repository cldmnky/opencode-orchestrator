import { HANDOFF_FORMAT, orchestrationRules } from "./policy.js"
import type { OrchestratorOptions } from "./config.js"
import { ROLE_GUIDANCE } from "./roles.js"

export function buildOrchestratorSystem(options: OrchestratorOptions): string {
  return [
    ROLE_GUIDANCE.orchestrator,
    "",
    "You are the conductor, not a worker of last resort. Understand the task, gather facts, then delegate focused work.",
    `Role map: planning=${options.roles.planning}; research=${options.roles.research}; implementation=${options.roles.implementation}; review=${options.roles.review}.`,
    orchestrationRules(options.max_parallel, options.require_review),
  ].join("\n")
}

export function buildWorkerSystem(role: keyof typeof ROLE_GUIDANCE): string {
  return `${ROLE_GUIDANCE[role]}\n\nWorker handoff format:\n${HANDOFF_FORMAT}`
}

export function buildCommandPrompt(name: string, argumentsText: string): string {
  const args = argumentsText.trim() || "(no arguments)"
  const common = "Use the configured orchestration roles and native OpenCode subagent delegation. This plugin cannot provide an atomic custom worktree boundary in the current V2 beta, so do not claim worktree or GitHub automation that was not actually performed. Do not claim completion without evidence."

  const prompts: Record<string, string> = {
    orchestrate: `Coordinate this task end to end. Start with repository facts, delegate independent work in parallel where safe, integrate the results, and verify the final state.\n\nTask: ${args}`,
    goal: `Manage the session goal deterministically. The argument is: ${args}. Use the namespaced goal tools and plugin-owned durable storage: set, show, pause, resume, or clear only the current session goal. Continue only while it is active, and mark complete through goal_update with auditable evidence.`,
    restructure: `Perform a conservative, test-backed restructuring of: ${args}. Research references and tests first, write an atomic plan, make only behavior-preserving edits, and run a reviewer pass.`,
    "run-plan": `Execute the requested plan from .orchestrator/plans/: ${args}. Read the complete plan before changing files, track each step, delegate safe independent work, and verify every step.`,
    halt: `Stop automated work for this session. Interpret this control request: ${args}. Preserve recoverable .orchestrator state and do not delete user work.`,
    handover: `Create a self-contained continuation handover for: ${args}. Read the current session context and VCS state, preserve user requirements accurately, redact secrets, and include completed work, pending work, decisions, verification, and blockers.`,
    polish: `Polish the requested scope without changing behavior: ${args}. Inspect changed files, make only justified cleanup edits, verify each affected area, and request an independent review.`,
    "stress-plan": `Create a robust plan for: ${args}. Gather repository facts, draft the plan, obtain independent critiques covering correctness, scope, security, and feasibility, then synthesize one revised plan under .orchestrator/plans/.`,
  }

  return `${prompts[name] ?? `Execute ${name}: ${args}`}\n\n${common}`
}

export function buildContinuationPrompt(objective: string, continuationCount: number): string {
  return [
    "Continue the active orchestration goal.",
    `Objective: ${objective}`,
    `This is continuation ${continuationCount}. Inspect the current repository and session state before acting.`,
    "Make concrete progress, delegate safely when useful, and stop only after the objective is complete or a blocker requires the user.",
    "Completion requires a direct verification result and an evidence string through the goal update tool.",
  ].join("\n")
}
