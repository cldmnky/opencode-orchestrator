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
import {
  createLeadBoardV2,
  hydrateLeadBoardV2,
  parseLeadBoardV2,
  pauseLeadBoardV2,
  removeLeadBoardV2,
  resumeLeadBoardV2,
  leadBoardV2KeyedLocation,
  leadBoardV2StorageKey,
  writeLeadBoardV2,
} from "../orchestration/lead-board-v2.js"
import type { ToolDraftLike } from "../compat.js"

type ToolResult = { content: string }

export function addGoalTools(
  draft: ToolDraftLike,
  storage: StorageLike,
  location: LocationLike,
  options: OrchestratorOptions,
): void {
  draft.add({
    name: "goal",
    description: "Get or mutate the current session goal with one strict action: get, set, pause, resume, complete, or clear.",
    input: goalActionInput,
    options: { namespace: "orchestrator", permission: GOAL_TOOL_PERMISSION },
    execute: async (input, tool) => {
      requireOrchestrator(tool.agent, options)
      const action = stringField(input, "action")
      if (action === "get") {
        const goal = await readGoal(storage, await goalKey(storage, location, tool.sessionID))
        return result(goal ? JSON.stringify(goal) : "No active orchestration goal.")
      }
      if (action === "clear") {
        return withSessionLock(location, tool.sessionID, async () => {
          const projectID = await stableProjectID(storage, location, tool.sessionID)
          const stableLocation = stableLocationFor(projectID, location)
          await storage.remove(goalStorageKey(stableLocation, tool.sessionID))
          await storage.remove(stopStorageKey(stableLocation, tool.sessionID))
          await removeLeadBoardV2(storage, location, tool.sessionID)
          return result("Orchestration goal cleared.")
        })
      }
      if (action === "set") {
        return withSessionLock(location, tool.sessionID, async () => {
          const objective = stringField(input, "objective")
          if (!objective) return result("objective must be a non-empty string")
          const goal = newGoal(tool.sessionID, objective)
          const projectID = await stableProjectID(storage, location, tool.sessionID)
          const stableLocation = stableLocationFor(projectID, location)
          await storage.set(goalStorageKey(stableLocation, tool.sessionID), goal)
          await storage.remove(stopStorageKey(stableLocation, tool.sessionID))
          try {
            const hydration = await hydrateLeadBoardV2(storage, location, tool.sessionID)
            if (hydration.status !== "unavailable") {
              const board = createLeadBoardV2({
                projectID,
                leadSessionID: tool.sessionID,
                goalGeneration: goal.createdAt,
                objective: goal.objective,
              })
              await writeLeadBoardV2(storage, stableLocation, board)
            }
          } catch {
            // The goal remains readable; board enrollment can be retried by a
            // later set or the board action init operation.
          }
          return result(JSON.stringify(goal))
        })
      }
      if (action !== "pause" && action !== "resume" && action !== "complete") {
        return result("action must be get, set, pause, resume, complete, or clear")
      }
      return withSessionLock(location, tool.sessionID, async () => {
        const projectID = await stableProjectID(storage, location, tool.sessionID)
        const stableLocation = stableLocationFor(projectID, location)
        const key = goalStorageKey(stableLocation, tool.sessionID)
        const goal = await readGoal(storage, key)
        if (!goal) return result("No active orchestration goal.")

        const status = action === "pause" ? "paused" : action === "resume" ? "active" : "complete"
        const evidence = stringField(input, "evidence")
        if (action === "complete" && evidence.length < 8) {
          return result("completion requires at least eight characters of evidence")
        }
        // A goal generation governed by a lead board cannot be bypassed: the
        // board must reach `complete` through orchestrator_board_action
        // (all tasks completed + aggregate verification + approved
        // exact-revision review). A missing board keeps the legacy path; an
        // unavailable/malformed board fails closed.
        if (action === "complete") {
          const hydration = await hydrateLeadBoardV2(storage, location, tool.sessionID, { goalGeneration: goal.createdAt })
          if (hydration.status === "unavailable") {
            return result("completion refused: the lead board is unavailable; repair or re-init it first")
          }
          if (hydration.status === "legacy") {
            return result("completion refused: the lead board is still V1; migrate it with orchestrator_board_action init first")
          }
          if (hydration.status === "ok" && hydration.board?.status !== "complete") {
            return result("completion refused: complete the lead board with orchestrator_board_action complete first")
          }
        }

        const now = Date.now()
        const updated: GoalRecord = {
          ...goal,
          status,
          updatedAt: now,
        }
        if (action === "complete") {
          updated.completedAt = now
          updated.completionEvidence = evidence
        } else {
          delete updated.completedAt
          delete updated.completionEvidence
        }
        await storage.set(key, updated)
        if (status === "active") await storage.remove(stopStorageKey(stableLocation, tool.sessionID))
        await setBoardPaused(storage, stableLocation, tool.sessionID, status === "paused")
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

async function setBoardPaused(storage: StorageLike, location: LocationLike, sessionID: string, paused: boolean): Promise<void> {
  try {
    const keyedLocation = await leadBoardV2KeyedLocation(storage, location, sessionID)
    const key = leadBoardV2StorageKey(keyedLocation, sessionID)
    const board = parseLeadBoardV2(await storage.get(key))
    if (!board || board.status === "complete") return
    const next = paused ? pauseLeadBoardV2(board) : resumeLeadBoardV2(board)
    if (next !== board) await writeLeadBoardV2(storage, keyedLocation, next)
  } catch (error) {
    console.warn(`opencode-orchestrator could not update the lead board pause state for ${sessionID}`, error)
  }
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

const goalActionInput = {
  oneOf: [
    {
      type: "object",
      properties: { action: { const: "get" } },
      required: ["action"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "set" },
        objective: { type: "string", minLength: 1 },
      },
      required: ["action", "objective"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { const: "pause" } },
      required: ["action"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { const: "resume" } },
      required: ["action"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "complete" },
        evidence: { type: "string", minLength: 8 },
      },
      required: ["action", "evidence"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { const: "clear" } },
      required: ["action"],
      additionalProperties: false,
    },
  ],
} as const
