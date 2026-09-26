#!/usr/bin/env bash
# Create one PostgreSQL dump and store it in an encrypted restic repository.
#
# This script is intended to run as root from inventory-backup.service. Keep
# the repository credentials in the root-owned EnvironmentFile used by that
# unit, not in the application .env file or this repository.

set -Eeuo pipefail

readonly RESTIC_TAG="${RESTIC_TAG:-inventory-database}"
readonly COMPOSE_PROJECT_DIR="${COMPOSE_PROJECT_DIR:-/opt/inventory}"
readonly BACKUP_DIR="${BACKUP_DIR:-/var/lib/inventory-backups}"
readonly LOCK_FILE="${LOCK_FILE:-/run/inventory-backup/backup.lock}"
readonly RESTIC_BIN="${RESTIC_BIN:-/usr/bin/restic}"
readonly DOCKER_BIN="${DOCKER_BIN:-/usr/bin/docker}"
readonly LOCAL_RETENTION_DAYS="${LOCAL_RETENTION_DAYS:-14}"
readonly RESTIC_KEEP_DAILY="${RESTIC_KEEP_DAILY:-14}"
readonly RESTIC_KEEP_WEEKLY="${RESTIC_KEEP_WEEKLY:-8}"
readonly RESTIC_KEEP_MONTHLY="${RESTIC_KEEP_MONTHLY:-12}"
readonly BACKUP_CHECK_BIN="${BACKUP_CHECK_BIN:-/usr/local/libexec/inventory-backup-check}"
readonly BACKUP_PUSH_EVENT_BIN="${BACKUP_PUSH_EVENT_BIN:-/usr/local/libexec/inventory-backup-push-event}"
readonly STATUS_FILE="${STATUS_FILE:-$BACKUP_DIR/last-run}"

failure_reason="backup command failed; inspect the systemd journal"
backup_tmp=""
backup_file=""

die() {
  failure_reason="$*"
  printf 'inventory backup: %s\n' "$*" >&2
  exit 1
}

record_status() {
  local result="$1"
  local status_tmp="${STATUS_FILE}.tmp.$$"

  {
    printf 'status=%s\n' "$result"
    printf 'finished_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [[ "$result" == "success" ]]; then
      printf 'message=backup completed and freshness was verified\n'
    else
      printf 'message=%s\n' "$failure_reason"
    fi
  } > "$status_tmp"
  chmod 0600 "$status_tmp"
  mv -- "$status_tmp" "$STATUS_FILE"
}

cleanup() {
  if [[ -n "$backup_tmp" && -e "$backup_tmp" ]]; then
    rm -f -- "$backup_tmp"
  fi
}

finish() {
  local exit_code="$?"
  set +e
  if (( exit_code == 0 )); then
    if record_status success; then
      "$BACKUP_PUSH_EVENT_BIN" backup_run healthy || true
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

[[ "$(id -u)" == "0" ]] || die "must run as root"
[[ -d "$COMPOSE_PROJECT_DIR" ]] || die "Compose project directory does not exist: $COMPOSE_PROJECT_DIR"
[[ -x "$RESTIC_BIN" ]] || die "restic executable not found: $RESTIC_BIN"
[[ -x "$DOCKER_BIN" ]] || die "docker executable not found: $DOCKER_BIN"
[[ -f "$RESTIC_PASSWORD_FILE" ]] || die "restic password file does not exist: $RESTIC_PASSWORD_FILE"
[[ "$(stat -c '%u' "$RESTIC_PASSWORD_FILE")" == "0" ]] ||
  die "restic password file must be owned by root: $RESTIC_PASSWORD_FILE"
[[ "$(stat -c '%a' "$RESTIC_PASSWORD_FILE")" == "600" ]] ||
  die "restic password file must have mode 0600: $RESTIC_PASSWORD_FILE"

[[ "$LOCAL_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] ||
  die "LOCAL_RETENTION_DAYS must be a positive integer"
[[ "$RESTIC_KEEP_DAILY" =~ ^[0-9]+$ ]] ||
  die "RESTIC_KEEP_DAILY must be a non-negative integer"
[[ "$RESTIC_KEEP_WEEKLY" =~ ^[0-9]+$ ]] ||
  die "RESTIC_KEEP_WEEKLY must be a non-negative integer"
[[ "$RESTIC_KEEP_MONTHLY" =~ ^[0-9]+$ ]] ||
  die "RESTIC_KEEP_MONTHLY must be a non-negative integer"

install -d -o root -g root -m 0700 "$BACKUP_DIR"
install -d -o root -g root -m 0700 "$(dirname "$LOCK_FILE")"

# A missed/slow transfer must not overlap the next scheduled run.
exec 9>"$LOCK_FILE"
flock -n 9 || die "another backup is already running"

cd "$COMPOSE_PROJECT_DIR"

backup_tmp="$(mktemp "$BACKUP_DIR/.inventory-XXXXXXXX.sql")"

printf 'inventory backup: dumping Compose database from %s\n' "$COMPOSE_PROJECT_DIR"
"$DOCKER_BIN" compose exec -T postgres sh -c '
  set -eu
  pg_dump --format=plain --no-owner --no-privileges \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"
' > "$backup_tmp"
test -s "$backup_tmp" || die "pg_dump produced an empty file"

backup_file="$BACKUP_DIR/inventory-$(date -u +%Y%m%dT%H%M%SZ).sql"
if [[ -e "$backup_file" ]]; then
  die "backup file already exists: $backup_file"
fi
mv -- "$backup_tmp" "$backup_file"
backup_tmp=""
chmod 0600 "$backup_file"

printf 'inventory backup: uploading encrypted snapshot\n'
"$RESTIC_BIN" backup --tag "$RESTIC_TAG" "$backup_file"

printf 'inventory backup: applying restic retention policy\n'
"$RESTIC_BIN" forget \
  --tag "$RESTIC_TAG" \
  --keep-daily "$RESTIC_KEEP_DAILY" \
  --keep-weekly "$RESTIC_KEEP_WEEKLY" \
  --keep-monthly "$RESTIC_KEEP_MONTHLY" \
  --prune

# Confirm that both copies are fresh before deleting old local dumps. The check
# reads only local file metadata and encrypted repository snapshot metadata.
"$BACKUP_CHECK_BIN"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'inventory-*.sql' \
  -mtime "+$LOCAL_RETENTION_DAYS" -delete

printf 'inventory backup: completed %s\n' "$backup_file"