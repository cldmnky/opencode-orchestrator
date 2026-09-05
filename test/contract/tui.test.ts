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
