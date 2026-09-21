import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const sourceEntry = fileURLToPath(new URL("../../../src/index.ts", import.meta.url))
let buildPromise: Promise<unknown> | undefined
let outputDirectory: string | undefined

/**
 * Build the server plugin into a private temporary directory for contract
 * tests. Contract tests must never consume ignored repository `dist/` output:
 * doing so makes a stale local bundle indistinguishable from current source.
 */
export function loadBuiltPlugin(): Promise<unknown> {
  buildPromise ??= buildAndLoad()
  return buildPromise
}

function buildAndLoad(): Promise<unknown> {
  outputDirectory = mkdtempSync(join(tmpdir(), "opencode-orchestrator-contract-"))
  process.once("exit", cleanup)
  return (async () => {
    const result = await Bun.build({
      entrypoints: [sourceEntry],
      outdir: outputDirectory,
      naming: "index.js",
      target: "bun",
      format: "esm",
      sourcemap: "none",
    })
    if (!result.success) {
      const diagnostics = result.logs.map((log) => log.message).join("\n")
      cleanup()
      throw new Error(`contract plugin build failed${diagnostics ? `:\n${diagnostics}` : ""}`)
    }
    const entry = join(outputDirectory!, "index.js")
    if (!existsSync(entry)) {
      cleanup()
      throw new Error(`contract plugin build produced no entrypoint: ${entry}`)
    }
    return (await import(pathToFileURL(entry).href)).default
  })()
}

function cleanup(): void {
  if (outputDirectory === undefined) return
  rmSync(outputDirectory, { recursive: true, force: true })
  outputDirectory = undefined
}
