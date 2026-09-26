#!/usr/bin/env bash
# Install the Ubuntu host integration for the existing Docker Compose checkout.
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd -- "${COMPOSE_PROJECT_DIR:-"${SCRIPT_DIR}/.."}" 2>/dev/null && pwd)" || {
  printf 'ERROR: COMPOSE_PROJECT_DIR does not identify an existing directory.\n' >&2
  exit 1
}
readonly UNIT_NAME=synthetic-solutions-inventory.service
readonly UNIT_PATH="/etc/systemd/system/${UNIT_NAME}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail "run as root (for example: sudo $0)"

[[ -r /etc/os-release ]] || fail "cannot identify the operating system"
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 22.04 ]] ||
  fail "Ubuntu 22.04 is required (found ${PRETTY_NAME:-unknown})"

[[ -d $PROJECT_DIR ]] || fail "checkout directory does not exist: $PROJECT_DIR"
[[ -f "$PROJECT_DIR/docker-compose.yml" ]] || fail "docker-compose.yml is missing from $PROJECT_DIR"
[[ -f "$PROJECT_DIR/Dockerfile" ]] || fail "Dockerfile is missing from $PROJECT_DIR"
[[ -f "$PROJECT_DIR/.env" ]] || fail "missing $PROJECT_DIR/.env; copy .env.example and fill every required secret"
[[ $PROJECT_DIR != *$'\n'* && $PROJECT_DIR != *' '* ]] ||
  fail "checkout path must not contain spaces or newlines"

env_value() {
  local key=$1 line
  line="$(grep -E "^[[:space:]]*${key}=" "$PROJECT_DIR/.env" | tail -n 1 || true)"
  printf '%s' "${line#*=}" | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}
session_secret="$(env_value SESSION_SECRET)"
postgres_password="$(env_value POSTGRES_PASSWORD)"
[[ ${#session_secret} -ge 32 && $session_secret != replace_with_* ]] ||
  fail "SESSION_SECRET must be at least 32 non-placeholder characters in .env"
[[ -n $postgres_password && $postgres_password != changeme && $postgres_password != replace_with_* ]] ||
  fail "POSTGRES_PASSWORD must be set to a non-placeholder value in .env"

export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker.io
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker-compose-v2
fi
command -v docker >/dev/null 2>&1 || fail "Docker installation did not provide docker"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable"
systemctl enable docker >/dev/null
systemctl start docker
systemctl is-active --quiet docker || fail "Docker daemon is not active"

tmp_unit="$(mktemp)"
trap 'rm -f "$tmp_unit"' EXIT
cat >"$tmp_unit" <<EOF
[Unit]
Description=Synthetic Solutions inventory Docker Compose stack
Wants=network-online.target
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
RemainAfterExit=yes
TimeoutStartSec=30min
TimeoutStopSec=5min

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "$tmp_unit" "$UNIT_PATH"
systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
systemctl is-enabled --quiet "$UNIT_NAME" || fail "could not enable $UNIT_NAME"
systemctl is-active --quiet "$UNIT_NAME" || fail "stack unit did not remain active; inspect journalctl -u $UNIT_NAME"
printf 'Installed and enabled %s for checkout %s.\n' "$UNIT_NAME" "$PROJECT_DIR"