import { describe, expect, test } from "bun:test"
import { formatModelReference, parseModelReference } from "../../src/core/model-reference.js"
import { parseOptions } from "../../src/core/config.js"
import {
  createWorkerModelRuntime,
  parseWorkerModelAssignment,
  workerAgentIDs,
} from "../../src/opencode-v2/worker-models/runtime.js"
import {
  readWorkerModelOverrides,
  resolveGitCommonDirectory,
  workerModelScopeKey,
  workerModelStorageKey,
  writeWorkerModelOverrides,
} from "../../src/opencode-v2/worker-models/state.js"

describe("model references", () => {
  test("parses and formats base, variant, and namespaced model IDs", () => {
    expect(parseModelReference("provider/model")).toEqual({ providerID: "provider", id: "model" })
    expect(parseModelReference("provider/vendor/model#fast")).toEqual({
      providerID: "provider",
      id: "vendor/model",
      variant: "fast",
    })
    expect(formatModelReference({ providerID: "provider", id: "vendor/model", variant: "fast" })).toBe("provider/vendor/model#fast")
    expect(() => parseModelReference("provider/ model")).toThrow()
    expect(() => parseModelReference("provider/model#")).toThrow()
  })
})

describe("worker model durable state", () => {
  test("hashes repository scope without persisting the source path", () => {
    const scope = workerModelScopeKey("project", "/private/tmp/repo/.git")
    const key = workerModelStorageKey(scope)
    expect(scope).toMatch(/^git-[a-f0-9]{64}$/)
    expect(key).not.toContain("/private/tmp/repo")
    expect(key).not.toContain(".git")
  })

  test("writes, reads, and ignores malformed strict records", async () => {
    const storage = memoryStorage()
    const key = workerModelStorageKey("project-project")
    const overrides = new Map([[
      "planner",
      { providerID: "provider", id: "model", variant: "fast" },
    ]])

    await writeWorkerModelOverrides(storage, key, overrides)
    expect(await readWorkerModelOverrides(storage, key)).toEqual(overrides)

    await storage.set(key, { version: 1, overrides: { planner: { providerID: "provider", id: "model" }, extra: true } })
    expect(await readWorkerModelOverrides(storage, key)).toEqual(new Map())
  })

  test("resolves a relative git common directory and falls back on git failure", async () => {
    const location = { directory: "/workspace/worktree", project: { id: "project" } }
    const runner = {
      run: async () => ({ exitCode: 0, stdout: "../repo/.git\n", stderr: "" }),
    }
    expect(await resolveGitCommonDirectory(runner, location)).toBe("/workspace/repo/.git")

    const failed = { run: async () => ({ exitCode: 128, stdout: "", stderr: "not a repository" }) }
    expect(await resolveGitCommonDirectory(failed, location)).toBeUndefined()
  })
})

describe("worker model runtime", () => {
  test("limits targets to workers, validates tool support and variants, and reloads agents", async () => {
    const storage = memoryStorage()
    const agentModels = new Map<string, { providerID: string; id: string; variant?: string } | undefined>([
      ["planner", { providerID: "configured", id: "planner" }],
      ["explore", { providerID: "configured", id: "explore" }],
      ["implementer", undefined],
      ["reviewer", undefined],
    ])
    let reloads = 0
    const runtime = await createWorkerModelRuntime({
      storage,
      location: { directory: "/workspace", project: { id: "project" } },
      options: parseOptions({}),
      runner: { run: async () => ({ exitCode: 128, stdout: "", stderr: "" }) },
      catalog: {
        model: {
          list: async () => ({
            data: [
              {
                providerID: "provider",
                id: "worker",
                modelID: "worker",
                name: "Worker",
                enabled: true,
                capabilities: { tools: true },
                variants: [{ id: "fast" }],
              },
              {
                providerID: "provider",
                id: "no-tools",
                modelID: "no-tools",
                name: "No tools",
                enabled: true,
                capabilities: { tools: false },
                variants: [],
              },
            ],
          }),
        },
      },
      agent: {
        get: async ({ agentID }) => ({ data: { model: agentModels.get(agentID) } }),
        reload: async () => {
          reloads++
        },
      },
    })

    expect(workerAgentIDs(parseOptions({}))).toEqual(["planner", "explore", "implementer", "reviewer"])
    await runtime.set("planner", { providerID: "provider", id: "worker", variant: "fast" })
    expect(runtime.overrides.get("planner")).toEqual({ providerID: "provider", id: "worker", variant: "fast" })
    expect(reloads).toBe(1)
    expect(await readWorkerModelOverrides(storage, workerModelStorageKey("project-project"))).toEqual(runtime.overrides)

    await expect(runtime.set("planner", { providerID: "provider", id: "no-tools" })).rejects.toThrow("does not support tools")
    await expect(runtime.set("planner", { providerID: "provider", id: "worker", variant: "missing" })).rejects.toThrow("variant")
    await expect(runtime.set("orchestrator", { providerID: "provider", id: "worker" })).rejects.toThrow("worker agents")
    expect(reloads).toBe(1)

    await runtime.clear("planner")
    expect(runtime.overrides.has("planner")).toBe(false)
    expect(reloads).toBe(2)
  })

  test("rolls back durable state and memory when agent reload fails", async () => {
    const storage = memoryStorage()
    let attempts = 0
    const runtime = await createWorkerModelRuntime({
      storage,
      location: { directory: "/workspace", project: { id: "project" } },
      options: parseOptions({}),
      runner: { run: async () => ({ exitCode: 128, stdout: "", stderr: "" }) },
      catalog: { model: { list: async () => ({ data: [{
        providerID: "provider",
        id: "worker",
        modelID: "worker",
        name: "Worker",
        enabled: true,
        capabilities: { tools: true },
        variants: [],
      }] }) } },
      agent: {
        get: async () => ({ data: {} }),
        reload: async () => {
          attempts++
          if (attempts === 1) throw new Error("reload failed")
        },
      },
    })

    await expect(runtime.set("planner", { providerID: "provider", id: "worker" })).rejects.toThrow("reload failed")
    expect(runtime.overrides.size).toBe(0)
    expect(await readWorkerModelOverrides(storage, workerModelStorageKey("project-project"))).toEqual(new Map())
    expect(attempts).toBe(2)
  })

  test("parses list, reset, default, and set command forms", () => {
    expect(parseWorkerModelAssignment("")).toEqual({ kind: "list" })
    expect(parseWorkerModelAssignment("list")).toEqual({ kind: "list" })
    expect(parseWorkerModelAssignment("reset")).toEqual({ kind: "reset" })
    expect(parseWorkerModelAssignment("planner=default")).toEqual({ kind: "set", agentID: "planner" })
    expect(parseWorkerModelAssignment("planner=provider/model#fast")).toEqual({
      kind: "set",
      agentID: "planner",
      model: { providerID: "provider", id: "model", variant: "fast" },
    })
    expect(() => parseWorkerModelAssignment("orchestrator")).toThrow()
  })
})

function memoryStorage() {
  const values = new Map<string, unknown>()
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => void values.set(key, value),
    remove: async (key: string) => void values.delete(key),
  }
}
