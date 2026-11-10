# Go-live checklist

Status as of 2026-11-10. The source is the decision brief, §11 Phase 5. Explicit owner approval is required before real money or paid ads are switched on, and each switch needs its own approval.

| Item | Status | Evidence / next step |
|---|---|---|
| Terms, Privacy, Refund pages | Done (drafts) | `/terms`, `/privacy`, `/refunds` (`src/views/legal-*.ts`), linked from the footer and checkout. Owner legal review is still pending. |
| Content policy, Ads disclosure | Partial | Paid placement is disclosed in the footer, and `/transparency` explains the 80% ads fund. There is no dedicated Ads Disclosure page yet. |
| Live payments switched on | Done (PayPal only) | Production has `PAYMENT_MODE=live` and `LIVE_PAYMENTS=true`, approved 2026-11-09 (`wrangler.jsonc`). SePay stays off until its live secrets are set. |
| E2E payment with a small real-money test | **Pending** | Make one small live PayPal bid on production. Confirm the bid receipt email, `payments.reviews` (empty) and `finance.reconcile` (balanced). Then refund it at PayPal and confirm the reversal. |
| OAuth redirect URIs | Done | `https://bip.ad/auth/github/callback` and `https://bip.ad/auth/google/callback` (`src/auth/upstream.ts`). Recheck them after any domain change. |
| Webhooks over HTTPS | Done (PayPal) | `https://bip.ad/api/webhooks/paypal`, registered by `scripts/setup-paypal.sh production`. SePay IPN is not configured. |
| Domain, DNS, certificate | Done | `bip.ad` and `www.bip.ad` are Workers custom domains (`env.production.routes`), with certificates managed by Cloudflare. |
| Hard spend limits | Done | Each flight's `spend_cap` and `daily_cap` are enforced in code and by a DB `CHECK` ([ADR-0007](../ADR/0007-media-and-ads-mocks.md)). |
| Alerts | Done | Alert emails go to `OPERATOR_ALERT_EMAIL`. See [monitoring](monitoring-alerts-slos.md). |
| Bank reconciliation, finance dashboard | Partial | `finance.reconcile` checks the ledger against itself only. Reconciliation against PayPal settlement reports is done by hand. |
| Referral payout disclosure, 5% policy | Partial | The 5% applies to the first external-cash bid only, approved by the owner on 2026-11-10 ([ADR-0005](../ADR/0005-referrals-wallet-payouts.md)). Payouts are manual on days 01–10. The other referral defaults and the tax disclosure still need owner approval. |
| Backup/restore, monitoring, SLOs, runbooks, incident response | Done | This folder. Do one restore drill (see [backup-restore](backup-restore.md)). |
| Social posting | **Off** | `SOCIAL_MODE=mock`. To turn it on, see "Owner actions" below. |
| Paid ads | **Off** (dry run) | `ADS_MODE=dry_run`, `ADS_LIVE_APPROVED=false`. Needs separate owner approval. |

## Owner actions
1. **Social posting.** Set the `ZERNIO_API_KEY` secret on the worker with `scripts/set-worker-secrets.sh production ZERNIO_API_KEY`.
   - Set `ZERNIO_ACCOUNT_X`, `_FACEBOOK`, `_YOUTUBE` and `_TIKTOK` to the account `_id`s from Zernio `GET /v1/accounts`.
   - Set `SOCIAL_MODE=live`, deploy, then publish one snapshot with `social.publish` and check each post.
   - YouTube and TikTok need a rendered video URL.
2. **Paid ads**, only after a separate approval:
   - Set `ZERNIO_ADS_ACCOUNTS`.
   - Review the unconfirmed API points in [ADR-0007](../ADR/0007-media-and-ads-mocks.md).
   - Watch a few dry-run cycles in `adapters.requests`.
   - Then set `ADS_MODE=live` and `ADS_LIVE_APPROVED=true`.
   - Flights that already executed as dry runs stay dry runs. Only new allocations are sent.
