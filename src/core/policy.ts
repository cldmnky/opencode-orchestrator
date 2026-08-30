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

export const CHILD_TASK_CONTRACT = [
  "Every child prompt must be explicit and self-contained, covering:",
  "Task: the concrete work to perform.",
  "Expected outcome: the definition of done for this child.",
  "Scope/file ownership: the exact files or areas the child may touch, disjoint from other children.",
  "Must do: the required steps, constraints, and verification commands.",
  "Must not do: forbidden actions, including editing out-of-scope files or launching other agents.",
  "Verification: the checks and commands that prove the work.",
  "Handoff: the worker handoff format below.",
].join("\n")

// Remote (GitHub) orchestration guidance lives here as the single source of
// truth. Prompt generation embeds these constants verbatim so every prompt
// kind states the same truthful policy without duplicating text.
export const TOOL_AVAILABILITY_GUIDANCE = [
  "Preflight: inspect the tool catalog the connected host actually exposes before using any GitHub tool; never infer availability from MCP server names or status.",
  "Use only GitHub tools the host has already configured and exposed; never assume, register, or invent tools.",
  "For issue, branch, pull request, review, merge, or closure operations, require direct evidence from the tool result — the object, its identifier, and its URL — before reporting completion.",
  "If the connected host does not expose the tools needed for issue or pull request automation, stop and ask the user; do not silently claim the work, fall back to unverified steps, or fabricate results.",
].join("\n")

export const SECRET_HANDLING_GUIDANCE = [
  "Never request, resolve, log, paste, or copy raw tokens, authorization headers, environment secrets, or OAuth credentials.",
  "Redact credentials from every ledger, handoff, and handover.",
].join("\n")

export const WORKTREE_BOUNDARY_GUIDANCE = [
  "Prompt-level rules are advisory and do not enforce filesystem isolation.",
  "The native V2 subagent API does not expose a plugin-controlled atomic worktree or location boundary; prompt-level disjoint write scopes do not equal filesystem isolation.",
  "Retain native role delegation; safe delegation is allowed whenever isolation is not required.",
].join("\n")

export const MANAGED_WORKTREE_GUIDANCE = [
  "Managed worktree tools (orchestrator_worktree_list, orchestrator_worktree_create, orchestrator_worktree_status, orchestrator_worktree_enter, orchestrator_worktree_push, orchestrator_worktree_cleanup) create and track one git worktree owned by the current session, with durable records and git-verified results.",
  "When managed worktrees are used for implementation, the required order is orchestrator_worktree_create -> orchestrator_worktree_enter -> delegate to the implementer. orchestrator_worktree_enter moves only the current session into its tracked worktree (session ID and history preserved); children delegated afterward inherit or start from that context, while no atomic child isolation is guaranteed.",
  "That managed ownership covers the current session only; it is not atomic child isolation, and parallel children still share the parent filesystem.",
].join("\n")

export const REMOTE_ORCHESTRATION_GUIDANCE = [
  TOOL_AVAILABILITY_GUIDANCE,
  SECRET_HANDLING_GUIDANCE,
  WORKTREE_BOUNDARY_GUIDANCE,
  MANAGED_WORKTREE_GUIDANCE,
].join("\n")

/**
 * Structured-handoff guidance for the serialized runtime validation tools.
 *
 * Workers are asked to emit the version-1 JSON envelope described below IN
 * ADDITION TO the unchanged five-field prose (HANDOFF_FORMAT); the parent is
 * told to run orchestrator_handoff_validate before any downstream use and to
 * call orchestrator_task_complexity_classify only after all eight structured
 * facts are collected. The tools are callable/advisory primitives, not
 * automatic hooks: nothing intercepts worker output automatically, and no
 * completion gate is enforced by this plugin.
 */
export const STRUCTURED_HANDOFF_GUIDANCE = [
  "Structured handoff envelope (version 1): include every worker result as this JSON envelope alongside the five-field prose:",
  "version: 1; taskId: the exact task ID from the parent contract; status: in-progress, blocked, completed, or failed; outcome; facts (statement plus evidence refs); assumptions (id, statement, status, evidence); filesRead and filesChanged (path plus scope); verification (command, status not-run/blocked/fail/pass, result, evidence refs); risks (severity, statement); followUp; artifactRefs (kind file or url, reference, description); reviewState (not-requested, pending, approved, changes-requested, or blocked).",
  "Use the same relative repository paths and https-only URL refs as the handoff schema; never include credentials, raw transcripts, or secrets in the envelope.",
  "Parent: call orchestrator_handoff_validate (level worker or orchestrator, with the task contract) before using any worker handoff downstream.",
  "Parent: call orchestrator_task_complexity_classify only after collecting all eight structured facts (independent_subtasks, dependent_stages, files_modules, independent_review, external_side_effects, shared_mutable_state, security_compliance_risk, expected_parallelism_value).",
  "These validation tools are callable/advisory, not automatic hooks: the orchestrator invokes them explicitly, results are advisory (D4) or deterministic fail-closed checks (D2/admission), and no automatic completion gate is enforced.",
].join("\n")

export function orchestrationRules(maxParallel: number, requireReview: boolean): string {
  return [
    `At most ${maxParallel} independent child tasks may run at once.`,
    "Route by the configured semantic role map, never by model name.",
    "Explore before planning when repository facts are unknown.",
    "Track the session goal with the namespaced tools orchestrator_goal_get, orchestrator_goal_set, and orchestrator_goal_update.",
    CHILD_TASK_CONTRACT,
    "Require an exact disjoint write scope from every child before any parallel write; no two children may claim the same file or area.",
    "Serialize implementation tasks when file ownership overlaps; parallelize writes only with explicit disjoint write scopes.",
    "Separate established facts from assumptions: label every assumption explicitly and verify it before relying on it.",
    TOOL_AVAILABILITY_GUIDANCE,
    SECRET_HANDLING_GUIDANCE,
    WORKTREE_BOUNDARY_GUIDANCE,
    MANAGED_WORKTREE_GUIDANCE,
    "Start independent read-only work in parallel/background mode.",
    "Record the original branch, HEAD, changed files, commits, and verification in the task ledger when those facts are available.",
    "Do not claim automated GitHub issue or pull request coordination unless the user explicitly performs and verifies those steps.",
    "Do not poll background tasks; consume native completion delivery.",
    "Keep a concise task ledger in the parent session.",
    requireReview ? "Implementation is incomplete until the review role audits the aggregate change." : "Review changed work before reporting completion.",
    "Verify worker claims directly in the parent session before reporting completion; never present a worker's self-report as your own verification.",
    "Own the final answer; do not concatenate raw worker responses.",
    "Return each worker result using the handoff format below.",
    HANDOFF_FORMAT,
  ].join("\n")
}
