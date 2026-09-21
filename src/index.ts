/**
 * Supported package entrypoint.
 *
 * Runtime implementation details stay behind the server plugin. The pure
 * D2/D4/admission contracts remain public because they are versioned fixtures
 * and documented contracts; durable state machines and storage helpers are
 * intentionally not re-exported from the package root.
 */
export { orchestratorPlugin as default, orchestratorPlugin } from "./opencode-v2/plugin.js"

export {
  OrchestratorOptionsSchema,
  parseOptions,
  TRACE_MODES,
  BUDGET_MODES,
  REVIEW_MODES,
  CLARIFY_MODES,
  AUTHORITY_MODES,
  RETRY_MODES,
  DECOMPOSITION_STRATEGIES,
} from "./core/config.js"
export type {
  OrchestratorOptions,
  CommandName,
  TraceMode,
  BudgetMode,
  ReviewMode,
  ClarifyMode,
  AuthorityMode,
  RetryMode,
  DecompositionStrategy,
  TraceOptions,
  BudgetOptions,
  BudgetLimits,
  ReviewOptions,
  ClarifyOptions,
  AuthorityOptions,
  RetryOptions,
  DecompositionOptions,
  PublishOptions,
} from "./core/config.js"

// D4 v1 is an advisory, versioned pure contract. It is not a runtime gate.
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

// D2 is the versioned structured handoff contract used by worker boundaries.
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

// V2 admission is a stateless, versioned transition contract. It is not an
// automatic plugin gate and does not read durable state.
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
