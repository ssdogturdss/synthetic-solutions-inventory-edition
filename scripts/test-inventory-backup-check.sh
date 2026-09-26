#!/usr/bin/env bash
#
# Verify that the freshness watchdog records copy metadata without exposing
# repository credentials or backup contents.

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly CHECK_SCRIPT="$SCRIPT_DIR/../deploy/inventory-backup-check.sh"
readonly TIMER_FILE="$SCRIPT_DIR/../deploy/inventory-backup-check.timer"
readonly SERVICE_FILE="$SCRIPT_DIR/../deploy/inventory-backup-check.service"
readonly ENV_EXAMPLE="$SCRIPT_DIR/../deploy/inventory-backup.env.example"

if [[ "$(id -u)" != "0" ]]; then
  command -v unshare >/dev/null ||
    { printf 'inventory backup check test: unshare is required when not running as root\n' >&2; exit 1; }
  exec unshare --user --map-root-user -- "$BASH" "$0" "$@"
fi

readonly TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
readonly NOW_EPOCH="$(/usr/bin/date -u +%s)"
readonly NOW_ISO="$(/usr/bin/date -u -d "@$NOW_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
readonly MAX_AGE_HOURS=26
readonly MAX_AGE_SECONDS="$((MAX_AGE_HOURS * 3600))"
readonly PRIVATE_DUMP_CONTENT="PRIVATE_DUMP_CONTENT_SENTINEL"
readonly PRIVATE_PASSWORD_CONTENT="SENSITIVE_PASSWORD_SENTINEL"

fail() {
  printf 'not ok: %s\n' "$*" >&2
  exit 1
}

assert_file_contains() {
  grep -F -- "$2" "$1" >/dev/null ||
    fail "expected $1 to contain: $2"
}

write_fake_commands() {
  local case_dir="$1"
  mkdir -p "$case_dir/bin"

  cat > "$case_dir/bin/restic" <<'FAKE_RESTIC'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${RESTIC_MODE:-success}" == "missing" ]]; then
  printf '[]\n'
else
  printf '[{"time":"%s"}]\n' "${SNAPSHOT_TIME:?SNAPSHOT_TIME is required}"
fi
FAKE_RESTIC

  cat > "$case_dir/bin/date" <<'FAKE_DATE'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == "-u" && "${2:-}" == "+%s" && -n "${FAKE_NOW_EPOCH:-}" ]]; then
  printf '%s\n' "$FAKE_NOW_EPOCH"
else
  exec /usr/bin/date "$@"
fi
FAKE_DATE

  cat > "$case_dir/bin/jq" <<'FAKE_JQ'
#!/usr/bin/env bash
set -Eeuo pipefail
sed -n 's/.*"time":"\([^"]*\)".*/\1/p' "$3"
FAKE_JQ

  cat > "$case_dir/bin/push-event" <<'FAKE_PUSH_EVENT'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s %s\n' "$1" "$2" >> "$CASE_DIR/push-events.log"
FAKE_PUSH_EVENT

  chmod 0700 "$case_dir/bin/"*
}

new_case() {
  local name="$1"
  local case_dir="$TEST_ROOT/$name"
  mkdir -p "$case_dir/backups"
  printf '%s\n' "$PRIVATE_PASSWORD_CONTENT" > "$case_dir/password"
  chmod 0600 "$case_dir/password"
  write_fake_commands "$case_dir"
  printf '%s\n' "$case_dir"
}

run_check() {
  local case_dir="$1"
  local output="$case_dir/check.log"
  shift
  if env \
    PATH="$case_dir/bin:$PATH" \
    BACKUP_DIR="$case_dir/backups" \
    CASE_DIR="$case_dir" \
    CHECK_STATUS_FILE="$case_dir/last-check" \
    BACKUP_PUSH_EVENT_BIN="$case_dir/bin/push-event" \
    JQ_BIN="$case_dir/bin/jq" \
    RESTIC_BIN="$case_dir/bin/restic" \
    RESTIC_PASSWORD_FILE="$case_dir/password" \
    RESTIC_REPOSITORY=isolated-test-destination \
    FAKE_NOW_EPOCH="$NOW_EPOCH" \
    SNAPSHOT_TIME="$NOW_ISO" \
    "$@" \
    "$CHECK_SCRIPT" >"$output" 2>&1; then
    return 0
  else
    return 1
  fi
}

assert_safe_failure_record() {
  local case_dir="$1"
  local status_file="$case_dir/last-check"
  local output_file="$case_dir/check.log"

  [[ -f "$status_file" ]] || fail "failed check did not leave a status record"
  [[ "$(stat -c '%a' "$status_file")" == "600" ]] ||
    fail "status record must be private (mode 0600)"
  assert_file_contains "$status_file" 'status=failure'
  assert_file_contains "$status_file" 'finished_at='

  if grep -E "$PRIVATE_DUMP_CONTENT|$PRIVATE_PASSWORD_CONTENT|RESTIC_REPOSITORY|RESTIC_PASSWORD_FILE" \
    "$status_file" "$output_file" >/dev/null; then
    fail "failure details exposed backup contents or repository credentials"
  fi
}

assert_check_fails() {
  local case_dir="$1"
  shift
  if run_check "$case_dir" "$@"; then
    fail "expected freshness check to fail"
  fi
  assert_safe_failure_record "$case_dir"
}

test_success_records_freshness_metadata() {
  local case_dir
  case_dir="$(new_case success)"
  printf '%s\n' "$PRIVATE_DUMP_CONTENT" > "$case_dir/backups/inventory-current.sql"
  touch -d "@$NOW_EPOCH" "$case_dir/backups/inventory-current.sql"

  if ! run_check "$case_dir"; then
    cat "$case_dir/check.log" >&2
    fail "fresh local and off-server copies should pass"
  fi

  assert_file_contains "$case_dir/last-check" 'status=success'
  assert_file_contains "$case_dir/push-events.log" 'backup_freshness healthy'
  assert_file_contains "$case_dir/last-check" 'local_status=fresh'
  assert_file_contains "$case_dir/last-check" 'offsite_status=fresh'
  assert_file_contains "$case_dir/last-check" "max_age_hours=$MAX_AGE_HOURS"
  ! grep -E "$PRIVATE_DUMP_CONTENT|$PRIVATE_PASSWORD_CONTENT|RESTIC_REPOSITORY|RESTIC_PASSWORD_FILE" \
    "$case_dir/last-check" "$case_dir/check.log" >/dev/null ||
    fail "status metadata or output must not contain credentials or dump contents"
}

test_missing_local_copy_is_recorded() {
  local case_dir
  case_dir="$(new_case missing-local)"

  assert_check_fails "$case_dir"

  assert_file_contains "$case_dir/last-check" 'local_status=missing'
  assert_file_contains "$case_dir/last-check" 'message=local backup is missing'
}

test_missing_offsite_copy_is_recorded() {
  local case_dir
  case_dir="$(new_case missing-offsite)"
  printf '%s\n' "$PRIVATE_DUMP_CONTENT" > "$case_dir/backups/inventory-current.sql"
  touch -d "@$NOW_EPOCH" "$case_dir/backups/inventory-current.sql"

  assert_check_fails "$case_dir" RESTIC_MODE=missing

  assert_file_contains "$case_dir/last-check" 'local_status=fresh'
  assert_file_contains "$case_dir/last-check" 'offsite_status=missing'
  assert_file_contains "$case_dir/last-check" 'message=off-server backup is missing'
}

test_stale_local_copy_is_recorded() {
  local case_dir
  case_dir="$(new_case stale-local)"
  printf '%s\n' "$PRIVATE_DUMP_CONTENT" > "$case_dir/backups/inventory-old.sql"
  touch -d "@$((NOW_EPOCH - MAX_AGE_SECONDS - 1))" "$case_dir/backups/inventory-old.sql"

  assert_check_fails "$case_dir"

  assert_file_contains "$case_dir/last-check" 'local_status=stale'
  assert_file_contains "$case_dir/last-check" 'message=local backup is too old'
}

test_stale_offsite_copy_is_recorded() {
  local case_dir
  case_dir="$(new_case stale-offsite)"
  printf '%s\n' "$PRIVATE_DUMP_CONTENT" > "$case_dir/backups/inventory-current.sql"
  touch -d "@$NOW_EPOCH" "$case_dir/backups/inventory-current.sql"
  local stale_snapshot_time
  stale_snapshot_time="$(/usr/bin/date -u -d "@$((NOW_EPOCH - MAX_AGE_SECONDS - 1))" +%Y-%m-%dT%H:%M:%SZ)"

  assert_check_fails "$case_dir" "SNAPSHOT_TIME=$stale_snapshot_time"

  assert_file_contains "$case_dir/last-check" 'local_status=fresh'
  assert_file_contains "$case_dir/last-check" 'offsite_status=stale'
  assert_file_contains "$case_dir/last-check" 'message=off-server backup is too old'
}

test_copy_at_maximum_age_boundary_is_fresh() {
  local case_dir
  case_dir="$(new_case boundary)"
  local boundary_epoch="$((NOW_EPOCH - MAX_AGE_SECONDS))"
  local boundary_snapshot_time
  boundary_snapshot_time="$(/usr/bin/date -u -d "@$boundary_epoch" +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "$PRIVATE_DUMP_CONTENT" > "$case_dir/backups/inventory-boundary.sql"
  touch -d "@$boundary_epoch" "$case_dir/backups/inventory-boundary.sql"

  if ! run_check "$case_dir" "SNAPSHOT_TIME=$boundary_snapshot_time"; then
    cat "$case_dir/check.log" >&2
    fail "copies exactly at MAX_BACKUP_AGE_HOURS should remain fresh"
  fi

  assert_file_contains "$case_dir/last-check" 'status=success'
  assert_file_contains "$case_dir/last-check" 'local_status=fresh'
  assert_file_contains "$case_dir/last-check" 'offsite_status=fresh'
  assert_file_contains "$case_dir/last-check" "local_age_seconds=$MAX_AGE_SECONDS"
  assert_file_contains "$case_dir/last-check" "offsite_age_seconds=$MAX_AGE_SECONDS"
}

test_timer_runs_hourly_and_catches_up_after_missed_runs() {
  grep -Fx 'OnCalendar=hourly' "$TIMER_FILE" >/dev/null ||
    fail "freshness timer must run hourly"
  grep -Fx 'Persistent=true' "$TIMER_FILE" >/dev/null ||
    fail "freshness timer must catch up after the host was offline"
  grep -Fx 'Unit=inventory-backup-check.service' "$TIMER_FILE" >/dev/null ||
    fail "freshness timer must start the backup check service"
  grep -Fx 'ExecStart=/usr/local/libexec/inventory-backup-check' "$SERVICE_FILE" >/dev/null ||
    fail "freshness service must run the watchdog script"
  grep -Fx 'MAX_BACKUP_AGE_HOURS=26' "$ENV_EXAMPLE" >/dev/null ||
    fail "example environment must keep the freshness window explicit"
}

test_success_records_freshness_metadata
test_missing_local_copy_is_recorded
test_missing_offsite_copy_is_recorded
test_stale_local_copy_is_recorded
test_stale_offsite_copy_is_recorded
test_copy_at_maximum_age_boundary_is_fresh
test_timer_runs_hourly_and_catches_up_after_missed_runs
printf 'ok: inventory backup freshness metadata behavior\n'