import { delegationGraphSummary } from "./roles.js"
import type { RoleName } from "./roles.js"
import type { DecompositionStrategy } from "./config.js"
import { renderCapabilityGuidance } from "./capabilities.js"

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

/**
 * The five D2 handoff fields, as user-facing section names. Worker handoffs and
 * user-facing finish summaries share one skeleton so a reader can move between
 * them without relearning the structure. The names mirror `D2_PROSE_HEADINGS`
 * in `core/contracts.ts` (asserted equal in the unit suite); the D2 envelope
 * and its schema are unchanged.
 */
export const HANDOFF_SUMMARY_FIELDS = ["Outcome", "Files", "Verification", "Risks", "Follow-up"] as const

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
  "Ownership rule: files that must change together for one outcome stay with one owner in the same child.",
  "Must do: the required steps, constraints, and verification commands.",
  "Must not do: forbidden actions, including editing out-of-scope files or delegating outside the child's own role graph.",
  "Verification: the checks and commands that prove the work.",
  "Handoff: the worker handoff format below.",
  "The parent stays accountable for every delegated child.",
  "It composes each child contract, keeps child scopes disjoint, verifies child claims directly, and owns the integrated result.",
].join("\n")

/**
 * Bounded nested-delegation guidance and the shared prompting policy. Both are
 * embedded verbatim so every prompt kind states the same truthful policy
 * without duplicating text, exactly like the remote-orchestration guidance
 * below.
 *
 * Restructured for G3: one instruction per bullet, each line short. The pinned
 * safety phrases (`stays accountable for its children`, `keep child write
 * scopes disjoint`, `Delegating outside your role graph is forbidden`, `stop
 * and report honestly`) are byte-identical.
 */
export const DELEGATION_GRAPH_GUIDANCE = [
  `Bounded nested delegation graph: ${delegationGraphSummary()}.`,
  "A worker that delegates stays accountable for its children.",
  "It composes each child prompt from the child-task contract.",
  "Rules: keep child write scopes disjoint, verify child claims directly, and own the integrated result.",
  "Delegating outside your role graph is forbidden even when the host would allow it.",
  "If a permitted delegation is refused or unavailable, stop and report honestly instead of substituting an unauthorized path.",
].join("\n")

/**
 * Coherent vertical-slice decomposition guidance, embedded verbatim in the
 * orchestrator rules, the worker system prompt, and continuation prompts.
 * It prefers the smallest coherent end-to-end slice over the smallest file or
 * layer, and it keeps the fail-closed anti-overlap rule explicit: coupling and
 * unknown coupling are resolved by sequencing or serialization with integrated
 * parent verification, never by concurrent overlapping writes. A slice is a
 * coordination unit, never a permission or filesystem boundary.
 *
 * The two pinned safety sentences stay byte-identical; the rest is split into
 * one instruction per bullet.
 */
export const VERTICAL_SLICE_GUIDANCE = [
  "Prefer the smallest coherent end-to-end implementation slice over the smallest file or layer: keep coupled code, tests, wiring, and requested docs under one owner.",
  "Split only at a verified boundary where every resulting slice has its own outcome, acceptance evidence, and no hidden dependency.",
  "Unavoidable coupling between files is resolved by sequencing or serialization with integrated parent verification — never by concurrent overlapping writes.",
  "A slice is a coordination unit, never a permission or filesystem boundary.",
  "Fail closed on uncertainty: unknown coupling fails closed and serializes.",
  "Prompt-level scopes are advisory, not isolation.",
].join("\n")

/**
 * Opt-in strict decomposition emphasis, appended verbatim after the base
 * `VERTICAL_SLICE_GUIDANCE` when `decomposition.strategy === "strict"`.
 * Prompt-preference only: it raises the emphasis on coherent end-to-end
 * slicing and never changes enforcement. The exact disjoint-write-scope
 * rule, the fail-closed serialization rule, aggregate review, the worktree
 * lifecycle, and the publication preconditions all remain verbatim and are
 * never bypassed or relaxed.
 */
export const STRICT_DECOMPOSITION_GUIDANCE = [
  "Strict decomposition strategy is configured.",
  "Treat the smallest coherent end-to-end slice as the default unit of work.",
  "Require a stated, verified reason before splitting it into file-by-file or layer-by-layer tasks.",
  "A split is justified only when every resulting slice has its own outcome, acceptance evidence, ownership, and no hidden dependency.",
  "When that cannot be shown, keep the work in one slice or serialize it with an explicit edge.",
  "This preference changes emphasis only and never overrides an explicit user decision.",
  "The exact disjoint-write-scope rule, fail-closed serialization for overlapping or unknown coupling, aggregate review, the worktree lifecycle, and the publication preconditions all remain unchanged.",
  "They must never be bypassed or relaxed.",
].join("\n")

/**
 * Slice guidance for a decomposition strategy: the Phase 1 MVP text alone
 * (default — byte-identical to the behavior before this option existed) or
 * the same text plus the strict emphasis block. Prompt-preference only.
 */
export function verticalSliceGuidance(strategy: DecompositionStrategy = "mvp"): string {
  return strategy === "strict" ? [VERTICAL_SLICE_GUIDANCE, STRICT_DECOMPOSITION_GUIDANCE].join("\n") : VERTICAL_SLICE_GUIDANCE
}

/**
 * Additive D4 v2 coherence-signal guidance (Phase 3), embedded verbatim after
 * the slice guidance in the orchestrator rules, the worker system prompt, and
 * continuation prompts. It names the explicit coherence question the eight D4
 * v1 dimensions cannot answer, states the deterministic slice-metadata mapping
 * (`cohesive-slice` | `parallel-candidate` | `serialized`), keeps the
 * fail-closed collect-facts rule explicit, and answers the D2 flow-through
 * question upfront: D2 v1 stays frozen, so the signal never adds or changes a
 * D2 handoff field, reviewState value, or handoff-validation behavior.
 *
 * Prompt-preference only: it is advisory coordination guidance, never a
 * runtime gate, and it changes no serialization, review, worktree, or
 * publication behavior.
 */
export const D4_V2_COHERENCE_GUIDANCE = [
  "Additive D4 v2 coherence signal (advisory; D4 v1 and D2 v1 are unchanged).",
  "Before splitting work, answer the explicit coherence question for the candidate slice: coupled-outcome, independent, overlap, or unknown.",
  "Deterministic slice metadata: a coupled-outcome stays one cohesive-slice.",
  "An independent slice is only a parallel-candidate after the parent verifies exact disjoint write scopes from repository facts.",
  "Overlapping or unknown coupling serializes.",
  "Unknown facts fail closed to collect-facts before any slice metadata is emitted.",
  "D2 flow-through question (named upfront): does this signal add or change any D2 handoff field, reviewState value, or handoff validation?",
  "No — D2 v1 stays frozen.",
  "Slice metadata is never written into a D2 envelope field, never replaces reviewState, and never changes handoff validation.",
  "Slice metadata is advisory coordination guidance only.",
  "It is not filesystem isolation and not a permission boundary.",
  "It never changes how a task is executed or published.",
].join("\n")

/**
 * Prompting policy for every orchestration participant: autonomous authorized
 * follow-through, explicit user-instruction precedence, legible inter-agent
 * messages, risk-proportionate verification, and concise evidence-led user
 * reporting. Each pinned behavior starts its own bullet.
 */
export const PROMPTING_POLICY_GUIDANCE = [
  "Follow through autonomously on exactly what the task authorizes.",
  "Keep going until the authorized work is done or a genuine blocker requires the user.",
  "Never expand scope beyond the authorization.",
  "The user's explicit instructions take precedence over skill guidance and general defaults whenever they conflict.",
  "Surface an unsafe conflict instead of silently resolving it.",
  "Inter-agent messages must be clear and legible.",
  "State the task, constraints, and expected result so another agent could act on them alone.",
  "Return results that are specific, structured, and free of process chatter.",
  "Verify in proportion to risk.",
  "Run the checks the task names and state exactly what was verified and how.",
  "Never present an unexecuted or borrowed check as your own pass.",
  "Report to the user concisely with evidence.",
  "Lead with the outcome and cite the verification that proves it.",
  "Name assumptions and risks instead of padding the answer.",
].join("\n")

// Remote (GitHub) orchestration guidance lives here as the single source of
// truth. Prompt generation embeds these constants verbatim so every prompt
// kind states the same truthful policy without duplicating text.
export const TOOL_AVAILABILITY_GUIDANCE = [
  "Preflight: inspect the tool catalog the connected host actually exposes.",
  "That means only tools already visible in this session, plus the plugin probes orchestrator_github_capabilities and orchestrator_worktree_status.",
  "Do this before using any GitHub tool.",
  "Availability rule: never infer availability from MCP server names or status.",
  "Use only GitHub tools the host has already configured and exposed.",
  "Host-configured tools only: never assume, register, or invent tools.",
  "There is no tool named search; do not call search.",
  "For issue, branch, pull request, review, merge, or closure operations, require direct evidence from the tool result.",
  "Direct evidence is the object, its identifier, and its URL.",
  "Require that evidence before reporting completion.",
  "If the connected host does not expose the tools needed for issue or pull request automation, stop and ask the user.",
  "Fail truthfully: do not silently claim the work, fall back to unverified steps, or fabricate results.",
].join("\n")

export const SECRET_HANDLING_GUIDANCE = [
  "Never request, resolve, log, paste, or copy raw tokens, authorization headers, environment secrets, or OAuth credentials.",
  "Redact credentials from every ledger, handoff, and handover.",
].join("\n")

export const WORKTREE_BOUNDARY_GUIDANCE = [
  "Prompt-level rules are advisory and do not enforce filesystem isolation.",
  "The native V2 subagent API does not expose a plugin-controlled atomic worktree or location boundary.",
  "These prompt-level disjoint write scopes do not equal filesystem isolation.",
  "Retain native role delegation: safe delegation is allowed whenever isolation is not required.",
].join("\n")

/** Shared guidance/recorded/observed/enforced vocabulary for every prompt. */
export const CAPABILITY_BOUNDARY_GUIDANCE = renderCapabilityGuidance()

export const MANAGED_WORKTREE_GUIDANCE = [
  "Managed worktree tools create and track one git worktree owned by the current session.",
  "Records are durable and results are verified with git.",
  "The tools are orchestrator_worktree_list, orchestrator_worktree_create, orchestrator_worktree_status, orchestrator_worktree_enter, orchestrator_worktree_push, and orchestrator_worktree_cleanup.",
  "When managed worktrees are used for implementation, the required order is orchestrator_worktree_create -> orchestrator_worktree_enter -> delegate to the implementer.",
  "orchestrator_worktree_enter moves only the current session into its tracked worktree; session ID and history are preserved.",
  "Note: children delegated afterward inherit or start from that context.",
  "Children still share the parent filesystem: this is not atomic child isolation, so none is guaranteed.",
  "A pending or failed orchestrator_worktree_enter result is not an entry receipt.",
  "Stop, wait for the V2 session move safe boundary, retry, and delegate only after entered:true is returned.",
  "Managed ownership covers the current session only.",
  "Parallel children still share the parent filesystem.",
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
  "Worktree lifecycle is mandatory for implementation when worktree support is enabled.",
  "Before delegating to the implementer, the orchestrator MUST run orchestrator_worktree_create -> orchestrator_worktree_enter.",
  "Lifecycle ownership: only the orchestrator creates, enters, pushes, and cleans up managed worktrees.",
  "Stop and ask the user when any of these is unavailable:",
  "the worktree tools;",
  "a whitelisted worktree.root;",
  "worktree.allow_mutations;",
  "a ready tracked worktree;",
  "a successful orchestrator_worktree_enter result.",
  "Do not fall back: never delegate implementation from the main checkout.",
].join("\n")

/**
 * Feature-specific GitHub lifecycle guidance, embedded only when
 * `github.enabled`. The orchestrator owns the branch push -> PR create ->
 * ready -> best-effort approve -> merge -> cleanup lifecycle; implementers never push or
 * create/merge PRs, and merge is autonomous once the durable publish
 * capability and the per-session gates allow it, always behind the full
 * fail-closed precondition chain.
 */
export const GITHUB_LIFECYCLE_GUIDANCE = [
  "GitHub lifecycle is orchestrator-owned.",
  "Always preflight with orchestrator_github_capabilities and use only the tools the host actually exposes.",
  "Role boundary: implementers never push branches or create or merge pull requests.",
  "The orchestrator pushes the worktree branch (orchestrator_worktree_push) and creates the pull request (orchestrator_github_pr_create).",
  "Do that only after validated maker/checker review and direct verification of the branch, changes, and commits.",
  "Merge is autonomous when the durable publish capability 'merge' and the per-session gates allow it.",
  "That means no separate user merge instruction is required.",
  "Run orchestrator_github_pr_merge with a fresh conflict-free view.",
  "Use the exact approved revision, the exact head and base SHAs, and the exact-revision approved internal review receipt.",
  "Then verify merged:true again with a fresh orchestrator_github_pr_view and clean up the tracked worktree.",
  "Every publication step fails closed.",
  "Refusals include stale base or head, a dirty tree, a missing sync or review receipt, a moved revision, and unresolved conflicts.",
  "They also include branch protection, required checks or reviews, permission failures, merge queues, merged:false, and a failed post-merge view.",
  "In every case, stop truthfully: never retry, fall back to a different SHA, or report a step without direct evidence.",
].join("\n")

/**
 * Peer-orchestrator discovery guidance, embedded in every orchestrator-facing
 * prompt kind. Discloses the durable metadata-only/incomplete semantics and
 * the same-project redaction boundary of `orchestrator_peer_list` up front so
 * peer findings are never mistaken for live, complete knowledge of other
 * sessions.
 */
export const PEER_DISCOVERY_GUIDANCE = [
  "Same-project peer orchestration sessions are discoverable with orchestrator_peer_list (orchestrator-only).",
  "The result is bounded, deterministically ordered metadata: sessionID, goal status, and a redacted/truncated objective hint.",
  "Results cover the same stable project only.",
  "The query is durable metadata only and is never live-complete.",
  "Sessions without a readable goal record do not appear.",
  "Only known-pattern-redacted hints are returned.",
  "Records of other projects are never read.",
  "Report complete:false truthfully when storage.scan is unavailable or the bounded scan cap is hit.",
].join("\n")

/**
 * Publication capability policy, embedded only when `publish.enabled` is on
 * (the config master gate). States the capability-not-authentication
 * semantics, the exact authorized steps (including merge), the never-authorized
 * step, the per-session narrowing boundary, the mandatory commit -> sync ->
 * verify -> exact-revision review -> push -> ready -> best-effort approve ->
 * merge -> cleanup sequence with the conflict-delegation recovery flow, the
 * draft-first PR lifecycle with its ready transition, its optional best-effort
 * approval, and the merge preconditions that never depend on a GitHub APPROVE
 * review.
 *
 * Restructured for G3: one rule per bullet. Pinned safety phrases (for example
 * `It never authorizes issue creation`, `A session-disabled gate is final`,
 * `No GitHub APPROVE review is required`, `never bypassed, never polled`) stay
 * byte-identical.
 */
export const PUBLICATION_POLICY_GUIDANCE = [
  "Durable publication authorization is capability policy, never caller authentication.",
  "The /publish command toggles a project-scoped durable authorization record.",
  "Nothing in that record proves which human invoked it.",
  "It never weakens the static github/worktree gates.",
  "It never mutates Git or GitHub by itself.",
  "When the durable capability is enabled it authorizes the orchestrator to pass confirm:true",
  "without re-prompting for exactly: worktree push, draft PR creation, the draft-to-ready transition, the verified post-ready approval, and merge after the full merge precondition chain.",
  "The verified post-ready approval is best-effort and optional.",
  "The 'approve-after-review' gate controls only that approval attempt.",
  "A truthful refusal never blocks the merge.",
  "Refusals include self-approval, a missing approval capability, or an API failure.",
  "The merge is independently authorized by the durable 'merge' capability, the per-session merge gate, and every merge precondition.",
  "It never authorizes issue creation.",
  "/gates (or the TUI gate picker) can narrow any of these steps — including merge — for the current session only.",
  "A session-disabled gate is final.",
  "Mandatory publication sequence: commit clean changes first.",
  "Then synchronize against the latest remote base (orchestrator_worktree_sync, which records an exact-revision receipt).",
  "Verify/test the synced result and run the exact-revision bounded review.",
  "Only then push (orchestrator_worktree_push) and create the always-draft pull request (orchestrator_github_pr_create).",
  "Mark it ready (orchestrator_github_pr_ready).",
  "Attempt the optional best-effort approval at the exact revision (orchestrator_github_pr_approve); a refusal never blocks the next step.",
  "Then merge (orchestrator_github_pr_merge), verify the merge, and clean up the tracked worktree (orchestrator_worktree_cleanup).",
  "When a sync reports conflicts after aborting, autonomously delegate an implementer to perform the merge/resolution inside the tracked worktree.",
  "Then rerun verification and sync, commit, and restart the exact-revision review.",
  "Stop only when conflicts cannot safely be resolved.",
  "Never push from an unresolved or unsynced state.",
  "If the base or head changes after the exact-revision review, re-sync and re-review before any push or merge.",
  "Stale base or head, dirty trees, missing sync receipts, and missing or mismatched approved review receipts all fail closed.",
  "Pull requests are always created as drafts.",
  "Fresh views must directly show the conflict-free exact revision before a ready transition: draft:true, mergeable:true, no dirty or unknown conflict state, remote base ancestry.",
  "An unknown mergeability stays draft and is truthfully deferred without polling.",
  "A draft that reports conflict state is never forced ready.",
  "Auto-approve happens only after the ready transition and the exact internal review.",
  "It needs an authenticated non-author viewer and fresh conflict-free evidence.",
  "It is best-effort and optional.",
  "Refuse same-author attempts, a missing approval capability, and API failures; report them truthfully without success evidence.",
  "A refused or skipped approval never blocks the independently authorized merge, which requires no GitHub APPROVE review.",
  "An automated approval is never claimed to satisfy branch protection.",
  "Merge preconditions (all required, checked against fresh reads):",
  "The pull is open, unmerged, non-draft, and its head SHA equals the exact expected revision.",
  "mergeable:true with no dirty or unknown conflict state.",
  "An exact-revision approved internal review receipt for the same head/base.",
  "The current remote base is an ancestor of the exact head.",
  "The durable 'merge' capability and the per-session gate allow it.",
  "No GitHub APPROVE review is required.",
  "The exact-revision approved internal review receipt is the review authority.",
  "A refused or skipped best-effort approval is not a merge precondition.",
  "Merge with the exact SHA and verify merged:true with a fresh view.",
  "Log the merge SHA, then clean up.",
  "Branch protection, required checks or reviews, permission failures, and merge queues are reported truthfully.",
  "They are never bypassed, never polled.",
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
    "Definition of Done (terminal drive): a ship-shaped task is finished only when it is merged and the tracked worktree is cleaned up.",
    "It is also finished when a configured gate or capability refuses the next terminal step.",
    "Never stop at 'changes are ready' or 'the PR is open' and wait for the user to ask for the next step.",
    ...(options.github.enabled
      ? [
          "Run the terminal chain in order as soon as the work is verified.",
          "verify/tests green -> commit -> sync against the latest remote base -> exact-revision review -> push -> draft PR -> ready.",
          "Then best-effort approve -> merge -> post-merge verify -> worktree cleanup.",
          "The publish capability authorizes these steps; only the fail-closed preconditions can refuse them.",
        ]
      : []),
    ...(options.publish.enabled
      ? [
          "If a terminal step is refused by a session-disabled gate (/gates) or a missing durable capability, state exactly which step is unavailable.",
          "Give the one command that would change it.",
          "Do not re-plan around the gate, do not re-enable it yourself, and do not claim completion.",
        ]
      : []),
    "If a terminal step fails, attempt at most one targeted recovery with new evidence (for example re-sync and re-review after a moved base or head).",
    "Never re-dispatch an identical failed step without new evidence.",
    "Implementer handoffs must arrive with green tests for the delivered scope.",
    "Do not start the terminal chain on unverified work.",
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
 * `review.mode === "bounded"`. It uses separate lead-start and
 * reviewer-submit V2 tools. The flow is callable and advisory: nothing is
 * gated automatically and a self-declared D2 reviewState is never trusted as
 * reviewer proof.
 */
export const BOUNDED_REVIEW_GUIDANCE = [
  "Bounded review mode is configured: run the explicit provenance-bound maker-checker flow.",
  "Validate the maker handoff with orchestrator_handoff_validate before review.",
  "Reach admission state review-pending through orchestrator_admission_transition (orchestrator-pass with reviewRequired=true) before starting a review record.",
  "Start V2 with orchestrator_review_start from the lead session using taskId, runId, and the exact head/base SHAs.",
  "Delegate the configured reviewer child, then have that child call orchestrator_review_submit with its lead session, round, and one fixed decision.",
  "The submit tool derives reviewer agent/session identity from ToolContext and refuses orchestrator self-approval or unrelated sessions.",
  "V1 records are readable as legacy-unproven status only and never authorize publication or completion.",
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
 *
 * The envelope field list is rewritten as bullets for one line per field
 * group; the schema, field names, and advisory status are unchanged.
 */
export const STRUCTURED_HANDOFF_GUIDANCE = [
  "Structured handoff envelope (version 1): include every worker result as this JSON envelope alongside the five-field prose:",
  "version: 1; taskId: the exact task ID from the parent contract; status: in-progress, blocked, completed, or failed.",
  "outcome; facts (statement plus evidence refs); assumptions (id, statement, status, evidence).",
  "filesRead and filesChanged (path plus scope); verification (command, status not-run/blocked/fail/pass, result, evidence refs).",
  "risks (severity, statement); followUp; artifactRefs (kind file or url, reference, description); reviewState (not-requested, pending, approved, changes-requested, or blocked).",
  "Use the same relative repository paths and https-only URL refs as the handoff schema; never include credentials, raw transcripts, or secrets in the envelope.",
  "Parent: call orchestrator_handoff_validate (level worker or orchestrator, with the task contract) before using any worker handoff downstream.",
  "Parent: call orchestrator_task_complexity_classify only after collecting all eight structured facts (independent_subtasks, dependent_stages, files_modules, independent_review, external_side_effects, shared_mutable_state, security_compliance_risk, expected_parallelism_value).",
  "These validation tools are callable/advisory, not automatic hooks.",
  "The orchestrator invokes them explicitly.",
  "Complexity classification is advisory; D2 and admission checks are deterministic fail-closed checks.",
  "No automatic completion gate is enforced.",
].join("\n")

export function orchestrationRules(
  maxParallel: number,
  requireReview: boolean,
  capabilities: OrchestrationCapabilities = {},
  decompositionStrategy: DecompositionStrategy = "mvp",
): string {
  return [
    `Treat max_parallel=${maxParallel} as an instructed dispatch ceiling; it is not a native dispatch coordinator or guaranteed runtime cap yet.`,
    "Route by the configured semantic role map, never by model name.",
    DELEGATION_GRAPH_GUIDANCE,
    "Explore before planning when repository facts are unknown.",
    "Track the session goal with the namespaced tools orchestrator_goal_get, orchestrator_goal_set, and orchestrator_goal_update.",
    CHILD_TASK_CONTRACT,
    "Require an exact disjoint write scope from every child before any parallel write; no two children may claim the same file or area.",
    "Serialize implementation tasks when file ownership overlaps; parallelize writes only with explicit disjoint write scopes.",
    verticalSliceGuidance(decompositionStrategy),
    D4_V2_COHERENCE_GUIDANCE,
    CAPABILITY_BOUNDARY_GUIDANCE,
    "Separate established facts from assumptions.",
    "Label every assumption explicitly and verify it before relying on it.",
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
    "Do not claim automated GitHub issue creation unless the connected host exposes the required tools and direct evidence is returned.",
    "Do not poll background tasks; consume native completion delivery.",
    "Keep a concise task ledger in the parent session.",
    requireReview ? "Implementation is incomplete until the review role audits the aggregate change." : "Review changed work before reporting completion.",
    "Verify worker claims directly in the parent session before reporting completion.",
    "Never present a worker's self-report as your own verification.",
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
 *
 * G3 pilot: the original single dense sentence is now a short bulleted
 * sequence. The asked questions are bounded (see the orchestrator personality
 * spec) and every pinned phrase is byte-identical.
 */
export const CLARIFY_GUIDANCE = [
  "Clarify mode is enabled: when the initial task is ambiguous, ask before decomposing or delegating; skip asking when the objective is already precise.",
  "Ambiguity means undefined scope, conflicting constraints, unclear success criteria, or a missing verification definition.",
  "Use the native ask tool to ask the user a small number of targeted clarifying questions with concrete answer options.",
  "Do not ask what repository facts can answer: explore first; ask only what cannot be resolved from the repository.",
  "Record the user's answers in the task ledger; state the resolved interpretation and proceed.",
  "Workers never ask on the user's behalf: clarification is owned by the orchestrator.",
].join("\n")
