import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode-ai/plugin/tui/context"
import { tuiPlugin } from "../../src/tui.js"

describe("TUI plugin contract", () => {
  test("registers its keymap layer before the first async boundary", async () => {
    let resolveSync: (() => void) | undefined
    const sync = new Promise<void>((resolve) => {
      resolveSync = resolve
    })
    let layerRegistered = false
    const stopped: string[] = []
    const context = contextWithSync(sync, stopped, () => {
      layerRegistered = true
    })

    const setup = tuiPlugin.setup(context)
    expect(layerRegistered).toBe(true)

    resolveSync?.()
    const cleanup = await setup
    await cleanup?.()
    expect(stopped).toEqual(["session.execution.failed", "command.updated"])
  })

  test("stops subscriptions when initial command sync fails", async () => {
    const stopped: string[] = []
    const error = new Error("sync failed")

    await expect(tuiPlugin.setup(contextWithSync(Promise.reject(error), stopped))).rejects.toBe(error)
    expect(stopped).toEqual(["session.execution.failed", "command.updated"])
  })
})

function contextWithSync(sync: Promise<void>, stopped: string[], onLayer: () => void = () => {}): Context {
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
    keymap: {
      layer: (definition: () => unknown) => {
        onLayer()
        definition()
      },
    },
  } as unknown as Context
}
