# Backup and restore (D1)

Production data lives in D1 `bip-ad-production` (`env.production` in `wrangler.jsonc`), and staging in `bip-ad`. KV holds only OAuth grants and sessions, which can be recreated: users sign in again.

## Point-in-time restore (D1 Time Travel)
D1 keeps a continuous history. It is 30 days on Workers Paid and 7 days on Free; check the plan before relying on 30.

```bash
# Bookmark for a moment (ISO timestamp or Unix seconds), e.g. just before a bad migration or incident
wrangler d1 time-travel info bip-ad-production --timestamp=2026-11-10T03:00:00+07:00 --env production
# Restore the whole database to that bookmark (destructive: everything after it is lost)
wrangler d1 time-travel restore bip-ad-production --bookmark=<bookmark> --env production
```

Before a restore:
- Pause writers: engage `ads.kill_switch`, then post the incident note (see [incident response](incident-response.md)).
- Export the current state first (below) so nothing is lost for good. Payments captured after the bookmark are still at PayPal. Reconcile them afterwards from `webhook_events` in the export and from the PayPal dashboard.

## Logical export
```bash
wrangler d1 export bip-ad-production --remote --env production --output=backups/bip-ad-production-$(date +%Y%m%d-%H%M).sql
```
- Take one before every production migration (`pnpm db:migrate:production`) and weekly.
- Store exports outside the repo. They contain personal data: emails, and payout details encrypted with `PII_ENCRYPTION_KEY`. Never commit them.
- The export is useless for payouts without the `PII_ENCRYPTION_KEY` secret. Keep that key in the vault (`ak secrets`), separate from the exports.

## Restore an export into a fresh database (drill or disaster)
```bash
wrangler d1 create bip-ad-restore-drill
wrangler d1 execute bip-ad-restore-drill --remote --file=backups/<file>.sql
wrangler d1 execute bip-ad-restore-drill --remote --command "SELECT COUNT(*) FROM ledger_entries"
```
- Run `finance.reconcile`'s queries ([`reconcile()`](../../src/mcp/operator-server.ts)) against the copy. They must balance.
- For a real disaster, point `env.production.d1_databases[0].database_id` at the restored database and deploy.
- Drill: restore the latest export into a scratch database once per quarter, reconcile it, then delete it.
