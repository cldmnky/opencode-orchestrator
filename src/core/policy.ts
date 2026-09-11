import { delegationGraphSummary } from "./roles.js"
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
  "Must not do: forbidden actions, including editing out-of-scope files or delegating outside the child's own role graph.",
  "Verification: the checks and commands that prove the work.",
  "Handoff: the worker handoff format below.",
  "The parent stays accountable for every delegated child: it composes the contract, keeps child scopes disjoint, verifies child claims directly, and owns the integrated result.",
].join("\n")

/**
 * Bounded nested-delegation guidance and the shared prompting policy. Both are
 * embedded verbatim so every prompt kind states the same truthful policy
 * without duplicating text, exactly like the remote-orchestration guidance
 * below.
 */
export const DELEGATION_GRAPH_GUIDANCE = [
  `Bounded nested delegation graph: ${delegationGraphSummary()}.`,
  "A worker that delegates stays accountable for its children: compose each child prompt from the child-task contract, keep child write scopes disjoint, verify child claims directly, and own the integrated result.",
  "Delegating outside your role graph is forbidden even when the host would allow it; if a permitted delegation is refused or unavailable, stop and report honestly instead of substituting an unauthorized path.",
].join("\n")

/**
 * Prompting policy for every orchestration participant: autonomous authorized
 * follow-through, explicit user-instruction precedence, legible inter-agent
 * messages, risk-proportionate verification, and concise evidence-led user
 * reporting.
 */
export const PROMPTING_POLICY_GUIDANCE = [
  "Follow through autonomously on exactly what the task authorizes: keep going until the authorized work is done or a genuine blocker requires the user, and never expand scope beyond the authorization.",
  "The user's explicit instructions take precedence over skill guidance and general defaults whenever they conflict; surface an unsafe conflict instead of silently resolving it.",
  "Inter-agent messages must be clear and legible: state the task, constraints, and expected result so another agent could act on them alone, and return results that are specific, structured, and free of process chatter.",
  "Verify in proportion to risk: run the checks the task names, state exactly what was verified and how, and never present an unexecuted or borrowed check as your own pass.",
  "Report to the user concisely with evidence: lead with the outcome, cite the verification that proves it, and name assumptions and risks instead of padding the answer.",
].join("\n")

// Remote (GitHub) orchestration guidance lives here as the single source of
// truth. Prompt generation embeds these constants verbatim so every prompt
// kind states the same truthful policy without duplicating text.
export const TOOL_AVAILABILITY_GUIDANCE = [
  "Preflight: inspect the tool catalog the connected host actually exposes — that is, only tools already visible in this session plus the plugin probes orchestrator_github_capabilities and orchestrator_worktree_status — before using any GitHub tool; never infer availability from MCP server names or status.",
  "Use only GitHub tools the host has already configured and exposed; never assume, register, or invent tools (there is no tool named search; do not call search).",
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
  "A pending or failed orchestrator_worktree_enter result is not an entry receipt: stop, wait for the V2 session move safe boundary, retry, and delegate only after entered:true is returned.",
  "That managed ownership covers the current session only; it is not atomic child isolation, and parallel children still share the parent filesystem.",
].join("\n")

/**
 * Feature-specific worktree lifecycle guidance, embedded only when
 * `worktree.enabled`. Makes create -> enter -> implementer delegation a
 * mandatory orchestrator precondition and keeps the whole lifecycle
 * orchestrator-owned, with truthful stop-and-ask behavior instead of falling
 * back to delegating implementation from the main checkout.
 */
export const WORKTREE_LIFECYCLE_GUIDANCE = [
  MANAGED_WORKTREE_GUIDANCE,
  "Worktree lifecycle is mandatory for implementation when worktree support is enabled: before delegating to the implementer, the orchestrator MUST run orchestrator_worktree_create -> orchestrator_worktree_enter, and only the orchestrator creates, enters, pushes, and cleans up managed worktrees.",
  "When the worktree tools, a whitelisted worktree.root, worktree.allow_mutations, a ready tracked worktree, or a successful orchestrator_worktree_enter result are unavailable, stop and ask the user; never delegate implementation from the main checkout instead.",
].join("\n")

/**
 * Feature-specific GitHub lifecycle guidance, embedded only when
 * `github.enabled`. The orchestrator owns the branch push -> PR create ->
 * ready -> approve -> merge -> cleanup lifecycle; implementers never push or
 * create/merge PRs, and merge is autonomous once the durable publish
 * capability and the per-session gates allow it, always behind the full
 * fail-closed precondition chain.
 */
export const GITHUB_LIFECYCLE_GUIDANCE = [
  "GitHub lifecycle is orchestrator-owned: preflight with orchestrator_github_capabilities and use only the tools the host actually exposes; implementers never push branches or create or merge pull requests.",
  "The orchestrator pushes the worktree branch (orchestrator_worktree_push) and creates the pull request (orchestrator_github_pr_create) only after validated maker/checker review and direct verification of the branch, changes, and commits.",
  "Merge is autonomous when the durable publish capability 'merge' and the per-session gates allow it: no separate user merge instruction is required. Run orchestrator_github_pr_merge with a fresh conflict-free view at the exact approved revision, the exact head and base SHAs, and the exact-revision approved internal review receipt; verify merged:true again with a fresh orchestrator_github_pr_view, then clean up the tracked worktree.",
  "Every publication step fails closed: stale base or head, a dirty tree, a missing sync or review receipt, a moved revision, unresolved conflicts, branch protection, required checks or reviews, permission failures, merge queues, merged:false, or a failed post-merge view stop truthfully; never retry, fall back to a different SHA, or report a step without direct evidence.",
].join("\n")

/**
 * Peer-orchestrator discovery guidance, embedded in every orchestrator-facing
 * prompt kind. Discloses the durable metadata-only/incomplete semantics and
 * the same-project redaction boundary of `orchestrator_peer_list` up front so
 * peer findings are never mistaken for live, complete knowledge of other
 * sessions.
 */
export const PEER_DISCOVERY_GUIDANCE = [
  "Same-project peer orchestration sessions are discoverable with orchestrator_peer_list (orchestrator-only): bounded, deterministically ordered metadata (sessionID, goal status, and a redacted/truncated objective hint) for the same stable project only.",
  "The query is durable metadata only and never live-complete: sessions without a readable goal record do not appear, only known-pattern-redacted hints are returned, records of other projects are never read, and complete:false is reported truthfully when storage.scan is unavailable or the bounded scan cap is hit.",
].join("\n")

/**
 * Publication capability policy, embedded only when `publish.enabled` is on
 * (the config master gate). States the capability-not-authentication
 * semantics, the exact authorized steps (including merge), the never-authorized
 * step, the per-session narrowing boundary, the mandatory commit -> sync ->
 * verify -> exact-revision review -> push -> ready -> approve -> merge ->
 * cleanup sequence with the conflict-delegation recovery flow, the draft-first
 * PR lifecycle with its ready/approval limitations, and the merge
 * preconditions.
 */
export const PUBLICATION_POLICY_GUIDANCE = [
  "Durable publication authorization is capability policy, never caller authentication: /publish toggles a project-scoped durable authorization record; nothing in it proves which human invoked it, it never weakens the static github/worktree gates, and it never mutates Git or GitHub itself.",
  "When the durable capability is enabled it authorizes the orchestrator to pass confirm:true without re-prompting for exactly: worktree push, draft PR creation, the draft-to-ready transition, the verified post-ready approval, and merge after the full merge precondition chain. It never authorizes issue creation. /gates (or the TUI gate picker) can narrow any of these steps — including merge — for the current session only; a session-disabled gate is final.",
  "Mandatory publication sequence: commit clean changes first, then synchronize against the latest remote base (orchestrator_worktree_sync, which records an exact-revision receipt), verify/test the synced result, run the exact-revision bounded review, and only then push (orchestrator_worktree_push) and create the always-draft pull request (orchestrator_github_pr_create), mark it ready (orchestrator_github_pr_ready), approve at the exact revision (orchestrator_github_pr_approve), merge (orchestrator_github_pr_merge), verify the merge, and clean up the tracked worktree (orchestrator_worktree_cleanup).",
  "When a sync reports conflicts after aborting, autonomously delegate an implementer to perform the merge/resolution inside the tracked worktree, rerun verification and sync, commit, and restart the exact-revision review; stop only when conflicts cannot safely be resolved, and never push from an unresolved or unsynced state.",
  "If the base or head changes after the exact-revision review, re-sync and re-review before any push or merge; stale base/head, dirty trees, missing sync receipts, and missing or mismatched approved review receipts all fail closed.",
  "Pull requests are always created as drafts; fresh views must directly show the conflict-free exact revision (draft:true, mergeable:true, no dirty/unknown conflict state, remote base ancestry) before a ready transition, an unknown mergeability stays draft and is truthfully deferred without polling, and a draft that reports conflict state is never forced ready.",
  "Auto-approve happens only after the ready transition and the exact internal review, with an authenticated non-author viewer and fresh conflict-free evidence; same-author attempts and API failures are refused and reported truthfully, and an automated approval is never claimed to satisfy branch protection.",
  "Merge preconditions (all required, checked against fresh reads): an open, unmerged, non-draft pull whose head SHA equals the exact expected revision; mergeable:true with no dirty or unknown conflict state; an exact-revision approved internal review receipt for the same head/base; the current remote base is an ancestor of the exact head; and the durable 'merge' capability plus the per-session gate allow it. Merge with the exact SHA, verify merged:true with a fresh view, log the merge SHA, then clean up. Branch protection, required checks or reviews, permission failures, and merge queues are reported truthfully — never bypassed, never polled.",
].join("\n")

/**
 * Terminal-drive policy: the Definition of Done for ship-shaped work.
 *
 * The orchestrator has historically stopped after "changes are ready" or "the
 * PR is open" and waited for a separate instruction to push, merge, and clean
 * up. This guidance makes the whole terminal chain the expected ending whenever
 * the configured capability and per-session gates allow it, while a disabled
 * gate or a failed step still stops truthfully. Embedded only when the GitHub
 * or publication features are enabled.
 */
export function terminalDriveGuidance(options: {
  github: { enabled: boolean }
  worktree: { enabled: boolean }
  publish: { enabled: boolean }
}): string {
  return [
    "Definition of Done (terminal drive): a ship-shaped task is finished only when it is merged and the tracked worktree is cleaned up, or when a configured gate/capability refuses the next terminal step. Never stop at 'changes are ready' or 'the PR is open' and wait for the user to ask for the next step.",
    ...(options.github.enabled
      ? [
          "Run the terminal chain in order as soon as the work is verified: verify/tests green -> commit -> sync against the latest remote base -> exact-revision review -> push -> draft PR -> ready -> approve -> merge -> post-merge verify -> worktree cleanup. The publish capability authorizes these steps; only the fail-closed preconditions can refuse them.",
        ]
      : []),
    ...(options.publish.enabled
      ? [
          "If a terminal step is refused by a session-disabled gate (/gates) or a missing durable capability, state exactly which step is unavailable and the one command that would change it; do not re-plan around the gate, do not re-enable it yourself, and do not claim completion.",
        ]
      : []),
    "If a terminal step fails, attempt at most one targeted recovery with new evidence (for example re-sync and re-review after a moved base or head); never re-dispatch an identical failed step without new evidence.",
    "Implementer handoffs must arrive with green tests for the delivered scope; do not start the terminal chain on unverified work.",
  ].join("\n")
}

/**
 * Capability flags that decide which feature-specific lifecycle guidance a
 * prompt embeds. Universal guidance (catalog preflight, secrets, the truthful
 * no-atomic-child-isolation boundary) is always present; feature lifecycle
 * text appears only for enabled features.
 */
export type OrchestrationCapabilities = {
  worktree?: boolean
  github?: boolean
  publish?: boolean
}

export const REMOTE_ORCHESTRATION_GUIDANCE = [
  TOOL_AVAILABILITY_GUIDANCE,
  SECRET_HANDLING_GUIDANCE,
  WORKTREE_BOUNDARY_GUIDANCE,
].join("\n")

/**
 * Explicit bounded maker-checker review flow, embedded only when
 * `review.mode === "bounded"`. It requires the serialized flow through the
 * existing admission tooling and the V1 review tools. The flow is callable and
 * advisory: nothing is gated automatically and a self-declared D2 reviewState
 * is never trusted as reviewer proof.
 */
export const BOUNDED_REVIEW_GUIDANCE = [
  "Bounded review mode is configured: run the explicit maker-checker flow.",
  "Validate the maker handoff with orchestrator_handoff_validate before review.",
  "Reach admission state review-pending through orchestrator_admission_transition (orchestrator-pass with reviewRequired=true) before starting a review record.",
  "Start the review record with orchestrator_review_transition using a start signal (taskId, runId, maker, checker, and the review-pending admission signal are required).",
  "Delegate the reviewer (the configured review role), then record its fixed decision through orchestrator_review_transition: fixed boolean checks for approve, or request-changes / block.",
  "Map the review decision through orchestrator_admission_transition (review-approve, review-reject, or review-block).",
  "Stop when the review record is blocked or tripped; do not keep dispatching the same run past a terminal breaker.",
  "These tools are callable/advisory, not an automatic completion gate: nothing is gated automatically and a self-declared D2 reviewState is never reviewer proof.",
].join("\n")

/**
 * stop-between-steps budget semantics, embedded only when
 * `budget.mode === "stop-between-steps"`. Only plugin-owned next dispatches
 * are checked; in-flight provider/tool calls are never interrupted and nothing
 * is cancelled automatically.
 */
export const BUDGET_GUIDANCE = [
  "stop-between-steps budget mode is configured: plugin-owned next dispatches (goal auto-continuations and slash-command prompts) are checked against the configured limits before dispatch.",
  "Exceeded limits stop the next dispatch; in-flight provider and tool calls are never interrupted and nothing is cancelled automatically.",
  "Unknown token or cost observations fail closed for these checks; inspect orchestrator_observability_get for the evaluation and reasons.",
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

export function orchestrationRules(
  maxParallel: number,
  requireReview: boolean,
  capabilities: OrchestrationCapabilities = {},
): string {
  return [
    `At most ${maxParallel} independent child tasks may run at once.`,
    "Route by the configured semantic role map, never by model name.",
    DELEGATION_GRAPH_GUIDANCE,
    "Explore before planning when repository facts are unknown.",
    "Track the session goal with the namespaced tools orchestrator_goal_get, orchestrator_goal_set, and orchestrator_goal_update.",
    CHILD_TASK_CONTRACT,
    "Require an exact disjoint write scope from every child before any parallel write; no two children may claim the same file or area.",
    "Serialize implementation tasks when file ownership overlaps; parallelize writes only with explicit disjoint write scopes.",
    "Separate established facts from assumptions: label every assumption explicitly and verify it before relying on it.",
    PROMPTING_POLICY_GUIDANCE,
    TOOL_AVAILABILITY_GUIDANCE,
    SECRET_HANDLING_GUIDANCE,
    WORKTREE_BOUNDARY_GUIDANCE,
    PEER_DISCOVERY_GUIDANCE,
    ...(capabilities.worktree ? [WORKTREE_LIFECYCLE_GUIDANCE] : []),
    ...(capabilities.github ? [GITHUB_LIFECYCLE_GUIDANCE] : []),
    ...(capabilities.publish ? [PUBLICATION_POLICY_GUIDANCE] : []),
    ...(capabilities.github || capabilities.publish
      ? [
          terminalDriveGuidance({
            github: { enabled: capabilities.github === true },
            worktree: { enabled: capabilities.worktree === true },
            publish: { enabled: capabilities.publish === true },
          }),
        ]
      : []),
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

/**
 * Feature capabilities for the configured options: which feature-specific
 * lifecycle guidance is embedded depends on `worktree.enabled` and
 * `github.enabled`. The parameter is the structural slice of
 * `OrchestratorOptions` so callers only need the flags, not the full options
 * type.
 */
export function orchestrationCapabilities(options: {
  worktree: { enabled: boolean }
  github: { enabled: boolean }
  publish: { enabled: boolean }
}): OrchestrationCapabilities {
  return { worktree: options.worktree.enabled, github: options.github.enabled, publish: options.publish.enabled }
}

/**
 * Ask-tool clarification guidance: ask targeted questions only when the
 * objective is genuinely ambiguous, resolve what the repository already
 * answers, and keep all clarification owned by the orchestrator.
 */
export const CLARIFY_GUIDANCE = [
  "Clarify mode is enabled: when the initial task is ambiguous (undefined scope, conflicting constraints, unclear success criteria, or a missing verification definition), use the native ask tool to ask the user a small number of targeted clarifying questions with concrete answer options before decomposing or delegating; skip asking when the objective is already precise.",
  "Do not ask what repository facts can answer: explore first; ask only what cannot be resolved from the repository.",
  "Record the user's answers in the task ledger; state the resolved interpretation and proceed.",
  "Workers never ask on the user's behalf; clarification is owned by the orchestrator.",
].join("\n")
