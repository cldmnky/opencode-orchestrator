export { orchestratorPlugin as default, orchestratorPlugin } from "./opencode-v2/plugin.js"
export { commandDefinitions, COMMAND_NAMES } from "./opencode-v2/commands/index.js"
export {
  OrchestratorOptionsSchema,
  parseOptions,
  TRACE_MODES,
  BUDGET_MODES,
  REVIEW_MODES,
} from "./core/config.js"
export type {
  OrchestratorOptions,
  CommandName,
  TraceMode,
  BudgetMode,
  ReviewMode,
  TraceOptions,
  BudgetOptions,
  BudgetLimits,
  ReviewOptions,
} from "./core/config.js"

// Serialized runtime public pure APIs. No package subpath: these are exported
// from the main entrypoint only. The orchestration tools
// (orchestrator_task_complexity_classify, orchestrator_handoff_validate,
// orchestrator_admission_transition) are wired behind the plugin, and these
// modules are their callable/stateless primitives — none of them enforces an
// automatic gate.

// D4 complexity classifier (advisory).
export {
  classifyTaskComplexity,
  D4InputSchema,
  D4_DIMENSIONS,
  D4_RULES,
  D4_RECOMMENDATIONS,
  D4_PARALLELISM_VALUES,
} from "./core/d4.js"
export type {
  D4Input,
  D4ClassificationResult,
  D4Rule,
  D4Recommendation,
  D4DimensionId,
  D4ParallelismValue,
  D4NormalizedFeatures,
} from "./core/d4.js"

// D2 versioned structured handoff.
export {
  D2_HANDOFF_SCHEMA,
  D2_REQUIRED_KEYS,
  D2_PROSE_HEADINGS,
  D2_LIMITS,
  D2_STATUSES,
  D2_REVIEW_STATES,
  ASSUMPTION_STATUSES,
  VERIFICATION_STATUSES,
  RISK_SEVERITIES,
  ARTIFACT_KINDS,
  RELATIVE_REPO_PATH_SCHEMA,
  EVIDENCE_REF_SCHEMA,
  FACT_SCHEMA,
  ASSUMPTION_SCHEMA,
  FILE_REF_SCHEMA,
  VERIFICATION_ENTRY_SCHEMA,
  RISK_SCHEMA,
  ARTIFACT_REF_SCHEMA,
  RELATIVE_REPO_PATH_PATTERN,
  EVIDENCE_REF_PATTERN,
  ARTIFACT_URL_REF_PATTERN,
  parseD2Handoff,
  validateD2Handoff,
  renderD2Handoff,
  validateD2Semantics,
  D2HandoffValidationError,
  isSafeRelativeRepoPath,
  isSafeEvidenceRef,
  ADAPTER_LEVEL_REQUIRED_CHECKS,
} from "./core/contracts.js"
export type {
  D2Handoff,
  D2Status,
  D2ReviewState,
  Assumption,
  AssumptionStatus,
  VerificationStatus,
  RiskSeverity,
  ArtifactKind,
  Fact,
  FileRef,
  VerificationEntry,
  Risk,
  ArtifactRef,
  D2ParseResult,
  HandoffIssue,
  D2SemanticCheck,
} from "./core/contracts.js"

// V2 admission state machine (stateless).
export {
  ADMISSION_STATES,
  ADMISSION_ACTIONS,
  ADMISSION_STATE_SCHEMA,
  ADMISSION_ACTION_SCHEMA,
  ADMISSION_SIGNAL_SCHEMA,
  ADMISSION_INPUT_SCHEMA,
  transitionAdmission,
} from "./core/admission.js"
export type {
  AdmissionState,
  AdmissionAction,
  AdmissionSignal,
  AdmissionInput,
  AdmissionTransitionResult,
} from "./core/admission.js"

// V3 typed evidence vocabulary/assessment/factories.
export {
  evidenceSchema,
  mutationProofSchema,
  assessEvidence,
  liveEvidence,
  mutationEvidence,
  EVIDENCE_MARKERS,
  FRESHNESS_VALUES,
  AUTHORITY_VALUES,
} from "./opencode-v2/orchestration/evidence.js"
export type {
  EvidenceRecord,
  EvidenceMarker,
  Freshness,
  Authority,
  MutationProof,
  LiveEvidence,
  MutationEvidence,
  LiveEvidenceInput,
  MutationProofInput,
  MutationEvidenceInput,
  Assessment,
  EvidenceRequirement,
} from "./opencode-v2/orchestration/evidence.js"

// S3 state & observability — deterministic budget evaluation and bounded
// metadata-only trace summaries. All pure/stateless; nothing here enforces an
// automatic gate by itself (stop-between-steps checks run only inside the
// plugin-owned dispatch surfaces below).
export { evaluateBudget, configuredBudgetLimits, BUDGET_LIMIT_NAMES } from "./opencode-v2/observability/budget.js"
export type {
  BudgetObservation,
  BudgetLimitName,
  BudgetLimitStatus,
  BudgetDetail,
  BudgetVerdict,
  BudgetEvaluation,
} from "./opencode-v2/observability/budget.js"
export {
  TRACE_RECORD_VERSION,
  TRACE_MAX_TOOL_ENTRIES,
  TRACE_MAX_PENDING_CALLS,
  TRACE_OTHER_TOOL,
  traceSummarySchema,
  traceToolUsageSchema,
  usageSnapshotSchema,
  newTraceSummary,
  applyToolCallStart,
  applyToolCallEnd,
  applyToolCallOutcome,
  recordStep,
  recordRetry,
  recordUsageSnapshot,
  usageTokensTotal,
  parseTraceSummary,
  traceStorageKey,
} from "./opencode-v2/observability/trace.js"
export type { TraceSummary, TraceToolUsage, UsageSnapshot, UsageSnapshotInput } from "./opencode-v2/observability/trace.js"

// V1 maker-checker review schema and deterministic transitions. This is a
// separate version-1 review schema: D2 reviewState semantics and the core
// admission state semantics are unchanged.
export {
  REVIEW_V1_VERSION,
  REVIEW_V1_STATES,
  REVIEW_V1_ACTIONS,
  REVIEW_V1_REASONS,
  reviewV1RecordSchema,
  REVIEW_V1_START_SIGNAL_SCHEMA,
  REVIEW_V1_APPROVE_SIGNAL_SCHEMA,
  REVIEW_V1_SIGNAL_SCHEMA,
  transitionReviewV1,
  parseReviewRecord,
  reviewStorageKey,
} from "./opencode-v2/observability/review.js"
export type {
  ReviewV1State,
  ReviewV1Action,
  ReviewV1Reason,
  ReviewV1Record,
  ReviewV1Signal,
  ReviewV1TransitionInput,
  ReviewV1Transition,
} from "./opencode-v2/observability/review.js"
export type { DispatchGate, DispatchDecision, DispatchCheck } from "./opencode-v2/observability/runtime.js"
