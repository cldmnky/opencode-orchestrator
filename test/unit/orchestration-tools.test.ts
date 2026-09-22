import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import { ORCHESTRATION_TOOL_PERMISSION } from "../../src/core/permissions.js"
import { ADMISSION_STATES, type AdmissionState } from "../../src/core/admission.js"
import { D2_LIMITS, RELATIVE_REPO_PATH_PATTERN } from "../../src/core/contracts.js"
import {
  addOrchestrationTools,
  type OrchestrationToolsDeps,
} from "../../src/opencode-v2/orchestration/tools.js"
import {
  HANDOFF_CHECK_IDS,
  type HandoffValidationResult,
} from "../../src/opencode-v2/orchestration/validation.js"
import {
  createLeadBoardV2 as createLeadBoard,
  leadBoardV2StorageKey as leadBoardStorageKey,
  leadTaskStepIdempotencyKey,
  parseLeadBoardV2 as parseLeadBoard,
  type LeadBoardV2 as LeadBoard,
} from "../../src/opencode-v2/orchestration/lead-board-v2.js"
import { reviewV2StorageKey, type ReviewV2Record } from "../../src/opencode-v2/observability/review-v2.js"
import { goalStorageKey } from "../../src/opencode-v2/goal/state.js"
import { verificationCommandDigest } from "../../src/core/verification.js"
import { verificationStorageKey } from "../../src/opencode-v2/verification/state.js"

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
      location: { directory: "/workspace", project: { id: "project" } },
      storage: memStorage(),
      pathExists: existsAlways,
      realpath: identityRealpath,
      ...overrides,
    },
  )
  return tools
}

function memStorage(values = new Map<string, unknown>()): {
  values: Map<string, unknown>
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(input: { prefix: string; after?: string; limit?: number }): Promise<{ entries: Array<{ key: string; value: unknown }>; next?: string }>
} {
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    scan: async ({ prefix, after, limit = 100 }) => {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit)
        .map(([key, value]) => ({ key, value }))
      return { entries }
    },
  }
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
  test("registers exactly the validation and lead-board tools under the orchestrator namespace with the shared permission", () => {
    const tools = collect()
    const names = [...tools.keys()]
    expect(names).toEqual([
      "handoff_validate",
      "board_get",
      "board_action",
    ])
    for (const name of names) {
      const tool = tools.get(name)!
      expect(tool.options?.namespace).toBe("orchestrator")
      expect(tool.options?.permission).toBe(ORCHESTRATION_TOOL_PERMISSION)
      expect(ORCHESTRATION_TOOL_PERMISSION).toBe("orchestrator_validation")
    }
  })

  test("the orchestration family stays separate from the conditional observability/review tools", () => {
    // addOrchestrationTools never registers the S3/V1 tools; they are added by
    // addObservabilityTools (src/opencode-v2/observability/tools.ts) only when
    // a mode is enabled, so default tool registration is unchanged.
    const tools = collect()
    for (const name of ["observability_get", "review_get", "review_start", "review_submit"]) {
      expect(tools.has(name)).toBe(false)
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
  test("rejects a worker agent for all canonical tools", async () => {
    const tools = collect()
    const worker = toolContext("session-1", "explore")
    await expect(
      tools.get("handoff_validate")!.execute(
        { level: "worker", handoff: handoff(), contract: contract() },
        worker,
      ),
    ).rejects.toThrow(/only to the orchestrator/)
    await expect(tools.get("board_get")!.execute({}, worker)).rejects.toThrow(/only to the orchestrator/)
    await expect(tools.get("board_action")!.execute({ action: "init" }, worker)).rejects.toThrow(/only to the orchestrator/)
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

  test("fails a safe github-token-shaped fixture without echoing it", async () => {
    const tools = collect()
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ outcome: "rotated ghp_EXAMPLEFAKETOKENFORTEST123456" }),
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
    expect(output.content).not.toContain("ghp_")
    expect(output.content).not.toContain("EXAMPLEFAKETOKENFORTEST123456")
    expect(result.prose).toBeUndefined()
  })

  test("fails a safe bearer-shaped fixture and passes the no-secret control", async () => {
    const tools = collect()
    const bearer = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "worker",
          handoff: handoff({ followUp: "call Bearer FAKE-BEARER-TOKEN-FOR-TEST" }),
          contract: contract(),
        },
        toolContext("session-1", "orchestrator"),
      )
    const bearerResult = parseResult(bearer.content)
    expect(bearerResult.verdict).toBe("fail")
    expect(bearerResult.admissionState).toBe("worker-failed")
    expect(bearerResult.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c7Redaction)?.verdict).toBe("fail")
    expect(bearer.content).not.toContain("FAKE-BEARER-TOKEN-FOR-TEST")
    expect(bearerResult.prose).toBeUndefined()

    const control = await tools
      .get("handoff_validate")!
      .execute({ level: "worker", handoff: handoff(), contract: contract() }, toolContext("session-1", "orchestrator"))
    const controlResult = parseResult(control.content)
    expect(controlResult.admissionState).toBe("worker-passed")
    expect(controlResult.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c7Redaction)?.verdict).toBe("pass")
    expect(controlResult.prose).toBeDefined()
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

  test("blocks when required commands have no plugin-observed receipt", async () => {
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
    // Caller-supplied D2 verification remains diagnostic; only an observed
    // receipt can satisfy the orchestrator command check.
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c4Commands)?.verdict).toBe("blocked-unknown")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o3Rerun)?.verdict).toBe("blocked-unknown")
    expect(result.verdict).toBe("blocked-unknown")
    expect(result.admissionState).toBe("blocked-unknown")
    expect(result.limitations.some((limit) => limit.includes("plugin-observed shell receipts"))).toBe(true)
  })

  test("accepts a matching plugin-observed receipt and exact revision", async () => {
    const values = new Map<string, unknown>()
    const now = Date.now()
    values.set(verificationStorageKey("project", "session-1", "receipt-1"), {
      version: 1,
      receiptID: "receipt-1",
      rootSessionID: "session-1",
      sessionID: "session-1",
      agentID: "orchestrator",
      messageID: "message-1",
      commandDigest: verificationCommandDigest("bun test"),
      commandLabel: "bun test",
      status: "pass",
      exitCode: 0,
      startedAt: now - 100,
      completedAt: now,
      repository: { rootDigest: "c".repeat(64), headSha: "a".repeat(40) },
    })
    const tools = collect({ storage: memStorage(values), vcs: vcsReturning([{ file: "src/a.ts" }]) })
    const output = await tools
      .get("handoff_validate")!
      .execute(
        {
          level: "orchestrator",
          handoff: handoff({
            filesChanged: [{ path: "src/a.ts", scope: "edited" }],
            verification: [{ command: "bun test", status: "pass", result: "all good", evidence: ["src/a.ts"] }],
          }),
          contract: contract({ requiredCommands: ["bun test"] }),
          receiptIDs: ["receipt-1"],
          revision: "a".repeat(40),
        },
        toolContext("session-1", "orchestrator"),
      )
    const result = parseResult(output.content)
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.c4Commands)?.verdict).toBe("pass")
    expect(result.checks.find((check) => check.id === HANDOFF_CHECK_IDS.o3Rerun)?.verdict).toBe("pass")
    expect(result.verdict).toBe("pass")
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

/* ------------------------------------------------------------------ */
/* Lead board tools                                                    */
/* ------------------------------------------------------------------ */

const boardLocation = { directory: "/workspace", project: { id: "project" } }
const HEAD_SHA = "a".repeat(40)
const BASE_SHA = "b".repeat(40)

function seedGoal(values: Map<string, unknown>, generation = 10, status = "active"): void {
  values.set(goalStorageKey(boardLocation, "session-1"), {
    version: 1,
    sessionID: "session-1",
    objective: "ship",
    status,
    createdAt: generation,
    updatedAt: generation,
    continuationCount: 0,
  })
}

function boardTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    taskID: "t1",
    title: "task one",
    owner: { sessionID: "session-1", role: "lead" },
    scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/a.ts"], broad: false },
    dependencies: [],
    status: "planned",
    attempt: 1,
    evidence: [],
    lifecycleVersion: 1,
    idempotencyKey: "board-x/t1",
    replay: { kind: "none" },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function seedBoard(values: Map<string, unknown>, overrides: Partial<LeadBoard> = {}): LeadBoard {
  const board: LeadBoard = {
    ...createLeadBoard({ projectID: "project", leadSessionID: "session-1", goalGeneration: 10, objective: "ship", now: 1 }),
    ...overrides,
  }
  values.set(leadBoardStorageKey(boardLocation, "session-1"), JSON.parse(JSON.stringify(board)) as LeadBoard)
  return board
}

function seedReview(values: Map<string, unknown>, overrides: Record<string, unknown> = {}): void {
  const state = (overrides.state as ReviewV2Record["state"] | undefined) ?? "approved"
  values.set(reviewV2StorageKey(boardLocation, "session-1"), {
    version: 2,
    taskId: "t1",
    runId: "r1",
    leadSessionID: "session-1",
    reviewerAgentID: "reviewer",
    ...(state !== "pending" ? { reviewerSessionID: "reviewer-session-1", submittedAt: 2 } : {}),
    ...(state === "approved" ? { checks: { diff: true, scope: true, verification: true } } : {}),
    state,
    round: 1,
    createdAt: 1,
    updatedAt: 2,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    ...overrides,
  })
}

function readStoredBoard(values: Map<string, unknown>): LeadBoard {
  const board = parseLeadBoard(values.get(leadBoardStorageKey(boardLocation, "session-1")))
  expect(board).toBeDefined()
  return board!
}

describe("lead board tools", () => {
  test("rejects a worker agent for the canonical board tools", async () => {
    const tools = collect()
    const worker = toolContext("session-1", "explore")
    for (const name of ["board_get", "board_action"]) {
      await expect(tools.get(name)!.execute({}, worker)).rejects.toThrow(/only to the orchestrator/)
    }
  })

  test("board_get reports missing, unavailable, and a bounded projection without raw receipts", async () => {
    const values = new Map<string, unknown>()
    const tools = collect({ storage: memStorage(values) })
    const missing = JSON.parse((await tools.get("board_get")!.execute({}, toolContext("session-1", "orchestrator"))).content) as Record<string, unknown>
    expect(missing.status).toBe("missing")
    expect((missing.limitations as string[]).join(" ")).toContain("advisory")

    values.set(leadBoardStorageKey(boardLocation, "session-1"), { version: 1, boardID: "x" })
    const unavailable = JSON.parse((await tools.get("board_get")!.execute({}, toolContext("session-1", "orchestrator"))).content) as Record<string, unknown>
    expect(unavailable.status).toBe("unavailable")
    expect(values.get(leadBoardStorageKey(boardLocation, "session-1"))).toEqual({ version: 1, boardID: "x" })

    values.clear()
    seedGoal(values)
    seedBoard(values, { tasks: [boardTask()] as never })
    const ok = JSON.parse((await tools.get("board_get")!.execute({}, toolContext("session-1", "orchestrator"))).content) as {
      status: string
      board: { counts: Record<string, number>; tasks: Array<Record<string, unknown>> }
    }
    expect(ok.status).toBe("ok")
    expect(ok.board.counts.planned).toBe(1)
    expect(ok.board.tasks[0]!.evidence).toBeUndefined()
    expect(ok.board.tasks[0]!.replay).toEqual({ kind: "none" })
  })

  test("board_action init requires a goal, creates once, and replaces only on a new generation", async () => {
    const values = new Map<string, unknown>()
    const tools = collect({ storage: memStorage(values) })
    const orchestrator = toolContext("session-1", "orchestrator")
    const refused = JSON.parse((await tools.get("board_action")!.execute({ action: "init" }, orchestrator)).content) as Record<string, unknown>
    expect(refused.reason).toBe("no-goal")

    seedGoal(values)
    const created = JSON.parse((await tools.get("board_action")!.execute({ action: "init" }, orchestrator)).content) as Record<string, unknown>
    expect(created.status).toBe("created")
    const again = JSON.parse((await tools.get("board_action")!.execute({ action: "init" }, orchestrator)).content) as Record<string, unknown>
    expect(again.status).toBe("exists")

    seedGoal(values, 11)
    const replaced = JSON.parse((await tools.get("board_action")!.execute({ action: "init", goalGeneration: 11 }, orchestrator)).content) as Record<string, unknown>
    expect(replaced.status).toBe("created")
    const stored = readStoredBoard(values)
    expect(stored.goalGeneration).toBe(11)
  })

  test("board_action create-task validates scope, duplicates, dependencies, and the board revision", async () => {
    const values = new Map<string, unknown>()
    seedGoal(values)
    const board = seedBoard(values)
    const tools = collect({ storage: memStorage(values) })
    const orchestrator = toolContext("session-1", "orchestrator")
    const request = {
      action: "create-task",
      expectedBoardRevision: board.boardRevision,
      taskID: "child-1",
      title: "child task",
      ownerSessionID: "child-session",
      ownerRole: "implementer",
      readPaths: ["src/a.ts"],
      writePaths: ["src/b.ts"],
      dependencies: ["root"],
    }
    const created = JSON.parse((await tools.get("board_action")!.execute(request, orchestrator)).content) as Record<string, unknown>
    expect(created.status).toBe("created")
    const stored = readStoredBoard(values)
    expect(stored.tasks).toHaveLength(2)
    expect(stored.tasks[1]!.status).toBe("planned")
    expect(stored.boardRevision).toBe(2)

    const duplicate = JSON.parse(
      (await tools.get("board_action")!.execute({ ...request, expectedBoardRevision: 2 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(duplicate.reason).toBe("invalid-task")
    expect((duplicate.issues as string[]).join(" ")).toContain("duplicate-task-id")

    const badScope = JSON.parse(
      (await tools.get("board_action")!.execute({ ...request, taskID: "child-2", expectedBoardRevision: 2, writePaths: ["/etc"] }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(badScope.reason).toBe("invalid-scope")

    const stale = JSON.parse(
      (await tools.get("board_action")!.execute({ ...request, taskID: "child-3", expectedBoardRevision: 1 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(stale.reason).toBe("version-mismatch")
  })

  test("board_action assign-task bumps versions once and refuses stale versions", async () => {
    const values = new Map<string, unknown>()
    seedBoard(values, { tasks: [boardTask()] as never })
    const tools = collect({ storage: memStorage(values) })
    const orchestrator = toolContext("session-1", "orchestrator")
    const assigned = JSON.parse(
      (await tools
        .get("board_action")!
        .execute({ action: "assign-task", taskID: "t1", expectedVersion: 1, ownerSessionID: "child-2", ownerRole: "reviewer" }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(assigned.status).toBe("assigned")
    const stored = readStoredBoard(values)
    expect(stored.tasks[0]!.owner).toEqual({ sessionID: "child-2", role: "reviewer" })
    expect(stored.tasks[0]!.lifecycleVersion).toBe(2)
    expect(stored.boardRevision).toBe(2)
    const stale = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "assign-task", taskID: "t1", expectedVersion: 1, ownerSessionID: "x", ownerRole: "lead" }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(stale.reason).toBe("version-mismatch")
  })

  test("board_action transition reports evidence, rejects stale versions, foreign actors, and workers", async () => {
    const values = new Map<string, unknown>()
    seedBoard(values, { tasks: [boardTask({ status: "in-progress", lifecycleVersion: 4 })] as never })
    const tools = collect({ storage: memStorage(values) })
    const orchestrator = toolContext("session-1", "orchestrator")
    const missingEvidence = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "transition", intent: "report-task", taskID: "t1", expectedVersion: 4 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(missingEvidence.reason).toBe("missing-evidence")
    const reported = JSON.parse(
      (await tools
        .get("board_action")!
        .execute(
          { action: "transition", intent: "report-task", taskID: "t1", expectedVersion: 4, evidence: [{ kind: "command", reference: "bun test", description: "green" }] },
          orchestrator,
        )).content,
    ) as Record<string, unknown>
    expect(reported.status).toBe("applied")
    expect(readStoredBoard(values).tasks[0]!.status).toBe("awaiting-validation")
    const stale = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "transition", intent: "request-rework", taskID: "t1", expectedVersion: 4 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(stale.reason).toBe("version-mismatch")
    // A foreign session cannot even reach the actor check: the board record is
    // keyed to and identity-verified against the lead session, so a different
    // session reads board-missing/unavailable and is refused.
    const foreign = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "transition", intent: "request-rework", taskID: "t1", expectedVersion: 5 }, toolContext("session-2", "orchestrator"))).content,
    ) as Record<string, unknown>
    expect(foreign.status).toBe("refused")
    expect(["missing", "unavailable"]).toContain(foreign.reason as string)
  })

  test("board_action start-task safely promotes a planned task to ready", async () => {
    const values = new Map<string, unknown>()
    seedBoard(values, { tasks: [boardTask()] as never })
    const tools = collect({ storage: memStorage(values) })
    const orchestrator = toolContext("session-1", "orchestrator")

    const started = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "transition", intent: "start-task", taskID: "t1", expectedVersion: 1 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(started.status).toBe("applied")
    expect((readStoredBoard(values).tasks[0] as { status: string; lifecycleVersion: number })).toMatchObject({ status: "ready", lifecycleVersion: 2 })

    const stale = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "transition", intent: "start-task", taskID: "t1", expectedVersion: 1 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(stale.reason).toBe("version-mismatch")
  })

  test("board_action transition validate runs the unchanged D2 validator and refuses non-pass results", async () => {
    const values = new Map<string, unknown>()
    seedBoard(values, { tasks: [boardTask({ status: "awaiting-validation", lifecycleVersion: 5 })] as never })
    const tools = collect({ storage: memStorage(values), vcs: vcsReturning([{ file: "src/a.ts" }]) })
    const orchestrator = toolContext("session-1", "orchestrator")
    const validateRequest = {
      taskID: "t1",
      expectedVersion: 5,
      action: "transition",
      intent: "validate-task",
      revision: HEAD_SHA,
      handoff: handoff({ taskId: "t1", filesChanged: [{ path: "src/a.ts", scope: "child" }] }),
      contract: contract({ taskId: "t1", writeScope: ["src/a.ts"], requiredCommands: [], reviewRequired: true }),
      checks: [{ id: "scope-review", verdict: "pass" }],
    }
    const failedCheck = JSON.parse(
      (await tools.get("board_action")!.execute({ ...validateRequest, checks: [{ id: "scope-review", verdict: "fail" }] }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(failedCheck.reason).toBe("check-failed")

    const contractMismatch = JSON.parse(
      (await tools.get("board_action")!.execute({ ...validateRequest, contract: contract({ taskId: "other" }) }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(contractMismatch.reason).toBe("contract-mismatch")

    const scopeEscape = JSON.parse(
      (await tools.get("board_action")!.execute({ ...validateRequest, contract: contract({ taskId: "t1", writeScope: ["src/z.ts"] }) }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(scopeEscape.reason).toBe("contract-scope")

    const badRevision = JSON.parse(
      (await tools.get("board_action")!.execute({ ...validateRequest, revision: "abc" }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(badRevision.reason).toBe("invalid-revision")

    // Without VCS truth the validator blocks conservatively and the action refuses.
    const noVcs = collect({ storage: memStorage(values) })
    const blocked = JSON.parse((await noVcs.get("board_action")!.execute(validateRequest, orchestrator)).content) as Record<string, unknown>
    expect(blocked.reason).toBe("validation-failed")

    const applied = JSON.parse((await tools.get("board_action")!.execute(validateRequest, orchestrator)).content) as {
      status: string
      board: { tasks: Array<{ status: string; lifecycleVersion: number; validation?: { checkIDs: string[] } }> }
    }
    expect(applied.status).toBe("applied")
    expect(applied.board.tasks[0]!.status).toBe("awaiting-review")
    expect(applied.board.tasks[0]!.validation!.checkIDs.length).toBeGreaterThan(0)
    expect(readStoredBoard(values).tasks[0]!.validation?.revision).toBe(HEAD_SHA)
  })

  test("board_action transition complete requires an approved exact-revision review and is sticky", async () => {
    const values = new Map<string, unknown>()
    seedBoard(values, {
      tasks: [
        boardTask({
          status: "awaiting-review",
          lifecycleVersion: 6,
          validation: { actorSessionID: "session-1", validatedAt: 3, revision: HEAD_SHA, checkIDs: ["c1-structure:pass"], receiptIDs: [] },
        }),
      ] as never,
    })
    const tools = collect({ storage: memStorage(values) })
    const orchestrator = toolContext("session-1", "orchestrator")
    const noReview = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "transition", intent: "complete", taskID: "t1", expectedVersion: 6 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(noReview.reason).toBeDefined()

    seedReview(values, { state: "changes-requested" })
    const notApproved = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "transition", intent: "complete", taskID: "t1", expectedVersion: 6 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(notApproved.reason).toBe("not-approved")

    seedReview(values, { headSha: "c".repeat(40) })
    const mismatch = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "transition", intent: "complete", taskID: "t1", expectedVersion: 6 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(mismatch.reason).toBe("revision-mismatch")

    seedReview(values)
    const completed = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "transition", intent: "complete", taskID: "t1", expectedVersion: 6 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(completed.status).toBe("applied")
    const stored = readStoredBoard(values)
    expect(stored.tasks[0]!.status).toBe("completed")
    expect(stored.tasks[0]!.review?.revision).toBe(HEAD_SHA)
    const sticky = JSON.parse(
      (await tools.get("board_action")!.execute({ action: "transition", intent: "requeue-task", taskID: "t1", expectedVersion: 7 }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(sticky.status).toBe("refused")
  })

  test("board_action complete requires all tasks completed, the aggregate verification, the exact review, and an unchanged goal", async () => {
    const values = new Map<string, unknown>()
    seedGoal(values)
    seedReview(values)
    const board = seedBoard(values)
    const tools = collect({ storage: memStorage(values), vcs: vcsReturning([]) })
    const orchestrator = toolContext("session-1", "orchestrator")
    const request = {
      action: "complete",
      expectedBoardRevision: board.boardRevision,
      revision: HEAD_SHA,
      handoff: handoff({ taskId: board.boardID, outcome: "aggregate verified" }),
      contract: contract({ taskId: board.boardID, writeScope: [], requiredCommands: [], reviewRequired: true }),
      checks: [],
    }
    const incomplete = JSON.parse((await tools.get("board_action")!.execute(request, orchestrator)).content) as Record<string, unknown>
    expect(incomplete.reason).toBe("board-incomplete")

    seedBoard(values, {
      tasks: [
        boardTask({
          status: "completed",
          validation: { actorSessionID: "session-1", validatedAt: 3, revision: HEAD_SHA, checkIDs: ["c1-structure:pass"], receiptIDs: [] },
          review: {
            reference: "review/v2/t1/r1",
            revision: HEAD_SHA,
            baseRevision: BASE_SHA,
            approvedAt: 4,
            reviewVersion: 2,
          },
        }),
      ] as never,
    })
    const contractMismatch = JSON.parse(
      (await tools.get("board_action")!.execute({ ...request, contract: contract({ taskId: "other", writeScope: [], requiredCommands: [], reviewRequired: true }) }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(contractMismatch.reason).toBe("contract-mismatch")

    // Goal identity change (a replaced generation) cancels the completion.
    seedGoal(values, 11)
    const identityChanged = JSON.parse((await tools.get("board_action")!.execute(request, orchestrator)).content) as Record<string, unknown>
    expect(identityChanged.reason).toBe("goal-identity-changed")

    // Restore the matching generation and complete under the lock.
    seedGoal(values, 10)
    const completed = JSON.parse((await tools.get("board_action")!.execute(request, orchestrator)).content) as Record<string, unknown>
    expect(completed.status).toBe("complete")
    const stored = readStoredBoard(values)
    expect(stored.status).toBe("complete")
    expect(stored.completion?.revision).toBe(HEAD_SHA)
    const goal = values.get(goalStorageKey(boardLocation, "session-1")) as { status: string; completionEvidence?: string }
    expect(goal.status).toBe("complete")
    expect(goal.completionEvidence).toContain(stored.boardID)

    // A paused goal also cancels before any write.
    const pausedValues = new Map<string, unknown>()
    seedGoal(pausedValues, 10, "paused")
    seedReview(pausedValues)
    const pausedBoard = seedBoard(pausedValues, {
      tasks: [
        boardTask({
          status: "completed",
          validation: { actorSessionID: "session-1", validatedAt: 3, revision: HEAD_SHA, checkIDs: ["c1-structure:pass"], receiptIDs: [] },
          review: {
            reference: "review/v2/t1/r1",
            revision: HEAD_SHA,
            baseRevision: BASE_SHA,
            approvedAt: 4,
            reviewVersion: 2,
          },
        }),
      ] as never,
    })
    const pausedTools = collect({ storage: memStorage(pausedValues), vcs: vcsReturning([]) })
    const paused = JSON.parse(
      (await pausedTools.get("board_action")!.execute({ ...request, expectedBoardRevision: pausedBoard.boardRevision }, orchestrator)).content,
    ) as Record<string, unknown>
    expect(paused.reason).toBe("goal-identity-changed")
    expect(readStoredBoard(pausedValues).status).toBe("active")
  })
})
