import type { ModelInfo } from "@opencode-ai/client"
import type { OrchestratorOptions } from "../../core/config.js"
import { formatModelReference, parseModelReference, type ModelReference } from "../../core/model-reference.js"
import { workerAgentIds, workerAgentRoles as coreWorkerAgentRoles } from "../../core/roles.js"
import type { ProcessRunner } from "../process/runner.js"
import {
  readWorkerModelOverrides,
  resolveGitCommonDirectory,
  workerModelScopeKey,
  workerModelStorageKey,
  writeWorkerModelOverrides,
  type WorkerModelLocation,
  type WorkerModelOverrides,
} from "./state.js"
import type { StorageLike } from "../goal/state.js"

export type WorkerModelCatalog = {
  model: {
    list(): Promise<unknown>
  }
}

export type WorkerModelAgentApi = {
  get(input: { agentID: string }): Promise<unknown>
  reload?: () => Promise<void>
}

export type WorkerModelRuntime = {
  readonly overrides: WorkerModelOverrides
  readonly workerIDs: readonly string[]
  readonly scope: string
  set(agentID: string, model: ModelReference): Promise<void>
  clear(agentID: string): Promise<void>
  reset(): Promise<void>
  list(): Promise<readonly WorkerModelStatus[]>
}

export type WorkerModelStatus = {
  agentID: string
  override?: ModelReference
  configured?: ModelReference
  effective?: ModelReference
}

type WorkerModelRuntimeDeps = {
  storage: StorageLike
  location: WorkerModelLocation
  options: OrchestratorOptions
  runner: ProcessRunner
  catalog: WorkerModelCatalog
  agent: WorkerModelAgentApi
}

type CatalogModel = Pick<ModelInfo, "id" | "providerID" | "name" | "capabilities" | "variants" | "enabled">

export async function createWorkerModelRuntime(deps: WorkerModelRuntimeDeps): Promise<WorkerModelRuntime> {
  const gitCommonDirectory = await resolveGitCommonDirectory(deps.runner, deps.location)
  const scope = workerModelScopeKey(deps.location.project.id, gitCommonDirectory)
  const storageKey = workerModelStorageKey(scope)
  const workerIDs = workerAgentIDs(deps.options)
  const loaded = await readWorkerModelOverrides(deps.storage, storageKey)
  const overrides: WorkerModelOverrides = new Map()
  for (const id of workerIDs) {
    const model = loaded.get(id)
    if (model) overrides.set(id, { ...model })
  }
  const configuredDefaults = new Map<string, ModelReference>()
  await Promise.all(
    workerIDs.map(async (agentID) => {
      const model = await configuredModel(deps.agent, agentID)
      if (model) configuredDefaults.set(agentID, model)
    }),
  )

  let queue = Promise.resolve()

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const ensureWorker = (agentID: string): void => {
    if (!workerIDs.includes(agentID)) throw new Error(`model selection is limited to configured worker agents: ${agentID}`)
  }

  const validateModel = async (model: ModelReference): Promise<void> => {
    const models = await catalogModels(deps.catalog)
    const match = models.find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id)
    if (!match) throw new Error(`model is not available: ${formatModelReference(model)}`)
    if (match.enabled === false) throw new Error(`model is disabled: ${formatModelReference(model)}`)
    if (!isToolCapableModel(match)) throw new Error(`model does not support tools: ${formatModelReference(model)}`)
    if (model.variant && !match.variants.some((variant) => variant.id === model.variant)) {
      throw new Error(`model variant is not available: ${formatModelReference(model)}`)
    }
  }

  const replace = (next: ReadonlyMap<string, ModelReference>): void => {
    overrides.clear()
    for (const [agentID, model] of next) overrides.set(agentID, { ...model })
  }

  const commit = async (next: ReadonlyMap<string, ModelReference>): Promise<void> => {
    const previous = new Map(overrides)
    await writeWorkerModelOverrides(deps.storage, storageKey, next)
    replace(next)
    try {
      await deps.agent.reload?.()
    } catch (error) {
      replace(previous)
      try {
        await writeWorkerModelOverrides(deps.storage, storageKey, previous)
        await deps.agent.reload?.()
      } catch (rollbackError) {
        throw new Error(`worker model reload failed and rollback failed: ${errorMessage(rollbackError)}`)
      }
      throw new Error(`worker model reload failed: ${errorMessage(error)}`)
    }
  }

  return {
    overrides,
    workerIDs,
    scope,
    set: (agentID, model) =>
      enqueue(async () => {
        ensureWorker(agentID)
        await validateModel(model)
        const next = new Map(overrides)
        next.set(agentID, { ...model })
        await commit(next)
      }),
    clear: (agentID) =>
      enqueue(async () => {
        ensureWorker(agentID)
        if (!overrides.has(agentID)) return
        const next = new Map(overrides)
        next.delete(agentID)
        await commit(next)
      }),
    reset: () =>
      enqueue(async () => {
        if (overrides.size === 0) return
        await commit(new Map())
      }),
    list: async () => {
      const statuses = await Promise.all(
        workerIDs.map(async (agentID) => {
          const effective = await configuredModel(deps.agent, agentID)
          return {
            agentID,
            ...(overrides.has(agentID) ? { override: { ...overrides.get(agentID)! } } : {}),
            ...(configuredDefaults.has(agentID) ? { configured: { ...configuredDefaults.get(agentID)! } } : {}),
            ...(effective ? { effective } : {}),
          }
        }),
      )
      return statuses
    },
  }
}

export function workerAgentIDs(options: OrchestratorOptions): string[] {
  return workerAgentIds(options.orchestrator, options.roles)
}

export function workerAgentRoles(options: OrchestratorOptions): ReadonlyMap<string, string[]> {
  return coreWorkerAgentRoles(options.orchestrator, options.roles)
}

export function parseWorkerModelAssignment(
  input: string,
): { kind: "reset" } | { kind: "list" } | { kind: "set"; agentID: string; model?: ModelReference } {
  const value = input.trim()
  if (!value || value === "list") return { kind: "list" }
  if (value === "reset") return { kind: "reset" }
  const separator = value.indexOf("=")
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("expected <worker>=<provider>/<model>[#variant], <worker>=default, list, or reset")
  }
  const agentID = value.slice(0, separator).trim()
  const reference = value.slice(separator + 1).trim()
  if (!agentID || !reference) throw new Error("expected <worker>=<provider>/<model>[#variant]")
  if (reference === "default") return { kind: "set", agentID }
  try {
    return { kind: "set", agentID, model: parseModelReference(reference) }
  } catch {
    throw new Error("expected <worker>=<provider>/<model>[#variant] or <worker>=default")
  }
}

export function isToolCapableModel(model: Pick<CatalogModel, "capabilities" | "enabled">): boolean {
  return model.enabled !== false && model.capabilities?.tools === true
}

async function catalogModels(catalog: WorkerModelCatalog): Promise<CatalogModel[]> {
  const response = await catalog.model.list()
  const data = Array.isArray(response)
    ? response
    : response && typeof response === "object" && Array.isArray((response as { data?: unknown }).data)
      ? (response as { data: unknown[] }).data
      : []
  return data as CatalogModel[]
}

async function configuredModel(agent: WorkerModelAgentApi, agentID: string): Promise<ModelReference | undefined> {
  try {
    const response = await agent.get({ agentID })
    const value = response && typeof response === "object" && "data" in response ? response.data : response
    if (!value || typeof value !== "object") return undefined
    const model = (value as { model?: unknown }).model
    if (!model || typeof model !== "object") return undefined
    const candidate = model as { id?: unknown; providerID?: unknown; variant?: unknown }
    if (typeof candidate.id !== "string" || typeof candidate.providerID !== "string") return undefined
    return {
      id: candidate.id,
      providerID: candidate.providerID,
      ...(typeof candidate.variant === "string" ? { variant: candidate.variant } : {}),
    }
  } catch {
    return undefined
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
