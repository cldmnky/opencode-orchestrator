import { describe, expect, test } from "bun:test"
import {
  MAX_OUTPUT_BYTES,
  ProcessTimeoutError,
  SpawnRunner,
  type ProcessResult,
} from "../../src/opencode-v2/process/runner.js"
import {
  REDACTED,
  createRedactor,
  redact,
  redactExact,
  redactKnownPatterns,
  redactProcessResult,
} from "../../src/opencode-v2/process/redact.js"
import { assertGitFamilyAllowed } from "../../src/opencode-v2/worktree/git.js"

const execPath = process.execPath
const runner = new SpawnRunner()

function nodeRun(script: string, args: readonly string[] = [], options?: { cwd?: string; env?: Record<string, string> }): Promise<ProcessResult> {
  return runner.run(execPath, ["-e", script, ...args], options)
}

describe("redaction", () => {
  test("redacts known secret patterns including bearer-style authorization", () => {
    expect(redact("Authorization: Bearer abcdef1234567890")).not.toContain("abcdef1234567890")
    expect(redact("authorization=Bearer abcdef1234567890")).toContain(REDACTED)
    expect(redact("x-api-key: k_test_12345")).not.toContain("k_test_12345")
    expect(redact("client_secret: s3cr3t-value")).toContain(REDACTED)
    expect(redact("token: abcdef")).not.toContain("abcdef")
    expect(redact("password = hunter2")).not.toContain("hunter2")
  })

  test("redacts github, pat, slack, and bearer token shapes", () => {
    expect(redact("token ghp_EXAMPLEFAKETOKENFORTEST123456")).not.toContain("ghp_")
    expect(redact("auth github_pat_EXAMPLEFAKEPATTERNFORTEST_1234567890aa")).not.toContain("github_pat_")
    expect(redact("slack xoxb-FAKE-TOKEN-FOR-TEST-EXAMPLE")).not.toContain("xoxb-")
    expect(redact("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature")).not.toContain("eyJhbGci")
  })

  test("redacts credential query parameters inside URLs", () => {
    const out = redact("https://example.com/cb?access_token=secret123&state=ok")
    expect(out).not.toContain("secret123")
    expect(out).toContain(REDACTED)
    expect(out).toContain("state=ok")
    // `auth` is only recognized as a query parameter, so this exercises the
    // URL query pattern directly rather than the keyed assignment pattern.
    const auth = redact("https://example.com/cb?auth=zzzsecret")
    expect(auth).not.toContain("zzzsecret")
    expect(auth).toContain(REDACTED)
  })

  test("replaces exact secrets including their URI-encoded form", () => {
    expect(redact("value=gho_abcDEF123456_xyz and again gho_abcDEF123456_xyz", ["gho_abcDEF123456_xyz"])).not.toContain(
      "gho_abcDEF123456_xyz",
    )
    const encoded = redactExact("filename abc%40def.txt", ["abc@def"])
    expect(encoded).not.toContain("%40")
    expect(redactExact("no secrets here", ["ghp_zz"])).toBe("no secrets here")
  })

  test("known patterns still apply when exact secrets are empty", () => {
    expect(redactKnownPatterns("token=ghp_AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPp")).not.toContain("ghp_")
  })

  test("createRedactor and redactProcessResult thread the same rules", () => {
    const redactor = createRedactor(["supersecret"])
    expect(redactor("Authorization: Bearer abc123 supersecret")).not.toContain("supersecret")
    expect(redactor("Authorization: Bearer abc123 supersecret")).not.toContain("abc123")

    const result: ProcessResult = {
      exitCode: 0,
      stdout: "token=ghp_AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPp",
      stderr: "boom supersecret",
    }
    const redacted = redactProcessResult(result, ["supersecret"])
    expect(redacted.exitCode).toBe(0)
    expect(redacted.stdout).not.toContain("ghp_")
    expect(redacted.stderr).not.toContain("supersecret")
  })

  test("does not corrupt plain git output", () => {
    const out = redact("f1c2dc0\trefs/heads/main\nM\tREADME.md")
    expect(out).toContain("refs/heads/main")
    expect(out).toContain("M\tREADME.md")
  })
})

describe("spawn runner", () => {
  test("resolves with exit code, stdout, and stderr", async () => {
    const result = await nodeRun("process.stdout.write('hello'); process.stderr.write('oops')")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello")
    expect(result.stderr).toBe("oops")
  })

  test("passes non-zero exit codes through as results", async () => {
    const result = await nodeRun("process.exit(3)")
    expect(result.exitCode).toBe(3)
  })

  test("times out long-running processes and rejects with ProcessTimeoutError", async () => {
    await expect(
      runner.run(execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 150 }),
    ).rejects.toThrow(ProcessTimeoutError)
  })

  test("bounds output to the per-stream cap", async () => {
    const result = await nodeRun(`process.stdout.write("x".repeat(${2 * 1024 * 1024}))`)
    expect(result.exitCode).toBe(0)
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 64)
    expect(result.stdout).toContain("[output truncated")
  })

  test("does not interpret shell metacharacters in args (shell: false)", async () => {
    const result = await nodeRun(
      "console.log(JSON.stringify(process.argv.slice(1)))",
      ["x; echo pwned", "$(id)", "`touch injected`", "-b", "--force"],
    )
    expect(result.stdout).toContain("x; echo pwned")
    expect(result.stdout).toContain("$(id)")
    expect(result.stdout).toContain("`touch injected`")
  })

  test("honors cwd and env overrides", async () => {
    const result = await nodeRun("console.log(process.cwd()); console.log(process.env.STAGE2_SECRET_VAR)", [], {
      cwd: "/tmp",
      env: { STAGE2_SECRET_VAR: "stage2-set" },
    })
    expect(result.stdout).toContain("/tmp")
    expect(result.stdout).toContain("stage2-set")
  })
})

describe("git arg allowlist", () => {
  test("rejects subcommands outside the allowlisted families", () => {
    expect(() => assertGitFamilyAllowed([])).toThrow(/empty/)
    expect(() => assertGitFamilyAllowed(["rm", "-rf", "/"])).toThrow(/disallowed/)
    expect(() => assertGitFamilyAllowed(["--version"])).toThrow(/disallowed/)
    expect(() => assertGitFamilyAllowed(["config", "--global", "user.name", "x"])).toThrow(/disallowed/)
  })

  test("accepts the built family shapes", () => {
    expect(() => assertGitFamilyAllowed(["worktree", "add", "-b", "feat", "--", "/wt", "main"])).not.toThrow()
    expect(() => assertGitFamilyAllowed(["worktree", "list", "--porcelain"])).not.toThrow()
    expect(() => assertGitFamilyAllowed(["rev-parse", "--is-bare-repository"])).not.toThrow()
    expect(() => assertGitFamilyAllowed(["push", "--set-upstream", "origin", "feat"])).not.toThrow()
    expect(() => assertGitFamilyAllowed(["ls-remote", "origin", "refs/heads/feat"])).not.toThrow()
    expect(() => assertGitFamilyAllowed(["status", "--porcelain"])).not.toThrow()
  })
})