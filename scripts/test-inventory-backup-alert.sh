#!/usr/bin/env bash
#
# Simulate failed backup units and verify their OnFailure alert reaches the
# configured webhook without writing credentials or backup data to the journal
# or webhook payload. This checks the unit wiring and alert process without
# requiring a running systemd instance or external network access.

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly BACKUP_SCRIPT="$PROJECT_DIR/deploy/inventory-backup.sh"
readonly CHECK_SCRIPT="$PROJECT_DIR/deploy/inventory-backup-check.sh"
readonly ALERT_SCRIPT="$PROJECT_DIR/deploy/inventory-backup-alert.sh"
readonly ALERT_SERVICE="$PROJECT_DIR/deploy/inventory-backup-alert@.service"

if [[ "$(id -u)" != "0" ]]; then
  command -v unshare >/dev/null ||
    { printf 'inventory backup alert test: unshare is required when not running as root\n' >&2; exit 1; }
  exec unshare --user --map-root-user -- "$BASH" "$0" "$@"
fi

readonly TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
  printf 'not ok: %s\n' "$*" >&2
  exit 1
}

assert_file_contains() {
  grep -F -- "$2" "$1" >/dev/null ||
    fail "expected $1 to contain required alert text"
}

assert_file_not_contains() {
  ! grep -F -- "$2" "$1" >/dev/null ||
    fail "sensitive test data appeared in $1"
}

read_on_failure() {
  local service_file="$1"
  local on_failure
  on_failure="$(sed -n 's/^OnFailure=//p' "$service_file")"
  [[ -n "$on_failure" ]] || fail "missing OnFailure in $service_file"
  printf '%s\n' "$on_failure"
}

mkdir -p "$TEST_ROOT/bin"

cat > "$TEST_ROOT/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
cat "$DUMP_SOURCE"
exit 31
FAKE_DOCKER

cat > "$TEST_ROOT/bin/logger" <<'FAKE_LOGGER'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$JOURNAL_CAPTURE"
FAKE_LOGGER

cat > "$TEST_ROOT/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$*" == "--fail --silent --show-error --config -" ]] || exit 40
cat > "$CURL_CONFIG_CAPTURE"
if grep -F 'X-Backup-Push-Token:' "$CURL_CONFIG_CAPTURE" >/dev/null; then
  cp "$CURL_CONFIG_CAPTURE" "$PUSH_CONFIG_CAPTURE"
  sed -n 's/^data = "\(.*\)"$/\1/p' "$CURL_CONFIG_CAPTURE" > "$PUSH_PAYLOAD_CAPTURE"
  printf 'push\n' >> "$CURL_CALL_CAPTURE"
  [[ "${PUSH_CURL_FAIL:-0}" != "1" ]] || exit 22
  exit 0
fi
sed -n 's/^data = "\(.*\)"$/\1/p' "$CURL_CONFIG_CAPTURE" > "$WEBHOOK_PAYLOAD_CAPTURE"
sed -n 's/^url = "\(.*\)"$/\1/p' "$CURL_CONFIG_CAPTURE" > "$WEBHOOK_URL_CAPTURE"
printf 'webhook\n' >> "$CURL_CALL_CAPTURE"
FAKE_CURL

chmod 0700 "$TEST_ROOT/bin/logger" "$TEST_ROOT/bin/curl"

readonly REPOSITORY_URL='s3://repo-user-canary:repo-secret-canary@storage.invalid/inventory'
readonly REPOSITORY_PASSWORD='restic-password-canary-167'
readonly DATABASE_URL='postgresql://synthetic.invalid/inventory'
readonly AWS_ACCESS_KEY='storage-access-canary'
readonly AWS_SECRET_KEY='storage-secret-canary'
readonly DUMP_CONTENT='private-dump-content-canary-167'
readonly WEBHOOK_URL='https://operator.invalid/hooks/webhook-token-canary'
readonly PUSH_URL='https://api.invalid/api/backup/events'
readonly PUSH_TOKEN='backup-push-token-canary-0123456789abcdef0123456789abcdef'

simulate_failed_unit() {
  local failed_unit="$1"
  local unit_file="$2"
  local case_dir="$TEST_ROOT/${failed_unit%.service}"
  local on_failure
  local alert_instance
  local expected_message
  local marker
  local -a canaries=(
    "$REPOSITORY_URL"
    "$REPOSITORY_PASSWORD"
    "$DATABASE_URL"
    "$AWS_ACCESS_KEY"
    "$AWS_SECRET_KEY"
    "$DUMP_CONTENT"
    "$WEBHOOK_URL"
    "$PUSH_TOKEN"
  )

  mkdir -p "$case_dir"
  mkdir -p "$case_dir/compose" "$case_dir/backups"
  printf '%s\n' "$DUMP_CONTENT" > "$case_dir/dump-source.sql"
  printf '%s\n' "$REPOSITORY_PASSWORD" > "$case_dir/restic-password"
  chmod 0600 "$case_dir/restic-password"

  # Run the real service command with deterministic failures, then model
  # systemd's OnFailure template activation and %i argument expansion.
  case "$failed_unit" in
    inventory-backup.service)
      if env -i \
        PATH="$PATH" \
        BACKUP_CHECK_BIN=/usr/bin/true \
        BACKUP_DIR="$case_dir/backups" \
        COMPOSE_PROJECT_DIR="$case_dir/compose" \
        DATABASE_URL="$DATABASE_URL" \
        DOCKER_BIN="$TEST_ROOT/bin/docker" \
        DUMP_SOURCE="$case_dir/dump-source.sql" \
        AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY" \
        AWS_SECRET_ACCESS_KEY="$AWS_SECRET_KEY" \
        LOCK_FILE="$case_dir/run/backup.lock" \
        RESTIC_BIN=/usr/bin/true \
        RESTIC_PASSWORD="$REPOSITORY_PASSWORD" \
        RESTIC_PASSWORD_FILE="$case_dir/restic-password" \
        RESTIC_REPOSITORY="$REPOSITORY_URL" \
        STATUS_FILE="$case_dir/last-run" \
        "$BACKUP_SCRIPT" > "$case_dir/unit-journal.log" 2>&1; then
        fail "simulated $failed_unit unexpectedly succeeded"
      fi
      ;;
    inventory-backup-check.service)
      printf '%s\n' "$DUMP_CONTENT" > "$case_dir/backups/inventory-stale.sql"
      touch -d '2 days ago' "$case_dir/backups/inventory-stale.sql"
      if env -i \
        PATH="$PATH" \
        BACKUP_DIR="$case_dir/backups" \
        CHECK_STATUS_FILE="$case_dir/last-check" \
        DATABASE_URL="$DATABASE_URL" \
        AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY" \
        AWS_SECRET_ACCESS_KEY="$AWS_SECRET_KEY" \
        JQ_BIN=/usr/bin/true \
        RESTIC_PASSWORD="$REPOSITORY_PASSWORD" \
        RESTIC_PASSWORD_FILE="$case_dir/restic-password" \
        RESTIC_REPOSITORY="$REPOSITORY_URL" \
        RESTIC_BIN=/usr/bin/true \
        "$CHECK_SCRIPT" > "$case_dir/unit-journal.log" 2>&1; then
        fail "simulated $failed_unit unexpectedly succeeded"
      fi
      ;;
    *)
      fail "unsupported simulated unit: $failed_unit"
      ;;
  esac

  on_failure="$(read_on_failure "$unit_file")"
  [[ "$on_failure" == "inventory-backup-alert@${failed_unit}" ]] ||
    fail "$unit_file must alert through the failed unit's template instance"
  [[ "$on_failure" == inventory-backup-alert@* ]] ||
    fail "unexpected alert unit configured by $unit_file"
  alert_instance="${on_failure#inventory-backup-alert@}"

  env -i \
    PATH="$PATH" \
    RESTIC_REPOSITORY="$REPOSITORY_URL" \
    RESTIC_PASSWORD="$REPOSITORY_PASSWORD" \
    RESTIC_PASSWORD_FILE="$case_dir/restic-password" \
    DATABASE_URL="$DATABASE_URL" \
    AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$AWS_SECRET_KEY" \
    ALERT_WEBHOOK_URL="$WEBHOOK_URL" \
    BACKUP_PUSH_URL="$PUSH_URL" \
    BACKUP_PUSH_TOKEN="$PUSH_TOKEN" \
    BACKUP_PUSH_EVENT_BIN="$PROJECT_DIR/deploy/inventory-backup-push-event.sh" \
    PUSH_CURL_FAIL=1 \
    LOGGER_BIN="$TEST_ROOT/bin/logger" \
    CURL_BIN="$TEST_ROOT/bin/curl" \
    JOURNAL_CAPTURE="$case_dir/journal.log" \
    CURL_CONFIG_CAPTURE="$case_dir/curl.config" \
    CURL_CALL_CAPTURE="$case_dir/curl.calls" \
    PUSH_CONFIG_CAPTURE="$case_dir/push.config" \
    PUSH_PAYLOAD_CAPTURE="$case_dir/push.payload" \
    WEBHOOK_PAYLOAD_CAPTURE="$case_dir/webhook.payload" \
    WEBHOOK_URL_CAPTURE="$case_dir/webhook.url" \
    "$ALERT_SCRIPT" "$alert_instance" > "$case_dir/alert-process.log" 2>&1 ||
    fail "alert script failed for $failed_unit"

  cat \
    "$case_dir/unit-journal.log" \
    "$case_dir/journal.log" \
    "$case_dir/alert-process.log" > "$case_dir/all-journal-output.log"

  [[ "$(grep -xc 'push' "$case_dir/curl.calls")" -eq 1 ]] ||
    fail "backup push callback was not called exactly once for $failed_unit"
  [[ "$(grep -xc 'webhook' "$case_dir/curl.calls")" -eq 1 ]] ||
    fail "configured webhook was not called exactly once for $failed_unit"
  [[ "$(cat "$case_dir/webhook.url")" == "$WEBHOOK_URL" ]] ||
    fail "alert was not sent to the configured endpoint for $failed_unit"

  case "$failed_unit" in
    inventory-backup.service) expected_push_payload='{"issue":"backup_run","state":"alert"}' ;;
    inventory-backup-check.service) expected_push_payload='{"issue":"backup_freshness","state":"alert"}' ;;
  esac
  [[ "$(cat "$case_dir/push.payload")" == "$expected_push_payload" ]] ||
    fail "backup callback must contain only issue and alert state for $failed_unit"
  assert_file_contains "$case_dir/push.config" "url = \"$PUSH_URL\""
  assert_file_contains "$case_dir/push.config" "header = \"X-Backup-Push-Token: $PUSH_TOKEN\""

  expected_message="ACTION REQUIRED: ${failed_unit} failed. Check 'journalctl -u ${failed_unit} -n 100 --no-pager'; restore service health before relying on inventory data."
  [[ "$(cat "$case_dir/webhook.payload")" == "$expected_message" ]] ||
    fail "webhook payload must contain only the unit and recovery guidance"
  assert_file_contains "$case_dir/all-journal-output.log" "$expected_message"
  assert_file_contains "$case_dir/alert-process.log" "notified configured operator endpoint for $failed_unit"

  for marker in "${canaries[@]}"; do
    assert_file_not_contains "$case_dir/all-journal-output.log" "$marker"
    assert_file_not_contains "$case_dir/webhook.payload" "$marker"
    assert_file_not_contains "$case_dir/push.payload" "$marker"
  done
}

if ! grep -F 'ExecStart=/usr/local/libexec/inventory-backup-alert %i' "$ALERT_SERVICE" >/dev/null; then
  fail "alert template must pass the failed unit to the alert script"
fi
if ! grep -Fx 'EnvironmentFile=/etc/inventory-backup.env' "$ALERT_SERVICE" >/dev/null; then
  fail "alert template must load the configured webhook endpoint"
fi

simulate_failed_unit \
  inventory-backup.service \
  "$PROJECT_DIR/deploy/inventory-backup.service"
simulate_failed_unit \
  inventory-backup-check.service \
  "$PROJECT_DIR/deploy/inventory-backup-check.service"

printf 'ok: backup and freshness failures alert operators without leaking sensitive data\n'
