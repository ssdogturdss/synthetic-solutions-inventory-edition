#!/usr/bin/env bash
#
# Exercise deploy/inventory-backup.sh without a database or an off-server
# destination. The production wrapper requires root because systemd runs it as
# root; use an isolated user namespace when this test starts as an unprivileged
# user.

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly BACKUP_SCRIPT="$SCRIPT_DIR/../deploy/inventory-backup.sh"

if [[ "$(id -u)" != "0" ]]; then
  command -v unshare >/dev/null ||
    { printf 'inventory backup test: unshare is required when not running as root\n' >&2; exit 1; }
  exec unshare --user --map-root-user -- "$BASH" "$0" "$@"
fi

readonly TEST_ROOT="$(mktemp -d)"
readonly FAKE_COMMANDS_DIR="$TEST_ROOT/bin"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
  printf 'not ok: %s\n' "$*" >&2
  exit 1
}

assert_file_exists() {
  [[ -e "$1" ]] || fail "expected file to exist: $1"
}

assert_file_missing() {
  [[ ! -e "$1" ]] || fail "expected file to be absent: $1"
}

assert_file_contains() {
  grep -F -- "$2" "$1" >/dev/null ||
    fail "expected $1 to contain: $2"
}

assert_file_not_contains() {
  ! grep -F -- "$2" "$1" >/dev/null ||
    fail "expected $1 not to contain: $2"
}

write_fake_commands() {
  local case_dir="$1"

  mkdir -p "$case_dir/bin"

  cat > "$case_dir/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail

printf 'docker %s\n' "$*" >> "$CASE_DIR/commands.log"
if [[ "${DOCKER_MODE:-success}" == "database-failure" ]]; then
  printf 'partial dump from the database\n'
  exit 31
fi
printf 'CREATE TABLE inventory_test (id integer);\n'
FAKE_DOCKER

  cat > "$case_dir/bin/restic" <<'FAKE_RESTIC'
#!/usr/bin/env bash
set -Eeuo pipefail

printf 'restic %s\n' "$*" >> "$CASE_DIR/commands.log"
case "$1" in
  backup)
    [[ -f "${!#}" ]] || exit 32
    if [[ "${RESTIC_MODE:-success}" == "upload-failure" ]]; then
      printf 'simulated encrypted destination failure\n' >&2
      exit 33
    fi
    printf 'encrypted snapshot accepted\n' >> "$CASE_DIR/destination.log"
    ;;
  forget)
    printf 'retention policy applied\n' >> "$CASE_DIR/destination.log"
    ;;
  *)
    exit 34
    ;;
esac
FAKE_RESTIC

  cat > "$case_dir/bin/check" <<'FAKE_CHECK'
#!/usr/bin/env bash
set -Eeuo pipefail

printf 'freshness check\n' >> "$CASE_DIR/commands.log"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'inventory-*.sql' -print -quit |
  grep -q . 
FAKE_CHECK

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

  mkdir -p "$case_dir/compose" "$case_dir/backups"
  printf 'test-only restic password\n' > "$case_dir/password"
  chmod 0600 "$case_dir/password"
  write_fake_commands "$case_dir"
  printf '%s\n' "$case_dir"
}

run_backup() {
  local case_dir="$1"
  shift

  if env \
    BACKUP_CHECK_BIN="$case_dir/bin/check" \
    BACKUP_PUSH_EVENT_BIN="$case_dir/bin/push-event" \
    BACKUP_DIR="$case_dir/backups" \
    CASE_DIR="$case_dir" \
    COMPOSE_PROJECT_DIR="$case_dir/compose" \
    DOCKER_BIN="$case_dir/bin/docker" \
    LOCK_FILE="$case_dir/lock/backup.lock" \
    RESTIC_BIN="$case_dir/bin/restic" \
    RESTIC_PASSWORD_FILE="$case_dir/password" \
    RESTIC_REPOSITORY=isolated-test-destination \
    RESTIC_TAG=inventory-database \
    STATUS_FILE="$case_dir/status" \
    "$@" \
    "$BACKUP_SCRIPT" > "$case_dir/output.log" 2>&1; then
    return 0
  fi

  cat "$case_dir/output.log" >&2
  return 1
}

run_expected_failure() {
  local case_dir="$1"
  shift

  if run_backup "$case_dir" "$@"; then
    fail "expected backup to fail for $case_dir"
  fi
}

count_local_dumps() {
  find "$1" -maxdepth 1 -type f -name 'inventory-*.sql' -print | wc -l
}

test_successful_backup_applies_retention_after_verification() {
  local case_dir old_dump recent_dump
  case_dir="$(new_case success)"
  old_dump="$case_dir/backups/inventory-old.sql"
  recent_dump="$case_dir/backups/inventory-recent.sql"

  printf 'retained old dump\n' > "$old_dump"
  printf 'retained recent dump\n' > "$recent_dump"
  touch -d '20 days ago' "$old_dump"
  touch -d '1 day ago' "$recent_dump"

  run_backup "$case_dir" LOCAL_RETENTION_DAYS=14

  assert_file_exists "$recent_dump"
  assert_file_missing "$old_dump"
  [[ "$(count_local_dumps "$case_dir/backups")" -eq 2 ]] ||
    fail "successful backup should leave the recent and current dumps"
  assert_file_contains "$case_dir/destination.log" 'encrypted snapshot accepted'
  assert_file_contains "$case_dir/destination.log" 'retention policy applied'
  assert_file_contains "$case_dir/commands.log" 'restic backup --tag inventory-database'
  assert_file_contains "$case_dir/commands.log" 'restic forget --tag inventory-database'
  assert_file_contains "$case_dir/commands.log" 'freshness check'
  assert_file_contains "$case_dir/status" 'status=success'
  assert_file_contains "$case_dir/push-events.log" 'backup_run healthy'
  [[ -z "$(find "$case_dir/backups" -maxdepth 1 -name '.inventory-*.sql' -print -quit)" ]] ||
    fail "temporary dump should be cleaned up after a successful backup"
}

test_database_failure_preserves_retained_dump() {
  local case_dir retained_dump
  case_dir="$(new_case database-failure)"
  retained_dump="$case_dir/backups/inventory-retained.sql"
  printf 'last known good dump\n' > "$retained_dump"
  touch -d '20 days ago' "$retained_dump"

  run_expected_failure "$case_dir" DOCKER_MODE=database-failure

  assert_file_exists "$retained_dump"
  [[ "$(count_local_dumps "$case_dir/backups")" -eq 1 ]] ||
    fail "database failure should not delete retained dumps or create a backup"
  assert_file_not_contains "$case_dir/commands.log" 'restic '
  assert_file_not_contains "$case_dir/commands.log" 'freshness check'
  assert_file_contains "$case_dir/status" 'status=failure'
}

test_upload_failure_preserves_new_and_retained_dumps() {
  local case_dir retained_dump
  case_dir="$(new_case upload-failure)"
  retained_dump="$case_dir/backups/inventory-retained.sql"
  printf 'last known good dump\n' > "$retained_dump"
  touch -d '20 days ago' "$retained_dump"

  run_expected_failure "$case_dir" RESTIC_MODE=upload-failure

  assert_file_exists "$retained_dump"
  [[ "$(count_local_dumps "$case_dir/backups")" -eq 2 ]] ||
    fail "upload failure should preserve the newly created and retained dumps"
  assert_file_contains "$case_dir/commands.log" 'restic backup --tag inventory-database'
  assert_file_not_contains "$case_dir/commands.log" 'restic forget '
  assert_file_not_contains "$case_dir/commands.log" 'freshness check'
  assert_file_contains "$case_dir/status" 'status=failure'
}

test_successful_backup_applies_retention_after_verification
test_database_failure_preserves_retained_dump
test_upload_failure_preserves_new_and_retained_dumps
printf 'ok: inventory backup wrapper failure and retention behavior\n'