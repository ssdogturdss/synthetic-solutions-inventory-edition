# Ubuntu deployment architecture

The supported Ubuntu deployment runs the existing `docker-compose.yml` stack:

* `postgres` stores inventory data in the named `postgres_data` volume.
* `migrate` applies the Drizzle schema, then `api` serves the Express API on the
  configured host port (8080 by default).
* The host's optional Nginx configuration terminates TLS and proxies to the API
  on loopback. PostgreSQL is loopback-only and is not a public service.

`scripts/install-ubuntu-22.04.sh` installs only host integration. It installs
Ubuntu's `docker.io` and `docker-compose-v2` packages when needed, validates
the existing checkout and `.env`, and installs
`synthetic-solutions-inventory.service`. The unit starts the Compose stack after
Docker at boot and stops it cleanly on shutdown. It does not add an application
runtime service or replace Nginx or the existing restic backup units.

Compose health and restart policies handle container ordering and recovery.
The systemd unit is deliberately `Type=oneshot` with `RemainAfterExit`; systemd
tracks the Compose lifecycle while Docker tracks individual containers.