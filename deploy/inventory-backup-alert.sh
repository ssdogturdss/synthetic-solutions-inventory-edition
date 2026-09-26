#!/usr/bin/env bash
# Emit an actionable backup alert without including credentials or dump data.

set -Eeuo pipefail

readonly FAILED_UNIT="${1:?failed systemd unit is required}"
readonly ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
readonly CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
readonly LOGGER_BIN="${LOGGER_BIN:-/usr/bin/logger}"
readonly ALERT_TIMEOUT_SECONDS="${ALERT_TIMEOUT_SECONDS:-15}"
readonly BACKUP_PUSH_EVENT_BIN="${BACKUP_PUSH_EVENT_BIN:-/usr/local/libexec/inventory-backup-push-event}"

message="ACTION REQUIRED: ${FAILED_UNIT} failed. Check 'journalctl -u ${FAILED_UNIT} -n 100 --no-pager'; restore service health before relying on inventory data."

# The journal is always an alert destination, including when no external
# webhook has been configured.
"$LOGGER_BIN" --tag inventory-backup-alert --priority alert -- "$message"

case "$FAILED_UNIT" in
  inventory-backup.service)
    "$BACKUP_PUSH_EVENT_BIN" backup_run alert || true
    ;;
  inventory-backup-check.service)
    "$BACKUP_PUSH_EVENT_BIN" backup_freshness alert || true
    ;;
esac

if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
  "$LOGGER_BIN" --tag inventory-backup-alert --priority warning -- \
    "No ALERT_WEBHOOK_URL is configured; the backup failure is recorded in the systemd journal."
  exit 0
fi

[[ -x "$CURL_BIN" ]] || {
  "$LOGGER_BIN" --tag inventory-backup-alert --priority err -- \
    "ALERT_WEBHOOK_URL is configured but curl is unavailable; inspect the systemd journal."
  exit 1
}

# Keep the URL and payload on curl's stdin rather than exposing them in the
# process argument list. The payload contains only the failed unit and advice.
escape_curl_config() {
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

escaped_url="$(printf '%s' "$ALERT_WEBHOOK_URL" | escape_curl_config)"
escaped_message="$(printf '%s' "$message" | escape_curl_config)"
if ! printf 'url = "%s"\nheader = "Content-Type: text/plain"\nconnect-timeout = %s\nmax-time = %s\ndata = "%s"\n' \
  "$escaped_url" "$ALERT_TIMEOUT_SECONDS" "$ALERT_TIMEOUT_SECONDS" "$escaped_message" |
  "$CURL_BIN" --fail --silent --show-error --config -; then
  "$LOGGER_BIN" --tag inventory-backup-alert --priority err -- \
    "Backup alert webhook delivery failed; inspect the systemd journal and configured alert endpoint."
  exit 1
fi

printf 'inventory backup alert: notified configured operator endpoint for %s\n' "$FAILED_UNIT"