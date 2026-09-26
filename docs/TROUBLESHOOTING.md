# Ubuntu troubleshooting

Check state without exposing environment values:

```bash
sudo systemctl status synthetic-solutions-inventory.service
sudo journalctl -u synthetic-solutions-inventory.service -n 100 --no-pager
cd /opt/inventory
docker compose ps
docker compose logs --tail=100 migrate api
```

If installation stops at validation, correct the named checkout, `.env`, or
Ubuntu version problem and run it again. The installer intentionally refuses
to proceed with missing or example secrets.

If Docker is inactive, check `sudo systemctl status docker` and its journal.
If migration fails, verify database settings and storage, then inspect the
`migrate` logs before restarting the stack. Do not use `docker compose down -v`
unless deleting the database volume is intentional.

After changing `.env` or pulling an update, restart the unit so Compose
recreates affected containers:

```bash
sudo systemctl restart synthetic-solutions-inventory.service
```

For Nginx problems, run `sudo nginx -t` before reloading it and verify that the
upstream port matches `PORT`. For certificate, firewall, or DNS failures,
diagnose those host layers separately. Backup failures are documented in the
existing backup journal units; investigate them before deleting local dumps.

No Ubuntu host or live production stack test is claimed by this repository
change. The meaningful checks here are shell syntax (`bash -n`) and review of
the generated systemd unit on an actual Ubuntu host.