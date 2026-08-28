import type { ProcessResult } from "./runner.js"

/**
 * Log redaction (stage 2).
 *
 * Two layers: known secret *patterns* (authorization headers, bearer tokens,
 * GitHub/Slack token formats, credential query parameters) and *exact*
 * caller-known secrets (including their URI-encoded form). No raw token is
 * ever logged by the worktree stage: tools thread `secrets` through here
 * before any output reaches a transcript.
 */

export const REDACTED = "[redacted]"

/** `key: value` or `key=value` credential pairs, keeping the key readable. */
const KEYED_PATTERN =
  /\b(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;&#]+/gi

/** Credential query parameters in URLs, keeping the parameter name. */
const KEYED_QUERY_PATTERN = /([?&](?:access_token|api_key|apikey|token|password|secret|client_secret|auth)=)[^&#\s]*/gi

const GITHUB_TOKEN_PATTERN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g
const GITHUB_PAT_PATTERN = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi

/** Redact every known secret shape. Order matters: keyed rules keep the key. */
export function redactKnownPatterns(text: string): string {
  return text
    .replace(KEYED_PATTERN, (_match, key: string) => `${key}: ${REDACTED}`)
    .replace(KEYED_QUERY_PATTERN, (_match, key: string) => `${key}${REDACTED}`)
    .replace(GITHUB_TOKEN_PATTERN, REDACTED)
    .replace(GITHUB_PAT_PATTERN, REDACTED)
    .replace(SLACK_TOKEN_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, REDACTED)
}

/**
 * Replace every known exact secret, plus its URI-encoded form so a token
 * echoed inside a URL is caught too. Plain split/join avoids regex escaping.
 */
export function redactExact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (!secret || secret.length === 0) continue
    out = out.split(secret).join(REDACTED)
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) out = out.split(encoded).join(REDACTED)
  }
  return out
}

/** Apply known-pattern redaction first, then exact secret replacement. */
export function redact(text: string, secrets: readonly string[] = []): string {
  return redactExact(redactKnownPatterns(text), secrets)
}

/** Build a reusable redactor bound to a fixed secret set. */
export function createRedactor(secrets: readonly string[] = []): (text: string) => string {
  return (text) => redact(text, secrets)
}

/** Redact a process result in place of field copies, preserving exit code. */
export function redactProcessResult(result: ProcessResult, secrets: readonly string[] = []): ProcessResult {
  if (secrets.length === 0 && !result.stdout && !result.stderr) return result
  return { ...result, stdout: redact(result.stdout, secrets), stderr: redact(result.stderr, secrets) }
}