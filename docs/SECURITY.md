# Ubuntu deployment security

* Keep `.env`, `/etc/inventory-backup.env`, and the restic password file
  root-readable only. Use separate credentials for the database, application
  session signing, and backup repository.
* Replace every example value before starting production. Never use
  `changeme`, `replace_with_*`, or a sample admin PIN.
* Expose only Nginx's HTTP/HTTPS endpoints and SSH. Compose binds PostgreSQL
  to loopback; do not publish port 5432 through a firewall or cloud security
  group.
* Use HTTPS with a real certificate and set a narrow `CORS_ORIGIN`. Keep the
  Docker socket and host package updates restricted to trusted operators.
* Review `docker compose config` carefully before using it in a diagnostic
  context because rendered output can contain secrets. Do not paste it into
  tickets or logs.
* Keep the checked-in backup scripts and systemd units under review, and test
  restores to an isolated destination. A backup success is not proof that a
  restore has been performed.

The deployment files do not contain credentials, generate default credentials,
or claim that a production host has been tested.