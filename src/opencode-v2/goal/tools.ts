import type { OrchestratorOptions } from "../../core/config.js"
import { GOAL_TOOL_PERMISSION } from "../../core/permissions.js"
import {
  goalStorageKey,
  newGoal,
  readGoal,
  stopStorageKey,
  withSessionLock,
  type LocationLike,
  type StorageLike,
  type GoalRecord,
} from "./state.js"
import type { Info as ToolInfo } from "@opencode-ai/plugin/promise/tool"

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
      const goal = await readGoal(storage, goalStorageKey(location, tool.sessionID))
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
        await storage.set(goalStorageKey(location, tool.sessionID), goal)
        await storage.remove(stopStorageKey(location, tool.sessionID))
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
        const key = goalStorageKey(location, tool.sessionID)
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
        if (status === "active") await storage.remove(stopStorageKey(location, tool.sessionID))
        return result(JSON.stringify(updated))
      })
    },
  })
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
