#!/usr/bin/env bash
# Send only a backup alert state transition to the API. Failures are logged but
# never affect backup work or the existing journal/operator alert destinations.

set -Eeuo pipefail

readonly ISSUE="${1:?backup issue key is required}"
readonly STATE="${2:?backup alert state is required}"
readonly PUSH_URL="${BACKUP_PUSH_URL:-}"
readonly PUSH_TOKEN="${BACKUP_PUSH_TOKEN:-}"
readonly CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
readonly LOGGER_BIN="${LOGGER_BIN:-/usr/bin/logger}"
readonly TIMEOUT_SECONDS="${BACKUP_PUSH_TIMEOUT_SECONDS:-10}"

case "$ISSUE" in
  backup_run|backup_freshness) ;;
  *)
    "$LOGGER_BIN" --tag inventory-backup-push --priority err -- \
      "Invalid backup push event type; inspect the backup service configuration."
    exit 0
    ;;
esac
case "$STATE" in
  alert|healthy) ;;
  *)
    "$LOGGER_BIN" --tag inventory-backup-push --priority err -- \
      "Invalid backup push event state; inspect the backup service configuration."
    exit 0
    ;;
esac

if [[ -z "$PUSH_URL" && -z "$PUSH_TOKEN" ]]; then
  exit 0
fi
if [[ -z "$PUSH_URL" || ! "$PUSH_TOKEN" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; then
  "$LOGGER_BIN" --tag inventory-backup-push --priority err -- \
    "Backup push callback configuration is incomplete or invalid; journal and operator alerts remain available."
  exit 0
fi
if [[ ! "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  "$LOGGER_BIN" --tag inventory-backup-push --priority err -- \
    "Backup push callback timeout is invalid; journal and operator alerts remain available."
  exit 0
fi
if [[ ! -x "$CURL_BIN" ]]; then
  "$LOGGER_BIN" --tag inventory-backup-push --priority err -- \
    "Backup push callback is configured but curl is unavailable; journal and operator alerts remain available."
  exit 0
fi

escape_curl_config() {
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

escaped_url="$(printf '%s' "$PUSH_URL" | escape_curl_config)"
payload="{\"issue\":\"${ISSUE}\",\"state\":\"${STATE}\"}"
if ! printf 'url = "%s"\nheader = "Content-Type: application/json"\nheader = "X-Backup-Push-Token: %s"\nconnect-timeout = %s\nmax-time = %s\ndata = "%s"\n' \
  "$escaped_url" "$PUSH_TOKEN" "$TIMEOUT_SECONDS" "$TIMEOUT_SECONDS" "$payload" |
  "$CURL_BIN" --fail --silent --show-error --config -; then
  "$LOGGER_BIN" --tag inventory-backup-push --priority err -- \
    "Backup push callback delivery failed; journal and operator alerts remain available."
fi

exit 0