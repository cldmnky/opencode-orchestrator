#!/usr/bin/env bash
set -euo pipefail

# Local publish script for opencode-v2-agent-orchestrator
# Usage:
#   ./scripts/publish.sh              # interactive OTP prompt if needed
#   ./scripts/publish.sh --otp 123456 # provide OTP directly
#   NPM_OTP=123456 ./scripts/publish.sh
#
# Requirements: bun, npm (logged in), git, gh (for release), YubiKey touch if 2FA hardware key is enabled.
# Run from repo root where YubiKey is physically accessible.

OTP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --otp)
      OTP="$2"
      shift 2
      ;;
    --otp=*)
      OTP="${1#--otp=}"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--otp CODE]"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${OTP}" && -n "${NPM_OTP:-}" ]]; then
  OTP="${NPM_OTP}"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
echo "==> Publishing opencode-v2-agent-orchestrator@${VERSION} (tag ${TAG})"

echo "==> 1/5 typecheck"
bun run typecheck

echo "==> 2/5 test"
bun test

echo "==> 3/5 build"
bun run build
ls -lh dist/index.js dist/tui.js dist/commands.js dist/installer.js dist/cli/index.js

echo "==> 4/5 npm pack --dry-run"
npm pack --dry-run

echo "==> Verify npm auth"
if ! npm whoami >/dev/null 2>&1; then
  echo "ERROR: npm whoami failed — run 'npm login' first" >&2
  npm whoami
  exit 1
fi
echo "   npm user: $(npm whoami)"
echo "   npm latest: $(npm view opencode-v2-agent-orchestrator version 2>&1 || echo 'unknown')"

# Check if tag already exists (local or remote)
if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "   tag ${TAG} already exists locally — skipping git tag"
else
  echo "==> Creating git tag ${TAG}"
  git tag "${TAG}"
fi

if git ls-remote --tags origin | grep -q "refs/tags/${TAG}$"; then
  echo "   tag ${TAG} already pushed — skipping push"
else
  echo "==> Pushing git tag ${TAG}"
  git push origin "${TAG}"
fi

# Create tarball for manual fallback
echo "==> Packing tarball to /tmp"
TARBALL="$(npm pack --pack-destination /tmp 2>&1 | tail -n1)"
# npm pack prints filename as last line; fallback to known path
if [[ -f "/tmp/opencode-v2-agent-orchestrator-${VERSION}.tgz" ]]; then
  TARBALL="/tmp/opencode-v2-agent-orchestrator-${VERSION}.tgz"
fi
echo "   tarball: ${TARBALL} ($(du -h "${TARBALL}" | cut -f1))"

# Publish
echo "==> 5/5 npm publish (YubiKey touch may be required)"
PUBLISH_ARGS=()
if [[ -n "${OTP}" ]]; then
  PUBLISH_ARGS+=(--otp="${OTP}")
  echo "   using OTP from CLI/env"
else
  echo "   no OTP provided — npm will prompt if 2FA requires it (touch YubiKey when asked)"
fi

if npm publish "${PUBLISH_ARGS[@]:-}"; then
  echo "   npm publish succeeded"
else
  echo ""
  echo "ERROR: npm publish failed. Common fixes:" >&2
  echo "  - If you have a hardware key (YubiKey), run this script locally where you can touch the key." >&2
  echo "  - If 2FA is TOTP, generate a fresh 6-digit code and retry: $0 --otp 123456" >&2
  echo "  - Or publish the tarball directly: npm publish /tmp/opencode-v2-agent-orchestrator-${VERSION}.tgz --otp 123456" >&2
  echo "  - Check npm whoami and token: cat ~/.npmrc" >&2
  exit 1
fi

echo "==> Verify published version"
sleep 2
PUBLISHED="$(npm view opencode-v2-agent-orchestrator version 2>&1)"
echo "   npm latest is now: ${PUBLISHED}"
if [[ "${PUBLISHED}" != "${VERSION}" ]]; then
  echo "WARN: published version mismatch (expected ${VERSION}, got ${PUBLISHED})" >&2
fi

# GitHub release (if not exists)
if gh release view "${TAG}" >/dev/null 2>&1; then
  echo "   GitHub release ${TAG} already exists — skipping"
  gh release view "${TAG}" --json tagName,url | cat
else
  echo "==> Creating GitHub release ${TAG}"
  # Generate notes from git log since previous tag
  PREV_TAG="$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")"
  if [[ -n "${PREV_TAG}" ]]; then
    LOG="$(git log "${PREV_TAG}..HEAD" --pretty=format:"- %s (%h)" | head -30)"
  else
    LOG="$(git log --pretty=format:"- %s (%h)" | head -30)"
  fi
  cat > /tmp/release_notes_${VERSION}.md <<EOF
Release ${TAG}

${LOG}

Verified: bun run typecheck, bun test, bun run build

Install:
\`\`\`sh
npm i opencode-v2-agent-orchestrator@${VERSION}
npx opencode-v2-agent-orchestrator install
\`\`\`
EOF
  gh release create "${TAG}" --title "${TAG}" --notes-file "/tmp/release_notes_${VERSION}.md" --target main
  echo "   created: $(gh release view "${TAG}" --json url --jq .url)"
fi

echo ""
echo "Done. Published ${TAG} to npm and GitHub."
echo "  npm: https://www.npmjs.com/package/opencode-v2-agent-orchestrator/v/${VERSION}"
echo "  gh:  https://github.com/cldmnky/opencode-orchestrator/releases/tag/${TAG}"
echo "  verify: npm view opencode-v2-agent-orchestrator version && gh release view ${TAG}"
