import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = resolve(dirname(new URL(import.meta.url).pathname), "..")
const packageName = "opencode-v2-agent-orchestrator"
const temporary = mkdtempSync(join(tmpdir(), "opencode-orchestrator-package-"))
const packed = join(temporary, "packed")
const extracted = join(temporary, "extracted")
const consumer = join(temporary, "consumer")

try {
  mkdirSync(packed)
  mkdirSync(extracted)
  mkdirSync(join(consumer, "node_modules"), { recursive: true })

  const pack = spawnSync("npm", ["pack", "--pack-destination", packed], { cwd: root, encoding: "utf8" })
  if (pack.status !== 0) throw new Error(`npm pack failed:\n${pack.stdout}\n${pack.stderr}`)
  const tarballName = pack.stdout.trim().split(/\r?\n/).at(-1)
  if (!tarballName) throw new Error("npm pack did not report a tarball")
  const tarball = join(packed, tarballName)

  const extract = spawnSync("tar", ["-xzf", tarball, "-C", extracted], { encoding: "utf8" })
  if (extract.status !== 0) throw new Error(`tar extraction failed:\n${extract.stdout}\n${extract.stderr}`)
  const packageDirectory = join(extracted, "package")
  if (!existsSync(join(packageDirectory, "dist", "index.js"))) throw new Error("packed package has no dist/index.js")
  symlinkSync(join(root, "node_modules"), join(packageDirectory, "node_modules"), "dir")
  symlinkSync(packageDirectory, join(consumer, "node_modules", packageName), "dir")

  // Resolve peer dependencies from the repository installation without
  // downloading anything during the smoke test.
  for (const dependency of ["@opencode", "@opentui", "solid-js"]) {
    const source = join(root, "node_modules", dependency)
    if (!existsSync(source)) continue
    const target = join(consumer, "node_modules", dependency)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, "dir")
  }

  const probe = [
    `const names = [${[packageName, `${packageName}/tui`, `${packageName}/commands`, `${packageName}/installer`].map((value) => JSON.stringify(value)).join(", ")}]`,
    "for (const name of names) { const module = await import(name); if (!module || Object.keys(module).length === 0) throw new Error(`empty package export: ${name}`) }",
  ].join("; ")
  const run = spawnSync("node", ["--input-type=module", "-e", probe], { cwd: consumer, encoding: "utf8" })
  if (run.status !== 0) throw new Error(`packed package import failed:\n${run.stdout}\n${run.stderr}`)

  const packageJSON = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>
  }
  for (const subpath of [".", "./tui", "./commands", "./installer"]) {
    expectExport(packageJSON.exports, subpath)
  }
  console.log("Packed package smoke test passed.")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

function expectExport(exports: Record<string, unknown> | undefined, subpath: string): void {
  if (!exports || !(subpath in exports)) throw new Error(`package exports missing ${subpath}`)
}
