import type { OrchestratorOptions } from "../../core/config.js"
import { GOAL_TOOL_PERMISSION } from "../../core/permissions.js"
import {
  goalStorageKey,
  newGoal,
  readGoal,
  stableProjectID,
  stopStorageKey,
  withSessionLock,
  type LocationLike,
  type StorageLike,
  type GoalRecord,
} from "./state.js"
import { createLeadBoardV2, hydrateLeadBoardV2, writeLeadBoardV2 } from "../orchestration/lead-board-v2.js"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"

type ToolDraftLike = {
  add(tool: ToolInfo<any, undefined>): void
}

type ToolResult = { content: string }

export function addGoalTools(
  draft: ToolDraftLike,
  storage: StorageLike,
  location: LocationLike,
  options: OrchestratorOptions,
): void {
  draft.add({
    name: "goal_get",
    description: "Read the active orchestration goal for this session.",
    input: emptyInput,
    options: { namespace: "orchestrator", permission: GOAL_TOOL_PERMISSION },
    execute: async (_input, tool) => {
      requireOrchestrator(tool.agent, options)
      const goal = await readGoal(storage, await goalKey(storage, location, tool.sessionID))
      return result(goal ? JSON.stringify(goal) : "No active orchestration goal.")
    },
  })

  draft.add({
    name: "goal_set",
    description: "Create or replace the active orchestration goal.",
    input: setInput,
    options: { namespace: "orchestrator", permission: GOAL_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, options)
      return withSessionLock(location, tool.sessionID, async () => {
        const objective = stringField(input, "objective")
        if (!objective) return result("objective must be a non-empty string")
        const goal = newGoal(tool.sessionID, objective)
        const projectID = await stableProjectID(storage, location, tool.sessionID)
        const stableLocation = stableLocationFor(projectID, location)
        await storage.set(goalStorageKey(stableLocation, tool.sessionID), goal)
        await storage.remove(stopStorageKey(stableLocation, tool.sessionID))
        // A new goal generation enrolls its own deterministic lead board
        // (same wiring as /goal set): new boardID, fresh idempotency keys, one
        // planned root task. A board write failure leaves the goal on the
        // legacy board-missing path, never a synthesized ledger.
        try {
          const hydration = await hydrateLeadBoardV2(storage, location, tool.sessionID)
          if (hydration.status === "unavailable") return result(JSON.stringify(goal))
          const board = createLeadBoardV2({
            projectID,
            leadSessionID: tool.sessionID,
            goalGeneration: goal.createdAt,
            objective: goal.objective,
          })
          await writeLeadBoardV2(storage, stableLocation, board)
        } catch {
          // Reported by the goal record itself; the board can be re-enrolled
          // explicitly with orchestrator_lead_board_init.
        }
        return result(JSON.stringify(goal))
      })
    },
  })

  draft.add({
    name: "goal_update",
    description: "Pause, resume, or complete the active goal; completion requires evidence.",
    input: updateInput,
    options: { namespace: "orchestrator", permission: GOAL_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, options)
      return withSessionLock(location, tool.sessionID, async () => {
        const projectID = await stableProjectID(storage, location, tool.sessionID)
        const stableLocation = stableLocationFor(projectID, location)
        const key = goalStorageKey(stableLocation, tool.sessionID)
        const goal = await readGoal(storage, key)
        if (!goal) return result("No active orchestration goal.")

        const status = stringField(input, "status")
        if (status !== "active" && status !== "paused" && status !== "complete") {
          return result("status must be active, paused, or complete")
        }
        const evidence = stringField(input, "evidence")
        if (status === "complete" && evidence.length < 8) {
          return result("completion requires at least eight characters of evidence")
        }
        // A goal generation governed by a lead board cannot be bypassed: the
        // board must reach `complete` through orchestrator_lead_board_complete
        // (all tasks completed + aggregate verification + approved
        // exact-revision review). A missing board keeps the legacy path; an
        // unavailable/malformed board fails closed.
        if (status === "complete") {
          const hydration = await hydrateLeadBoardV2(storage, location, tool.sessionID, { goalGeneration: goal.createdAt })
          if (hydration.status === "unavailable") {
            return result("completion refused: the lead board is unavailable; repair or re-init it first")
          }
          if (hydration.status === "legacy") {
            return result("completion refused: the lead board is still V1; migrate it with orchestrator_lead_board_init first")
          }
          if (hydration.status === "ok" && hydration.board?.status !== "complete") {
            return result("completion refused: complete the lead board with orchestrator_lead_board_complete first")
          }
        }

        const now = Date.now()
        const updated: GoalRecord = {
          ...goal,
          status,
          updatedAt: now,
        }
        if (status === "complete") {
          updated.completedAt = now
          updated.completionEvidence = evidence
        } else {
          delete updated.completedAt
          delete updated.completionEvidence
        }
        await storage.set(key, updated)
        if (status === "active") await storage.remove(stopStorageKey(stableLocation, tool.sessionID))
        return result(JSON.stringify(updated))
      })
    },
  })
}

// Goal/run/halt keys stay anchored to the session's stable project so a
// session move (which relocates the session anchor and the worktree index, but
// never this state) cannot orphan the goal.
async function goalKey(storage: StorageLike, location: LocationLike, sessionID: string): Promise<string> {
  return goalStorageKey(stableLocationFor(await stableProjectID(storage, location, sessionID), location), sessionID)
}

function stableLocationFor(projectID: string, location: LocationLike): LocationLike {
  return { ...location, project: { id: projectID } }
}

function requireOrchestrator(agent: string, options: OrchestratorOptions): void {
  if (agent !== options.orchestrator) throw new Error("orchestration goal tools are available only to the orchestrator")
}

function stringField(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return ""
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "string" ? value.trim() : ""
}

function result(content: string): ToolResult {
  return { content }
}

const emptyInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const setInput = {
  type: "object",
  properties: {
    objective: { type: "string", minLength: 1 },
  },
  required: ["objective"],
  additionalProperties: false,
} as const

const updateInput = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["active", "paused", "complete"] },
    evidence: { type: "string" },
  },
  required: ["status"],
  additionalProperties: false,
} as const
