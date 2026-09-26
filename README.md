# Synthetic Solutions — Inventory Edition

Enterprise chemical inventory management for car wash operations. A **React Native mobile app** (Expo) backed by an **Express REST API** with PostgreSQL, built as a pnpm monorepo.

---

## What It Does

- **PIN-based auth** with role separation (admin / store user)
- **Stores, products, categories** — full CRUD with soft deletes
- **Inventory sessions** — open → scan/enter → finalize (auto-calculates chemical usage)
- **Receiving** — log deliveries with vendor, invoice, per-item quantities, photos
- **Central warehouse** — admin-only stock receiving, balances, and transfers to stores
- **Chemical pull log** — track chemicals pulled into active service
- **Reports** — usage by period/store/category, valuation, min/max alerts, rankings
- **AI Report Agent** — structured AI-generated inventory analysis (xAI Grok)
- **Audit log** — every write recorded with before/after values

---

## Tech Stack

| Layer | Technology |
|---|---|
| Mobile | Expo SDK 54, React Native 0.81, Expo Router |
| API | Node 22, Express 5, TypeScript |
| ORM | Drizzle ORM + drizzle-kit |
| Database | PostgreSQL 16 |
| Auth | PIN → bcrypt → JWT (8 h), AES-256-GCM for stored keys |
| AI | xAI Grok via REST |
| Logging | pino + pino-http |
| Monorepo | pnpm workspaces |

---

## Monorepo Layout

```
artifacts/
  api-server/       Express API (deployable via Docker)
  mobile/           Expo React Native app
lib/
  db/               Drizzle schema + migration helpers
  api-zod/          Shared Zod validation schemas
  api-client-react/ TanStack Query hooks (generated)
  api-spec/         OpenAPI spec (source of truth)
scripts/            E2E test runner, seed scripts
```

---

## Prerequisites

- **Node 22+** and **pnpm 10.26.1** (`corepack enable && corepack prepare pnpm@10.26.1 --activate`)
- **PostgreSQL 16** (or Docker — see below)
- **Docker + Docker Compose** (for the containerised path)

---

## Quick Start — Docker Compose

The fastest way to get the API server running locally or on a Linux server.

```bash
# 1. Clone and enter the repo
git clone https://github.com/ssdogturdss/synthetic-solutions-inventory-edition.git
cd synthetic-solutions-inventory-edition

# 2. Create your env file
cp .env.example .env
#    → Edit .env:
#      - Set SESSION_SECRET  (openssl rand -hex 32)
#      - Set POSTGRES_PASSWORD to something secure
#      - Set CORS_ORIGIN to one or more trusted HTTPS browser origins
#      - Optionally set XAI_API_KEY for AI features

# 3. Build and start in the background
docker compose up -d --build

# The first run automatically applies the database schema via drizzle-kit push --force.
# The API is available at http://localhost:8080
```

`ADMIN_PIN` is only needed for the optional first-admin seed command below. It is
not required to start the normal `postgres`, `migrate`, and `api` services.

**Seed the first admin account** (fresh deploys only):

```bash
# Choose a secure PIN (≥4 digits) and an admin display name, then run:
ADMIN_PIN=739184 ADMIN_NAME=Admin docker compose --profile seed run --rm seed
```

The seed command is **idempotent** — it exits immediately if an admin already
exists, so it is safe to run again. After it completes, open the mobile app,
select "Admin" from the user list, and enter the PIN you set.

**Subsequent starts** (no rebuild needed unless source changed):

```bash
docker compose up
```

**Stop everything:**

```bash
docker compose down          # keeps the database volume
docker compose down -v       # also removes the database volume (destructive)
```

---

## Quick Start — Bare Metal (no Docker)

### 1. Install dependencies

```bash
pnpm install
```

The API package uses Node's `--env-file-if-exists` support to load the
repository-root `.env` automatically when started outside Docker. You do not
need to export each variable manually.

### 2. Set up environment variables

```bash
cp .env.example .env
# Set DATABASE_URL and SESSION_SECRET. For production, also set CORS_ORIGIN
# to the trusted HTTPS origins allowed to call the API from a browser.
```

### 3. Apply the database schema

```bash
pnpm --filter @workspace/db run push-force
```

### 4. Start the API server

```bash
pnpm --filter @workspace/api-server run dev
# Builds with esbuild then starts Node — http://localhost:8080
```

### 5. Start the mobile app (separate terminal)

```bash
pnpm --filter @workspace/mobile run dev
# Starts Expo Metro bundler — scan the QR code with Expo Go
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values. Never commit `.env`.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `SESSION_SECRET` | ✅ | ≥32 random chars; signs JWTs and encrypts stored AI keys |
| `PORT` | ✅ | Port the API server binds to (default `8080`) |
| `NODE_ENV` | — | `production` or `development` (affects log format) |
| `CORS_ORIGIN` | Compose / production | Comma-separated trusted HTTPS browser origins; required by Compose and in production. `*` is rejected in production. |
| `XAI_API_KEY` | — | xAI Grok key; enables AI report and chat features |
| `POSTGRES_USER` | Docker only | Postgres username for the Docker container |
| `POSTGRES_PASSWORD` | Docker only | Postgres password for the Docker container |
| `POSTGRES_DB` | Docker only | Postgres database name for the Docker container |

For a production browser client, set `CORS_ORIGIN` to a comma-separated list of
trusted HTTPS origins, for example
`https://app.example.com,https://admin.example.com`. Native Expo requests do
not require CORS. Avoid using `*` if a browser client will access the API.

Generate a secure `SESSION_SECRET`:

```bash
openssl rand -hex 32
```

---

## Database Migrations

This project uses **Drizzle Kit push** (schema-sync, not migration files).

```bash
# Apply (or re-sync) the schema against your database
pnpm --filter @workspace/db run push-force

# Interactive push (prompts before destructive changes)
pnpm --filter @workspace/db run push
```

> **Production warning:** `push-force` accepts destructive schema changes without
> an interactive prompt. It is idempotent only when the existing data model is
> compatible with the checked-in schema; it can drop columns or other data when
> the schema changes. Before production upgrades, take and verify a backup,
> review the schema change, and do not run it against irreplaceable data without
> a tested recovery path.

---

## Mobile App Setup

The Expo app connects to the API server. Development builds can override the
API host with `EXPO_PUBLIC_DOMAIN`:

```bash
# Local dev (API on same machine)
EXPO_PUBLIC_DOMAIN=localhost:8080 pnpm --filter @workspace/mobile run dev

# Pointing at a remote HTTPS server
EXPO_PUBLIC_DOMAIN=api.your-domain.com pnpm --filter @workspace/mobile run dev
```

`EXPO_PUBLIC_DOMAIN` is the API hostname, without `https://` and without a
trailing slash. It only overrides the app configuration during development.

For a release build, configure the Ubuntu API once in
`artifacts/mobile/app.json` under `expo.extra.apiDomain`:

```json
{
  "expo": {
    "extra": {
      "apiDomain": "api.your-domain.com"
    }
  }
}
```

Use the public HTTPS hostname that points to the Ubuntu server through Nginx,
or the published `.replit.app` hostname when the API and mobile artifacts are
published together on Replit.
Do not put `https://`, a path, credentials, or a trailing slash in
`apiDomain`. The release build validates this value and refuses to start if it
is missing, still points at a local or Replit development host, or is
malformed. After changing the host, rebuild the app so the value is included
in the native bundle:

```bash
pnpm --filter @workspace/mobile run build:production
```

The build reads `expo.extra.apiDomain` directly, so it does not depend on a
release shell variable being present. For local testing, keep using the
`EXPO_PUBLIC_DOMAIN=... pnpm --filter @workspace/mobile run dev` override above;
it does not change the checked-in release host.

---

## Production Deployment — Ubuntu + Nginx

### 1. Provision a server

A $6/month VPS (2 GB RAM, 1 vCPU) is sufficient for a small fleet.

### 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in
```

### 3. Clone the repo and configure

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git /opt/inventory
cd /opt/inventory
cp .env.example .env
nano .env   # fill in SESSION_SECRET, POSTGRES_PASSWORD, etc.
```

### 4. Start the stack

```bash
docker compose up -d --build
```

### 5. Configure the firewall

Only SSH, HTTP, and HTTPS should be publicly reachable. PostgreSQL is bound to
loopback by Docker Compose and should not be opened in the firewall.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

### 6. Install and configure Nginx

```bash
sudo apt install -y nginx
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/inventory
sudo sed -i 's/api.example.com/api.your-domain.com/g' \
  /etc/nginx/sites-available/inventory
sudo ln -sfn /etc/nginx/sites-available/inventory /etc/nginx/sites-enabled/inventory
sudo nginx -t && sudo systemctl reload nginx
```

The example config forwards to the API container on loopback, preserves client
headers, disables proxy buffering for the AI chat SSE stream, and allows up to
120 seconds for report generation. Point your DNS `A`/`AAAA` record at the
server before requesting the certificate.

### 7. Add HTTPS with Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.your-domain.com
```

Test the public API after TLS is active:

```bash
curl -fsS https://api.your-domain.com/api/healthz
# Expected: {"status":"ok"}
```

### 8. Set up auto-restart on reboot

Docker Compose services already use `restart: unless-stopped`, so they come back automatically. To also start on server boot:

```bash
sudo systemctl enable docker
```

### 9. Update the app

```bash
cd /opt/inventory
git pull
docker compose up -d --build
docker compose ps
```

The migration service runs before the API after an update. Check the migration
and API logs if the API does not start:

```bash
docker compose logs --tail=100 migrate api
```

### 10. Backups and restore

The PostgreSQL data volume survives a normal `docker compose down`, but it is
not a backup. Create a dump before destructive maintenance, schema changes, or
any planned server work. Run these commands from the repository directory
(for example, `/opt/inventory`) so they use the intended Compose project and
`.env` file:

```bash
# Keep the dump outside the Git checkout. Override BACKUP_DIR if needed.
BACKUP_DIR="${BACKUP_DIR:-$HOME/inventory-backups}"
install -d -m 700 "$BACKUP_DIR"

# Confirm the database selected by this Compose project before creating a dump.
docker compose exec -T postgres sh -c \
  'printf "backup target: database=%s user=%s\n" "$POSTGRES_DB" "$POSTGRES_USER"'

umask 077
BACKUP_FILE="$BACKUP_DIR/inventory-$(date -u +%Y%m%dT%H%M%SZ).sql"
docker compose exec -T postgres sh -c '
  set -eu
  pg_dump --format=plain --no-owner --no-privileges \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"
' > "$BACKUP_FILE"
test -s "$BACKUP_FILE"
printf 'Created %s\n' "$BACKUP_FILE"
```

The `POSTGRES_*` values in this command are read inside the Compose PostgreSQL
container. This avoids accidentally using an unset host-shell variable or
dumping a database with a different name than the one configured in `.env`.
The plain SQL format can be restored with `psql`; `--no-owner` and
`--no-privileges` make the dump suitable for a replacement stack whose role
ownership differs.

#### Restore a dump

Restoring replaces all data in the target database. It is destructive: first
make a fresh backup, verify the backup path, and confirm that the target shown
by the command below is the intended Compose project. Do not run the restore
while `api`, `migrate`, or the optional `seed` service can write to the
database.

1. Stop the stack without deleting its volume, then start only PostgreSQL. If
   the original server is unavailable, perform the same steps from a fresh
   checkout with the replacement server's `.env` and a new Compose volume:

   ```bash
   docker compose down
   docker compose up -d postgres
   docker compose ps postgres
   ```

   Wait until the `postgres` health status is `healthy` before continuing.
   Never use `docker compose down -v` as part of ordinary restore preparation:
   `-v` permanently removes the existing PostgreSQL volume.

2. Confirm the exact restore target and set the path to an existing dump. The
   target must match the database and project you intend to replace:

   ```bash
   docker compose exec -T postgres sh -c \
     'printf "restore target: database=%s user=%s\n" "$POSTGRES_DB" "$POSTGRES_USER"'
   BACKUP_FILE="$HOME/inventory-backups/inventory-YYYYMMDDTHHMMSSZ.sql"
   test -s "$BACKUP_FILE"
   ```

3. Recreate only the configured database, then load the dump. The database
   container stays running so its local PostgreSQL role can perform the
   operation; the API and migration services remain stopped:

   ```bash
   docker compose exec -T postgres sh -c '
     set -eu
     dropdb --if-exists --maintenance-db=postgres \
       --username="$POSTGRES_USER" "$POSTGRES_DB"
     createdb --maintenance-db=postgres \
       --username="$POSTGRES_USER" "$POSTGRES_DB"
   '

   docker compose exec -T postgres sh -c '
     set -eu
     psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
       --set=ON_ERROR_STOP=1
   ' < "$BACKUP_FILE"
   ```

   `ON_ERROR_STOP=1` makes a failed restore exit non-zero instead of allowing
   the procedure to continue with a partial database. Leave `migrate` and
   `api` stopped until the restored data passes the verification gate below.

4. Run the read-only restored-data verification while only PostgreSQL is
   running:

   ```bash
   docker compose --profile restore-verify run --rm restore-verify
   ```

   This command checks that the four required inventory tables exist, that
   stores and products have representative rows, and that a finalized session
   has a complete store → session → session item → product relationship. It
   runs in a read-only PostgreSQL transaction and exits non-zero for an
   incomplete or corrupt restore. Do not start `migrate` or `api` if it
   fails; investigate or repeat the restore instead.

5. Only after verification succeeds, start the migration and API services, then
   check their status and logs:

   ```bash
   docker compose up -d
   docker compose ps
   docker compose logs --tail=100 migrate api
   ```

   The same procedure works for a replacement stack: copy the dump to the new
   host through a protected transfer, place it outside the checkout, confirm
   the replacement `.env` target, restore it, and run the verification gate
   before starting the API.

#### Restore drill record

The replacement-stack restore procedure was rehearsed on **2026-09-18** in UTC
using a fresh Compose project and a new PostgreSQL volume. The successful pass
took **75 seconds** from source API readiness to replacement API readiness:

- Source API ready: `06:31:53`
- Dump copied to the separate off-server directory: `06:32:41`
- Replacement PostgreSQL ready: `06:32:58`
- Database restored and verified while the API was stopped: `06:32:59`
- Replacement migration and API ready: `06:33:07`

The 26,084-byte plain-SQL dump and its off-server copy both had mode `0600` and
SHA-256
`7df2e33ae063e53781e65512edac1bee787a805fa154a77656e7a0f63cf28038`.
Before reopening the API, the target contained the expected four inventory
tables, the `RDS-RESTORE` store, two products, two session items, and a
finalized session. After reopening, `/api/healthz` returned `{"status":"ok"}`
and the same records were present.

Manual steps used in the drill:

1. Seed representative store, product, user, category, session, and session
   item rows in the source stack.
2. Create the dump outside the checkout with `pg_dump --format=plain
   --no-owner --no-privileges`, then copy it to a separate off-server
   directory and verify the file size, mode, and checksum.
3. Stop the source stack without deleting its volume. Start the replacement
   PostgreSQL service on a new volume and verify the intended database and
   user before restoring.
4. Drop and recreate only the configured target database, restore with
   `psql --set=ON_ERROR_STOP=1`, and query representative inventory records
   before starting `migrate` or `api`.
5. Start the migration and API services, inspect their status/logs, and verify
   `/api/healthz` plus the restored records.

This runner could not execute Compose health checks or `docker compose exec`
because its container runtime returned an OCI `setns` error. The drill used
host-side `pg_isready`, `pg_dump`, `dropdb`, `createdb`, and `psql`, plus a
temporary host-network override for the disposable migration/API containers.
On Ubuntu, use the normal Compose commands above; the override is not part of
the production procedure. The root-owned systemd/restic transfer path remains
an Ubuntu-host-specific manual check.

#### Root-owned restic restore drill

The encrypted off-server path was rehearsed on **2026-09-24** in UTC using a
disposable Ubuntu 24.04 container running the production backup and freshness
scripts as root. An authenticated restic REST service in a separate disposable
container represented the protected off-server repository. Restic was
initialised once, the backup wrapper uploaded one `inventory-database` snapshot,
the freshness check passed, and `restic restore latest --tag inventory-database`
retrieved the dump before the replacement restore.

Measured timings for this pass were:

- Source PostgreSQL volume start and representative data setup: **12 seconds**
- Root backup, encrypted upload, retention/freshness checks, and retrieval:
  **7 seconds**
- Fresh replacement Compose PostgreSQL volume, database recreation, restore,
  and verification: **7 seconds**
- End-to-end elapsed time: **26 seconds**

The root-only controls were verified inside the disposable Ubuntu host:

- `/etc/inventory-backup.env`: owner `root`, mode `0600`
- `/etc/inventory-backup-password`: owner `root`, mode `0600`
- `/var/lib/inventory-backups`: owner `root`, mode `0700`
- Backup dump: owner UID `0`, mode `0600`, **9,532 bytes**
- Dump SHA-256:
  `ec2606d0c014a394817f9881b1383bdbd09037063ce624124be4dbf76e7c4c22`
- `last-run` and `last-check` both reported `status=success`; both local and
  off-server copies were reported `fresh`

Representative verification after restoring into the new
`task151-target_postgres_data` volume found **1 category**, the
`RDS-RESTORE` store, **2 products**, **1 finalized session**, **2 session
items**, and **17.500 gallons**. The restored dump checksum matched the
root-owned local dump checksum.

Manual transfer and recovery steps used in the rehearsal:

1. Create the root-only environment and password files, install the wrapper and
   checker under `/usr/local/libexec`, and verify their owner and modes. On an
   actual host, perform these operations with the `sudo install`, `sudo chown`,
   and `sudo chmod` commands in the automated schedule above.
2. Initialize or open the approved authenticated restic repository using the
   root-only environment. Do not move the repository password or storage
   credentials into the application checkout.
3. Run the root backup service once, then inspect `last-run`, `last-check`, and
   the systemd journal before relying on the snapshot.
4. Retrieve the known snapshot with the documented root-only command:
   `sudo bash -c 'set -a; . /etc/inventory-backup.env; set +a; exec /usr/bin/restic restore latest --tag inventory-database --target /protected/temporary/path'`.
5. Keep the retrieved SQL under a root-only protected path, verify its size,
   mode, owner, and checksum as root, then follow **Restore a dump** above
   against a fresh Compose volume. Do not start the API until the database
   recreation, `psql --set=ON_ERROR_STOP=1` restore, and representative queries
   succeed.
6. Remove the disposable source and replacement Compose projects, their named
   volumes, the temporary restic service and repository, the temporary
   credentials, and the protected restore directory. The rehearsal verified
   that no `task151-*` containers or volumes remained after cleanup.

The runner does not provide a booted systemd host, so the timer units were not
started here. It also rejects Docker `exec` with the same OCI `setns` limitation
noted above; the disposable pass used an isolated host-side `pg_dump` adapter
over the source container's loopback port. The backup wrapper, restic
encryption/upload, authenticated retrieval, freshness check, root ownership
checks, and fresh-volume SQL restore were real. On an Ubuntu server with normal
systemd and Docker namespaces, install and invoke the units exactly as shown in
**Install the automated Ubuntu schedule**.

#### Recording a successful restore drill

After a restore drill passes the read-only database verification and the
replacement API checks, record its UTC verification time in
`/var/lib/inventory-backups/last-restore-drill` on the backup host. This is
inside the root-only status directory mounted read-only into the API container.
If `BACKUP_STATUS_DIR` uses a different host path, write the file in that
configured directory instead. Record success only after the full drill passes:

```bash
sudo sh -c '
  set -eu
  status_dir=/var/lib/inventory-backups
  tmp="$status_dir/.last-restore-drill.$$"
  umask 077
  printf "status=success\nverified_at=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  mv -f "$tmp" "$status_dir/last-restore-drill"
'
```

The API returns only the verified timestamp from this file. It returns `null`
when no valid successful drill record exists; database contents, dump contents,
and credentials are not included. Keep this record alongside `last-run` and
`last-check` in the status directory.

**Next restore drill:** 2026-12-18, or sooner after any backup, Compose, schema,
or PostgreSQL-version change.

#### Off-server copies and retention

Keep at least one encrypted copy off the Ubuntu server (ideally use a
3-2-1-style policy: multiple copies, different media, and one off-site). A
server-local dump does not protect against VPS loss, disk failure, or accidental
volume deletion. The repository includes a root-owned systemd wrapper and timer
that use [restic](https://restic.net/) to encrypt each dump before uploading it
to the business-approved off-server repository. Restic repository contents are
encrypted before they leave the Ubuntu host; the storage provider does not need
to be trusted with the repository password.

A practical starting policy is daily backups retained for 14 days, weekly
backups retained for 8 weeks, and monthly backups retained for 12 months.
Adjust this to the business's recovery-point and storage requirements, and
periodically perform a restore drill on a disposable replacement stack. The
automated wrapper applies those retention defaults to the encrypted repository
and keeps 14 days of local dumps for quick recovery. It records the result of
each run in `/var/lib/inventory-backups/last-run`, and the freshness watchdog
records only metadata in `/var/lib/inventory-backups/last-check`: local and
off-server freshness status, copy age, and the check timestamp. The check fails
when either copy is missing or older than `MAX_BACKUP_AGE_HOURS` (26 hours by
default). A separate hourly systemd watchdog catches a missed timer or stale
repository even when no backup run starts. Non-zero dump, upload, retention, or
freshness checks are recorded as failed units in the journal and trigger an
actionable alert.

#### Install the automated Ubuntu schedule

Perform this setup once on the Ubuntu host as an operator with `sudo`
privileges. These instructions assume the checkout is `/opt/inventory`; set
`COMPOSE_PROJECT_DIR` in the environment file if it is elsewhere.

1. Install restic and make the root-only directories:

   ```bash
   sudo apt-get update
   sudo apt-get install -y restic jq curl
   sudo install -d -o root -g root -m 0750 /usr/local/libexec
   sudo install -d -o root -g root -m 0700 /var/lib/inventory-backups
   ```

2. Install the wrapper and systemd units from this checkout. The wrapper is
   deliberately installed outside the checkout so an application deploy cannot
   replace the executable used by the timer:

   ```bash
   sudo install -o root -g root -m 0750 \
     deploy/inventory-backup.sh /usr/local/libexec/inventory-backup
   sudo install -o root -g root -m 0644 \
     deploy/inventory-backup.service /etc/systemd/system/inventory-backup.service
   sudo install -o root -g root -m 0644 \
     deploy/inventory-backup.timer /etc/systemd/system/inventory-backup.timer
   sudo install -o root -g root -m 0750 \
      deploy/inventory-backup-check.sh /usr/local/libexec/inventory-backup-check
   sudo install -o root -g root -m 0750 \
      deploy/inventory-backup-alert.sh /usr/local/libexec/inventory-backup-alert
    sudo install -o root -g root -m 0750 \
      deploy/inventory-backup-push-event.sh /usr/local/libexec/inventory-backup-push-event
   sudo install -o root -g root -m 0644 \
      deploy/inventory-backup-check.service /etc/systemd/system/inventory-backup-check.service
   sudo install -o root -g root -m 0644 \
      deploy/inventory-backup-check.timer /etc/systemd/system/inventory-backup-check.timer
   sudo install -o root -g root -m 0644 \
      deploy/inventory-backup-alert@.service /etc/systemd/system/inventory-backup-alert@.service
   ```

3. Create a random repository password in a root-only file. Losing this
   password makes the encrypted off-server snapshots unrecoverable:

   ```bash
   sudo sh -c \
     'umask 077; openssl rand -base64 48 > /etc/inventory-backup-password'
   sudo chown root:root /etc/inventory-backup-password
   sudo chmod 0600 /etc/inventory-backup-password
   ```

   Store a separate copy of this password in the organisation's approved
   secrets manager. Do not put it in Git, the application `.env`, shell
   history, or an issue tracker.

4. Create the root-only systemd environment file from the checked-in example,
   then edit it on the server:

   ```bash
   sudo install -o root -g root -m 0600 \
     deploy/inventory-backup.env.example /etc/inventory-backup.env
   sudoedit /etc/inventory-backup.env
   ```

   Set `RESTIC_REPOSITORY` to the approved off-server destination and provide
   that provider's credentials in this file when required. For an S3-compatible
   destination, set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
   `AWS_DEFAULT_REGION` here. Use a storage credential restricted to this
   repository and backup operations. Do not reuse the application's
   `POSTGRES_PASSWORD` or `SESSION_SECRET`.

    To send backup alerts to opted-in administrators, set
    `BACKUP_PUSH_URL=https://<api-host>/api/backup/events` and
    `BACKUP_PUSH_TOKEN` in this root-only file. Generate a token with
    `openssl rand -hex 32`, then store the same value as the API server's
    `BACKUP_PUSH_TOKEN` secret. Do not put it in the application `.env`, Git,
    command-line arguments, or logs. If the callback is unavailable, the backup
    host still records the failure in the journal and sends the separately
    configured `ALERT_WEBHOOK_URL` notice.

5. Initialise the restic repository once before enabling the timer. This
   command reads the root-only environment and password files without adding
   them to the application environment:

   ```bash
   sudo bash -c '
     set -a
     . /etc/inventory-backup.env
     set +a
     exec /usr/bin/restic init
   '
   ```

   Only run `restic init` for a new repository. If the repository already
   exists, verify that its URL is the intended approved destination instead of
   initialising another repository.

6. Enable both timers, run one immediate backup, and inspect the result. The
   backup timer runs daily at 02:30 UTC with a random delay of up to 30 minutes
   and catches up after downtime. The freshness timer runs hourly and also
   catches up after downtime. Configure the alert destination before relying on
   the schedule:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now inventory-backup.timer inventory-backup-check.timer
   sudo systemctl start inventory-backup.service
   sudo systemctl status inventory-backup.service inventory-backup-check.service --no-pager
   sudo systemctl list-timers inventory-backup.timer inventory-backup-check.timer --all
   sudo journalctl -u inventory-backup.service -u inventory-backup-check.service \
     -u 'inventory-backup-alert@*' -n 100 --no-pager
   ```

   A failed run leaves its local dump in `/var/lib/inventory-backups` and is
   visible as a failed systemd service; investigate the journal before deleting
   anything. The next successful run uploads and verifies a new tagged snapshot
   before local retention cleanup. Both a backup failure and a stale/missing
    copy start `inventory-backup-alert@.service`. The alert is always written
    to the journal. To notify an on-call system as well, set
    `ALERT_WEBHOOK_URL` in the root-only `/etc/inventory-backup.env`; its POST
    contains only the failed unit and a journal command. The optional
    `BACKUP_PUSH_URL` callback sends only a backup issue key and its alert or
    healthy state. Callback errors never suppress journal or operator-webhook
    alerts. Keep the default `MAX_BACKUP_AGE_HOURS=26` unless the backup schedule
    or recovery-point policy requires a shorter limit.

The admin app's **Backup Health** screen reads only `last-run`, `last-check`,
and `last-restore-drill` metadata through `GET /api/backup/health`. The endpoint
requires an admin JWT and never returns database or repository credentials,
restored data, dump contents, or backup file contents. When the API runs in
Docker, mount the host backup directory read-only and set `BACKUP_STATUS_DIR`
(the Compose file does this by default):

```yaml
services:
  api:
    environment:
      BACKUP_STATUS_DIR: /var/lib/inventory-backups
    volumes:
      - /var/lib/inventory-backups:/var/lib/inventory-backups:ro
```

### Push notification setup

The **Notifications** screen lets each signed-in device opt in to backup and
inventory alerts separately. Backup alerts go to active administrators who
enable that category. Store alerts go to active users assigned to that store
and opted-in administrators; warehouse alerts go only to opted-in
administrators because warehouses do not have individual store assignments.
Inventory alerts use the report thresholds and are sent on entry into a
below-minimum or overstock condition. The condition must clear before it can
notify again.

For browser push, configure `WEB_PUSH_VAPID_PUBLIC_KEY`,
`WEB_PUSH_VAPID_PRIVATE_KEY`, and `WEB_PUSH_VAPID_SUBJECT` on the API server.
Generate a VAPID key pair with the `web-push generate-vapid-keys` command; keep
the private key in Replit Secrets and expose the public key through the server
environment. Use a valid contact value such as `mailto:ops@example.com` for
the subject. Browser push requires HTTPS and browser permission. On
iPhone/iPad, open the site as a Home Screen web app (iOS/iPadOS 16.4 or newer)
before enabling push.

Native iOS/Android push uses Expo's push service. Configure the EAS project ID
in the Expo app config and the corresponding APNs/FCM credentials in the
installed native builds. Expo Go is not a valid end-to-end push test; use an
installed development or production build. The screen explains when the
current browser or native build cannot register for push.

To perform a recovery drill, use the same root-only environment and password:

```bash
sudo bash -c '
  set -a
  . /etc/inventory-backup.env
  set +a
  exec /usr/bin/restic restore latest --tag inventory-database \
    --target /protected/temporary/path
'
```

Then follow the restore procedure above against a disposable Compose stack.
Keep the repository password and storage credentials out of the replacement
checkout.

The dump and restore commands above were validated against an isolated,
temporary PostgreSQL 16 Compose database. Running them against the operational
Ubuntu host still requires the operator to confirm the project directory,
`.env`, root-only restic environment, backup file, and off-server copy policy.

Do not run `docker compose down -v` on a live server unless you intentionally
want to delete the PostgreSQL volume and all stored inventory data.

---

## Push to GitHub

```bash
git init                          # already done if you cloned
git add .
git commit -m "Initial production-ready commit"

git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

---

## Development Notes

- **esbuild platform overrides** in `pnpm-workspace.yaml` target `linux-x64`. If you develop on macOS, remove the `esbuild>@esbuild/darwin-*` override lines so pnpm installs the darwin binaries.
- **Mockup sandbox** (`artifacts/mockup-sandbox`) is a Replit-only design canvas tool; it is excluded from the Docker build.
- **Drizzle schema** lives in `lib/db/src/schema/`; one file per domain.
- **OpenAPI spec** at `lib/api-spec/openapi.yaml` is the source of truth for all API contracts.
- **Audit logs**: every write (create / update / delete) is recorded automatically via `lib/audit.ts`.

---

## License

MIT — see [LICENSE](./LICENSE).
