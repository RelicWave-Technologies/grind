#!/usr/bin/env bash
#
# dev-clean.sh — kill stale dev processes, then start API + agent fresh.
#
# Why this exists:
#   - The Electron agent uses app.requestSingleInstanceLock(). If an old
#     Electron instance is still running, a NEW `electron-vite dev` build
#     quits immediately and the STALE window stays up — so your code changes
#     silently never appear.
#   - The API runs under `tsx watch`. A leftover process keeps port 4000, so a
#     fresh `tsx watch` fails with EADDRINUSE while the old, possibly
#     creds-less, instance keeps answering requests.
#
# This script clears both classes of straggler, waits for port 4000 to free up,
# then hands off to `pnpm dev` (turbo runs API + agent in parallel).
#
# Dev tooling only — it does NOT change any app runtime behavior.

set -euo pipefail

# Resolve repo root from this script's location so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Port the API binds to. Prefer API_PORT from .env, fall back to 4000.
API_PORT="${API_PORT:-4000}"
if [[ -f .env ]]; then
  ENV_PORT="$(grep -E '^API_PORT=' .env 2>/dev/null | head -n1 | cut -d= -f2 | tr -d '"' | tr -d "'" | tr -d '[:space:]' || true)"
  [[ -n "${ENV_PORT:-}" ]] && API_PORT="$ENV_PORT"
fi

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *)
    echo "dev-clean: unsupported OS '$OS' — only macOS/Linux are handled."
    echo "           Skipping straggler cleanup; starting dev directly."
    exec pnpm dev
    ;;
esac

# pkill is available on both macOS and Linux. `|| true` keeps set -e happy when
# there's nothing to kill (pkill exits 1 when no process matched).
kill_match() {
  local label="$1" pattern="$2"
  if pkill -f "$pattern" 2>/dev/null; then
    echo "  killed: $label"
  fi
  true
}

echo "dev-clean: clearing stale dev processes…"
kill_match "API (tsx watch)"        "tsx watch src/index.ts"
kill_match "agent (electron-vite)"  "electron-vite dev"
kill_match "agent (electron app)"   "node_modules/electron/dist"

# Give signalled processes a beat to release sockets/locks.
sleep 1

# Wait for the API port to actually be free before starting. Use lsof if
# available (present by default on macOS and most Linux), else best-effort skip.
if command -v lsof >/dev/null 2>&1; then
  echo "dev-clean: waiting for port $API_PORT to free up…"
  for _ in $(seq 1 20); do
    if ! lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "dev-clean: WARNING — port $API_PORT is still in use. Offending process:"
    lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN || true
    echo "           Start may fail with EADDRINUSE; kill the process above and retry."
  fi
else
  echo "dev-clean: lsof not found — skipping port wait."
fi

echo "dev-clean: starting API + agent (pnpm dev)…"
exec pnpm dev
