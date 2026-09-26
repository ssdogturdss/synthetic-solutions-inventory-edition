#!/usr/bin/env bash
#
# Exercise the restored-data gate with valid, incomplete, and corrupt restore
# fixtures. The production script still owns the SQL; these fixtures model the
# psql result so this test does not require Docker or a running PostgreSQL host.

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly VERIFY_SCRIPT="$SCRIPT_DIR/../deploy/inventory-restore-verify.sh"
readonly TEST_ROOT="$(mktemp -d)"
readonly FIXTURE_DIR="$TEST_ROOT/fixtures"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
  printf 'not ok: %s\n' "$*" >&2
  exit 1
}

assert_file_contains() {
  grep -F -- "$2" "$1" >/dev/null ||
    fail "expected $1 to contain: $2"
}

write_fixture() {
  local name="$1"
  shift
  printf '%s\n' "$@" > "$FIXTURE_DIR/$name"
}

write_fake_psql() {
  cat > "$TEST_ROOT/psql" <<'FAKE_PSQL'
#!/usr/bin/env bash
set -Eeuo pipefail
cat "$FIXTURE_DIR/${RESTORE_FIXTURE:?RESTORE_FIXTURE is required}"
FAKE_PSQL
  chmod 0700 "$TEST_ROOT/psql"
}

write_fake_docker() {
  cat > "$TEST_ROOT/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'docker %s\n' "$*" >> "$DOCKER_LOG"
cat "$FIXTURE_DIR/${RESTORE_FIXTURE:?RESTORE_FIXTURE is required}"
FAKE_DOCKER
  chmod 0700 "$TEST_ROOT/docker"
}

run_verify() {
  local case_dir="$1"
  shift
  if env \
    FIXTURE_DIR="$FIXTURE_DIR" \
    PSQL_BIN="$TEST_ROOT/psql" \
    "$@" \
    "$VERIFY_SCRIPT" > "$case_dir/output.log" 2>&1; then
    return 0
  fi

  cat "$case_dir/output.log" >&2
  return 1
}

run_verify_through_compose() {
  local case_dir="$1"
  shift
  if env \
    COMPOSE_PROJECT_DIR="$TEST_ROOT" \
    DOCKER_BIN="$TEST_ROOT/docker" \
    DOCKER_LOG="$case_dir/docker.log" \
    FIXTURE_DIR="$FIXTURE_DIR" \
    "$@" \
    "$VERIFY_SCRIPT" > "$case_dir/output.log" 2>&1; then
    return 0
  fi

  cat "$case_dir/output.log" >&2
  return 1
}

run_expected_failure() {
  local case_dir="$1"
  shift

  if run_verify "$case_dir" "$@"; then
    fail "expected restore verification to fail for $case_dir"
  fi
}

mkdir -p \
  "$FIXTURE_DIR" \
  "$TEST_ROOT/valid" \
  "$TEST_ROOT/compose" \
  "$TEST_ROOT/incomplete" \
  "$TEST_ROOT/corrupt"

write_fixture valid \
  'required_tables=ok;count=4' \
  'stores=ok;count=1' \
  'products=ok;count=2' \
  'finalized_sessions=ok;count=1' \
  'session_items=ok;count=2' \
  'relationships=ok;count=2'
write_fixture incomplete \
  'required_tables=fail;found=3'
write_fixture corrupt \
  'required_tables=ok;count=4' \
  'stores=ok;count=1' \
  'products=ok;count=2' \
  'finalized_sessions=ok;count=1' \
  'session_items=ok;count=2' \
  'relationships=fail;count=0'

write_fake_psql
write_fake_docker

test_valid_restore_passes() {
  run_verify "$TEST_ROOT/valid" RESTORE_FIXTURE=valid
  assert_file_contains "$TEST_ROOT/valid/output.log" \
    'inventory restore verification: passed'
}

test_compose_mode_passes() {
  run_verify_through_compose "$TEST_ROOT/compose" RESTORE_FIXTURE=valid
  assert_file_contains "$TEST_ROOT/compose/output.log" \
    'inventory restore verification: passed'
  assert_file_contains "$TEST_ROOT/compose/docker.log" \
    'docker compose exec -T postgres'
}

test_incomplete_restore_fails() {
  run_expected_failure "$TEST_ROOT/incomplete" RESTORE_FIXTURE=incomplete
  assert_file_contains "$TEST_ROOT/incomplete/output.log" \
    'verification failed (required_tables=ok)'
  assert_file_contains "$TEST_ROOT/incomplete/output.log" \
    'API startup remains blocked'
}

test_corrupt_restore_fails() {
  run_expected_failure "$TEST_ROOT/corrupt" RESTORE_FIXTURE=corrupt
  assert_file_contains "$TEST_ROOT/corrupt/output.log" \
    'verification failed (relationships=ok)'
  assert_file_contains "$TEST_ROOT/corrupt/output.log" \
    'API startup remains blocked'
}

test_valid_restore_passes
test_compose_mode_passes
test_incomplete_restore_fails
test_corrupt_restore_fails
printf 'ok: inventory restore verification gate behavior\n'