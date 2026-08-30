import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { ORCHESTRATION_TOOL_PERMISSION } from "../../src/core/permissions.js"
import { ADMISSION_ACTIONS, ADMISSION_STATES, type AdmissionState } from "../../src/core/admission.js"
import { D4_PARALLELISM_VALUES, type D4Recommendation } from "../../src/core/d4.js"
import { D2_LIMITS, RELATIVE_REPO_PATH_PATTERN } from "../../src/core/contracts.js"
import {
  addOrchestrationTools,
  type OrchestrationToolsDeps,
} from "../../src/opencode-v2/orchestration/tools.js"
import { HANDOFF_CHECK_IDS, type HandoffValidationResult } from "../../src/opencode-v2/orchestration/validation.js"

const options = parseOptions({})

type ToolLike = {
  name: string
  input?: unknown
  options?: { namespace?: string; permission?: string }
  execute(input: unknown, tool: { sessionID: string; agent: string }): Promise<{ content: string }>
}

type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, any>
  anyOf?: unknown[]
  enum?: unknown[]
  items?: any
  required?: string[]
  minLength?: number
  maxLength?: number
  pattern?: string
  additionalProperties?: boolean | unknown
}

function schema(tools: Map<string, ToolLike>, name: string): JsonSchema {
  const tool = tools.get(name)
  expect(tool).toBeDefined()
  return tool!.input as JsonSchema
}

type HandoffObject = Record<string, unknown>

function handoff(overrides: HandoffObject = {}): HandoffObject {
  return {
    version: 1,
    taskId: "task-1",
    status: "completed",
    outcome: "did the work",
    facts: [],
    assumptions: [],
    filesRead: [],
    filesChanged: [],
    verification: [],
    risks: [],
    followUp: "next step",
    artifactRefs: [],
    reviewState: "not-requested",
    ...overrides,
  }
}

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { taskId: "task-1", writeScope: ["src/a.ts"], requiredCommands: [], reviewRequired: false, ...overrides }
}

function toolContext(sessionID: string, agent: string): { sessionID: string; agent: string } {
  return { sessionID, agent }
}

const identityRealpath = async (path: string): Promise<string | undefined> => path
const existsAlways = async (): Promise<boolean> => true

function collect(overrides: Partial<OrchestrationToolsDeps> = {}): Map<string, ToolLike> {
  const tools = new Map<string, ToolLike>()
  addOrchestrationTools(
    {
      add(tool) {
        tools.set(tool.name, tool as ToolLike)
      },
    },
    {
      options,
      location: { directory: "/workspace" },
      pathExists: existsAlways,
      realpath: identityRealpath,
      ...overrides,
    },
  )
  return tools
}

type VcsResult = ReadonlyArray<{ file: string }>

function vcsReturning(files: VcsResult): OrchestrationToolsDeps["vcs"] {
  return {
    status: async () => files,
  }
}

function parseResult(content: string): HandoffValidationResult {
  return JSON.parse(content) as HandoffValidationResult
}

describe("orchestration validation tool registration", () => {
  test("registers exactly the three tools under the orchestrator namespace with the shared permission", () => {
    const tools = collect()
    const names = [...tools.keys()]
    expect(names).toEqual(["task_complexity_classify", "handoff_validate", "admission_transition"])
    for (const name of names) {
      const tool = tools.get(name)!
      expect(tool.options?.namespace).toBe("orchestrator")
      expect(tool.options?.permission).toBe(ORCHESTRATION_TOOL_PERMISSION)
      expect(ORCHESTRATION_TOOL_PERMISSION).toBe("orchestrator_validation")
    }
  })

  test("registers unconditionally as core tools with no confirm input or persistence surface", () => {
    const tools = collect()
    for (const tool of tools.values()) {
      const input = tool.input as { properties?: Record<string, unknown> } | undefined
      expect(input?.properties?.["confirm"]).toBeUndefined()
    }
  })
})

describe("orchestrator-only gating", () => {
  test("rejects a worker agent for all three tools", async () => {
    const tools = collect()
    const worker = toolContext("session-1", "explore")
    await expect(tools.get("task_complexity_classify")!.execute({}, worker)).rejects.toThrow(/only to the orchestrator/)
    await expect(
      tools.get("handoff_validate")!.execute(
        { level: "worker", handoff: handoff(), contract: contract() },
        worker,
      ),
    ).rejects.toThrow(/only to the orchestrator/)
    await expect(
      tools.get("admission_transition")!.execute({ from: "candidate", signal: { action: "worker-pass" } }, worker),
    ).rejects.toThrow(/only to the orchestrator/)
  })
})

describe("task_complexity_classify", () => {
  const FULL_FACTS = {
    independent_subtasks: 0,
    dependent_stages: 0,
    files_modules: 1,
    independent_review: false,
    external_side_effects: false,
    shared_mutable_state: false,
    security_compliance_risk: false,
    expected_parallelism_value: "none",
  }

  test("classifies a fully-known trivial input as an advisory direct-execution candidate", async () => {
    const tools = collect()
    const output = await tools
      .get("task_complexity_classify")!
      .execute(FULL_FACTS, toolContext("session-1", "orchestrator"))
    const result = JSON.parse(output.content) as {
      version: number
      recommendation: D4Recommendation
      rule: string
      advisory: boolean
    }
    expect(result.version).toBe(1)
    expect(result.recommendation).toBe("direct-execution-candidate")
    expect(result.advisory).toBe(true)
  })

  test("unknown or missing facts classify as collect-facts", async () => {
    const tools = collect()
    const empty = await tools.get("task_complexity_classify")!.execute({}, toolContext("session-1", "orchestrator"))
    expect((JSON.parse(empty.content) as { recommendation: string }).recommendation).toBe("collect-facts")

    const partial = await tools
      .get("task_complexity_classify")!
      .execute({ ...FULL_FACTS, shared_mutable_state: null, security_compliance_risk: undefined }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(partial.content) as { recommendation: string; unknownDimensions: string[] }
    expect(parsed.recommendation).toBe("collect-facts")
    expect(parsed.unknownDimensions.sort()).toEqual(["security_compliance_risk", "shared_mutable_state"])
  })

  test("invalid structured input returns a safe deterministic failure that does not echo offending values", async () => {
    const tools = collect()
    for (const bad of [{ files_modules: -1 }, { security_compliance_risk: "yes" }, { extra_field: true }, { independent_subtasks: 0.5 }]) {
      const output = await tools
        .get("task_complexity_classify")!
        .execute(bad, toolContext("session-1", "orchestrator"))
      expect(output.content).toBe(
        "task_complexity_classify rejected invalid structured input; supply only the eight typed dimension fields (each may be null when the fact is unknown) and retry",
      )
      expect(output.content).not.toContain("-1")
      expect(output.content).not.toContain("yes")
      expect(output.content).not.toContain("extra_field")
    }
  })

  test("classifies a null parallelism fact as collect-facts with that dimension unknown", async () => {
    const tools = collect()
    const output = await tools
      .get("task_complexity_classify")!
      .execute(
        { ...FULL_FACTS, expected_parallelism_value: null },
        toolContext("session-1", "orchestrator"),
      )
    const result = JSON.parse(output.content) as { recommendation: string; unknownDimensions: string[]; version: number }
    expect(result.version).toBe(1)
    expect(result.recommendation).toBe("collect-facts")
    expect(result.unknownDimensions).toEqual(["expected_parallelism_value"])
  })

  test("the registered host schema accepts null for every nullable D4 field including the parallelism enum", () => {
    const tools = collect()
    const classify = schema(tools, "task_complexity_classify")
    const props = classify.properties!

    // Plain nullable fields use a null-inclusive type array (valid 2020-12).
    expect(props.independent_subtasks.type).toEqual(["integer", "null"])
    expect(props.dependent_stages.type).toEqual(["integer", "null"])
    expect(props.files_modules.type).toEqual(["integer", "null"])
    for (const field of ["independent_review", "external_side_effects", "shared_mutable_state", "security_compliance_risk"]) {
      expect(props[field].type).toEqual(["boolean", "null"])
    }

    // Enum field: null must sit in its own `anyOf` branch, because a shared
    // `type: ["string","null"]` + `enum` rejects null (2019-09/2020-12).
    const parallelism = props.expected_parallelism_value
    expect(parallelism.anyOf).toEqual([
      { type: "string", enum: ["none", "low", "medium", "high"] },
      { type: "null" },
    ])
    expect(parallelism.anyOf[0].enum).toEqual([...D4_PARALLELISM_VALUES])
    // No invalid extreme leaks into the accepted values.
    for (const invalid of ["extreme", "max", "unlimited"]) {
      expect(parallelism.anyOf[0].enum).not.toContain(invalid)
    }
  })

  test("high-risk and shared-state signals never authorize runtime parallelism", async () => {
    const tools = collect()
    const risky = await tools
      .get("task_complexity_classify")!
      .execute({ ...FULL_FACTS, security_compliance_risk: true }, toolContext("session-1", "orchestrator"))
    const parsed = JSON.parse(risky.content) as { recommendation: string; rule: string }
    expect(parsed.rule).toBe("high-risk")
    expect(parsed.recommendation).toBe("orchestrate-with-review")
  })
})

describe("admission_transition", () => {
  test("transitions deterministic state pairs and never persists", async () => {
    const tools = collect()
    const input = { from: "candidate" as const, signal: { action: "worker-pass" as const } }
    const output = await tools.get("admission_transition")!.execute(input, toolContext("session-1", "orchestrator"))
    const result = JSON.parse(output.content) as { version: number; accepted: boolean; from: string; to: string; replacementReceipt: boolean }
    expect(result.version).toBe(1)
    expect(result.accepted).toBe(true)
    expect(result.from).toBe("candidate")
    expect(result.to).toBe("worker-passed")
    expect(result.replacementReceipt).toBe(false)
    // Pure/stateless: input is not mutated and nothing is written anywhere.
    expect(input).toEqual({ from: "candidate", signal: { action: "worker-pass" } })
  })

  test("maps orchestrator-pass to admitted or review-pending via contract reviewRequired", async () => {
    const tools = collect()
    const admitted = await tools
      .get("admission_transition")!
      .execute(
        { from: "worker-passed", signal: { action: "orchestrator-pass", reviewRequired: false } },
        toolContext("session-1", "orchestrator"),
      )
    expect((JSON.parse(admitted.content) as { to: string }).to).toBe("admitted")

    const pending = await tools
      .get("admission_transition")!
      .execute(
        { from: "worker-passed", signal: { action: "orchestrator-pass", reviewRequired: true } },
        toolContext("session-1", "orchestrator"),
      )
    expect((JSON.parse(pending.content) as { to: string }).to).toBe("review-pending")
  })

  test("blocked-unknown never auto-advances without an explicit human decision", async () => {
    const tools = collect()
    const output = await tools
      .get("admission_transition")!
      .execute({ from: "blocked-unknown", signal: { action: "new-receipt" } }, toolContext("session-1", "orchestrator"))
    const result = JSON.parse(output.content) as { accepted: boolean; to?: string; requiresHuman: boolean }
    expect(result.accepted).toBe(false)
    expect(result.to).toBeUndefined()
    expect(result.requiresHuman).toBe(true)
  })

  test("invalid input returns a generic deterministic rejection without echoing values", async () => {
    const tools = collect()
    const output = await tools
      .get("admission_transition")!
      .execute({ from: "bogus-state", signal: { action: "nope" } }, toolContext("session-1", "orchestrator"))
    expect(output.content).toBe(
      "admission_transition rejected invalid input; supply from (one of the admission states) and a strict signal object with a valid action and retry",
    )
    expect(output.content).not.toContain("bogus-state")
  })

  test("the admission host schema mirrors the runtime vocabulary and reason limits", () => {
    const tools = collect()
    const admission = schema(tools, "admission_transition")
    const props = admission.properties!
    expect(props.from.enum).toEqual([...ADMISSION_STATES])
    const signal = props.signal
    expect(signal.properties.action.enum).toEqual([...ADMISSION_ACTIONS])
    expect(signal.properties.reason).toEqual({ type: "string", minLength: 1, maxLength: 2000 })
    expect(signal.properties.reviewRequired.type).toBe("boolean")
    expect(signal.properties.humanDecision.type).toBe("boolean")
    expect(signal.required).toEqual(["action"])
    expect(admission.required).toEqual(["from", "signal"])
    expect(admission.additionalProperties).toBe(false)
  })

  test("the input is strictly a (from, signal) pair: D2 reviewState is never accepted as approval", async () => {
    const tools = collect()
    const output = await tools
      .get("admission_transition")!
      .execute(
        { from: "worker-failed", signal: { action: "new-receipt" }, reviewState: "approved" },
        toolContext("session-1", "orchestrator"),
      )
    expect(output.content).toContain("rejected invalid input")
  })
})

describe("handoff_validate worker level", () => {
  test("the handoff host-schema contract mirrors the D2 runtime limits", () => {
    const tools = collect()
    const validate = schema(tools, "handoff_validate")
    const contract = validate.properties!.contract
    expect(contract.required).toEqual(["taskId", "writeScope", "requiredCommands", "reviewRequired"])
    expect(contract.properties.taskId).toEqual({
      type: "string",
      minLength: D2_LIMITS.taskId.min,
      maxLength: D2_LIMITS.taskId.max,
    })
    expect(contract.properties.writeScope).toEqual({
      type: "array",
      items: {
        type: "string",
        minLength: D2_LIMITS.fileScope.min,
        maxLength: D2_LIMITS.fileScope.max,
        pattern: RELATIVE_REPO_PATH_PATTERN,
      },
    })
    expect(contract.properties.requiredCommands).toEqual({
      type: "array",
      items: {
        type: "string",
        minLength: D2_LIMITS.verificationCommand.min,
        maxLength: D2_LIMITS.verificationCommand.max,
      },
    })
    expect(contract.properties.reviewRequired.type).toBe("boolean")
    expect(contract.additionalProperties).toBe(false)
    expect(validate.required).toEqual(["level", "handoff", "contract"])
  })

  test("threads the invoking sessionID into session resolution without exposing session content", async () => {
    const seenSessionIDs: string[] = []
    const seenDirectories: string[] = []
    const session: OrchestrationToolsDeps["session"] = {
      get: async (input) => {
        seenSessionIDs.push(input.sessionID)
        return { location: { directory: "/session-root", workspaceID: "ws-1" } }
      },
    }
    const vcs: OrchestrationToolsDeps["vcs"] = {
      status: async (input) => {
        seenDirectories.push(input.location.directory)
        return [{ file: "src/a.ts" }]
      },
    }
    const tools = collect({ session, vcs })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({ filesChanged: [{ path: "src/a.ts", scope: "edited" }] }),
          contract: contract(),
        },
        toolContext("session-42", "orchestrator"),
      )
    // The tool passes its own sessionID straight into the resolver; only the
    // resolved directory (never the session content) reaches VCS.
    expect(seenSessionIDs).toEqual(["session-42"])
    expect(seenDirectories).toEqual(["/session-root"])
    expect(parseResult(output.content).admissionState).toBe("admitted")
  })

  test("returns worker-passed for a clean in-scope worker receipt with five-field prose", async () => {
    const tools = collect()
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({
            filesChanged: [{ path: "src/a.ts", scope: "edited the entrypoint" }],
            verification: [{ command: "bun test", status: "pass", result: "all passed", evidence: ["src/a.test.ts"] }],
          }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.version).toBe(1)
    expect(result.level).toBe("worker")
    expect(result.verdict).toBe("pass")
    expect(result.admissionState).toBe("worker-passed")
    expect(result.checks.map((check) => check.id)).toEqual([
      HANDOFF_CHECK_IDS.c1Structure,
      HANDOFF_CHECK_IDS.c2Status,
      HANDOFF_CHECK_IDS.c3Scope,
      HANDOFF_CHECK_IDS.c4Commands,
      HANDOFF_CHECK_IDS.c5Artifacts,
      HANDOFF_CHECK_IDS.c6Semantics,
      HANDOFF_CHECK_IDS.c7Redaction,
    ])
    expect(result.prose).toContain("Outcome: did the work")
    expect(result.prose).toContain("Follow-up: next step")
    expect(result.limitations.some((limit) => limit.includes("raw-transcript authenticity"))).toBe(true)
  })

  test("fails on scope escape (changed file outside writeScope)", async () => {
    const tools = collect()
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ filesChanged: [{ path: "lib/outside.ts", scope: "touched another area" }] }),
          contract: contract({ writeScope: ["src/a.ts"] }),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.verdict).toBe("fail")
    expect(result.admissionState).toBe("worker-failed")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c3Scope)?.verdict).toBe("fail")
  })

  test("fails when the scope contains unsafe path entries or changed files are unsafe", async () => {
    const tools = collect()
    const unsafeScope = await tools
      .get("handoff_validate")!
      .execute(
        { level: "worker", handoff: handoff(), contract: contract({ writeScope: ["../escape"] }) },
        toolContext("session-1", "orchestrator"),
      )
    expect(parseResult(unsafeScope.content).admissionState).toBe("worker-failed")
  })

  test("fails on taskId mismatch and on a failed status; blocks on blocked/in-progress", async () => {
    const tools = collect()
    const wrongTask = await tools
      .get("handoff_validate")!
      .execute(
        { level: "worker", handoff: handoff({ taskId: "other-task" }), contract: contract() },
        toolContext("session-1", "orchestrator"),
      )
    expect(parseResult(wrongTask.content).admissionState).toBe("worker-failed")

    const failedStatus = await tools
      .get("handoff_validate")!
      .execute(
        { level: "worker", handoff: handoff({ status: "failed" }), contract: contract() },
        toolContext("session-1", "orchestrator"),
      )
    expect(parseResult(failedStatus.content).admissionState).toBe("worker-failed")

    const blockedStatus = await tools
      .get("handoff_validate")!
      .execute(
        { level: "worker", handoff: handoff({ status: "blocked" }), contract: contract() },
        toolContext("session-1", "orchestrator"),
      )
    const blockedResult = parseResult(blockedStatus.content)
    expect(blockedResult.verdict).toBe("blocked-unknown")
    expect(blockedResult.admissionState).toBe("blocked-unknown")

    const inProgress = await tools
      .get("handoff_validate")!
      .execute(
        { level: "worker", handoff: handoff({ status: "in-progress" }), contract: contract() },
        toolContext("session-1", "orchestrator"),
      )
    expect(parseResult(inProgress.content).admissionState).toBe("blocked-unknown")
  })

  test("required commands: missing or failed fails; blocked/not-run blocks; pass without evidence blocks", async () => {
    const tools = collect()
    const missing = await tools
      .get("handoff_validate")!
      .execute(
        { level: "worker", handoff: handoff(), contract: contract({ requiredCommands: ["bun test"] }) },
        toolContext("session-1", "orchestrator"),
      )
    expect(parseResult(missing.content).admissionState).toBe("worker-failed")

    const failed = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ verification: [{ command: "bun test", status: "fail", result: "boom" }] }),
          contract: contract({ requiredCommands: ["bun test"] }),
        },
        toolContext("session-1", "orchestrator"),
      )
    expect(parseResult(failed.content).admissionState).toBe("worker-failed")

    const notRun = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ verification: [{ command: "bun test", status: "not-run", result: "skipped" }] }),
          contract: contract({ requiredCommands: ["bun test"] }),
        },
        toolContext("session-1", "orchestrator"),
      )
    const notRunResult = parseResult(notRun.content)
    expect(notRunResult.verdict).toBe("blocked-unknown")
    expect(notRunResult.admissionState).toBe("blocked-unknown")

    const passWithoutEvidence = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({
            verification: [{ command: "bun test", status: "pass", result: "all good", evidence: [] }],
          }),
          contract: contract({ requiredCommands: ["bun test"] }),
        },
        toolContext("session-1", "orchestrator"),
      )
    const passEmptyResult = parseResult(passWithoutEvidence.content)
    expect(passEmptyResult.verdict).toBe("blocked-unknown")
    expect(passEmptyResult.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c4Commands)?.detail).toContain("passed without evidence")

    const passWithNoEvidenceKey = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({
            verification: [{ command: "bun test", status: "pass", result: "all good" }],
          }),
          contract: contract({ requiredCommands: ["bun test"] }),
        },
        toolContext("session-1", "orchestrator"),
      )
    expect(parseResult(passWithNoEvidenceKey.content).admissionState).toBe("blocked-unknown")
  })

  test("semantic errors fail the receipt while reviewState stays self-declared", async () => {
    const tools = collect()
    const semanticError = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({
            assumptions: [{ id: "a1", statement: "assumed security", status: "Verified", evidence: [] }],
            reviewState: "approved",
          }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(semanticError.content)
    expect(result.verdict).toBe("fail")
    expect(result.admissionState).toBe("worker-failed")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c6Semantics)?.verdict).toBe("fail")

    // reviewState approved with no semantic error does not upgrade anything.
    const approvedOnly = await tools
      .get("handoff_validate")!
      .execute(
        { level: "worker", handoff: handoff({ reviewState: "approved" }), contract: contract() },
        toolContext("session-1", "orchestrator"),
      )
    const approvedResult = parseResult(approvedOnly.content)
    expect(approvedResult.admissionState).toBe("worker-passed")
    expect(approvedResult.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c6Semantics)?.verdict).toBe("pass")
  })

  test("failure is deterministic and versioned for malformed structured input", async () => {
    const tools = collect()
    const malformed = await tools
      .get("handoff_validate")!
      .execute(
        { level: "worker", handoff: { ...handoff(), version: 2 }, contract: contract() },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(malformed.content)
    expect(result.verdict).toBe("fail")
    expect(result.admissionState).toBe("worker-failed")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c1Structure)?.verdict).toBe("fail")
    expect(result.prose).toBeUndefined()

    const second = parseResult(
      (
        await tools
          .get("handoff_validate")!
          .execute({ level: "worker", handoff: { ...handoff(), version: 2 }, contract: contract() }, toolContext("session-1", "orchestrator"))
      ).content,
    )
    expect(second.checks).toEqual(result.checks)
  })

  test("rejects envelope-level malformed input without echoing it", async () => {
    const tools = collect()
    const output = await tools
      .get("handoff_validate")!
      .execute({ level: "bogus-level", handoff: handoff(), contract: contract() }, toolContext("session-1", "orchestrator"))
    const result = parseResult(output.content)
    expect(result.verdict).toBe("fail")
    expect(result.checks[0]?.id).toBe("input-strict")
    expect(result.admissionState).toBe("worker-failed")
    expect(output.content).not.toContain("bogus-level")
  })
})

describe("handoff_validate credential redaction (C7)", () => {
  test("fails with generic detail and never echoes the credential or its prose", async () => {
    const tools = collect()
    const secret = "supersecretvalue123"
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ outcome: `done using token: ${secret}` }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.verdict).toBe("fail")
    expect(result.admissionState).toBe("worker-failed")
    const redaction = result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c7Redaction)
    expect(redaction?.verdict).toBe("fail")
    expect(redaction?.detail).toContain("credential-shaped")
    expect(output.content).not.toContain(secret)
    expect(output.content).not.toContain("ghp_")
    // Prose is suppressed so the redacted text cannot leak downstream.
    expect(result.prose).toBeUndefined()
  })

  test("threads an injected redactor (custom patterns) through the tool", async () => {
    const tools = collect({
      redact: (text: string) => (text.includes("TOPSECRETMARKER") ? text.replaceAll("TOPSECRETMARKER", "[redacted]") : text),
    })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ followUp: "then rotate TOPSECRETMARKER" }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c7Redaction)?.verdict).toBe("fail")
    expect(output.content).not.toContain("TOPSECRETMARKER")
  })
})

describe("handoff_validate file artifacts (C5) and evidence files (O4)", () => {
  test("contained file artifacts that exist pass", async () => {
    const tools = collect()
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ artifactRefs: [{ kind: "file", reference: "src/a.ts", description: "built artifact" }] }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.admissionState).toBe("worker-passed")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c5Artifacts)?.verdict).toBe("pass")
  })

  test("fails when a file artifact escapes the session project through a symlink", async () => {
    const tools = collect({
      realpath: async (path: string) => (path === "/workspace/src/a.ts" ? "/outside/secret.ts" : path),
    })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ artifactRefs: [{ kind: "file", reference: "src/a.ts", description: "sketchy artifact" }] }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.verdict).toBe("fail")
    const artifactCheck = result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c5Artifacts)
    expect(artifactCheck?.verdict).toBe("fail")
    expect(artifactCheck?.detail).toContain("escapes")
  })

  test("fails when a file artifact does not exist", async () => {
    const missing = new Set(["/workspace/not-exists.ts"])
    const tools = collect({
      pathExists: async (path: string) => !missing.has(path),
    })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ artifactRefs: [{ kind: "file", reference: "not-exists.ts", description: "promised artifact" }] }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.verdict).toBe("fail")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c5Artifacts)?.detail).toContain("does not exist")
  })

  test("URL artifacts are syntax-only and never claim reachability", async () => {
    const tools = collect()
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ artifactRefs: [{ kind: "url", reference: "https://example.com/artifact.zip", description: "release" }] }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c5Artifacts)?.verdict).toBe("pass")
  })
})

describe("handoff_validate orchestrator level", () => {
  test("passes a clean single-receipt result and maps to admitted when review is not required", async () => {
    const tools = collect({ vcs: vcsReturning([{ file: "src/a.ts" }]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({ filesChanged: [{ path: "src/a.ts", scope: "edited" }] }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.verdict).toBe("pass")
    expect(result.admissionState).toBe("admitted")
    expect(result.checks.map((check) => check.id)).toEqual([
      HANDOFF_CHECK_IDS.c1Structure,
      HANDOFF_CHECK_IDS.c2Status,
      HANDOFF_CHECK_IDS.c3Scope,
      HANDOFF_CHECK_IDS.c4Commands,
      HANDOFF_CHECK_IDS.c5Artifacts,
      HANDOFF_CHECK_IDS.c6Semantics,
      HANDOFF_CHECK_IDS.c7Redaction,
      HANDOFF_CHECK_IDS.o2Vcs,
      HANDOFF_CHECK_IDS.o3Rerun,
      HANDOFF_CHECK_IDS.o4EvidenceFiles,
      HANDOFF_CHECK_IDS.o5Foreign,
      HANDOFF_CHECK_IDS.o6Authority,
    ])
    for (const check of result.checks) {
      expect(check.verdict, check.id).toBe("pass")
    }
  })

  test("maps a full pass to review-pending when the contract requires review", async () => {
    const tools = collect({ vcs: vcsReturning([{ file: "src/a.ts" }]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({ filesChanged: [{ path: "src/a.ts", scope: "edited" }] }),
          contract: contract({ reviewRequired: true }),
        },
        toolContext("session-1", "orchestrator"),
      )
    expect(parseResult(output.content).admissionState).toBe("review-pending")
  })

  test("independently repeats worker checks and fails on missing observed files", async () => {
    const tools = collect({ vcs: vcsReturning([]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({ filesChanged: [{ path: "src/a.ts", scope: "edited" }] }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.verdict).toBe("fail")
    expect(result.admissionState).toBe("orchestrator-failed")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o2Vcs)?.verdict).toBe("fail")
  })

  test("fails when observed in-scope files were not declared (extra changed file)", async () => {
    const tools = collect({ vcs: vcsReturning([{ file: "src/a.ts" }, { file: "src/a2.ts" }]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({ filesChanged: [{ path: "src/a.ts", scope: "edited" }] }),
          contract: contract({ writeScope: ["src"] }),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o2Vcs)?.verdict).toBe("fail")
    expect(result.admissionState).toBe("orchestrator-failed")
  })

  test("blocks as unknown when VCS status is unavailable", async () => {
    // No `vcs` dependency is wired into the collector, so status resolves to
    // undefined (fail-closed) instead of guessing.
    const tools = collect()
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({ filesChanged: [{ path: "src/a.ts", scope: "edited" }] }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.verdict).toBe("blocked-unknown")
    expect(result.admissionState).toBe("blocked-unknown")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o2Vcs)?.verdict).toBe("blocked-unknown")
    expect(result.limitations.some((limit) => limit.includes("single receipt"))).toBe(true)
  })

  test("blocks foreign changed files outside the write scope instead of ignoring them", async () => {
    const tools = collect({ vcs: vcsReturning([{ file: "src/a.ts" }, { file: "otherapp/unrelated.ts" }]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({ filesChanged: [{ path: "src/a.ts", scope: "edited" }] }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.verdict).toBe("blocked-unknown")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o5Foreign)?.verdict).toBe("blocked-unknown")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o5Foreign)?.detail).toContain("cross-task")
  })

  test("blocks when required commands exist because the pinned API cannot re-run them", async () => {
    const tools = collect({ vcs: vcsReturning([{ file: "src/a.ts" }]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({
            filesChanged: [{ path: "src/a.ts", scope: "edited" }],
            verification: [{ command: "bun test", status: "pass", result: "all good", evidence: ["src/a.test.ts"] }],
          }),
          contract: contract({ requiredCommands: ["bun test"] }),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    // Worker-level C4 passes, but the orchestrator cannot re-run the command.
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c4Commands)?.verdict).toBe("pass")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o3Rerun)?.verdict).toBe("blocked-unknown")
    expect(result.verdict).toBe("blocked-unknown")
    expect(result.admissionState).toBe("blocked-unknown")
    expect(result.limitations.some((limit) => limit.includes("independently re-run the required commands"))).toBe(true)
  })

  test("blocks URL evidence claims for unauthenticatable authority and never claims proof from marker text", async () => {
    const tools = collect({ vcs: vcsReturning([{ file: "src/a.ts" }]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({
            filesChanged: [{ path: "src/a.ts", scope: "edited" }],
            facts: [
              { statement: "external doc confirms the fix is current", evidence: ["https://example.com/evidence#L1"] },
              { statement: "marker text is not proof", evidence: ["src/a.ts#L12"] },
            ],
          }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.verdict).toBe("blocked-unknown")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o6Authority)?.verdict).toBe("blocked-unknown")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o6Authority)?.detail).toContain("typed EvidenceRecord")
    expect(result.limitations.some((limit) => limit.includes("marker text"))).toBe(true)
  })

  test("local static evidence file refs pass o6 once their existence was confirmed", async () => {
    const tools = collect({ vcs: vcsReturning([{ file: "src/a.ts" }]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({
            filesChanged: [{ path: "src/a.ts", scope: "edited" }],
            facts: [{ statement: "verified by the local receipt", evidence: ["src/a.ts"] }],
          }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o6Authority)?.verdict).toBe("pass")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o4EvidenceFiles)?.verdict).toBe("pass")
  })

  test("a truly empty receipt with no evidence claims may pass in scope with VCS confirmation", async () => {
    const tools = collect({ vcs: vcsReturning([{ file: "src/a.ts" }]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({ filesChanged: [{ path: "src/a.ts", scope: "edited" }] }),
          contract: contract({ reviewRequired: false }),
        },
        toolContext("session-1", "orchestrator"),
      )
    expect(parseResult(output.content).admissionState).toBe("admitted")
  })

  test("admission states stay within the vocabulary", async () => {
    const tools = collect({ vcs: vcsReturning([]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({ filesChanged: [{ path: "src/a.ts", scope: "edited" }] }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(ADMISSION_STATES).toContain(result.admissionState as AdmissionState)
    expect(result.verdict === "fail" ? result.admissionState === "orchestrator-failed" : true).toBe(true)
  })
})