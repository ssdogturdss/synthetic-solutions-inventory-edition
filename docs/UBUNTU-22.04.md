# Ubuntu 22.04 deployment

## Prerequisites

Use a supported, patched Ubuntu 22.04 LTS host and an existing checkout. As
root (or via `sudo`), create `.env` from `.env.example`, use unique production
secrets, and review the Nginx and backup configuration. Do not put backup
repository credentials in the application `.env`.

Run the installer from the checkout:

```bash
sudo COMPOSE_PROJECT_DIR=/opt/inventory \
  /opt/inventory/scripts/install-ubuntu-22.04.sh
```

`COMPOSE_PROJECT_DIR` is optional when the script is run from `scripts/`; an
explicit absolute path is recommended. The script refuses non-Ubuntu-22.04
hosts, missing checkout files, missing `.env`, placeholder secrets, or an
unavailable Docker/Compose installation. It is safe to run again: packages,
the unit, and enablement are reconciled rather than duplicated.

The unit starts the stack with `docker compose up -d`. Manage it with:

```bash
sudo systemctl status synthetic-solutions-inventory.service
sudo systemctl restart synthetic-solutions-inventory.service
sudo systemctl stop synthetic-solutions-inventory.service
```

Install and configure Nginx from `deploy/nginx.conf.example`, then obtain TLS
with the distribution's Certbot packages. Allow only SSH, HTTP, and HTTPS in
the host firewall. Follow the existing backup documentation for encrypted
restic snapshots and recovery drills.

This procedure was not run against an Ubuntu host in this checkout. The script
performs host checks when executed; review `systemctl` status and journal output
after installation.