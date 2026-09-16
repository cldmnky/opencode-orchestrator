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

  test("replaces exact secrets with reserved characters in raw and URI-encoded form", () => {
    const secret = "FAKE/EXACT?VALUE&ONLY=1"
    const encoded = encodeURIComponent(secret)
    const out = redactExact(`raw ${secret} encoded ${encoded}`, [secret])
    expect(out).toBe(`raw ${REDACTED} encoded ${REDACTED}`)
    // A space-bearing secret is only ever seen encoded inside a URL.
    expect(redact(`?next=${encodeURIComponent("FAKE SECRET VALUE")}`, ["FAKE SECRET VALUE"])).toBe(`?next=${REDACTED}`)
    // Empty entries are skipped instead of matching every position.
    expect(redactExact("unchanged", ["", ""])).toBe("unchanged")
    expect(redactExact("unchanged", [])).toBe("unchanged")
  })

  test("preserves surrounding substrings and does not over-match partial parameter names", () => {
    expect(redactExact("prefixFAKEMARKERsuffix", ["FAKEMARKER"])).toBe(`prefix${REDACTED}suffix`)
    // Only whole key words followed by `:`/`=` are keyed secrets: `tokenizer`
    // and `authorization_code` are different words and stay readable.
    expect(redact("tokenizer=fast authorization_code=abc")).toBe("tokenizer=fast authorization_code=abc")
  })

  test("redacts multiline mixed output without dropping benign lines", () => {
    const raw = [
      "diff --git a/src/app.ts b/src/app.ts",
      "Authorization: Bearer FAKE-BEARER-TOKEN-FOR-TEST-0001",
      "api_key=FAKE-API-KEY-FOR-TEST-0002",
      "https://example.invalid/cb?access_token=FAKE-QUERY-TOKEN-0003&state=ok",
      "const FAKE_EXACT_SECRET_0004 = read()",
      "plain status line",
    ].join("\n")
    const out = redact(raw, ["FAKE_EXACT_SECRET_0004"])
    expect(out.split("\n")).toHaveLength(6)
    expect(out).not.toContain("FAKE-BEARER-TOKEN-FOR-TEST-0001")
    expect(out).not.toContain("FAKE-API-KEY-FOR-TEST-0002")
    expect(out).not.toContain("FAKE-QUERY-TOKEN-0003")
    expect(out).not.toContain("FAKE_EXACT_SECRET_0004")
    expect(out).toContain("diff --git a/src/app.ts b/src/app.ts")
    expect(out).toContain("state=ok")
    expect(out).toContain("plain status line")
    expect(out).toContain(REDACTED)
  })

  test("handles query-like text conservatively", () => {
    const out = redact("https://example.invalid/cb?secret=FAKE-QUERY-SECRET-0001&next=1")
    expect(out).not.toContain("FAKE-QUERY-SECRET-0001")
    expect(out).toContain("next=1")
    expect(out).toContain(REDACTED)
    // Unrecognized parameters and bare words are left readable.
    expect(redact("plain?mode=read&tokenizer=fast")).toBe("plain?mode=read&tokenizer=fast")
  })

  test("hint-path redaction: advisory-output-shaped text keeps its structure with a no-secret control", () => {
    // The opt-in generation-hint post-step runs model output through this
    // exact canonical API before bounding it: known patterns plus caller-known
    // exact secrets (threaded only where wired), structure preserved.
    const secret = "FAKE-CALLER-KNOWN-SECRET-01"
    const output = [
      "Keep the receipt scoped.",
      "Authorization: Bearer FAKE-BEARER-TOKEN-FOR-TEST-02",
      `value=${secret}`,
      "verified",
    ].join("\n")
    const out = redact(output, [secret])
    expect(out).not.toContain("FAKE-BEARER-TOKEN-FOR-TEST-02")
    expect(out).not.toContain(secret)
    expect(out.split("\n")).toHaveLength(4)
    expect(out).toContain("Keep the receipt scoped.")
    expect(out).toContain("verified")

    // No-secret control: safe advisory text is unchanged by both layers.
    const control = "Keep the receipt scoped and verified."
    expect(redact(control, [secret])).toBe(control)
    expect(redact(control, [])).toBe(control)
  })

  test("applies known patterns with an empty secret list and skips empty exact secrets", () => {
    expect(redact("token=FAKE-KEYED-VALUE", [])).toBe(redactKnownPatterns("token=FAKE-KEYED-VALUE"))
    expect(redact("token=FAKE-KEYED-VALUE", [])).not.toContain("FAKE-KEYED-VALUE")
    expect(redactExact("ghp_EXAMPLEFAKETOKENFORTEST123456", [])).toBe("ghp_EXAMPLEFAKETOKENFORTEST123456")
    expect(createRedactor()("password=FAKE-PASSWORD-VALUE")).not.toContain("FAKE-PASSWORD-VALUE")
  })

  test("redactProcessResult preserves the envelope and never mutates its input", () => {
    const original: ProcessResult = {
      exitCode: 7,
      stdout: "Bearer FAKE-BEARER-TOKEN-FOR-TEST",
      stderr: "password=FAKE-PASSWORD-VALUE",
      truncated: true,
    }
    const redacted = redactProcessResult(original, ["FAKE-BEARER-TOKEN-FOR-TEST"])
    expect(redacted.exitCode).toBe(7)
    expect(redacted.truncated).toBe(true)
    expect(redacted.stdout).not.toContain("FAKE-BEARER-TOKEN-FOR-TEST")
    expect(redacted.stderr).not.toContain("FAKE-PASSWORD-VALUE")
    expect(redacted.stderr).toContain(REDACTED)
    // The input result object is never mutated in place.
    expect(original.stdout).toContain("FAKE-BEARER-TOKEN-FOR-TEST")
    expect(original.stderr).toContain("FAKE-PASSWORD-VALUE")
    // Nothing to do: the same reference is returned.
    const empty: ProcessResult = { exitCode: 0, stdout: "", stderr: "" }
    expect(redactProcessResult(empty)).toBe(empty)
    expect(redactProcessResult({ ...empty, stdout: "token=FAKE-KEYED-VALUE" }, []).stdout).not.toContain("FAKE-KEYED-VALUE")
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