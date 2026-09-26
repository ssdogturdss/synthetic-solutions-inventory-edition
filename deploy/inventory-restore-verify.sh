#!/usr/bin/env bash
# Verify a restored inventory database before the application is started.
#
# The default mode runs psql through the Compose postgres service. Set PSQL_BIN
# to use a local/direct psql client instead (the restore-verify Compose service
# uses this mode). All statements run in a read-only transaction.

set -Eeuo pipefail

readonly COMPOSE_PROJECT_DIR="${COMPOSE_PROJECT_DIR:-/opt/inventory}"
readonly DOCKER_BIN="${DOCKER_BIN:-/usr/bin/docker}"
readonly POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"

die() {
  printf 'inventory restore verification: %s\n' "$*" >&2
  exit 1
}

run_verification_query() {
  if [[ -n "${PSQL_BIN:-}" ]]; then
    "$PSQL_BIN" \
      --no-psqlrc \
      --quiet \
      --tuples-only \
      --no-align \
      --set=ON_ERROR_STOP=1
    return
  fi

  [[ -d "$COMPOSE_PROJECT_DIR" ]] ||
    die "Compose project directory does not exist: $COMPOSE_PROJECT_DIR"
  [[ -x "$DOCKER_BIN" ]] || die "docker executable not found: $DOCKER_BIN"

  (
    cd "$COMPOSE_PROJECT_DIR"
    "$DOCKER_BIN" compose exec -T "$POSTGRES_SERVICE" sh -c '
      exec psql \
        --no-psqlrc \
        --quiet \
        --tuples-only \
        --no-align \
        --set=ON_ERROR_STOP=1 \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB"
    '
  )
}

printf 'inventory restore verification: checking required tables and relationships\n'

if ! verification_output="$(
  run_verification_query <<'SQL'
BEGIN TRANSACTION READ ONLY;

SELECT CASE
  WHEN count(*) = 4 THEN 'required_tables=ok;count=' || count(*)
  ELSE 'required_tables=fail;found=' || count(*)
END
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'stores',
    'products',
    'inventory_sessions',
    'inventory_session_items'
  );

SELECT 'stores=' ||
  CASE WHEN count(*) > 0 THEN 'ok' ELSE 'fail' END ||
  ';count=' || count(*)
FROM stores;

SELECT 'products=' ||
  CASE WHEN count(*) > 0 THEN 'ok' ELSE 'fail' END ||
  ';count=' || count(*)
FROM products;

SELECT 'finalized_sessions=' ||
  CASE WHEN count(*) > 0 THEN 'ok' ELSE 'fail' END ||
  ';count=' || count(*)
FROM inventory_sessions AS sessions
JOIN stores ON stores.id = sessions.store_id
WHERE sessions.status = 'finalized';

SELECT 'session_items=' ||
  CASE WHEN count(*) > 0 THEN 'ok' ELSE 'fail' END ||
  ';count=' || count(*)
FROM inventory_session_items AS items
JOIN inventory_sessions AS sessions ON sessions.id = items.session_id
JOIN products ON products.id = items.product_id;

SELECT 'relationships=' ||
  CASE WHEN count(*) > 0 THEN 'ok' ELSE 'fail' END ||
  ';count=' || count(*)
FROM inventory_session_items AS items
JOIN inventory_sessions AS sessions ON sessions.id = items.session_id
JOIN stores ON stores.id = sessions.store_id
JOIN products ON products.id = items.product_id
WHERE sessions.status = 'finalized';

COMMIT;
SQL
)"; then
  printf '%s\n' "$verification_output" >&2
  die "read-only verification query failed; API startup remains blocked"
fi

printf '%s\n' "$verification_output"

for expected in \
  'required_tables=ok' \
  'stores=ok' \
  'products=ok' \
  'finalized_sessions=ok' \
  'session_items=ok' \
  'relationships=ok'
do
  if ! grep -Eq "^${expected};" <<<"$verification_output"; then
    die "verification failed (${expected}); API startup remains blocked"
  fi
done

printf 'inventory restore verification: passed; start migration and API separately\n'