# Code Review: BIP.AD MVP (commit 544aabc)

## Scope
- Files: src/** (domain, payments, mcp, auth, routes, app.ts, index.ts), migrations/0001_init.sql, test/**. Views checked only for XSS and open redirects.
- Spec: docs/BIP_AD_Decision_Brief_v1.1.md §3–6, 9, 12; docs/ADR/0001–0007.
- Checks run: `pnpm exec tsc --noEmit` passes (exit 0). `pnpm test`: 6 files, 47 tests, all pass.
- Method: read-only. I traced the code paths by hand and confirmed one finding (M1) with a script. I wrote no probe tests because the review is read-only.

## Overall assessment
Normal duplicate deliveries settle exactly once: the UNIQUE constraints are in the same batch. The ledger postings balance by construction, and HTML output is escaped everywhere. The defects are in the paths that only run when something goes wrong:
- a webhook that fails partway is never retried;
- several "cash arrived but rejected" states have no way to recover;
- refunds are silently dropped when any constraint fails;
- a state-changing UPDATE matches 0 rows, but the postings in the same batch still commit;
- the MCP OAuth consent step can be bypassed, which lets an attacker take over another user's account.

Several tests pass while asserting the wrong behaviour. For example, the A29 test checks that a captured $17 is rejected.

---

## Verified findings

### CRITICAL

**C1. MCP OAuth consent bypass lets an attacker get an MCP token for any user (A18)**
- Where: `src/app.ts:215-223` (`/auth/:provider/start?req=`), `src/app.ts:250-258` (`completeAuthorization`), `src/app.ts:264-280` (`/authorize`).
- Scenario:
  1. The attacker registers a client through `/register` with `redirect_uri=https://attacker/cb`.
  2. The attacker's server fetches `/authorize?...` with its own PKCE challenge and scrapes the `req=KEY` from the HTML.
  3. It sends the victim a 302 to `/auth/github/start?req=KEY`. The `bip_oauth_state` cookie is set in the victim's own browser, so the state check passes.
  4. GitHub redirects back without a prompt when the app was already authorized. The callback calls `completeAuthorization` for the victim's `userId` and redirects to the attacker's `redirect_uri` with a code.
  5. The attacker exchanges the code and now has a `/mcp` token as the victim.
  - The victim never sees a consent screen or the client name: `/authorize` has no Approve step, and `mcpreq:KEY` is not tied to the browser that loaded it.
- Impact:
  - `payouts.request` with the attacker's `beneficiary_reference` drains the victim's available commission at the next manual payout.
  - `products.update` can change `website_url` on the victim's paid products.
  - The attacker can read the victim's wallet, payouts and products.
- Fix:
  - Bind the pending request to the browser: set an HttpOnly cookie on `/authorize` and require it at the callback.
  - After sign-in, show an explicit consent page (client name, redirect host, scopes) with a POST form protected by a CSRF token.
  - The installed `workers-oauth-provider` already offers browser-bound consent helpers (`approveConsent`, `finishUpstream`, see `dist/*.d.ts` ~L1228-1280). Use them instead of the hand-rolled KV key.

**C2. A webhook is marked consumed before it is processed, so a failure loses the payment or refund permanently (A05)**
- Where: `src/payments/process.ts:50-71`.
- Scenario: `processEvent` inserts `webhook_events` as its own statement before calling `settle` or `refund`. If processing then throws a non-constraint error, the row stays in status `received` and the request returns 500. Causes include a transient D1 error, a CPU or time limit, or the `throw e` at `bidding.ts:263` after a reservation-closure race. PayPal or SePay retries, the INSERT hits UNIQUE, and the handler returns `replayed` with 200. The payment is never settled: cash is captured, no contribution exists, nothing alerts anyone, and the ledger is missing the receipt. Refund and chargeback events have the same problem, so the contribution keeps ranking and the ads fund stays overstated.
- Fix: treat the event row as a processing record:
  - On a UNIQUE conflict, re-run processing when the stored status is still `received` (or `failed`) and return `replayed` only for terminal statuses.
  - Alternatively, write the row with its final status inside the same batch as the settlement or refund.
  - Wrap processing in try/catch, set status `failed` with detail, and return 5xx so the provider retries.

### HIGH

**H1. Cash can be captured and then rejected, with no recovery path (wallet + provider)**
- Where: `src/domain/bidding.ts:99-127` (`applyWallet`), `:198-210` (`settle`), `src/payments/checkout.ts:15`, `src/app.ts:146-147`.
- Scenario (a), stale due amount:
  1. `boosts.checkout(provider=paypal)` creates the PayPal order for the full due amount (`checkout.ts:17`).
  2. The agent then calls `wallet.apply_to_bid`. It is allowed because the status is `awaiting_payment`, and `due` shrinks.
  3. The human pays the original order. `cashMinor !== due`, so the intent goes to `needs_review`.
  4. The wallet reservation is never released: `expireIntents` only scans `quoted` and `awaiting_payment`. Cash was captured, no bid exists, and no operator tool handles `needs_review`.
  5. SePay has the same problem: the signed form is built at GET time with the current due.
- Scenario (b), late capture after release: the quote expires plus a 1 h grace, and `expireIntents` releases the wallet. A late capture of the remaining cash returns `rejected: wallet_reservation_missing`. The intent stays `expired`, is not flagged, and the money is kept. `test/ledger.test.ts:111-113` asserts this outcome.
- Scenario (c), race: `applyWallet` checks the status and then batches. If `settle` commits in between, the reservation is created on a `confirmed` intent and stays reserved forever.
- Fix:
  - Freeze the wallet split once a provider order or form exists: refuse `applyWallet` when `provider_order_id` is set or `status != 'quoted'`.
  - Guard the batch: insert the reservation via `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM bid_intents WHERE id=? AND status='quoted' AND wallet_applied_minor=0)`, and check `meta.changes`.
  - When a captured payment is rejected for any reason, set `needs_review`, release the wallet reservation, and record an outbox or decision event.
  - Add an operator tool to resolve `needs_review`: settle at the locked price or refund.

**H2. A refund is silently dropped when any constraint fails (A07, A32)**
- Where: `src/domain/bidding.ts:305-311`, `:335-337`.
- Scenario:
  1. The commission is `available`. `refund` reads the referrer's `available_minor` (say 500) outside the batch.
  2. In parallel, the referrer's `payouts.request` reserves 500.
  3. The refund batch then applies `available -500`. The CHECK (>= 0) fails, the catch returns `{status:'duplicate'}`, and the webhook row is stored as `duplicate`. Replays are then `replayed` (see C2).
  4. Result: the contribution keeps ranking, ads funds are not reduced, the commission is not clawed back, and the buyer got their money back from the provider.
- The same catch also turns the vest race (M4) and any foreign-key failure into "duplicate".
- Fix:
  - Return `duplicate` only when a re-read shows `payments.state <> 'captured'`. Otherwise re-read the balances and retry.
  - Better: do the clawback split without a read-then-write. Credit the whole commission to `clawback_receivable`, then net it in a follow-up transaction.

**H3. Simulated mode is the fail-open default on a public deployment and writes real-looking money records**
- Where: `src/domain/config.ts:44`, `wrangler.jsonc` vars (`PAYMENT_MODE: "simulated"` on `bip-ad.digitop-vn.workers.dev`), `src/payments/process.ts:77-84`, `src/app.ts:178-181`.
- Scenario:
  1. Any signed-in user quotes up to 100,000,000 rank units (USD 1M) and clicks the simulated pay button. The bid ranks.
  2. If that user was referred, the referrer gets a real `referral_commissions` row and `liability:wallet:*:pending` (5% = USD 50k). After 30 days it vests and `payouts.request` works.
  3. Simulated receipts are booked as `provider='paypal'` and `asset:cash:paypal`. They can only be told apart from real receipts by the `sim_` prefix, so the operator's payout batch and `finance.reconcile` cannot tell them apart.
  4. Any typo in `PAYMENT_MODE` (for example `Live`) also falls back to `simulated`.
- Fix:
  - Fail closed: throw at startup on an unknown `PAYMENT_MODE`.
  - In simulated mode, book receipts to `asset:cash:simulated`, mark the payments and commissions `is_test`, and refuse payout requests and batches for test funds.
  - Never share a database between simulated and sandbox/live.

**H4. Housekeeping runs before the 03:12 lock and can block it**
- Where: `src/index.ts:48-52`, `src/domain/wallet.ts:25-54`, `src/domain/bidding.ts:342-350`.
- Scenario: both crons call `scheduledJob`, which runs `vestCommissions`, then `expireIntents`, then `runDueLocks` in sequence with no isolation. Any non-constraint throw stops the lock for that run; the hourly catch-up then hits the same error every hour, so no snapshots, cohorts or flights are produced. Possible throws:
  - a transient D1 error;
  - a poison row;
  - the per-invocation query budget, since these are unbounded loops of 2–4 queries per row.
  The housekeeping also delays the lock past 20:12, which widens the race in M2.
- Fix: run `runDueLocks` first on the `12 20 * * *` trigger (dispatch on `event.cron`). Wrap each housekeeping step in its own try/catch. Process rows in pages, for example `LIMIT 100` per run.

### MEDIUM

**M1. Open redirect after sign-in through an embedded TAB (confirmed with a script)**
- Where: `src/app.ts:54` (`safeNext`), `src/views/login.ts:22-24`, used by `/auth/:provider/start` (`app.ts:220`) and the callback (`app.ts:260`).
- Scenario: `/login?next=%2F%09%2Fevil.com`, or a direct `/auth/github/start?next=%2F%09%2Fevil.com`. The value `"/\t/evil.com"` passes both checks, `Headers.set('Location')` accepts it, and browsers strip the TAB. `new URL("/\t/evil.com","https://bip.ad")` gives `https://evil.com/`. A real sign-in on bip.ad then lands on an attacker page, which is useful for phishing.
- Fix: reject any control character or whitespace (`/[\x00-\x1f\x7f\s]/`). Also require `new URL(next, origin).origin === origin`.

**M2. A contribution can be left out of every cohort; refund and finalize race (A08, A10)**
- Where: `src/domain/snapshot.ts:50-55`, `src/domain/bidding.ts:221`, `:286`, `:296`.
- Scenario (a), straggler: `settle` stamps `confirmed_at` and `assigned_cutoff_at` from the request's `nowMs`, before several D1 round-trips and the batch commit. A capture processed at 20:11:59.9 is assigned cutoff C but commits after `finalizeCohort(board, C)` has read its rows. Two things then exclude it for good:
  - the early return when a cohort for (board, C) already exists;
  - the `assigned_cutoff_at = ?` equality filter.
  Its 80% stays in `liability:ads_pending:{board}` and is never allocated.
- Scenario (b), refund race: `refund` reads `inCohort=false`. `finalizeCohort` then includes the still-active contribution and moves its ads share to `ads_fund`. The refund then debits `ads_pending`. Result: `ads_pending` goes negative and `ads_fund` is overstated by the refunded ads share.
- Fix:
  - Finalize with `assigned_cutoff_at <= ?` and no early return. Sweep every active, unallocated contribution into the current cohort, or into a separate "late adjustment" cohort row.
  - In `refund`, decide the ads account in SQL inside the batch rather than from a prior read. For example, always debit `ads_pending`, and have finalize move only what was actually allocated.

**M3. A concurrent refund and chargeback reverse the same payment twice**
- Where: `src/domain/bidding.ts:327-328`.
- Scenario: `PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.CAPTURE.REVERSED` for the same capture are processed concurrently. Both read `state='captured'`. The ledger kinds differ (`bid_refund` and `bid_chargeback`), so UNIQUE(kind, reference_id) does not stop the second. `UPDATE payments … WHERE state='captured'` silently matches 0 rows, and the reversal is posted twice. The buyer's wallet portion is returned twice, cash is credited twice, and the ads and platform accounts are debited twice.
- Fix: use one ledger kind for every reversal of a payment (for example `bid_reversal`, with `refund` or `chargeback` in the memo). Alternatively, add a guard row, such as `INSERT INTO payment_reversals(payment_id PRIMARY KEY)`, in the batch.

**M4. Vesting posts the ledger entries even when the state UPDATE matched 0 rows**
- Where: `src/domain/wallet.ts:34-42`.
- Scenario: `refund` claws back a pending commission (state becomes `clawed_back`, pending −c) just as `vestCommissions` runs from a stale SELECT. The vest batch runs:
  - `UPDATE … WHERE state='pending'`, which matches 0 rows;
  - the `commission_vest` posting, which is first-time and UNIQUE-free;
  - `pending −c / available +c`.
  If the referrer has other pending commissions, the CHECK passes and a clawed-back commission becomes spendable. Otherwise the CHECK fails and is swallowed. In the reverse order, H2 drops the refund instead.
- Fix: make the batch abort when the guard UPDATE misses. For example, add `INSERT INTO guard(x) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM referral_commissions WHERE id=? AND state='available')` after the UPDATE, against a NOT NULL column. Or use a trigger-backed state-transition table.

**M5. A partial PayPal refund is treated as a full refund**
- Where: `src/payments/process.ts:29-30`, `src/domain/bidding.ts:278-339`.
- Scenario: the merchant refunds $1 of a $15 capture. `PAYMENT.CAPTURE.REFUNDED` arrives, the amount is ignored, and the whole contribution is voided. Cash is credited with the full $15, the ads share and commission are fully reversed, and the ledger cash no longer matches PayPal.
- Fix: read `resource.amount`. For a partial refund, either set `needs_review` or post a proportional adjustment, and keep the contribution according to policy.

**M6. The ads hard cap is not enforced cumulatively, and a refund does not lower the cap (A14, A16)**
- Where: `src/mcp/operator-server.ts:78-92`, `src/domain/snapshot.ts:87-89`.
- Scenario: `ads.execute` checks `committed_minor + amount > spend_cap_minor`, but `committed_minor` is never incremented. One hundred calls of `spend_cap_minor` each are all within cap. A refund after funding debits `ads_fund`, but `ad_flights.spend_cap_minor` stays the same. The adapter is mocked today, so nothing is spent, but A14 currently passes for the wrong reason.
- Fix: do an atomic `UPDATE ad_flights SET committed_minor = committed_minor + ? WHERE id=? AND committed_minor + ? <= spend_cap_minor` and check `meta.changes`. Reduce the cap, or pause the flight, in the refund batch when `inCohort` is true.

**M7. Owners can change published content without moderation**
- Where: `src/domain/products.ts:93-108` (`updateProduct`), `:187-202` (`publishPage`).
- Scenario: after approval (auto or by the operator), the owner calls `products.update` to change the name, tagline or `website_url`, and `pages.publish` to publish any new page version as `approved`. Both go live immediately with no re-screen. `/go/:slug` (`app.ts:103`) then redirects bip.ad traffic to whatever URL the owner now chooses. This defeats manual moderation (`AUTO_APPROVE_PRODUCTS=false`) and brief §6.2 ("every page version has moderation_state").
- Fix: for published products, store edits as pending versions and run `moderationScreen` on them. Do not set `moderation_status='approved'` in `publishPage` unless the screen passes or the operator approves.

**M8. A17 is not implemented: nothing sets `removed_from_publication`**
- Where: `src/domain/products.ts:152-165`. The only place that sets it is raw SQL in `test/snapshot.test.ts:85-95`.
- Scenario: the operator suspends a product after a lock. The snapshot items stay `visible`, and no decision record links the suspension to any published snapshot. `produceMockMedia` already ran, so the composition keeps the product.
- Fix: in `moderateProduct(..., 'suspend')`, in the same batch, set `visibility_state='removed_from_publication'` on that product's items in snapshots whose media is not final. Write a decision log entry for each snapshot.

**M9. The click/view tie-breaker can be inflated by rotating the User-Agent (A23)**
- Where: `src/app.ts:92`, `:101`, `:305-312`; `src/domain/measurement.ts:12`.
- Scenario: the visitor is `hash(secret, day, IP, UA)`. A script on one IP requesting `/p/slug?src=card` or `/go/slug` with N distinct non-bot UAs (20+ characters) gets N unique clicks and views per day. That decides ties, including among all free listings. The owner is excluded only when signed in.
- Fix: key the visitor on IP (or /24 for IPv4, /64 for IPv6) plus day, without the UA. Count `product_card_click` only with a same-site Referer and a short-lived signed token from the card render. Cap unique visitors per IP prefix per product per day.

**M10. Every public page view runs unbounded ranking aggregations; reconcile does N+1 queries**
- Where:
  - `src/domain/ranking.ts:52-87`;
  - `src/routes/view-data.ts:44-48` (home: 3 runs), `:66-70` (product page: 3 runs);
  - `/api/boards/:board`, polled every 30 s per open tab;
  - `src/mcp/operator-server.ts:118-123`.
- Scenario: each request runs `COUNT(DISTINCT visitor_hash)` over 30 days of `measurement_events` for every published product, three times per page, with no cache. Read volume grows with traffic times the 30-day window, which is both a D1 cost and a denial-of-service risk. `reconcile` runs 4 queries per wallet row and will exceed the per-invocation query budget as wallets grow.
- Fix: maintain a `ranking_metric_rollups` table (the brief §3.1/§6.3 asks for this), written hourly and at the cutoff. Read standings from it, cache the board JSON in KV or the Cache API for about 15 s, and compute reconcile drift with one GROUP BY join.

### LOW

**L1. A late first lock run uses current state, not state at the cutoff (A33)**
`src/domain/ranking.ts:86` (`p.status='published'`) and `:78` (`current_page_version_id`, `version`). Snapshot retries are deterministic once the snapshot is stored. But if a product is suspended, or its page republished, between 20:12 and a late first run, it is dropped or pinned to the wrong page version. Fix: filter on a status history, or record the moderation time and include products suspended after the cutoff.

**L2. Lock marks "done" even when cohort creation failed; the constraint regex is too broad**
`src/domain/snapshot.ts:97-99`, `:137`; `src/domain/errors.ts:10`. `isConstraintError` also matches FOREIGN KEY and NOT NULL failures. `finalizeCohort` swallows any of them as `{created:false, cohorts:[]}`, and `runLock` sets `done`, so the cohort is never retried. Fix: after a constraint error, re-read and confirm a cohort exists; otherwise rethrow. Narrow the regex to UNIQUE and PRIMARY KEY where a race is what is expected.

**L3. The operator can create snapshots for arbitrary past cutoffs**
`src/mcp/operator-server.ts:17-24`. `locks.run` or `boards.freeze` with a cutoff a year ago produces an "immutable" snapshot from today's data. Fix: limit to the catch-up window (for example 2 days) unless an explicit backfill flag is set, and log the decision.

**L4. `SESSION_SECRET` is reused as the PII encryption key**
`src/domain/wallet.ts:81`, `src/mcp/user-server.ts:123`, `src/mcp/operator-server.ts:95`. Rotating the session secret makes every stored beneficiary reference undecryptable. Fix: use a separate `PII_ENCRYPTION_KEY` and add a key id to the `v1.` envelope.

**L5. Quote annotations and idempotency**
`src/mcp/user-server.ts:83-93` sets `readOnlyHint: true` on `boosts.quote`, which writes a `bid_intents` row. `quote()` (`bidding.ts:71-72`) returns the existing intent for a reused key even when the product, board or amount differ. Fix: set `readOnly` to false, and return 409 when a reused key comes with different parameters.

**L6. `failPayout` reports `failed` after losing the race to `recordManualTransfer`**
`src/domain/wallet.ts:204-207`. The constraint error is swallowed and `{status:'failed'}` is returned while the request is actually `paid`. Fix: re-read and return the real state.

**L7. Any visitor can view `/checkout/:id`**
`src/app.ts:140-153`. A non-owner holding the URL sees the product, amounts and wallet split. The ids are unguessable, so the risk is low. Fix: limit the details to the owner, or accept as designed.

---

## Suspicions not confirmed (need provider docs or a live check)

- **S1. PayPal `PAYMENT.CAPTURE.REVERSED` lookup** (`src/payments/process.ts:31-32`). I believe the event's `resource` is a refund-type object whose `id` is not the capture id. If so, `refund()` returns `unknown` and chargebacks are never applied. Verify with a sandbox event; if confirmed, resolve the capture through `links[rel=up]` as REFUNDED does.
- **S2. PayPal webhook verification uses re-serialized JSON** (`src/payments/paypal.ts:70-92`). `webhook_event: JSON.parse(raw)` is re-serialized before being sent to `verify-webhook-signature`. There are reports of FAILURE results when the event is not byte-identical. If legitimate events fail, every refund and reversal webhook is rejected; captures still settle through the return URL. Test in sandbox; if needed, splice the raw body into the request string.
- **S3. D1 per-invocation query limits** (50 on Free, 1000 on Paid). A first full `runDueLocks` (3 cutoffs × 3 boards × freeze + finalize + media) plus housekeeping loops may exceed 50 on the Free plan. The plan tier is unknown.
- **S4. Batch size of `freezeBoard`** (`src/domain/snapshot.ts:26-33`): one INSERT per published product, for each of three boards, in one batch. I could not confirm whether D1 statement-count or payload limits are hit at around 1k products.
- **S5. Out-of-order webhooks.** If a refund arrives before its capture, `refund()` returns `unknown` and the event is consumed (C2). The later capture then settles a refunded payment. Ordering is provider-dependent; the brief §4.3 says to expect out-of-order delivery.

## Edge cases found while scouting
- Captured cash with no contribution: C2, H1 (a) (b) (c), S5.
- A state UPDATE that matches 0 rows while the postings in the same batch still commit: M3 (payments), M4 (commission vest), H1 (c) (`applyWallet` intent status).
- A value read outside the batch and then written inside it: H2 (clawback balance), M2 (b) (`inCohort`).
- Lock-time boundary: M2 (a) straggler; H4 delays the lock.
- `isConstraintError` used as a catch-all for "duplicate" or "race": H2, L2, L6, `upsertUser` (catch-all at `session.ts:69`).

## Test quality notes
- `test/ledger.test.ts:111-113` (A29) asserts that a $17 capture after release is `rejected`, with no `needs_review` and no release check. This enshrines H1 (b).
- The A30 test uses `Promise.allSettled` within a single isolate against local D1. It does show that the CHECK serializes the two writes, which is real evidence.
- The A17 test sets `removed_from_publication` with raw SQL, so it does not test any product code path (M8).
- Missing tests:
  - a webhook that fails during processing and is then replayed (C2);
  - a wallet applied after a provider order exists (H1 a);
  - a concurrent refund and chargeback (M3);
  - a partial refund (M5);
  - a refund racing with vesting or a payout (H2, M4);
  - a contribution committed after its cohort was finalized (M2);
  - the OAuth flow with `req=` from another browser (C1).

## XSS / injection
I found no XSS. The `html` tagged template escapes `& < > " ' \``. URLs go through `httpUrl`, which allows only http(s). Markdown escapes text runs and allows only http(s) links. The `board-data` JSON escapes `<`, and the SePay auto-form escapes its fields and action. No server-side fetch of user-supplied URLs exists, so SSRF does not apply (the `safeUrl` blocklist is incomplete, but nothing fetches).

## Recommended actions (in priority order)
1. C1: browser-bound consent with an explicit approval step for MCP OAuth.
2. C2: make webhook processing retryable (status-aware replay, failure status, 5xx).
3. H1: freeze the wallet split once a provider order exists; release and flag on every rejected capture; add a `needs_review` operator tool.
4. H2, M3, M4: stop turning every constraint error into "duplicate"; add guard rows so a 0-row UPDATE aborts its batch.
5. H3: fail closed on `PAYMENT_MODE`; separate simulated money from real money and block payouts of test funds.
6. H4: run the lock first and isolate housekeeping.
7. M1: fix `safeNext` in both places.
8. M2: let finalization sweep stragglers.
9. M5–M10, then the Low items.

## Metrics
- Type check: pass (0 errors).
- Tests: 47/47 pass (6 files). No coverage report is configured.
- Lint: no linter configured.

## Plan follow-ups
Phase 2/3 acceptance should not be marked complete for A05 (C2), A07/A32 (H2, M3, M5), A17 (M8), A18 (C1), A28–A29 (H1) and A14 (M6) until the fixes above land and have tests. I did not edit any plan files.

## Unresolved questions
1. Is the workers.dev deployment meant to collect real referral payouts while in simulated mode? This decides whether H3 is critical.
2. Does the owner want partial refunds to void the bid (M5)? This is a product decision.
3. Which D1 plan tier is used (S3)?
