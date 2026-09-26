#!/usr/bin/env bash
# Verify that the newest local dump and encrypted off-server snapshot are fresh.
#
# This script intentionally reads only file timestamps and restic snapshot
# metadata. It never opens a dump or prints repository credentials.

set -Eeuo pipefail

readonly RESTIC_TAG="${RESTIC_TAG:-inventory-database}"
readonly BACKUP_DIR="${BACKUP_DIR:-/var/lib/inventory-backups}"
readonly RESTIC_BIN="${RESTIC_BIN:-/usr/bin/restic}"
readonly JQ_BIN="${JQ_BIN:-/usr/bin/jq}"
readonly MAX_BACKUP_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-26}"
readonly STATUS_FILE="${CHECK_STATUS_FILE:-$BACKUP_DIR/last-check}"
readonly BACKUP_PUSH_EVENT_BIN="${BACKUP_PUSH_EVENT_BIN:-/usr/local/libexec/inventory-backup-push-event}"

failure_reason="backup freshness check failed; inspect the systemd journal"
snapshot_tmp=""
local_status="unknown"
local_age_seconds=""
offsite_status="unknown"
offsite_age_seconds=""

fail() {
  failure_reason="$*"
  printf 'inventory backup check: %s\n' "$*" >&2
  exit 1
}

record_status() {
  local result="$1"
  local status_tmp="${STATUS_FILE}.tmp.$$"

  {
    printf 'status=%s\n' "$result"
    printf 'finished_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [[ "$result" == "success" ]]; then
      printf 'message=local and off-server backup freshness verified\n'
    else
      printf 'message=%s\n' "$failure_reason"
    fi
    printf 'max_age_hours=%s\n' "$MAX_BACKUP_AGE_HOURS"
    printf 'local_status=%s\n' "$local_status"
    if [[ -n "$local_age_seconds" ]]; then
      printf 'local_age_seconds=%s\n' "$local_age_seconds"
    fi
    printf 'offsite_status=%s\n' "$offsite_status"
    if [[ -n "$offsite_age_seconds" ]]; then
      printf 'offsite_age_seconds=%s\n' "$offsite_age_seconds"
    fi
  } > "$status_tmp"
  chmod 0600 "$status_tmp"
  mv -- "$status_tmp" "$STATUS_FILE"
}

cleanup() {
  if [[ -n "$snapshot_tmp" && -e "$snapshot_tmp" ]]; then
    rm -f -- "$snapshot_tmp"
  fi
}

finish() {
  local exit_code="$?"
  set +e
  if (( exit_code == 0 )); then
    if record_status success; then
      "$BACKUP_PUSH_EVENT_BIN" backup_freshness healthy || true
    else
      exit_code=1
    fi
  else
    record_status failure || true
  fi
  cleanup
  exit "$exit_code"
}

trap finish EXIT

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY must be set in the systemd environment file}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE must be set in the systemd environment file}"

[[ "$(id -u)" == "0" ]] || fail "must run as root"
[[ -d "$BACKUP_DIR" ]] || fail "local backup directory does not exist"
[[ -x "$RESTIC_BIN" ]] || fail "restic executable not found"
[[ -x "$JQ_BIN" ]] || fail "jq executable not found"
[[ -f "$RESTIC_PASSWORD_FILE" ]] || fail "restic password file does not exist"
[[ "$(stat -c '%u' "$RESTIC_PASSWORD_FILE")" == "0" ]] ||
  fail "restic password file must be owned by root"
[[ "$(stat -c '%a' "$RESTIC_PASSWORD_FILE")" == "600" ]] ||
  fail "restic password file must have mode 0600"
[[ "$MAX_BACKUP_AGE_HOURS" =~ ^[1-9][0-9]*$ ]] ||
  fail "MAX_BACKUP_AGE_HOURS must be a positive integer"

readonly MAX_BACKUP_AGE_SECONDS="$((MAX_BACKUP_AGE_HOURS * 3600))"

now_epoch="$(date -u +%s)"
latest_local_epoch=""
while IFS= read -r local_file; do
  latest_local_epoch="$(stat -c '%Y' -- "$local_file")"
  break
done < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'inventory-*.sql' \
    -printf '%T@ %p\n' | sort -nr | sed 's/^[^ ]* //'
)

[[ -n "$latest_local_epoch" ]] ||
  { local_status="missing"; fail "local backup is missing; run the backup service and inspect its journal"; }
local_age_seconds="$((now_epoch - latest_local_epoch))"
(( local_age_seconds < 0 )) && local_age_seconds=0
local_status="fresh"
(( local_age_seconds <= MAX_BACKUP_AGE_SECONDS )) ||
  { local_status="stale"; fail "local backup is too old (age=${local_age_seconds}s, max=${MAX_BACKUP_AGE_SECONDS}s)"; }

snapshot_tmp="$(mktemp "$BACKUP_DIR/.inventory-snapshots-XXXXXXXX.json")"
if ! "$RESTIC_BIN" snapshots --json --tag "$RESTIC_TAG" > "$snapshot_tmp"; then
  fail "off-server backup metadata is unavailable; verify restic repository access"
fi

latest_snapshot_time="$("$JQ_BIN" -r '
  if length == 0 then empty else sort_by(.time) | .[-1].time end
' "$snapshot_tmp")" || fail "off-server backup metadata is invalid"
[[ -n "$latest_snapshot_time" ]] ||
  { offsite_status="missing"; fail "off-server backup is missing; verify the upload and restic repository"; }

if ! latest_offsite_epoch="$(date -u -d "$latest_snapshot_time" +%s 2>/dev/null)"; then
  fail "off-server backup timestamp is invalid"
fi
offsite_age_seconds="$((now_epoch - latest_offsite_epoch))"
(( offsite_age_seconds < 0 )) && offsite_age_seconds=0
offsite_status="fresh"
(( offsite_age_seconds <= MAX_BACKUP_AGE_SECONDS )) ||
  { offsite_status="stale"; fail "off-server backup is too old (age=${offsite_age_seconds}s, max=${MAX_BACKUP_AGE_SECONDS}s)"; }

printf 'inventory backup check: local and off-server copies are fresh (max age %ss)\n' \
  "$MAX_BACKUP_AGE_SECONDS"