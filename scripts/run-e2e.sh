#!/usr/bin/env bash
# E2E integration test runner for Synthetic Solutions API
# Starts the API server if not already running, runs the full suite, then cleans up.
set -euo pipefail

API_PORT=9000
BASE_URL="http://localhost:${API_PORT}/api"
SERVER_PID=""
E2E_BACKUP_PUSH_TOKEN="e2e-backup-push-token-0123456789abcdef0123456789abcdef"

# ── helpers ──────────────────────────────────────────────────────────────────

server_ready() {
  curl -sf "${BASE_URL}/healthz" >/dev/null 2>&1
}

wait_for_server() {
  local elapsed=0
  local max_ms=15000   # 15-second hard cap
  local interval=500   # poll every 0.5 s
  echo "  Waiting for API server on port ${API_PORT}…"
  while ! server_ready; do
    elapsed=$((elapsed + interval))
    if [ $elapsed -ge $max_ms ]; then
      echo "  ❌ API server did not become ready after $((max_ms / 1000))s" >&2
      # Show the last log line to help diagnose the hang
      if [ -f /tmp/api-server-e2e.log ]; then
        local last_line
        last_line=$(tail -n 1 /tmp/api-server-e2e.log 2>/dev/null || true)
        echo "  Last server log line: ${last_line:-<empty>}" >&2
      fi
      return 1
    fi
    sleep 0.5
  done
  echo "  ✅ API server ready ($((elapsed / 1000)).$((elapsed % 1000 / 100))s)"
}

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    echo "  Stopping test API server (PID ${SERVER_PID})…"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── start server if not already running ──────────────────────────────────────

if server_ready; then
  echo "  API server already running on port ${API_PORT} — skipping start"
else
  echo "  Building API server…"
  (cd "$(dirname "$0")/../artifacts/api-server" && pnpm run build) 2>&1 | sed 's/^/  /'

  echo "  Starting API server on port ${API_PORT}…"
  PORT=${API_PORT} \
    DATABASE_URL="${DATABASE_URL}" \
    BACKUP_PUSH_TOKEN="${E2E_BACKUP_PUSH_TOKEN}" \
    NODE_ENV=test \
    node --enable-source-maps "$(dirname "$0")/../artifacts/api-server/dist/index.mjs" \
    >/tmp/api-server-e2e.log 2>&1 &
  SERVER_PID=$!

  wait_for_server
fi

# ── typecheck seed script against current schema ──────────────────────────────

echo ""
echo "  Typechecking seed script…"
(cd "$(dirname "$0")" && pnpm run typecheck) 2>&1 | sed 's/^/  /'
echo "  ✅ Seed typecheck passed"

# ── run the test suite ────────────────────────────────────────────────────────

echo ""
BACKUP_PUSH_TOKEN="${E2E_BACKUP_PUSH_TOKEN}" NODE_ENV=test node "$(dirname "$0")/e2e-test.mjs"
