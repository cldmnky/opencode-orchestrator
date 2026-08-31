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