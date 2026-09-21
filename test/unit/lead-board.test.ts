import { describe, expect, test } from "bun:test"
import { D2_HANDOFF_SCHEMA, D2_REQUIRED_KEYS, D2_REVIEW_STATES } from "../../src/core/contracts.js"
import type { LocationLike, StorageLike } from "../../src/opencode-v2/goal/state.js"
import {
  LEAD_BOARD_ID_MAX_LENGTH,
  LEAD_BOARD_ID_PATTERN,
  LEAD_BOARD_MAX_COMPLETION_EVIDENCE,
  LEAD_BOARD_MAX_TASKS,
  LEAD_CURSOR_MAX_LENGTH,
  LEAD_MAX_CHECK_IDS,
  LEAD_REF_MAX_LENGTH,
  LEAD_TASK_MAX_DEPENDENCIES,
  LEAD_TASK_MAX_EVIDENCE,
  LEAD_TASK_MAX_READ_PATHS,
  LEAD_TASK_MAX_WRITE_PATHS,
  LEAD_TITLE_MAX_LENGTH,
  assignLeadTaskOwner,
  boardCompletionEligible,
  boundedBoardText,
  boundedEvidenceList,
  completeLeadBoard,
  createLeadBoard,
  createLeadTask,
  hydrateLeadBoard,
  leadBoardID,
  leadBoardStorageKey,
  leadTaskIdempotencyKey,
  leadTaskPacketText,
  leadTaskStepIdempotencyKey,
  normalizeEvidenceRef,
  normalizeScopePacket,
  parseLeadBoard,
  parseReplayDescriptor,
  pauseLeadBoard,
  reconcileLeadBoard,
  releaseLeadReservation,
  removeLeadBoard,
  reserveNextLeadTask,
  resumeLeadBoard,
  scopesConflict,
  transitionLeadTask,
  validateTaskGraph,
  verifyLeadBoard,
  writeLeadBoard,
  type EvidenceRef,
  type LeadBoard,
  type LeadStepObservation,
  type LeadTask,
} from "../../src/opencode-v2/orchestration/lead-board.js"

const location: LocationLike = { directory: "/workspace", project: { id: "project" } }

function memStorage(values = new Map<string, unknown>()): StorageLike & { values: Map<string, unknown> } {
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  }
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function baseBoard(overrides: Partial<LeadBoard> = {}): LeadBoard {
  const board = createLeadBoard({
    projectID: "project",
    leadSessionID: "lead",
    goalGeneration: 100,
    objective: "ship the slice",
    now: 1,
  })
  return { ...board, ...overrides }
}

function task(overrides: Partial<LeadTask> = {}): LeadTask {
  return {
    version: 1,
    taskID: "t1",
    title: "task one",
    owner: { sessionID: "lead", role: "lead" },
    scope: { version: 1, root: "project", readPaths: [], writePaths: [], broad: false },
    dependencies: [],
    status: "planned",
    attempt: 1,
    evidence: [],
    lifecycleVersion: 1,
    idempotencyKey: "board-1/t1",
    replay: { kind: "none" },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function evidence(overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  return { kind: "command", reference: "bun test", description: "suite passed", observedAt: 5, ...overrides }
}

describe("lead board schema accept/reject matrix", () => {
  test("accepts a freshly created board and every lifecycle status", () => {
    const board = baseBoard()
    expect(parseLeadBoard(plain(board))).toEqual(board)
    const statuses = [
      "planned",
      "ready",
      "reserved",
      "in-progress",
      "awaiting-validation",
      "awaiting-review",
      "changes-requested",
      "ambiguous",
      "failed",
      "blocked",
      "completed",
    ] as const
    for (const status of statuses) {
      const candidate = baseBoard({ tasks: [task({ status })] })
      expect(parseLeadBoard(plain(candidate))?.tasks[0]?.status).toBe(status)
    }
  })

  test("rejects unknown keys at every object depth", () => {
    expect(parseLeadBoard(plain({ ...baseBoard(), extra: 1 }))).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ tasks: [{ ...task(), extra: true } as unknown as LeadTask] })))).toBeUndefined()
    expect(
      parseLeadBoard(plain(baseBoard({ tasks: [task({ scope: { ...task().scope, extra: 1 } as never })] }))),
    ).toBeUndefined()
    expect(
      parseLeadBoard(plain(baseBoard({ tasks: [task({ owner: { ...task().owner, extra: 1 } as never })] }))),
    ).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ tasks: [task({ replay: { kind: "none", extra: 1 } as never })] })))).toBeUndefined()
  })

  test("rejects wrong literals, missing fields, and out-of-enum values", () => {
    expect(parseLeadBoard(plain({ ...baseBoard(), version: 2 }))).toBeUndefined()
    expect(parseLeadBoard(plain({ ...baseBoard(), status: "running" }))).toBeUndefined()
    expect(parseLeadBoard(plain({ ...baseBoard(), tasks: [task({ version: 2 } as unknown as Partial<LeadTask>)] }))).toBeUndefined()
    expect(parseLeadBoard(plain({ ...baseBoard(), tasks: [task({ status: "done" } as unknown as Partial<LeadTask>)] }))).toBeUndefined()
    expect(
      parseLeadBoard(
        plain({ ...baseBoard(), tasks: [task({ owner: { sessionID: "lead", role: "manager" } } as unknown as Partial<LeadTask>)] }),
      ),
    ).toBeUndefined()
    const { objective: _objective, ...missing } = baseBoard()
    expect(parseLeadBoard(plain(missing))).toBeUndefined()
  })

  test("rejects invalid task ids, dangling replays, and bad timestamps", () => {
    expect(parseLeadBoard(plain(baseBoard({ tasks: [task({ taskID: "Bad ID" })] })))).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ tasks: [task({ taskID: `a${"b".repeat(128)}` })] })))).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ tasks: [task({ replay: { kind: "github-pr-merge", repository: "o/r", prNumber: 1 } as never })] })))).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ tasks: [task({ createdAt: -1 })] })))).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ tasks: [task({ createdAt: Number.NaN })] })))).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ tasks: [task({ attempt: 0 })] })))).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ tasks: [task({ lifecycleVersion: 0 })] })))).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ boardRevision: 0 })))).toBeUndefined()
  })

  test("enforces every exported bound", () => {
    const many = Array.from({ length: LEAD_BOARD_MAX_TASKS + 1 }, (_, index) =>
      task({ taskID: `t${index}`, idempotencyKey: `k${index}` }),
    )
    expect(parseLeadBoard(plain(baseBoard({ tasks: many })))).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ objective: "x".repeat(1001) })))).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ tasks: [task({ title: "x".repeat(LEAD_TITLE_MAX_LENGTH + 1) })] })))).toBeUndefined()
    expect(
      parseLeadBoard(plain(baseBoard({ tasks: [task({ dependencies: Array.from({ length: LEAD_TASK_MAX_DEPENDENCIES + 1 }, (_, i) => `d${i}`) })] }))),
    ).toBeUndefined()
    expect(
      parseLeadBoard(
        plain(
          baseBoard({
            tasks: [
              task({
                scope: {
                  version: 1,
                  root: "project",
                  readPaths: Array.from({ length: LEAD_TASK_MAX_READ_PATHS + 1 }, (_, i) => `r${i}`),
                  writePaths: [],
                  broad: false,
                },
              }),
            ],
          }),
        ),
      ),
    ).toBeUndefined()
    expect(
      parseLeadBoard(
        plain(
          baseBoard({
            tasks: [
              task({
                scope: {
                  version: 1,
                  root: "project",
                  readPaths: [],
                  writePaths: Array.from({ length: LEAD_TASK_MAX_WRITE_PATHS + 1 }, (_, i) => `w${i}`),
                  broad: false,
                },
              }),
            ],
          }),
        ),
      ),
    ).toBeUndefined()
    expect(
      parseLeadBoard(plain(baseBoard({ tasks: [task({ evidence: Array.from({ length: LEAD_TASK_MAX_EVIDENCE + 1 }, (_, i) => evidence({ reference: `c${i}` })) })] }))),
    ).toBeUndefined()
    expect(parseLeadBoard(plain(baseBoard({ tasks: [task({ cursor: "c".repeat(LEAD_CURSOR_MAX_LENGTH + 1) })] })))).toBeUndefined()
    expect(
      parseLeadBoard(plain(baseBoard({ tasks: [task({ validation: { leadSessionID: "lead", validatedAt: 1, revision: "a".repeat(40), checkIDs: Array.from({ length: LEAD_MAX_CHECK_IDS + 1 }, () => "c1:pass") } })] }))),
    ).toBeUndefined()
    expect(
      parseLeadBoard(plain(baseBoard({ completion: { leadSessionID: "lead", validatedAt: 1, revision: "r", reviewReference: "ref", evidence: [] } }))),
    ).not.toBeUndefined()
  })

  test("scope paths reject duplicates, absolute paths, traversal, and empty segments", () => {
    expect(normalizeScopePacket({ readPaths: ["src/a", "src/a"] }).ok).toBe(false)
    expect(normalizeScopePacket({ writePaths: ["/etc"] }).ok).toBe(false)
    expect(normalizeScopePacket({ writePaths: ["../x"] }).ok).toBe(false)
    expect(normalizeScopePacket({ writePaths: ["a//b"] }).ok).toBe(false)
    expect(normalizeScopePacket({ writePaths: ["a/./b"] }).ok).toBe(false)
    expect(normalizeScopePacket({ writePaths: [""] }).ok).toBe(false)
    const normalized = normalizeScopePacket({ readPaths: ["src/a/"], writePaths: ["src\\b"] })
    expect(normalized.ok && normalized.packet.readPaths).toEqual(["src/a"])
    expect(normalized.ok && normalized.packet.writePaths).toEqual(["src/b"])
  })

  test("evidence refs are redacted, bounded, and kind-checked", () => {
    const token = "ghp_" + "a".repeat(30)
    const ref = normalizeEvidenceRef({ kind: "command", reference: `run with ${token}`, description: "line one\nline two", observedAt: 1 })
    expect(ref?.reference).toContain("[redacted]")
    expect(ref?.reference).not.toContain("ghp_")
    expect(ref?.description).toBe("line one line two")
    expect(normalizeEvidenceRef({ kind: "url", reference: "http://x.test", description: "x", observedAt: 1 })).toBeUndefined()
    expect(normalizeEvidenceRef({ kind: "url", reference: "https://x.test", description: "x", observedAt: 1 })?.reference).toBe("https://x.test")
    expect(normalizeEvidenceRef({ kind: "file", reference: "../escape", description: "x", observedAt: 1 })).toBeUndefined()
    expect(normalizeEvidenceRef({ kind: "file", reference: "src/a.ts", description: "x", observedAt: 1 })?.kind).toBe("file")
    expect(normalizeEvidenceRef({ kind: "review", reference: "", description: "x", observedAt: 1 })).toBeUndefined()
    expect(normalizeEvidenceRef({ kind: "receipt", reference: "ref", description: "x", observedAt: -1 })).toBeUndefined()
    const long = normalizeEvidenceRef({ kind: "command", reference: "x".repeat(900), description: "y".repeat(900), observedAt: 1 })
    expect(long!.reference.length).toBeLessThanOrEqual(LEAD_REF_MAX_LENGTH)
    expect(long!.description.length).toBeLessThanOrEqual(LEAD_REF_MAX_LENGTH)
  })

  test("boundedBoardText redacts secrets, collapses whitespace, and truncates with an ellipsis", () => {
    const value = boundedBoardText(`token=${"ghp_" + "b".repeat(30)}\n\n  spaced   out`, 200)
    expect(value).toContain("[redacted]")
    expect(value).not.toContain("ghp_")
    expect(value).not.toContain("\n")
    expect(value).toContain("spaced out")
    const truncated = boundedBoardText("x".repeat(100), 10)
    expect(truncated.length).toBe(10)
    expect(truncated.endsWith("…")).toBe(true)
    expect(boundedEvidenceList([evidence(), evidence(), evidence()], 2)).toHaveLength(2)
  })
})

describe("lead board redaction and bounds freeze", () => {
  test("board builders redact secret shapes and bound stored text before any write", () => {
    const token = "ghp_" + "z".repeat(30)
    const board = createLeadBoard({
      projectID: "project",
      leadSessionID: "lead",
      goalGeneration: 1,
      objective: `ship ${token}\n\nacross lines ${"x".repeat(2000)}`,
      now: 1,
    })
    expect(board.objective).not.toContain("ghp_")
    expect(board.objective).toContain("[redacted]")
    expect(board.objective).not.toContain("\n")
    expect(board.objective.length).toBeLessThanOrEqual(1000)
    expect(board.tasks[0]!.title.length).toBeLessThanOrEqual(LEAD_TITLE_MAX_LENGTH)

    const scope = normalizeScopePacket({ writePaths: ["src/a"] })
    const created = createLeadTask(board, {
      taskID: "child",
      title: `Authorization: Bearer ${token}`,
      owner: { sessionID: "lead", role: "lead" },
      scope,
    })
    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.task.title).not.toContain("Bearer")
      expect(created.task.title).toContain("[redacted]")
    }
  })
})

describe("lead board identity and keys", () => {
  test("board id is deterministic per project/session/goal generation and never aliases a new generation", () => {
    const first = leadBoardID("project", "lead", 100)
    expect(first).toBe(leadBoardID("project", "lead", 100))
    expect(first).not.toBe(leadBoardID("project", "lead", 101))
    expect(first).not.toBe(leadBoardID("project", "other", 100))
    expect(first).not.toBe(leadBoardID("other", "lead", 100))
    expect(first.length).toBeLessThanOrEqual(LEAD_BOARD_ID_MAX_LENGTH)
    expect(LEAD_BOARD_ID_PATTERN.test(first)).toBe(true)
  })

  test("re-created boards for the same generation keep stable ids and keys; a new generation does not", () => {
    const first = createLeadBoard({ projectID: "project", leadSessionID: "lead", goalGeneration: 100, objective: "a", now: 1 })
    const second = createLeadBoard({ projectID: "project", leadSessionID: "lead", goalGeneration: 100, objective: "different", now: 2 })
    expect(second.boardID).toBe(first.boardID)
    expect(second.tasks[0]!.idempotencyKey).toBe(first.tasks[0]!.idempotencyKey)
    expect(second.tasks[0]!.taskID).toBe("root")
    const replaced = createLeadBoard({ projectID: "project", leadSessionID: "lead", goalGeneration: 101, objective: "a", now: 3 })
    expect(replaced.boardID).not.toBe(first.boardID)
    expect(replaced.tasks[0]!.idempotencyKey).not.toBe(first.tasks[0]!.idempotencyKey)
  })

  test("storage keys are project/session scoped and step keys are exact-inverse stable", () => {
    expect(leadBoardStorageKey(location, "lead")).toBe("lead-board/v1/project/lead")
    expect(leadBoardStorageKey(location, "lead")).not.toBe(leadBoardStorageKey(location, "other"))
    expect(leadTaskIdempotencyKey("board-1", "t1")).toBe("board-1/t1")
    expect(leadTaskStepIdempotencyKey("board-1", "t1", 2)).toBe("lead/board-1/t1/2")
  })

  test("the packet renders the stored (post-normalization) values with a none fallback", () => {
    const packet = leadTaskPacketText(
      task({
        taskID: "t1",
        lifecycleVersion: 4,
        attempt: 2,
        scope: { version: 1, root: "project", readPaths: ["src/a"], writePaths: ["src/b"], broad: false },
        dependencies: ["root"],
        cursor: "c-1",
      }),
    )
    expect(packet).toContain("Task: t1 at lifecycle version 4")
    expect(packet).toContain("Owner: lead/lead")
    expect(packet).toContain("Read scope: src/a")
    expect(packet).toContain("Write scope: src/b")
    expect(packet).toContain("Dependencies: root")
    expect(packet).toContain("Attempt: 2")
    expect(packet).toContain("Cursor: c-1")
    const empty = leadTaskPacketText(task({ taskID: "t2" }))
    expect(empty).toContain("Read scope: (none)")
    expect(empty).toContain("Dependencies: (none)")
    expect(empty).toContain("Cursor: none")
  })
})

describe("lead board DAG validation", () => {
  test("reports duplicates, missing dependencies, self-dependencies, and cycles deterministically", () => {
    const duplicated = [task({ taskID: "a" }), task({ taskID: "a" })]
    expect(validateTaskGraph(duplicated)).toContain("duplicate-task-id:a")
    const missing = [task({ taskID: "a", dependencies: ["ghost"] })]
    expect(validateTaskGraph(missing)).toContain("missing-dependency:a->ghost")
    const self = [task({ taskID: "a", dependencies: ["a"] })]
    expect(validateTaskGraph(self)).toContain("self-dependency:a")
    const cycle = [task({ taskID: "a", dependencies: ["b"] }), task({ taskID: "b", dependencies: ["a"] })]
    expect(validateTaskGraph(cycle).some((issue) => issue.startsWith("cycle:"))).toBe(true)
    expect(validateTaskGraph([task({ taskID: "a" })])).toEqual([])
  })

  test("verifyLeadBoard catches foreign identity, board id, and generation mismatches", () => {
    const board = baseBoard()
    expect(verifyLeadBoard(board, { projectID: "project", leadSessionID: "lead", boardID: board.boardID })).toEqual([])
    expect(verifyLeadBoard(board, { projectID: "other" })).toContain("project-mismatch")
    expect(verifyLeadBoard(board, { leadSessionID: "other" })).toContain("session-mismatch")
    expect(verifyLeadBoard(board, { boardID: "board-other" })).toContain("board-id-mismatch")
    expect(verifyLeadBoard(board, { goalGeneration: 999 })).toContain("goal-generation-mismatch")
  })

  test("createLeadTask rejects invalid ids, duplicate ids, unknown dependencies, and scope failures", () => {
    const board = baseBoard({ tasks: [task({ taskID: "root", status: "completed" })] })
    const validScope = normalizeScopePacket({ writePaths: ["src/a"] })
    expect(createLeadTask(board, { taskID: "child", title: "child", owner: { sessionID: "lead", role: "implementer" }, scope: validScope }).ok).toBe(true)
    expect(createLeadTask(board, { taskID: "root", title: "dup", owner: { sessionID: "lead", role: "lead" }, scope: validScope }).ok).toBe(false)
    expect(createLeadTask(board, { taskID: "Bad", title: "x", owner: { sessionID: "lead", role: "lead" }, scope: validScope }).ok).toBe(false)
    expect(createLeadTask(board, { taskID: "child", title: "", owner: { sessionID: "lead", role: "lead" }, scope: validScope }).ok).toBe(false)
    expect(
      createLeadTask(board, { taskID: "child", title: "x", owner: { sessionID: "lead", role: "lead" }, scope: validScope, dependencies: ["ghost"] }).ok,
    ).toBe(false)
    expect(
      createLeadTask(board, { taskID: "child", title: "x", owner: { sessionID: "lead", role: "lead" }, scope: normalizeScopePacket({}) }).ok,
    ).toBe(true)
    const emptyScope = normalizeScopePacket({})
    expect(emptyScope.ok && emptyScope.packet.broad).toBe(true)
  })
})

describe("lead board scope overlap", () => {
  const scope = (input: Parameters<typeof normalizeScopePacket>[0]) => {
    const normalized = normalizeScopePacket(input)
    if (!normalized.ok) throw new Error(normalized.reason)
    return normalized.packet
  }

  test("overlap is segment-boundary: equal or ancestor, never a bare prefix", () => {
    expect(scopesConflict(scope({ writePaths: ["src/a"] }), scope({ writePaths: ["src/a"] }))).toBe(true)
    expect(scopesConflict(scope({ writePaths: ["src/a"] }), scope({ writePaths: ["src/a/b"] }))).toBe(true)
    expect(scopesConflict(scope({ writePaths: ["src/a/b"] }), scope({ writePaths: ["src/a"] }))).toBe(true)
    expect(scopesConflict(scope({ writePaths: ["src/a"] }), scope({ writePaths: ["src/ab"] }))).toBe(false)
  })

  test("write/write and write/read overlap conflict; read/read may proceed", () => {
    expect(scopesConflict(scope({ writePaths: ["src/a"] }), scope({ readPaths: ["src/a"] }))).toBe(true)
    expect(scopesConflict(scope({ readPaths: ["src/a"] }), scope({ writePaths: ["src/a/b"] }))).toBe(true)
    expect(scopesConflict(scope({ readPaths: ["src/a"] }), scope({ readPaths: ["src/a/b"] }))).toBe(false)
  })

  test("broad (or a '.' path) conflicts with every active write; unknown is conservative", () => {
    expect(scopesConflict(scope({ broad: true }), scope({ writePaths: ["anything"] }))).toBe(true)
    expect(scopesConflict(scope({ readPaths: ["."] }), scope({ writePaths: ["anything"] }))).toBe(true)
    expect(scope({}).broad).toBe(true)
    expect(scopesConflict(scope({}), scope({ readPaths: ["anything"] }))).toBe(true)
    expect(scope({ readPaths: ["."] }).broad).toBe(true)
  })
})

describe("lead board transitions", () => {
  test("applies the full happy path with one version bump per transition", () => {
    let board = baseBoard({ tasks: [task()] })
    const step = (action: Parameters<typeof transitionLeadTask>[0]["action"], extra: Partial<Parameters<typeof transitionLeadTask>[0]> = {}) => {
      const result = transitionLeadTask({
        board,
        taskID: "t1",
        expectedVersion: board.tasks[0]!.lifecycleVersion,
        actorSessionID: "lead",
        action,
        ...extra,
      })
      expect(result.ok).toBe(true)
      if (result.ok) board = result.board
      return result
    }
    expect(step("ready").ok).toBe(true)
    expect(step("reserve", { stepIndex: 3 }).ok).toBe(true)
    expect(board.tasks[0]!.stepIndex).toBe(3)
    expect(step("deliver").ok).toBe(true)
    expect(step("report", { evidence: [evidence()] }).ok).toBe(true)
    expect(step("validate", { validation: { leadSessionID: "lead", validatedAt: 9, revision: "a".repeat(40), checkIDs: ["c1:pass"] } }).ok).toBe(true)
    expect(step("complete", { review: { reference: "review/1/1", revision: "a".repeat(40), approvedAt: 9 } }).ok).toBe(true)
    expect(board.tasks[0]!.status).toBe("completed")
    expect(board.tasks[0]!.lifecycleVersion).toBe(7)
    expect(board.boardRevision).toBe(7)
    // Completed is sticky.
    const sticky = transitionLeadTask({ board, taskID: "t1", expectedVersion: 7, actorSessionID: "lead", action: "requeue" })
    expect(sticky.ok).toBe(false)
    if (!sticky.ok) expect(sticky.reason).toBe("invalid-transition")
  })

  test("refuses actor mismatch, missing tasks, and stale versions without writing", () => {
    const board = baseBoard({ tasks: [task()] })
    expect(transitionLeadTask({ board, taskID: "t1", expectedVersion: 1, actorSessionID: "worker", action: "ready" })).toMatchObject({
      ok: false,
      reason: "actor-mismatch",
    })
    expect(transitionLeadTask({ board, taskID: "ghost", expectedVersion: 1, actorSessionID: "lead", action: "ready" })).toMatchObject({
      ok: false,
      reason: "task-missing",
    })
    expect(transitionLeadTask({ board, taskID: "t1", expectedVersion: 2, actorSessionID: "lead", action: "ready" })).toMatchObject({
      ok: false,
      reason: "version-mismatch",
    })
    expect(board.tasks[0]!.status).toBe("planned")
  })

  test("dependencies must be completed before ready/reserve/requeue", () => {
    const board = baseBoard({
      tasks: [task({ taskID: "dep", status: "in-progress" }), task({ taskID: "t1", dependencies: ["dep"], lifecycleVersion: 3 })],
    })
    const result = transitionLeadTask({ board, taskID: "t1", expectedVersion: 3, actorSessionID: "lead", action: "ready" })
    expect(result).toMatchObject({ ok: false, reason: "dependencies-unmet" })
    const completedDep = baseBoard({ tasks: [task({ taskID: "dep", status: "completed" }), task({ taskID: "t1", dependencies: ["dep"] })] })
    expect(
      transitionLeadTask({ board: completedDep, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "ready" }).ok,
    ).toBe(true)
  })

  test("reserve refuses a scope conflict and leaves the task ready; read/read and disjoint writes proceed", () => {
    const conflicting = baseBoard({
      tasks: [
        task({ taskID: "active", status: "in-progress", scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/a"], broad: false } }),
        task({ taskID: "t1", status: "ready", scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/a/b"], broad: false } }),
      ],
    })
    const refused = transitionLeadTask({ board: conflicting, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "reserve", stepIndex: 1 })
    expect(refused).toMatchObject({ ok: false, reason: "scope-conflict" })
    expect(conflicting.tasks[1]!.status).toBe("ready")

    const disjoint = baseBoard({
      tasks: [
        task({ taskID: "active", status: "in-progress", scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/a"], broad: false } }),
        task({ taskID: "t1", status: "ready", scope: { version: 1, root: "project", readPaths: ["src/a"], writePaths: ["src/b"], broad: false } }),
      ],
    })
    // write/read overlap still conflicts; a purely read candidate on the same
    // path is fine only when the active task does not write it.
    expect(
      transitionLeadTask({ board: disjoint, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "reserve", stepIndex: 1 }),
    ).toMatchObject({ ok: false, reason: "scope-conflict" })

    const readOnly = baseBoard({
      tasks: [
        task({ taskID: "active", status: "in-progress", scope: { version: 1, root: "project", readPaths: ["src/a"], writePaths: [], broad: false } }),
        task({ taskID: "t1", status: "ready", scope: { version: 1, root: "project", readPaths: ["src/a"], writePaths: [], broad: false } }),
      ],
    })
    expect(
      transitionLeadTask({ board: readOnly, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "reserve", stepIndex: 1 }).ok,
    ).toBe(true)
  })

  test("report/fail/ambiguous require bounded evidence or a reason", () => {
    const inProgress = baseBoard({ tasks: [task({ status: "in-progress" })] })
    expect(transitionLeadTask({ board: inProgress, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "report" })).toMatchObject({
      ok: false,
      reason: "missing-evidence",
    })
    expect(
      transitionLeadTask({ board: inProgress, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "report", evidence: [evidence()] }).ok,
    ).toBe(true)
    expect(transitionLeadTask({ board: inProgress, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "ambiguous" })).toMatchObject({
      ok: false,
      reason: "missing-evidence",
    })
    const ambiguous = transitionLeadTask({ board: inProgress, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "ambiguous", note: "response lost" })
    expect(ambiguous.ok).toBe(true)
    if (ambiguous.ok) {
      expect(ambiguous.task.status).toBe("ambiguous")
      expect(ambiguous.task.evidence[0]!.description).toBe("response lost")
    }
  })

  test("validate requires bounded check results; complete requires validation and a matching review revision", () => {
    const awaitingValidation = baseBoard({ tasks: [task({ status: "awaiting-validation" })] })
    expect(transitionLeadTask({ board: awaitingValidation, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "validate" })).toMatchObject({
      ok: false,
      reason: "missing-validation",
    })
    const validated = transitionLeadTask({
      board: awaitingValidation,
      taskID: "t1",
      expectedVersion: 1,
      actorSessionID: "lead",
      action: "validate",
      validation: { leadSessionID: "lead", validatedAt: 1, revision: "a".repeat(40), checkIDs: ["c1:pass"] },
    })
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    expect(validated.task.status).toBe("awaiting-review")
    expect(validated.task.validation?.leadSessionID).toBe("lead")
    const awaitingReview = validated.board
    expect(transitionLeadTask({ board: awaitingReview, taskID: "t1", expectedVersion: 2, actorSessionID: "lead", action: "complete" })).toMatchObject({
      ok: false,
      reason: "missing-review",
    })
    expect(
      transitionLeadTask({
        board: awaitingReview,
        taskID: "t1",
        expectedVersion: 2,
        actorSessionID: "lead",
        action: "complete",
        review: { reference: "review/1/1", revision: "b".repeat(40), approvedAt: 1 },
      }),
    ).toMatchObject({ ok: false, reason: "review-mismatch" })
    const completed = transitionLeadTask({
      board: awaitingReview,
      taskID: "t1",
      expectedVersion: 2,
      actorSessionID: "lead",
      action: "complete",
      review: { reference: "review/1/1", revision: "a".repeat(40), approvedAt: 1 },
    })
    expect(completed.ok).toBe(true)
  })

  test("requeue bumps the attempt once; reconcile from ambiguous never bumps the attempt", () => {
    const failed = baseBoard({ tasks: [task({ status: "failed", attempt: 2 })] })
    const requeued = transitionLeadTask({ board: failed, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "requeue" })
    expect(requeued.ok).toBe(true)
    if (requeued.ok) {
      expect(requeued.task.status).toBe("ready")
      expect(requeued.task.attempt).toBe(3)
    }
    const ambiguous = baseBoard({ tasks: [task({ status: "ambiguous", attempt: 2 })] })
    const reconciled = transitionLeadTask({
      board: ambiguous,
      taskID: "t1",
      expectedVersion: 1,
      actorSessionID: "lead",
      action: "reconcile",
      evidence: [evidence()],
    })
    expect(reconciled.ok).toBe(true)
    if (reconciled.ok) {
      expect(reconciled.task.status).toBe("ready")
      expect(reconciled.task.attempt).toBe(2)
    }
  })

  test("board status gates transitions: paused refuses, complete is immutable, record-replay allowed while paused", () => {
    const paused = pauseLeadBoard(baseBoard({ tasks: [task({ status: "in-progress" })] }), 5)
    expect(paused.status).toBe("paused")
    expect(transitionLeadTask({ board: paused, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "report", evidence: [evidence()] })).toMatchObject({
      ok: false,
      reason: "board-not-active",
    })
    const replay = parseReplayDescriptor({
      kind: "github-pr-create",
      repository: "o/r",
      headRef: "feat",
      baseRef: "main",
      expectedHeadSHA: "a".repeat(40),
      expectedBaseSHA: "b".repeat(40),
    })
    expect(replay).toBeDefined()
    expect(
      transitionLeadTask({ board: paused, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", action: "record-replay", replay }).ok,
    ).toBe(true)
    const resumed = resumeLeadBoard(paused, 6)
    expect(resumed.status).toBe("active")
    const complete = completeLeadBoard(baseBoard(), { revision: "a".repeat(40), reviewReference: "review/1/1" }, 7)
    expect(complete.status).toBe("complete")
    expect(transitionLeadTask({ board: complete, taskID: "root", expectedVersion: 1, actorSessionID: "lead", action: "ready" })).toMatchObject({
      ok: false,
      reason: "board-complete",
    })
  })

  test("assign bumps versions once and refuses completed tasks and stale versions", () => {
    const board = baseBoard({ tasks: [task()] })
    const assigned = assignLeadTaskOwner({
      board,
      taskID: "t1",
      expectedVersion: 1,
      actorSessionID: "lead",
      owner: { sessionID: "child-1", role: "implementer" },
      now: 3,
    })
    expect(assigned.ok).toBe(true)
    if (assigned.ok) {
      expect(assigned.task.owner).toEqual({ sessionID: "child-1", role: "implementer" })
      expect(assigned.task.lifecycleVersion).toBe(2)
      expect(assigned.board.boardRevision).toBe(2)
    }
    const completed = baseBoard({ tasks: [task({ status: "completed" })] })
    expect(
      assignLeadTaskOwner({ board: completed, taskID: "t1", expectedVersion: 1, actorSessionID: "lead", owner: { sessionID: "x", role: "lead" } }),
    ).toMatchObject({ ok: false, reason: "invalid-transition" })
  })
})

describe("lead board reservation + release", () => {
  test("promotes planned tasks and reserves the first conflict-free ready task deterministically", () => {
    const board = baseBoard({
      tasks: [
        task({ taskID: "a", status: "in-progress", scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/x"], broad: false } }),
        task({ taskID: "b", scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/x"], broad: false } }),
        task({ taskID: "c", scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/y"], broad: false } }),
      ],
    })
    const result = reserveNextLeadTask(board, { stepIndex: 4, now: 9 })
    expect(result.reservation?.taskID).toBe("c")
    const reserved = result.board.tasks.find((candidate) => candidate.taskID === "c")!
    expect(reserved.status).toBe("reserved")
    expect(reserved.stepIndex).toBe(4)
    // planned -> ready -> reserved is two applied transitions.
    expect(reserved.lifecycleVersion).toBe(3)
    expect(result.board.tasks.find((candidate) => candidate.taskID === "b")!.status).toBe("ready")
  })

  test("claims are held through review and ambiguity, never released on pending review", () => {
    for (const status of ["awaiting-validation", "awaiting-review", "changes-requested", "ambiguous", "blocked"] as const) {
      const board = baseBoard({
        tasks: [
          task({ taskID: "held", status, scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/a"], broad: false } }),
          task({ taskID: "next", status: "ready", scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/a"], broad: false } }),
        ],
      })
      const result = reserveNextLeadTask(board, { stepIndex: 1 })
      expect(result.reservation, status).toBeUndefined()
      expect(result.reason, status).toBe("scope-conflict")
    }
  })

  test("all-conflict reports scope-conflict and leaves candidates ready (waiting, not failed)", () => {
    const board = baseBoard({
      tasks: [
        task({ taskID: "a", status: "in-progress", scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/x"], broad: false } }),
        task({ taskID: "b", status: "ready", scope: { version: 1, root: "project", readPaths: [], writePaths: ["src/x"], broad: false } }),
      ],
    })
    const result = reserveNextLeadTask(board, { stepIndex: 1 })
    expect(result.reservation).toBeUndefined()
    expect(result.reason).toBe("scope-conflict")
    expect(result.board.tasks.find((candidate) => candidate.taskID === "b")!.status).toBe("ready")
  })

  test("release returns an undelivered reservation to ready without bumping the attempt and refuses stale versions", () => {
    const reserved = baseBoard({ tasks: [task({ status: "reserved", stepIndex: 3, lifecycleVersion: 2 })] })
    const released = releaseLeadReservation({ board: reserved, taskID: "t1", expectedLifecycleVersion: 2, expectedBoardRevision: 1, now: 5 })
    expect(released.ok).toBe(true)
    if (released.ok) {
      expect(released.board.tasks[0]!.status).toBe("ready")
      expect(released.board.tasks[0]!.attempt).toBe(1)
      expect(released.board.boardRevision).toBe(2)
    }
    expect(
      releaseLeadReservation({ board: reserved, taskID: "t1", expectedLifecycleVersion: 1, expectedBoardRevision: 1 }),
    ).toMatchObject({ ok: false, reason: "version-mismatch" })
  })

  test("completion eligibility requires every task completed", () => {
    expect(boardCompletionEligible(baseBoard())).toBe(false)
    expect(boardCompletionEligible(baseBoard({ tasks: [task({ status: "completed" })] }))).toBe(true)
    expect(boardCompletionEligible(baseBoard({ status: "paused", tasks: [task({ status: "completed" })] }))).toBe(false)
  })
})

describe("lead board hydration and receipt recovery", () => {
  test("missing and malformed boards never throw and never get repaired", async () => {
    const storage = memStorage()
    expect((await hydrateLeadBoard(storage, location, "lead")).status).toBe("missing")
    await storage.set("lead-board/v1/project/lead", { version: 1, boardID: "x" })
    const malformed = await hydrateLeadBoard(storage, location, "lead")
    expect(malformed.status).toBe("unavailable")
    expect(malformed.issues).toContain("malformed")
    expect(await storage.get("lead-board/v1/project/lead")).toEqual({ version: 1, boardID: "x" })
  })

  test("hydration verifies identity and goal generation and resolves the stable origin project", async () => {
    const storage = memStorage()
    const board = baseBoard()
    await writeLeadBoard(storage, location, board)
    expect((await hydrateLeadBoard(storage, location, "lead")).status).toBe("ok")
    expect((await hydrateLeadBoard(storage, location, "lead", { goalGeneration: 100, boardID: board.boardID })).status).toBe("ok")
    expect((await hydrateLeadBoard(storage, location, "lead", { goalGeneration: 101 })).status).toBe("unavailable")
    expect((await hydrateLeadBoard(storage, location, "other")).status).toBe("missing")

    // A moved session whose anchor records the origin finds the board under
    // the origin project key.
    const moved = memStorage(
      new Map<string, unknown>([
        ["session/v1/project/lead", {
          version: 1,
          sessionID: "lead",
          originProjectID: "origin",
          originDirectory: "/origin",
          currentProjectID: "project",
          currentDirectory: "/workspace",
          updatedAt: 1,
        }],
        [leadBoardStorageKey({ directory: "/origin", project: { id: "origin" } }, "lead"), plain(baseBoard({ projectID: "origin", boardID: leadBoardID("origin", "lead", 100) }))],
      ]),
    )
    const hydrated = await hydrateLeadBoard(moved, location, "lead")
    expect(hydrated.status).toBe("ok")
    expect(hydrated.board?.projectID).toBe("origin")
    await removeLeadBoard(moved, location, "lead")
    expect((await hydrateLeadBoard(moved, location, "lead")).status).toBe("missing")
  })

  test("reconcile maps pending/dispatched/missing/malformed/unreadable/failed to ambiguous and retains the claim", () => {
    for (const state of ["pending", "dispatched", "missing", "malformed", "unreadable", "failed"] as const) {
      const board = baseBoard({ tasks: [task({ status: "in-progress", stepIndex: 1 })] })
      const observation: LeadStepObservation =
        state === "pending" || state === "dispatched" || state === "failed"
          ? { state, stepIndex: 1, idempotencyKey: "lead/board-1/t1/1" }
          : { state }
      const result = reconcileLeadBoard(board, { observations: new Map([["t1", observation]]), now: 5 })
      expect(result.board.tasks[0]!.status, state).toBe("ambiguous")
      expect(result.changes[0]).toMatchObject({ taskID: "t1", to: "ambiguous", observation: state })
      expect(result.board.boardRevision).toBe(2)
    }
  })

  test("a completed step observation advances at most to awaiting-validation and never to completed", () => {
    const board = baseBoard({ tasks: [task({ status: "in-progress", stepIndex: 2 })] })
    const result = reconcileLeadBoard(board, {
      observations: new Map([["t1", { state: "completed", stepIndex: 2, idempotencyKey: "lead/board-1/t1/1" }]]),
      now: 5,
    })
    expect(result.board.tasks[0]!.status).toBe("awaiting-validation")
    expect(result.board.tasks[0]!.evidence.some((ref) => ref.description.includes("idle edge"))).toBe(true)
  })

  test("a live step index is skipped and already-completed tasks are never touched", () => {
    const live = baseBoard({ tasks: [task({ status: "in-progress", stepIndex: 7 })] })
    const skipped = reconcileLeadBoard(live, { observations: new Map(), liveStepIndex: 7, now: 5 })
    expect(skipped.board.tasks[0]!.status).toBe("in-progress")
    expect(skipped.changes).toHaveLength(0)
    const done = baseBoard({ tasks: [task({ status: "completed", stepIndex: 7 })] })
    const untouched = reconcileLeadBoard(done, { observations: new Map(), now: 5 })
    expect(untouched.board.tasks[0]!.status).toBe("completed")
  })

  test("a reservation without a step identity reconciles to ambiguous instead of guessing", () => {
    const board = baseBoard({ tasks: [task({ status: "reserved" })] })
    const result = reconcileLeadBoard(board, { observations: new Map(), now: 5 })
    expect(result.board.tasks[0]!.status).toBe("ambiguous")
  })
})

describe("D2 freeze fixture", () => {
  test("the D2 envelope keys and reviewState enum are byte-identical to the frozen v1 contract", () => {
    const frozenKeys = [
      "artifactRefs",
      "assumptions",
      "facts",
      "filesChanged",
      "filesRead",
      "followUp",
      "outcome",
      "reviewState",
      "risks",
      "status",
      "taskId",
      "verification",
      "version",
    ]
    expect(JSON.stringify(Object.keys(D2_HANDOFF_SCHEMA.shape).sort())).toBe(JSON.stringify(frozenKeys))
    expect(JSON.stringify(D2_REQUIRED_KEYS)).toBe(
      JSON.stringify([
        "version",
        "taskId",
        "status",
        "outcome",
        "facts",
        "assumptions",
        "filesRead",
        "filesChanged",
        "verification",
        "risks",
        "followUp",
        "artifactRefs",
        "reviewState",
      ]),
    )
    expect(JSON.stringify(D2_REVIEW_STATES)).toBe(
      JSON.stringify(["not-requested", "pending", "approved", "changes-requested", "blocked"]),
    )
  })
})
