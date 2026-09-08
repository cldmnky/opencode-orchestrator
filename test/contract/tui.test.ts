import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode-ai/plugin/tui/context"
import { tuiPlugin } from "../../src/tui.js"

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
    expect(requests[1]).toMatchObject({ command: "worker-models", text: "explore=provider/model#fast", sessionID: "session" })
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
    // the app slot, then the sidebar's 8 session-refresh subscriptions and
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
      "session.usage.updated",
      "session.renamed",
      "session.created",
      "slot",
    ])
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