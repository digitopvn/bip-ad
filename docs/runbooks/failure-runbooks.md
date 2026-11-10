# Failure runbooks

All tools named here are on `/operator/mcp`. Start every investigation with `operator.health` and `operator.decisions`.

## Payment webhook failures
PayPal posts to `/api/webhooks/paypal` (`src/app.ts`). A failed signature check answers 401. A processing failure or an out-of-order reversal answers 503, and PayPal redelivers it for up to 3 days.

1. Find the cause in the Workers logs, then check the PayPal dashboard → Webhooks → event history.
   - 401: compare `PAYPAL_WEBHOOK_ID` with the webhook registered by `scripts/setup-paypal.sh production`.
   - 503: read the logged error.
2. Look for captures that need a human with `payments.reviews`, then settle or dismiss them with `payments.resolve_review` (ADR-0004).
3. After a fix, resend the failed events from the PayPal dashboard. Processing is idempotent per event (`webhook_events`).
4. Run `finance.reconcile`. It must be balanced.

## Lock failure or missed lock
The lock runs at 03:12 ICT, and the hourly cron (`:40`) resumes or catches it up (`runDueLocks`, `src/domain/snapshot.ts`). Every step is idempotent.

1. Check `operator.health` → `last_lock`, and the `lock run` cron log.
2. Run `locks.run` with `cutoff_at` = the cutoff (03:12 ICT = 20:12Z of the previous day). It is safe to repeat.
3. After `CATCH_UP_DAYS` (3) a cutoff can no longer be locked. Record the gap in the decision log and tell users (see [incident response](incident-response.md)).

## Email failure or backlog
Delivery goes through the Cloudflare Email Service binding ([ADR-0009](../ADR/0009-transactional-email.md)). A failed send retries 6 times over about 10 h, and permanent errors fail at once.

1. Use `emails.list` with `status: failed`, then read `last_error`.
   - `E_SENDER_*` errors: check the `bip.ad` zone under Email Service → Email Sending, and check `EMAIL_FROM`.
   - Rate or daily limits: wait. Rows stay pending and are retried.
2. A projection backlog (`email_projection_backlog`) means the projector is failing. Check the `email projection` errors in the logs.

## Ads paused (reconcile or kill switch)
The hourly cycle pauses every unfinished flight when `finance.reconcile` is unbalanced or the kill switch is on (`src/ads/ads-safety-controls.ts`). Pausing logs `ads.pause`.

1. Use `finance.reconcile` to find the unbalanced `txn_id`s or the wallet drift. Fix the cause through an audited domain function, never by editing balances.
2. If the kill switch is on, check `operator.health` → `ads_kill_switch` for who set it and why. `ADS_KILL_SWITCH=true` in config can only be cleared by a deploy.
3. Once it balances and the switch is off, run `ads.resume` with a note. Flights continue where they stopped.

To stop ads immediately, use `ads.kill_switch` `{ engaged: true, reason }`.

## Adapter dead letters
Failed live Zernio calls (posts, campaigns) wait in `adapters.dead_letters`.

1. Read the `error`.
   - 401/403: check `ZERNIO_API_KEY` and the account's permissions in Zernio.
   - 4xx validation: fix the configuration.
   - 5xx or timeout: retry.
2. Use `adapters.retry` `{ dead_letter_id }`. It resends the stored request with the same `Idempotency-Key`, so a post that actually landed is returned rather than duplicated.
3. If the platform refuses for policy reasons, do not keep retrying. Leave the publication `failed` and note it with the decision log.
