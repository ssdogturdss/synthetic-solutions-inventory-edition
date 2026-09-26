# Ubuntu environment

The application reads the checkout's `.env` through Docker Compose. Keep it
owned by root (for example `root:root`, mode `0600`) and never commit it.

Required production values:

* `SESSION_SECRET`: at least 32 random characters (`openssl rand -hex 32`).
* `POSTGRES_PASSWORD`: a unique, strong database password.
* `POSTGRES_USER` and `POSTGRES_DB`: use the intended database identity.
* `PORT`: normally `8080`, matching the Nginx upstream.
* `NODE_ENV=production`.
* `CORS_ORIGIN`: trusted HTTPS origins, not `*`, for browser clients.

`XAI_API_KEY` is optional and may remain empty when AI features are not used.
`ADMIN_PIN` is only for the explicit, first-run seed profile; it is not needed
by the normal boot unit. Generate it outside shell history and do not leave it
in a shared environment.

The installer validates the required secret fields and rejects the example
values. It does not generate or print secrets. Backup settings belong in the
root-only `/etc/inventory-backup.env` described by the existing backup files,
not in this application environment.