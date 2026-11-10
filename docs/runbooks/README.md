# Runbooks

Operational procedures for bip.ad. Each one points to the code that owns the behaviour rather than restating it.

- [Go-live checklist](go-live-checklist.md): what is done and what is pending before real money and paid ads.
- [Backup and restore](backup-restore.md): D1 Time Travel and `wrangler d1 export`.
- [Monitoring, alerts and SLOs](monitoring-alerts-slos.md): `operator.health`, alert emails and service targets.
- [Failure runbooks](failure-runbooks.md): payment webhooks, the 03:12 lock, email, ads pause, adapter dead letters.
- [Incident response](incident-response.md): severity levels, the first 15 minutes, communication and the post-incident review.

Operator tools live on `/operator/mcp` (bearer `OPERATOR_TOKEN`, [ADR-0006](../ADR/0006-mcp-auth-and-operator.md)). Their source is [`src/mcp/operator-server.ts`](../../src/mcp/operator-server.ts).
