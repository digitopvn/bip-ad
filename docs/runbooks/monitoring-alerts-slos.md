# Monitoring, alerts and SLOs

## Health
`operator.health` on `/operator/mcp` reports:
- payment mode;
- pending moderation and open payouts;
- the email projection backlog;
- the last lock;
- adapter modes (video, social, ads), with whether `ZERNIO_API_KEY` and the accounts are set;
- the ads kill switch;
- whether the ledger reconciles;
- open dead letters;
- current alert conditions and unsent alert emails.

Workers observability is on (`"observability": { "enabled": true }`). Cron runs log `lock run`, `scheduled queries` and `email run` lines.

## Alert emails
Alerts are detected by the hourly cron (`src/ads/ads-hourly-cycle.ts`). They are mailed by the 15-minute email cron to `OPERATOR_ALERT_EMAIL` (`src/monitoring/operator-alerts.ts`). Each condition alerts at most once per period (`operator_alerts.dedupe_key`). An alert not mailed within 24 hours is marked `skipped`.

| Alert | Condition | Period | Runbook |
|---|---|---|---|
| `reconcile_unbalanced` | `finance.reconcile`: a transaction does not balance, or a wallet projection drifts. Ads are paused automatically. | ICT day | [Ads pause](failure-runbooks.md#ads-paused-reconcile-or-kill-switch) |
| `email_backlog` | ≥ 100 unhandled domain events, or ≥ 20 emails overdue by more than 1 h | ICT day | [Email](failure-runbooks.md#email-failure-or-backlog) |
| `lock_missed` | The latest 03:12 lock is not `done` 2 h after its cutoff | per cutoff | [Lock](failure-runbooks.md#lock-failure-or-missed-lock) |
| `dead_letters_open` | Any failed live adapter call is waiting | ICT day | [Dead letters](failure-runbooks.md#adapter-dead-letters) |

If `OPERATOR_ALERT_EMAIL` or the `EMAIL` binding is missing, alerts stay pending. `operator.health` still lists the current conditions.

## SLOs
These are targets, not contracts. They are measured monthly from cron logs, `job_runs`, `email_outbox` and the decision log.

| Objective | Target |
|---|---|
| 03:12 lock `done` within 1 h of the cutoff (the hourly cron retries) | 99% of days; 100% within the 3-day catch-up window (`CATCH_UP_DAYS`) |
| Public pages and `/mcp` available (Workers) | 99.9% monthly |
| Verified PayPal webhook processed (bid settled or queued for review) | 99% within 5 min of first delivery |
| Transactional email sent | 95% within 15 min, 99% within 2 h |
| Ledger reconciles | 100% of hourly checks; any failure is an incident |
| Ads overspend | Zero: no flight beyond `spend_cap` or `daily_cap`, enforced by a DB `CHECK` and the planner |
