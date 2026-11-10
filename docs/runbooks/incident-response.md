# Incident response

## Severity
| Level | Examples | Response |
|---|---|---|
| SEV1 | Money at risk: ledger unbalanced, wrong captures, ads spend beyond a cap, data exposure, site down | Start now. Owner informed within 30 min. |
| SEV2 | Lock missed past 2 h, webhooks failing, email stopped, adapter dead letters piling up | Start within 2 h. |
| SEV3 | A degraded page, a single failed email or post | Next working day. |

## First 15 minutes
1. **Contain.**
   - Money or ads: run `ads.kill_switch` with `engaged: true`.
   - Bad payments: switch production `PAYMENT_MODE` away from `live` (degrades to `sandbox`) by changing `wrangler.jsonc` and deploying from `main`. Captured payments are kept.
   - Data exposure: rotate the affected secret (`OPERATOR_TOKEN`, `SESSION_SECRET`, `ZERNIO_API_KEY`) with `scripts/set-worker-secrets.sh`.
2. **Preserve evidence.**
   - Take a D1 export ([backup-restore](backup-restore.md)) and note a Time Travel timestamp.
   - Save `operator.health`, `operator.decisions` and `finance.reconcile`.
3. **Open an incident note**: an issue in the repository with the time (ICT), severity, symptoms and actions taken. Update it as you go.

## Recover
Follow the matching [failure runbook](failure-runbooks.md).
- Never edit balances or snapshots by hand. Corrections go through audited domain functions and leave a decision log entry.
- A restore from Time Travel is the last resort for corrupted data.

## Communicate
- Affected users get email from `hello@bip.ad` when their money, bids or payouts were affected.
- Public impact goes on `/transparency` and the social accounts once they are live.
- State facts and times only.

## Afterwards
Within 5 working days, write a short review in the incident issue covering the timeline, root cause, what contained it, and follow-ups with owners. Release the kill switch and resume ads only after `finance.reconcile` balances.
