import { spawn } from "node:child_process"

/**
 * Injectable process runner (stage 2).
 *
 * The whole stage-2 surface (git client, worktree tools) executes processes
 * through `ProcessRunner` so tests can inject fakes and so spawn details
 * (shell off, output bounds, timeouts) live in exactly one place. Nothing in
 * this module knows about tokens, headers, or git: secret handling is layered
 * on top via `redact.ts`.
 */

export const DEFAULT_TIMEOUT_MS = 30_000

/** Per-stream output bound. Buffers stop growing past the cap and the tail is marked. */
export const MAX_OUTPUT_BYTES = 1024 * 1024

export type ProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
  /** True when stdout or stderr hit the output bound and was truncated. */
  truncated?: boolean
}

export type RunOptions = {
  cwd?: string
  timeoutMs?: number
  /** Extra environment variables merged over the inherited environment. */
  env?: Record<string, string>
}

export interface ProcessRunner {
  run(cmd: string, args: readonly string[], opts?: RunOptions): Promise<ProcessResult>
}

export class ProcessTimeoutError extends Error {
  readonly cmd: string
  readonly args: readonly string[]
  readonly stdout: string
  readonly stderr: string

  constructor(cmd: string, args: readonly string[], stdout: string, stderr: string, timeoutMs: number) {
    super(`process timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`)
    this.name = "ProcessTimeoutError"
    this.cmd = cmd
    this.args = args
    this.stdout = stdout
    this.stderr = stderr
  }
}

/**
 * Spawn-based runner: `spawn` with `shell: false`, 1 MiB output bound per
 * stream, and a default 30s timeout. A non-zero exit code is a normal result
 * (callers decide); timeouts and spawn failures reject.
 */
export class SpawnRunner implements ProcessRunner {
  async run(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<ProcessResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const cwd = opts.cwd ?? process.cwd()
    const env = mergedEnv(opts.env)

    return new Promise<ProcessResult>((resolve, reject) => {
      let child
      try {
        child = spawn(cmd, [...args], { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] })
      } catch (error) {
        reject(error)
        return
      }

      const out = collector(MAX_OUTPUT_BYTES)
      const err = collector(MAX_OUTPUT_BYTES)
      child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
      child.stderr?.on("data", (chunk: Buffer) => err.push(chunk))

      let settled = false
      let timedOut = false
      let killer: ReturnType<typeof setTimeout> | undefined
      let fallback: ReturnType<typeof setTimeout> | undefined

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (killer) clearTimeout(killer)
        if (fallback) clearTimeout(fallback)
        fn()
      }

      child.on("error", (error) => finish(() => reject(error)))

      child.on("close", (code, signal) => {
        const stdout = out.text()
        const stderr = err.text()
        if (timedOut) {
          finish(() => reject(new ProcessTimeoutError(cmd, args, stdout, stderr, timeoutMs)))
          return
        }
        finish(() =>
          resolve({
            exitCode: code ?? (signal ? 1 : -1),
            stdout,
            stderr,
            truncated: out.truncated || err.truncated,
          }),
        )
      })

      if (timeoutMs > 0) {
        // Graceful SIGTERM first, then a hard SIGKILL fallback in case the
        // process ignores TERM. Both timers are cleared on exit.
        killer = setTimeout(() => {
          timedOut = true
          try {
            child.kill("SIGTERM")
          } catch {
            // already gone
          }
          fallback = setTimeout(() => {
            try {
              child.kill("SIGKILL")
            } catch {
              // already gone
            }
          }, 1000)
        }, timeoutMs)
      }
    })
  }
}

function mergedEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  if (!extra) return process.env
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

type Collector = {
  push(chunk: Buffer): void
  readonly truncated: boolean
  text(): string
}

/** Byte-bounded stream collector; decoding happens once at the end. */
function collector(cap: number): Collector {
  let bytes = 0
  let truncated = false
  const chunks: Buffer[] = []
  return {
    get truncated() {
      return truncated
    },
    push(chunk: Buffer): void {
      if (bytes >= cap) {
        truncated = true
        return
      }
      const room = cap - bytes
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room))
        bytes = cap
        truncated = true
      } else {
        chunks.push(chunk)
        bytes += chunk.length
      }
    },
    text(): string {
      if (chunks.length === 0 && !truncated) return ""
      let text = Buffer.concat(chunks).toString("utf8")
      if (truncated) {
        text = text.slice(0, cap)
        if (!text.endsWith("\n")) text += "\n"
        text += `[output truncated at ${cap} bytes]`
      }
      return text
    },
  }
}