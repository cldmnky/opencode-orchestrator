import {
  BUDGET_GUIDANCE,
  BOUNDED_REVIEW_GUIDANCE,
  CAPABILITY_BOUNDARY_GUIDANCE,
  CHILD_TASK_CONTRACT,
  CLARIFY_GUIDANCE,
  DELEGATION_GRAPH_GUIDANCE,
  GITHUB_LIFECYCLE_GUIDANCE,
  HANDOFF_FORMAT,
  HANDOFF_SUMMARY_FIELDS,
  PEER_DISCOVERY_GUIDANCE,
  PROMPTING_POLICY_GUIDANCE,
  PUBLICATION_POLICY_GUIDANCE,
  REMOTE_ORCHESTRATION_GUIDANCE,
  REVIEW_METHOD_GUIDANCE,
  REVIEWER_SUBMIT_GUIDANCE,
  SECURITY_GUIDANCE,
  STRUCTURED_HANDOFF_GUIDANCE,
  WORKTREE_LIFECYCLE_GUIDANCE,
  orchestrationCapabilities,
  orchestrationRules,
  terminalDriveGuidance,
  verticalSliceGuidance,
} from "./policy.js"
import type { OrchestratorOptions } from "./config.js"
import { ROLE_GUIDANCE } from "./roles.js"
import { buildOrchestrationPrompt } from "./prompt-builder.js"

/**
 * Orchestrator-only personality spec (G3 Phase 0, orchestrator-only).
 *
 * The orchestrator is the only user-facing voice in the delegation graph, so
 * it gets a voice/tone/audience contract; worker prompts stay task-shaped and
 * never embed these sections. The spec is plain-language pressure on the
 * *rendering* of the model's own output, not on the model-facing contracts:
 * D2 envelopes, evidence records, tool names, and fail-closed preconditions
 * keep their exact wording. See docs/g3-communication-contract.md.
 */
const ORCHESTRATOR_COMMUNICATION_GUIDANCE = [
  "Voice: friendly, concise, and proactive; explain the plan in one or two sentences before non-trivial work.",
  "Talk to the user in plain language, and keep every sentence short: one instruction per sentence, 25 words or fewer.",
  "Gloss jargon on first use: a gate is a safety step you can turn off for this session.",
  "Never paste a policy string, admission state, SHA, gate name, or tool name into user output without a plain gloss.",
  "Use the status template for anything the user reads: what happened, what it means, what's next.",
  "Say what is uncertain instead of implying that unverified work passed.",
].join("\n")

const ORCHESTRATOR_RESTATEMENT_GUIDANCE = (clarifyEnabled: boolean): string =>
  [
    "Restatement: before starting multi-worker work, restate the request in two or three bullets.",
    "List the assumptions you will proceed under, and label them as assumptions.",
    ...(clarifyEnabled
      ? [
          "Ask through the native ask tool only when scope, success criteria, or verification is genuinely ambiguous.",
          "Ask budget: at most three questions in one ask, each with concrete options; never re-ask an answered question.",
          "Record the answers in the task ledger; when no answer blocks the work, state your assumptions and proceed.",
        ]
      : [
          "Clarify mode is off: ask nothing, state your assumptions, and proceed.",
          "Record those assumptions in the task ledger instead of stalling for input.",
        ]),
  ].join("\n")

const ORCHESTRATOR_SUMMARY_GUIDANCE = [
  "Phase transitions: announce each transition in one plain line, in order: plan, delegate, review, publish.",
  "Say what is happening and why it matters; never present internal state without a gloss.",
  "Finish summary: end every run with the same five fields as the D2 handoff.",
  `Use exactly these field names, in order: ${HANDOFF_SUMMARY_FIELDS.join(", ")}.`,
  "Outcome comes first in plain words: what was achieved and what it means for the user.",
  "Verification states the commands run and their results; say 'not run' instead of implying a pass.",
  "A refusal or blocker follows the status template: what happened, what it means, what the user can do.",
].join("\n")

export function buildOrchestratorSystem(options: OrchestratorOptions): string {
  const clarifyEnabled = options.clarify.mode !== "off"
  const sections = [
    ROLE_GUIDANCE.orchestrator,
    "",
    "You are the conductor, not a worker of last resort. Understand the task, gather facts, then delegate focused work.",
    `Role map: planning=${options.roles.planning}; research=${options.roles.research}; implementation=${options.roles.implementation}; review=${options.roles.review}.`,
    "",
    ORCHESTRATOR_COMMUNICATION_GUIDANCE,
    "",
    ORCHESTRATOR_RESTATEMENT_GUIDANCE(clarifyEnabled),
    "",
    ORCHESTRATOR_SUMMARY_GUIDANCE,
    "",
    SECURITY_GUIDANCE,
    "",
    orchestrationRules(options.max_parallel, options.require_review, orchestrationCapabilities(options), options.decomposition.strategy),
    "",
    STRUCTURED_HANDOFF_GUIDANCE,
  ]
  if (options.review.mode === "bounded") sections.push("", BOUNDED_REVIEW_GUIDANCE)
  if (options.budget.mode === "stop-between-steps") sections.push("", BUDGET_GUIDANCE)
  if (clarifyEnabled) sections.push("", CLARIFY_GUIDANCE)
  return sections.join("\n")
}

export function buildWorkerSystem(role: keyof typeof ROLE_GUIDANCE, options?: OrchestratorOptions): string {
  return [
    ROLE_GUIDANCE[role],
    "",
    DELEGATION_GRAPH_GUIDANCE,
    "",
    PROMPTING_POLICY_GUIDANCE,
    "",
    verticalSliceGuidance(options?.decomposition?.strategy),
    CAPABILITY_BOUNDARY_GUIDANCE,
    // Review-methodology guidance is review-role-only: it adapts the host's
    // built-in /review discipline to the maker-checker flow. The submit block
    // additionally appears only when the bounded review tools are enabled,
    // so the default prompt mode stays unchanged.
    ...(role === "review" ? ["", REVIEW_METHOD_GUIDANCE] : []),
    ...(role === "review" && options?.review?.mode === "bounded" ? ["", REVIEWER_SUBMIT_GUIDANCE] : []),
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

/**
 * Command prompts are rendered as short bullets (G3 full rollout): one
 * instruction per line, each within the 25-word plain-language sentence
 * budget. Pinned safety phrases stay byte-identical; where a phrase was
 * lowercase mid-sentence, a short lead-in keeps the phrase intact instead of
 * re-capitalizing it. The `orchestrate` prompt keeps the tracked
 * prompt-builder coordination line (see test/unit/prompt-builder.test.ts).
 */
export function buildCommandPrompt(name: string, argumentsText: string, options?: OrchestratorOptions): string {
  const args = argumentsText.trim() || "(no arguments)"
  const common = [
    "Use the configured orchestration roles and native OpenCode subagent delegation.",
    "Do not claim completion without evidence.",
    DELEGATION_GRAPH_GUIDANCE,
    PROMPTING_POLICY_GUIDANCE,
    CAPABILITY_BOUNDARY_GUIDANCE,
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
    goal: [
      "Manage the session goal deterministically.",
      `The argument is: ${args}.`,
      "Use orchestrator_goal with plugin-owned durable storage: get, set, pause, resume, complete, or clear only the current session goal.",
      "Continue only while it is active.",
      "Mark complete through orchestrator_goal with auditable evidence.",
    ].join("\n"),
    "run-plan": [
      `Execute the requested plan from .orchestrator/plans/: ${args}.`,
      "Read the complete plan before changing files.",
      "Follow the plan's phase order.",
      "Track each step.",
      "Delegate safe independent work only with disjoint write scopes.",
      "Verify every step.",
      "Audit the aggregate result with the review role.",
    ].join("\n"),
    halt: [
      "Stop automated work for this session.",
      `Interpret this control request: ${args}.`,
      "Preserve recoverable .orchestrator state and do not delete user work.",
    ].join("\n"),
    handover: [
      `Create a self-contained continuation handover for: ${args}.`,
      "Read the current session context and VCS state.",
      "Preserve user requirements accurately.",
      "Then redact secrets.",
      "Then separate established facts from assumptions.",
      "Then include completed work, pending work, decisions, verification, and blockers.",
    ].join("\n"),
    gates: [
      `Manage the per-session orchestrator gates for: ${args}.`,
      "This control request is handled by the plugin before any model turn.",
      "No prompt is delivered.",
    ].join("\n"),
  }

  return `${prompts[name] ?? `Execute ${name}: ${args}`}\n\n${common}`
}

/**
 * Board operating instructions appended only when a durable lead-board task
 * drives the continuation. The packet itself is rendered verbatim
 * (post-normalization) by the lead-board module and passed in; this module
 * adds instructions and never embeds board fields into the D2 handoff
 * skeleton. Scope packets stay advisory: not isolation, permissions, or a
 * worktree binding.
 */
const LEAD_BOARD_OPERATING_GUIDANCE = [
  "The lead board is the durable task ledger for this goal generation.",
  "If recovery leaves the packet's task in planned, use orchestrator_board_action with action transition and intent start-task once; this only moves planned to ready. If a ready task has no pending idle edge, use transition intent dispatch-task once with its current expectedVersion to request normal reservation/delivery. Neither action skips work, lead validation, or review.",
  "Work the task in the packet above, then use orchestrator_board_action with action transition and intent report-task; a delivered prompt never completes a task.",
  "A worker handoff is a report until you validate it: call orchestrator_handoff_validate on the unchanged D2 envelope first.",
  "Then rerun the required checks yourself and use orchestrator_board_action with action transition and intent validate-task, receipt IDs, revision, and bounded redacted refs.",
  "Start review directly with orchestrator_review_start after validation; the plugin applies the legal review-pending transition without a separate admission call.",
  "Completion additionally requires an approved exact-revision review for the same revision; pass expectedVersion on every board action.",
  "Complete each task's validation and approved review before push or merge moves the revision.",
  "If the revision already moved, validate and review again at the new head; never request a forced board close.",
  "If an external outcome is unknowable, mark the task ambiguous instead of retrying; resume only from a lead-validated cursor.",
  "Scope packets are advisory: they are not filesystem isolation, permissions, or a worktree binding.",
].join("\n")

export function buildContinuationPrompt(
  objective: string,
  continuationCount: number,
  options?: OrchestratorOptions,
  plan?: string,
  taskPacket?: string,
): string {
  return [
    "Continue the active orchestration goal.",
    `Objective: ${objective}`,
    ...(plan ? [planContinuationGuidance(plan)] : []),
    `This is continuation ${continuationCount}. Inspect the current repository and session state before acting.`,
    "Make concrete progress, delegate safely when useful, and stop only after the objective is complete or a blocker requires the user.",
  "Read and update the goal with orchestrator_goal actions get, set, pause, resume, complete, or clear.",
  "Completion requires a direct verification result and an evidence string through orchestrator_goal.",
    ...(taskPacket ? [taskPacket, LEAD_BOARD_OPERATING_GUIDANCE] : []),
    DELEGATION_GRAPH_GUIDANCE,
    PROMPTING_POLICY_GUIDANCE,
    verticalSliceGuidance(options?.decomposition?.strategy),
    CAPABILITY_BOUNDARY_GUIDANCE,
    REMOTE_ORCHESTRATION_GUIDANCE,
    featureGuidance(options),
    STRUCTURED_HANDOFF_GUIDANCE,
    controlsGuidance(options),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n")
}

/**
 * Plan-aware ledger guidance for continuations of an ACTIVE plan run. Only
 * the plan's safe relative path is embedded — never plan file contents or
 * transcripts — and the ledger behavior is explicit: reopen the plan, execute
 * the first unfinished item with direct verification, update the ledger, then
 * keep advancing autonomously until a real blocker or a configured breaker
 * applies. Every rule is a short bullet so continuations stay plain-language.
 * Line breaks in the stored path are neutralized so a malformed
 * durable record cannot inject prompt sections.
 */
function planContinuationGuidance(plan: string): string {
  const safePlan = plan.replace(/[\r\n]+/g, " ")
  return [
    `Plan ledger: ${safePlan}`,
    "Reopen the active plan ledger.",
    "Then execute the first unfinished item with direct verification.",
    "Then update the ledger to record the change before moving to the next unfinished item in order.",
    "Continue autonomously through the ledger unless a real blocker or a configured breaker applies.",
    "Configured breakers: halt flag, budget fail-closed, cooldown, max continuations, or an open review circuit.",
    "Stop and report to the user otherwise.",
    "Above all, never mark the goal or plan complete without direct evidence.",
  ].join("\n")
}

/**
 * Feature-specific lifecycle guidance plus the universal peer-discovery
 * disclosure, composed into every prompt kind that takes options:
 * - the peer disclosure is always present (it states the durable
 *   metadata-only/incomplete semantics and the same-project redaction
 *   boundary of orchestrator_status);
 * - the worktree lifecycle text appears only when `worktree.enabled`;
 * - the GitHub lifecycle text only when `github.enabled`;
 * - the publication capability policy only when `publish.enabled` (the
 *   config master gate).
 * The remaining universal guidance (catalog preflight, secrets, the
 * no-atomic-child-isolation boundary) is embedded separately in every prompt
 * kind.
 */
function featureGuidance(options: OrchestratorOptions | undefined): string {
  if (!options) return ""
  const sections: string[] = [PEER_DISCOVERY_GUIDANCE]
  if (options.worktree.enabled) sections.push(WORKTREE_LIFECYCLE_GUIDANCE)
  if (options.github.enabled) sections.push(GITHUB_LIFECYCLE_GUIDANCE)
  if (options.publish.enabled) sections.push(PUBLICATION_POLICY_GUIDANCE)
  if (options.github.enabled || options.publish.enabled) sections.push(terminalDriveGuidance(options))
  return sections.join("\n")
}

function controlsGuidance(options: OrchestratorOptions | undefined): string {
  if (!options) return ""
  const sections: string[] = []
  if (options.review.mode === "bounded") sections.push(BOUNDED_REVIEW_GUIDANCE)
  if (options.budget.mode === "stop-between-steps") sections.push(BUDGET_GUIDANCE)
  return sections.join("\n")
}
