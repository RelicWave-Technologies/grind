#!/usr/bin/env bash
# Package the macOS DMG via a `pnpm deploy` staging dir.
#
# Why not just `electron-builder` in-place? This is a pnpm workspace with
# shamefully-hoist, so the agent's transitive deps (e.g. color-convert's
# color-name, pulled in by sharp) live at the hoisted root, not beside the
# package that requires them. electron-builder's asar collector dedupes them
# out and the packaged app dies at launch with "Cannot find module 'color-name'".
# `pnpm deploy --prod` materializes a correct, self-contained flat node_modules
# that electron-builder can pack faithfully.
#
# Usage:
#   bash scripts/package-mac.sh [arm64|x64]
# Env:
#   SIGN=1   sign + notarize (needs a Developer ID cert in the keychain and
#            APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID). Default: unsigned.
#   MAIN_VITE_API_URL is read from apps/agent/.env.production at build time.
set -euo pipefail

ARCH="${1:-arm64}"
AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$AGENT_DIR/../.." && pwd)"
STAGE="${STAGE_DIR:-/tmp/grind-agent-deploy}"
ELECTRON_VERSION="33.2.0"

cd "$ROOT_DIR"

echo "▸ electron-vite build (bakes MAIN_VITE_API_URL from .env.production)"
pnpm --filter @grind/agent exec electron-vite build

echo "▸ pnpm deploy --prod → $STAGE"
rm -rf "$STAGE"
pnpm --filter @grind/agent deploy --prod "$STAGE"

echo "▸ staging out/ + build resources + config into deploy dir"
cp -R "$AGENT_DIR/out" "$STAGE/out"
cp -R "$AGENT_DIR/build" "$STAGE/build"
cp "$AGENT_DIR/electron-builder.yml" "$STAGE/electron-builder.yml"

# afterPack + entitlements must be ABSOLUTE paths: electron-builder resolves
# relative ones against CWD, but spawns afterPack/codesign from a different dir,
# so a relative `build/…` fails ("cannot read entitlement data").
EB_ARGS=(--mac dmg "--$ARCH" --projectDir "$STAGE" "-c.electronVersion=$ELECTRON_VERSION"
  "-c.afterPack=$STAGE/build/afterPack.cjs"
  "-c.mac.entitlements=$STAGE/build/entitlements.mac.plist"
  "-c.mac.entitlementsInherit=$STAGE/build/entitlements.mac.plist")
if [[ "${SIGN:-0}" != "1" ]]; then
  echo "▸ unsigned build (set SIGN=1 + Apple creds to sign + notarize)"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  EB_ARGS+=("-c.mac.notarize=false")
elif [[ "${NOTARIZE:-1}" != "1" ]]; then
  # Signed but not notarized — fixes TCC/Accessibility (stable signature) without
  # needing Apple ID / app-specific password. Distribution still shows the
  # "unidentified developer" Gatekeeper warning until notarized.
  echo "▸ signed build (notarization skipped — NOTARIZE=0)"
  EB_ARGS+=("-c.mac.notarize=false")
else
  echo "▸ signed + notarized build"
fi

pnpm exec electron-builder "${EB_ARGS[@]}"

mkdir -p "$AGENT_DIR/release"
cp "$STAGE"/release/*.dmg "$AGENT_DIR/release/"
echo "✓ DMG(s) → $AGENT_DIR/release/"
ls -lh "$AGENT_DIR/release/"*.dmg
