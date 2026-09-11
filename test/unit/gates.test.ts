import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/core/config.js"
import {
  clearGates,
  gateStatus,
  gateStatuses,
  gatesStorageKey,
  readGates,
  requireGateEnabled,
  setGateDisabled,
  SESSION_GATES,
  type GateStatus,
} from "../../src/opencode-v2/gates/state.js"
import { gatesRpcDefinition, parseGatesGetInput, parseGatesSetInput, parseGatesView } from "../../src/opencode-v2/gates/rpc.js"
import { publishStorageKey } from "../../src/opencode-v2/publish/state.js"

const LOCATION = { directory: "/workspace", project: { id: "project" } }
const SESSION = "session"

function fakeStorage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial))
  return {
    values,
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => void values.set(key, value),
      remove: async (key: string) => void values.delete(key),
    },
  }
}

function enabledPublish(record: Record<string, unknown>): Record<string, unknown> {
  return {
    [publishStorageKey("project")]: {
      version: 1,
      projectID: "project",
      enabled: true,
      capabilities: ["push"],
      updatedAt: 1,
      updatedBy: SESSION,
      ...record,
    },
  }
}

function statusOf(statuses: GateStatus[], gate: string): GateStatus {
  const status = statuses.find((candidate) => candidate.gate === gate)
  expect(status).toBeDefined()
  return status!
}

describe("session gate state", () => {
  test("readGates ignores absent and malformed records and roundtrips a valid one", async () => {
    const { storage, values } = fakeStorage()
    expect(await readGates(storage, SESSION)).toBeUndefined()

    values.set(gatesStorageKey(SESSION), { version: 1, sessionID: SESSION, disabled: ["nonsense"], updatedAt: 1 })
    expect(await readGates(storage, SESSION)).toBeUndefined()

    await setGateDisabled(storage, SESSION, "merge", true, 42)
    expect(await readGates(storage, SESSION)).toEqual({
      version: 1,
      sessionID: SESSION,
      disabled: ["merge"],
      updatedAt: 42,
    })
  })

  test("setGateDisabled toggles deterministically and clearGates removes the record", async () => {
    const { storage, values } = fakeStorage()
    await setGateDisabled(storage, SESSION, "push", true)
    await setGateDisabled(storage, SESSION, "merge", true)
    expect((values.get(gatesStorageKey(SESSION)) as { disabled: string[] }).disabled).toEqual(["merge", "push"])

    // Re-enabling removes the narrowing entry; other entries remain.
    await setGateDisabled(storage, SESSION, "merge", false)
    expect((values.get(gatesStorageKey(SESSION)) as { disabled: string[] }).disabled).toEqual(["push"])

    await clearGates(storage, SESSION)
    expect(values.has(gatesStorageKey(SESSION))).toBe(false)
  })

  test("gateStatuses resolves every gate with its ceiling source and reason", async () => {
    const { storage } = fakeStorage()
    const statuses = await gateStatuses(storage, LOCATION, SESSION, parseOptions({}))

    expect(statuses.map((status) => status.gate)).toEqual([...SESSION_GATES])
    for (const status of statuses) {
      expect(status.enabled).toBe(false)
      expect(status.ceiling).toBe(false)
      expect(status.sessionDisabled).toBe(false)
    }
    expect(statusOf(statuses, "push").ceilingSource).toBe("project")
    expect(statusOf(statuses, "push").projectID).toBe("project")
    expect(statusOf(statuses, "push").ceilingReason).toContain("/publish enable")
    expect(statusOf(statuses, "github-mutations").ceilingSource).toBe("config")
    expect(statusOf(statuses, "github-mutations").ceilingReason).toBe("github.enabled is off")
    expect(statusOf(statuses, "worktree-mutations").ceilingReason).toBe("worktree.enabled is off")
  })

  test("an enabled publish record normalizes to the current capability set and raises every capability ceiling", async () => {
    // A record written before `merge` existed carries only a partial set; an
    // enabled record authorizes the current capability family on read.
    const { storage } = fakeStorage(enabledPublish({}))
    const statuses = await gateStatuses(storage, LOCATION, SESSION, parseOptions({}))

    for (const gate of ["push", "pr-draft-create", "pr-ready-transition", "approve-after-review", "merge"]) {
      const status = statusOf(statuses, gate)
      expect(status.ceiling).toBe(true)
      expect(status.enabled).toBe(true)
      expect(status.ceilingReason).toBeUndefined()
    }
    expect(statusOf(statuses, "github-mutations").ceiling).toBe(false)
  })

  test("a disabled publish record leaves every capability ceiling off", async () => {
    const { storage } = fakeStorage(enabledPublish({ enabled: false, capabilities: [] }))
    const statuses = await gateStatuses(storage, LOCATION, SESSION, parseOptions({ publish: { enabled: true } }))
    expect(statusOf(statuses, "merge").ceiling).toBe(false)
    expect(statusOf(statuses, "merge").ceilingReason).toContain("/publish enable")
  })

  test("session narrowing turns a gate off without touching the ceiling", async () => {
    const { storage } = fakeStorage(enabledPublish({}))
    await setGateDisabled(storage, SESSION, "merge", true)
    const status = await gateStatus(storage, LOCATION, SESSION, parseOptions({}), "merge")

    expect(status.ceiling).toBe(true)
    expect(status.enabled).toBe(false)
    expect(status.sessionDisabled).toBe(true)
    expect(status.ceilingReason).toBeUndefined()
  })

  test("requireGateEnabled distinguishes a session narrowing from a disabled ceiling", async () => {
    const options = parseOptions({ github: { enabled: true, allow_mutations: true }, publish: { enabled: true } })
    const { storage } = fakeStorage(enabledPublish({}))

    const allowed = await requireGateEnabled(storage, LOCATION, SESSION, options, "merge")
    expect(allowed.ok).toBe(true)

    await setGateDisabled(storage, SESSION, "merge", true)
    const narrowed = await requireGateEnabled(storage, LOCATION, SESSION, options, "merge")
    expect(narrowed.ok).toBe(false)
    if (narrowed.ok) throw new Error("expected refusal")
    expect(narrowed.message).toContain("disabled for this session")
    expect(narrowed.message).toContain("/gates merge=on")

    await setGateDisabled(storage, SESSION, "github-mutations", true)
    const configNarrowed = await requireGateEnabled(storage, LOCATION, SESSION, options, "github-mutations")
    expect(configNarrowed.ok).toBe(false)
    if (configNarrowed.ok) throw new Error("expected refusal")
    expect(configNarrowed.message).toContain("disabled for this session")
  })

  test("requireGateEnabled reports capability and config ceilings truthfully", async () => {
    const { storage } = fakeStorage()
    const disabledOptions = parseOptions({})

    const capability = await requireGateEnabled(storage, LOCATION, SESSION, disabledOptions, "push")
    expect(capability.ok).toBe(false)
    if (capability.ok) throw new Error("expected refusal")
    expect(capability.message).toContain("publication capability 'push' is not authorized for project project")
    expect(capability.message).toContain("/publish enable")

    const config = await requireGateEnabled(storage, LOCATION, SESSION, disabledOptions, "github-mutations")
    expect(config.ok).toBe(false)
    if (config.ok) throw new Error("expected refusal")
    expect(config.message).toContain("github.enabled is off")

    const enabled = parseOptions({ github: { enabled: true } })
    const allowMutations = await requireGateEnabled(storage, LOCATION, SESSION, enabled, "github-mutations")
    expect(allowMutations.ok).toBe(false)
    if (allowMutations.ok) throw new Error("expected refusal")
    expect(allowMutations.message).toContain("github.allow_mutations is off")
  })
})

describe("session gate RPC contract", () => {
  const validView = {
    sessionID: SESSION,
    gates: [
      {
        gate: "merge",
        enabled: false,
        ceiling: true,
        ceilingSource: "project",
        sessionDisabled: true,
        projectID: "project",
      },
      {
        gate: "github-mutations",
        enabled: false,
        ceiling: false,
        ceilingSource: "config",
        sessionDisabled: false,
        ceilingReason: "github.enabled is off",
      },
    ],
  }

  test("exposes exactly the read/toggle surface", () => {
    expect(gatesRpcDefinition.id).toBe("opencode-orchestrator.gates")
    expect(Object.keys(gatesRpcDefinition.methods).sort()).toEqual(["get", "set"])
    expect(gatesRpcDefinition.events).toEqual({})
  })

  test("parseGatesView validates every rendered field", () => {
    const parsed = parseGatesView(validView)
    expect(parsed?.sessionID).toBe(SESSION)
    expect(parsed?.gates.map((status) => status.gate)).toEqual(["merge", "github-mutations"])
    expect(parsed?.gates[0]?.projectID).toBe("project")

    expect(parseGatesView(undefined)).toBeUndefined()
    expect(parseGatesView({ sessionID: SESSION, gates: [{ gate: "unknown" }] })).toBeUndefined()
    expect(parseGatesView({ sessionID: SESSION, gates: [{ ...validView.gates[0], enabled: "yes" }] })).toBeUndefined()
    expect(parseGatesView({ gates: validView.gates })).toBeUndefined()
  })

  test("parses lenient get/set inputs without accepting unknown gates", () => {
    expect(parseGatesGetInput({ sessionID: SESSION })).toEqual({ sessionID: SESSION })
    expect(parseGatesGetInput({})).toBeUndefined()
    expect(parseGatesGetInput(undefined)).toBeUndefined()

    expect(parseGatesSetInput({ sessionID: SESSION, gate: "merge", disabled: true })).toEqual({
      sessionID: SESSION,
      gate: "merge",
      disabled: true,
    })
    expect(parseGatesSetInput({ sessionID: SESSION, gate: "frobnicate", disabled: true })).toBeUndefined()
    expect(parseGatesSetInput({ sessionID: SESSION, gate: "merge" })).toBeUndefined()
  })
})
