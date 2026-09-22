import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { tuiPlugin } from "../../src/tui.js"
import { commandDefinitions, tuiCommandSurface } from "../../src/opencode-v2/commands/index.js"
import { parseOptions } from "../../src/core/config.js"
import { unavailableProgressView } from "../../src/opencode-v2/progress/rpc.js"

describe("TUI plugin contract", () => {
  test("registers its keymap layer from the app slot before the first async boundary", async () => {
    let resolveSync: (() => void) | undefined
    const sync = new Promise<void>((resolve) => {
      resolveSync = resolve
    })
    const stopped: string[] = []
    let layerRegistered = false

    const setup = tuiPlugin.setup(contextWithSync(sync, stopped, () => (layerRegistered = true)))
    expect(layerRegistered).toBe(true)

    resolveSync?.()
    const cleanup = await setup
    await cleanup?.()
    expect(stopped).toEqual(["session.execution.failed", "command.updated", "slot"])
  })

  test("stops subscriptions and the slot when initial command sync fails", async () => {
    const stopped: string[] = []
    const error = new Error("sync failed")

    await expect(tuiPlugin.setup(contextWithSync(Promise.reject(error), stopped))).rejects.toBe(error)
    expect(stopped).toEqual(["session.execution.failed", "command.updated", "slot"])
  })

  test("uses the active location for the worker model catalog and dispatches the selected model", async () => {
    const commands: Array<{ id?: string; run(input?: string): Promise<void> | void }> = []
    const selections: string[] = []
    const requests: unknown[] = []
    const context = {
      options: {},
      location: { directory: "/workspace" },
      data: {
        on: () => () => {},
        location: {
          default: () => ({ directory: "/workspace" }),
          command: {
            sync: async () => {},
            invalidate: () => {},
            list: () => [{ name: "worker-models", description: "Select durable models for worker agents" }],
          },
        },
      },
      ui: {
        slot: (claim: { render: (input: Record<string, never>) => unknown }) => {
          claim.render({})
          return () => {}
        },
        router: { current: () => ({ type: "session", sessionID: "session" }) },
        dialog: {
          select: async (input: { title: string }) => {
            selections.push(input.title)
            return input.title === "Select worker agent"
              ? { kind: "worker", agentID: "explore" }
              : { kind: "model", reference: { providerID: "provider", id: "model", variant: "fast" } }
          },
          alert: async () => {},
        },
        toast: { show: () => {} },
      },
      keymap: {
        layer: (definition: () => { commands: Array<{ id?: string; run(input?: string): Promise<void> | void }> }) => {
          commands.push(...definition().commands)
        },
      },
      client: {
        model: {
          list: async (input: unknown) => {
            requests.push(input)
            return {
              data: [{
                providerID: "provider",
                id: "model",
                name: "Worker",
                enabled: true,
                capabilities: { tools: true },
                variants: [{ id: "fast" }],
              }],
            }
          },
        },
        agent: { list: async () => ({ data: [{ id: "explore", model: { providerID: "configured", id: "old" } }] }) },
        session: { command: async (input: unknown) => requests.push(input) },
      },
    } as unknown as Context

    const cleanup = await tuiPlugin.setup(context)
    await commands.find((command) => command.id?.endsWith(".worker-models"))?.run()
    await cleanup?.()

    expect(selections).toEqual(["Select worker agent", "Select model for explore"])
    expect(requests[0]).toEqual({ location: { directory: "/workspace" } })
    expect(requests[1]).toMatchObject({ name: "worker-models", text: "explore=provider/model#fast", sessionID: "session" })
  })

  test("registers the read-only sidebar.content slot and cleans up its subscriptions", async () => {
    // The sidebar contribution only registers when the host exposes session
    // tabs (the busy state comes from them); hosts without tabs skip it.
    const stopped: string[] = []
    const claims: Array<{ append?: string; render: (input: unknown) => unknown }> = []

    const cleanup = await tuiPlugin.setup(contextWithSidebar(stopped, claims))
    await cleanup?.()

    // The app slot and the sidebar.content slot are both claimed. The host
    // invokes slot renders with the active-session record ({ sessionID });
    // the fake host here threads that input shape through the app render.
    // The sidebar render is deliberately not executed in this harness: it
    // constructs OpenTUI elements that require the interactive renderer's
    // context (it throws "No renderer found" outside a live TUI), so the
    // contract pins registration and teardown while
    // test/unit/tui-sidebar.test.ts covers the pure row logic beneath the
    // render.
    expect(claims.map((claim) => claim.append)).toEqual(["app", "sidebar.content"])
    expect(typeof claims[1]?.render).toBe("function")

    // Cleanup stops the failure notice and command refresh subscriptions,
    // the app slot, then the sidebar's session-refresh and progress
    // invalidation subscriptions and
    // its own slot. `stopped` records every teardown in order.
    expect(stopped).toEqual([
      "session.execution.failed",
      "command.updated",
      "slot",
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.status",
      "session.idle",
      "session.usage.updated",
      "session.renamed",
      "session.created",
      "tui.command.execute",
      "slot",
    ])
  })

  test("fetches visible progress through the connected RPC and refreshes on idle completion", async () => {
    const stopped: string[] = []
    const handlers = new Map<string, (event: any) => void>()
    const calls: unknown[] = []
    const sessions = [{ id: "session", agent: "orchestrator", title: "Goal" }]
    const progress = unavailableProgressView("session", "test compatibility view")
    const specs = commandDefinitions(parseOptions({}))
    const context = {
      options: {},
      location: { directory: "/workspace" },
      data: {
        on: (type: string, handler: (event: any) => void) => {
          handlers.set(type, handler)
          return () => {
            stopped.push(type)
            handlers.delete(type)
          }
        },
        session: {
          list: () => sessions,
          invalidate: () => {},
          sync: async () => {},
          status: () => "idle",
          cost: () => 0,
        },
        location: {
          default: () => ({ directory: "/workspace" }),
          command: {
            sync: async () => {},
            invalidate: () => {},
            list: () => specs.map((spec) => ({ name: spec.name, description: spec.description })),
          },
        },
      },
      ui: {
        slot: (claim: { append?: string; render: (input: unknown) => unknown }) => {
          if (claim.append !== "sidebar.content") claim.render({})
          return () => stopped.push(`slot:${claim.append ?? "app"}`)
        },
        tabs: { list: () => [] },
        router: { current: () => ({ type: "session", sessionID: "session" }) },
        dialog: { alert: async () => {}, select: async () => undefined },
        toast: { show: () => {} },
      },
      keymap: { layer: (definition: () => unknown) => void definition() },
      client: {
        rpc: (definition: { id: string }) => {
          expect(definition.id).toBe("opencode-orchestrator.progress")
          return {
            get: async (input: unknown, requestOptions: unknown) => {
              calls.push({ input, requestOptions })
              return progress
            },
          }
        },
      },
    } as unknown as Context

    const cleanup = await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([{ input: { sessionID: "session" }, requestOptions: { location: { directory: "/workspace" } } }])

    handlers.get("session.idle")?.({ data: { sessionID: "session" } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toHaveLength(2)
    await cleanup?.()
    expect(stopped).toContain("session.idle")
  })

  test("keeps execution commands slash-only and configuration commands palette-only", async () => {
    const commands: Array<{ id?: string; title?: string; group?: string; palette?: boolean; slash?: { name: string } }> = []
    const specs = commandDefinitions(parseOptions({}))
    const slashSpecs = specs.filter((spec) => tuiCommandSurface(spec.name) === "slash")
    const paletteSpecs = specs.filter((spec) => tuiCommandSurface(spec.name) === "palette")
    const context = {
      options: {},
      location: { directory: "/workspace" },
      data: {
        on: () => () => {},
        location: {
          default: () => ({ directory: "/workspace" }),
          command: {
            sync: async () => {},
            invalidate: () => {},
            list: () => specs.map((spec) => ({ name: spec.name, description: spec.description })),
          },
        },
      },
      ui: {
        slot: (claim: { render: (input: Record<string, never>) => unknown }) => {
          claim.render({})
          return () => {}
        },
      },
      keymap: {
        layer: (definition: () => { commands: typeof commands }) => {
          commands.push(...definition().commands)
        },
      },
    } as unknown as Context

    const cleanup = await tuiPlugin.setup(context)
    await cleanup?.()

    // Execution workflows are owned by the server command transform, which
    // supplies native slash completion. The CLI keymap must not mirror them.
    const slashCommands = commands.filter((command) => command.slash)
    expect(slashCommands).toEqual([])
    expect(slashSpecs.map((spec) => spec.name)).toEqual(["orchestrate", "goal", "run-plan", "halt", "handover"])

    // Configuration/operator controls are palette-only. They deliberately do
    // not create slash completion entries or execution-looking `/name` titles.
    const paletteCommands = commands.filter(
      (command) => command.palette && command.id !== "opencode-orchestrator.progress",
    )
    expect(paletteCommands.map((command) => command.id?.split(".").pop()).sort()).toEqual(
      paletteSpecs.map((spec) => spec.name).sort(),
    )
    for (const command of paletteCommands) {
      expect(command.title).not.toMatch(/^\//)
      expect(command.slash).toBeUndefined()
      expect(command.group).toBe("OpenCode Orchestrator")
    }
    expect(commands.find((command) => command.title === "View orchestrator progress")?.palette).toBe(true)
  })

  test("opens the session gate picker and toggles gates through the server RPC", async () => {
    const commands: Array<{ id?: string; run(input?: string): Promise<void> | void }> = []
    const specs = commandDefinitions(parseOptions({}))
    const selections: string[] = []
    const setCalls: unknown[] = []
    const toasts: string[] = []
    let selectCalls = 0
    const gate = (name: string, state: { enabled: boolean; ceiling?: boolean; sessionDisabled?: boolean; ceilingReason?: string }) => ({
      gate: name,
      enabled: state.enabled,
      ceiling: state.ceiling ?? true,
      ceilingSource: "project",
      sessionDisabled: state.sessionDisabled ?? !state.enabled,
      ...(state.ceilingReason !== undefined ? { ceilingReason: state.ceilingReason } : {}),
    })
    const view = {
      sessionID: "session",
      gates: [
        gate("merge", { enabled: true }),
        gate("push", { enabled: false, sessionDisabled: true }),
        gate("github-mutations", { enabled: false, ceiling: false, ceilingReason: "github.enabled is off" }),
      ],
    }
    const context = {
      options: {},
      location: { directory: "/workspace" },
      data: {
        on: () => () => {},
        location: {
          default: () => ({ directory: "/workspace" }),
          command: {
            sync: async () => {},
            invalidate: () => {},
            list: () => specs.map((spec) => ({ name: spec.name, description: spec.description })),
          },
        },
      },
      ui: {
        slot: (claim: { render: (input: Record<string, never>) => unknown }) => {
          claim.render({})
          return () => {}
        },
        router: { current: () => ({ type: "session", sessionID: "session" }) },
        dialog: {
          select: async (input: { title: string }) => {
            selections.push(input.title)
            selectCalls += 1
            // First open selects the enabled `merge` row (turning it off for
            // the session); the reopened dialog closes.
            return selectCalls === 1 ? { kind: "gate", status: view.gates[0] } : { kind: "close" }
          },
          alert: async () => {},
        },
        toast: { show: (input: { message?: string }) => void toasts.push(input.message ?? "") },
      },
      keymap: {
        layer: (definition: () => { commands: typeof commands }) => {
          commands.push(...definition().commands)
        },
      },
      client: {
        rpc: (definition: { id: string }) => {
          expect(definition.id).toBe("opencode-orchestrator.gates")
          return {
            get: async () => view,
            set: async (input: unknown) => {
              setCalls.push(input)
              return { ...view, message: "'merge' is now off for this session" }
            },
          }
        },
      },
    } as unknown as Context

    const cleanup = await tuiPlugin.setup(context)
    await commands.find((command) => command.id?.endsWith(".gates"))?.run()
    await cleanup?.()

    expect(selections).toEqual(["Session gates (select to toggle)", "Session gates (select to toggle)"])
    expect(setCalls).toEqual([{ sessionID: "session", gate: "merge", disabled: true }])
    expect(toasts).toContain("'merge' is now off for this session")
  })
})

function contextWithSync(sync: Promise<void>, stopped: string[], onRender: () => void = () => {}): Context {
  return {
    options: {},
    location: { directory: "/workspace" },
    data: {
      on: (type: string) => () => stopped.push(type),
      location: {
        default: () => ({ directory: "/workspace" }),
        command: {
          sync: () => sync,
          invalidate: () => {},
          list: () => [],
        },
      },
    },
    ui: {
      slot: (claim: { render: (input: Record<string, never>) => unknown }) => {
        onRender()
        claim.render({})
        return () => stopped.push("slot")
      },
    },
    keymap: {
      layer: (definition: () => unknown) => {
        definition()
      },
    },
  } as unknown as Context
}

function contextWithSidebar(
  stopped: string[],
  claims: Array<{ append?: string; render: (input: unknown) => unknown }>,
): Context {
  return {
    options: {},
    location: { directory: "/workspace" },
    data: {
      on: (type: string) => () => void stopped.push(type),
      location: {
        default: () => ({ directory: "/workspace" }),
        command: {
          sync: async () => {},
          invalidate: () => {},
          list: () => [],
        },
      },
    },
    ui: {
      slot: (claim: { append?: string; render: (input: unknown) => unknown }) => {
        claims.push(claim)
        // The app slot render returns null and is safe to execute here; the
        // sidebar.content render needs the interactive OpenTUI renderer.
        if (claim.append !== "sidebar.content") claim.render({ sessionID: "session" })
        return () => void stopped.push("slot")
      },
      tabs: { list: () => [] },
    },
    keymap: {
      layer: (definition: () => unknown) => {
        definition()
      },
    },
  } as unknown as Context
}
