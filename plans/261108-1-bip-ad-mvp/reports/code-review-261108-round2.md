# Code Review Round 2: fix commit ce5493e

## Scope
- Commit `ce5493e` ("fix: harden payments, ledger, consent and moderation"): 28 files, +1315/-261. I read the full current source of `src/app.ts`, `src/index.ts`, `src/domain/{bidding,wallet,snapshot,products,ledger,config,errors,measurement,referrals}.ts`, `src/payments/{process,paypal,sepay,checkout}.ts`, `src/mcp/*.ts`, `src/views/{authorize,login}.ts`, `migrations/0002_money_guards.sql`, `test/hardening.test.ts`, and the ADR diffs.
- Checks: `pnpm typecheck` passes. `pnpm test` passes: 7 files, 69 tests.
- Probes: I ran three probe tests from a scratch vitest config outside the repo. They import the real source and use the same miniflare setup. No repository file was changed except this report.
  - Probe 1: a second `GET /api/boards/daily` returns **500** (`TypeError: Can't modify immutable headers`).
  - Probe 2: two partial refunds of 500 + 1000 on a 1500 capture both return `partial_review`, and the contribution stays `active`.
  - Probe 3: after `suspend` and then `reject`, `products.submit` republishes the product (`published`, auto-approve on).

## Overall assessment
Most of the claimed fixes are real.
- The batch-guard pattern is sound. Every condition is an `EXISTS(...)`, so `NOT(cond)` is never NULL, and a false condition always aborts the batch. `isConstraintError` also matches the NOT NULL error, so all existing catch blocks see guard failures.
- The refund and finalize retry loops re-read state, and they stop after 4 attempts with a loud error.
- The OAuth consent flow now uses the library's browser-bound `beginConsent`/`approveConsent`/`beginUpstream`/`finishUpstream`. The test proves that a request without the binding cookie is refused.

One new High defect: the board JSON edge cache crashes on every cache hit. Two fixes are incomplete: partial refunds (M5) and moderation of published edits (M7).

---

## Verification of claimed fixes

| Item | Verdict | Evidence |
|---|---|---|
| C1 OAuth consent bypass | **Fixed** | `app.ts:282-322` uses `beginConsent` → POST `approveConsent(handle)` (the cookie must match, single use) → `beginUpstream`. The callback uses `finishUpstream` (`app.ts:266`). The consent page escapes the client name and redirect host, and warns about loopback redirects. `hardening.test.ts:293` covers a missing cookie and a reused handle. |
| C2 webhook consumed before processing | **Fixed** | `process.ts:92-112`: a redelivery reprocesses while status is `received`, `failed` or `retry`; errors set `failed` and the route answers 503. Settle and refund are idempotent by their own keys. See also the Low item on refunds for captures that never became payments. |
| H1 captured cash rejected without recovery | **Fixed** | `applyWallet` accepts only `quoted` with no provider order, with a guard (`bidding.ts:115-129`). Every rejected external capture goes through `flagCaptureForReview`: payment review, intent set to `needs_review`, wallet released. `resolvePaymentReview` exists. One exception remains: `intent_provider_mismatch` (Low below). |
| H2 refund silently dropped | **Fixed** | `bidding.ts:409-414`: only a recorded `payment_reversals` row counts as duplicate; any other constraint or guard failure retries with fresh reads. |
| H3 simulated mode fail-open | **Fixed** (one gap) | An unknown `PAYMENT_MODE` throws (`config.ts:269`). Simulated cash goes to `asset:cash:simulated:*`, `payments.is_test` and `referral_commissions.is_test` are set, and quotes are capped. Payouts are refused in simulated mode, and test commissions are excluded from the payable balance. Gap: wallet-only settlements are not flagged (Low below). |
| H4 housekeeping blocks lock | **Fixed** | `index.ts:224-234`: the lock runs first, each housekeeping step runs isolated, and `expireIntents`/`vestCommissions` process at most 100 rows per run. |
| M1 open redirect | **Fixed** | `safeNext` rejects `[\x00-\x20\x7f\\]` and checks the origin. It is used at start and at the callback. |
| M2 straggler + refund/finalize race | **Fixed** | Finalize selects `assigned_cutoff_at <= ?` and guards each row as still active. Refund guards the cohort membership it read. Both retry. |
| M3 double reversal | **Fixed** | The primary key on `payment_reversals.payment_id` is in the same batch. |
| M4 vest posts on a 0-row update | **Fixed** | The guard in `wallet.ts:37`. |
| M5 partial refund treated as full | **Partial** | See Medium #1: cumulative partial refunds never reverse the bid. |
| M6 ads cap | **Fixed** | Atomic conditional `UPDATE ... committed_minor + ? <= spend_cap_minor`. A refund lowers the cap but never below what is already committed. |
| M7 published edits bypass moderation | **Partial** | Edits are held, but the operator cannot see them, and approval is not pinned to what was reviewed. See Medium #2. |
| M8 A17 not implemented | **Fixed** | Suspension marks `removed_from_publication`, with one decision log per snapshot. |
| M9 UA rotation inflates visitors | **Partial** | The UA is removed from the key, but the full IPv6 address is the key. See Medium #3. |
| M10 board JSON cache | **Broken** | See High #1. |
| M10 single-query reconcile | **Fixed** | One CTE join in `operator-server.ts:131-148`. The column names match the account format. |
| L2 lock done despite cohort failure | **Fixed** | `tryFinalizeCohort` returns `null` (retry) unless a cohort really exists, and `runLock` is marked done only after every board succeeds. |
| L3 arbitrary past cutoffs | **Fixed** | `cutoffArg` limits the cutoff to 3 days back. |
| L5 quote annotation and idempotency | **Fixed** | `boosts.quote` is no longer read-only, and a reused key with different parameters returns 409. |
| L6 failPayout reports wrong state | **Fixed** | A guard is added, and the real state is re-read on conflict. |
| S1 REVERSED capture lookup | **Addressed, unverified** | Uses `links[rel=up]` first, then falls back to `resource.id`. The provider payload is still unverified in sandbox. |
| S5 refund before capture | **Fixed** | The event is marked `retry` and answered with 503. |

---

## Critical
None found.

## High

**1. `/api/boards/:board` returns 500 on every edge-cache hit (confirmed by probe)**
- Where: `src/app.ts:330-333` together with `secureHeaders()` (`app.ts:39`).
- Cause: on a hit, the handler returns the `Response` from `caches.default.match()` unchanged. Hono assigns it to `c.res` without copying, because no earlier response exists. `secureHeaders` then calls `ctx.res.headers.set(...)` after `next()`. Responses from `cache.match()` have immutable headers, so the call throws `TypeError: Can't modify immutable headers`, and `onError` returns the 500 HTML page.
- Scenario: request 1 is a miss (200) and stores the copy. Every request for that board in the next 15 s gets a 500. Every open board tab polls this endpoint every 30 s.
- Why the tests miss it: `web.test.ts:27` fetches the endpoint only once.
- Deployment note: the Cache API has no effect on `*.workers.dev`, so the current deployment never gets a hit and the bug is latent. It fires as soon as the Worker is served from a custom domain such as bip.ad.
- Fix: `if (hit) return new Response(hit.body, hit);` copies the response with mutable headers. Add a test that fetches the endpoint twice.

## Medium

**1. Partial refunds that add up to a full refund never reverse the bid, and nothing can fix it (confirmed by probe)**
- Where: `src/domain/bidding.ts:339-348`, `src/payments/process.ts:60-62`, `resolvePaymentReview` (`bidding.ts:457-482`).
- Cause: each PayPal `PAYMENT.CAPTURE.REFUNDED` event carries the amount of *that* refund. `refund()` compares each event alone with `cash_minor`.
- Scenario: the merchant refunds $5 and later the remaining $10 of a $15 capture. Both events are `< 1500`, so both become `partial_review`.
- Result:
  - The contribution keeps ranking for its whole duration.
  - The ledger still shows $15 cash and 80% in the ads accounts.
  - The referral commission still vests and becomes payable on cash that was returned.
- No path recovers from this:
  - `resolve_review` refuses `settle` for `partial_refund` reviews.
  - `dismiss` is a no-op for a confirmed intent.
  - No operator tool voids a contribution.
- The test `hardening.test.ts:91-93` assumes that the second refund event reports the full `15.00`, which is not how PayPal reports refunds.
- Fix: sum the refunded amounts per payment (store each refund event, for example in `payment_reviews` or a `payment_refunds` table). Reverse the bid when the cumulative refund reaches `cash_minor`. Alternatively, add an operator `void`/`reverse` resolution for `partial_refund` reviews.

**2. Held edits on published products cannot be reviewed, and approval applies whatever is pending at call time (M7 partial)**
- Where: `src/domain/products.ts:100-131`, `:206-221`, `:271-289`; `src/mcp/operator-server.ts:37-54`.
- Problem (a), no review surface:
  - No operator tool lists products with `pending_edit_json` or `pending_page_version_id`, or shows their contents.
  - `operator.health` counts only `status='pending_review'`, which a published product with a held edit never has.
  - With `AUTO_APPROVE_PRODUCTS=false`, held edits are invisible except as `defer` rows in `operator.decisions`, and the operator must approve without seeing the content.
- Problem (b), approval not pinned to what was reviewed:
  - `moderateProduct('approve')` re-reads the product and applies the current `pending_edit_json` and `pending_page_version_id`.
  - The owner can replace the pending `website_url` (`updateProduct` merges into the pending edit) or the pending page (`publishPage`) after the operator inspected it and before the operator calls approve.
  - The unreviewed version then goes live, and `/go/:slug` redirects to the new URL.
- Fix:
  - Add an operator tool that lists pending edits and pages with their contents and the product `version`.
  - Make `products.moderate` take `expected_version` and use `UPDATE ... WHERE version = ?`, so approval fails if the product changed after review.

**3. The visitor key is the full IP, so one IPv6 /64 mints unlimited "unique" visitors (M9 partial)**
- Where: `src/domain/measurement.ts:193-195`, `src/app.ts:366-368`.
- Scenario: a single VPS or home connection usually gets an IPv6 /64. A script that sends each request from a different address in that /64 records one new `product_page_view`, `outbound_click` and `product_card_impression` per address per day. A spoofed `Referer` also adds `product_card_click`. These counts decide ties, including the order of every free listing.
- Fix: truncate IPv6 to /64 (and optionally IPv4 to /24) before hashing, as the first review recommended.

## Low

1. **Refunds or chargebacks for captures that never became payments keep returning 503.**
   - Where: `process.ts:121-124`.
   - Cause: `refund()` returns `unknown` whenever no `payments` row exists, and `unknown` always maps to `retry`.
   - Affected events: refunds of captures that were sent to `payment_reviews` and then dismissed ("refund at the provider" is the documented path), and refunds of unrelated sales on the same PayPal account.
   - Result: the event never reaches a final status. The provider redelivers until it gives up, and a real out-of-order case becomes hard to tell apart.
   - Fix: when a `payment_reviews` row exists for that capture, return a final status such as `review_refunded`.
2. **`intent_provider_mismatch` keeps captured money without a review.** `process.ts:117` returns the final status `rejected:intent_provider_mismatch` before `settle`, so this capture never reaches `flagCaptureForReview`. This breaks the ADR-0004 rule that "a verified capture that does not match its intent is never silently kept". The trigger is rare: for example, a capture for an intent whose `provider` is still NULL. Fix: route it through `flagCaptureForReview`.
3. **A `reject` after a `suspend` lets the owner republish (confirmed by probe; the behaviour predates this commit).**
   - Where: `products.ts:210`.
   - Cause: `reject` on a suspended product sets `rejected`, and `submitProduct` accepts `rejected`.
   - Result: with `AUTO_APPROVE_PRODUCTS=true` (the deployed value), a product the operator suspended goes back on the boards. The commit's new "reject drops pending changes" meaning makes this operator call more likely.
   - Fix: keep `suspended` on `reject`, or refuse to resubmit products that were suspended.
4. **Wallet-only settlements in simulated mode are not flagged as test money.** `app.ts:170` calls `settle` with `provider: 'wallet'` and no `isTest`. In simulated mode the wallet balance can only come from simulated commissions, yet the payment is stored with `is_test=0` and counted as real `wallet_funded` cohort revenue. Fix: pass `isTest: cfg.paymentMode === 'simulated'`.
5. **The straggler sweep moves revenue between cohorts when locks run out of order.**
   - Where: `snapshot.ts:64`.
   - Cause: with `assigned_cutoff_at <= ?`, the first cohort finalized for cutoff C takes every unallocated contribution from earlier cutoffs. `runDueLocks` runs oldest first, so the cron is safe.
   - Scenario: the C-1 lock is stuck, and the operator runs `locks.run` for C (allowed within 3 days). C-1's revenue and ad budget move into C's cohort, and C-1 later records a zero cohort.
   - Fix: refuse to finalize C while an earlier cutoff in the catch-up window has no cohort.

---

## Still open from round 1 (not claimed fixed)
- M10: no ranking rollups. Public pages still run the 30-day aggregations on every request.
- L1: a late first lock uses current status and page version, not the state at the cutoff.
- L4: `SESSION_SECRET` is still reused as the PII encryption key.
- L7: any visitor can view `/checkout/:id`.
- S2: PayPal verification still sends re-serialized JSON.
- S3: D1 per-invocation query limits are unverified.
- S4: the batch size of `freezeBoard` at around 1k products is unverified.

## Test-quality notes
- `hardening.test.ts:91-93` encodes the wrong PayPal refund model (Medium #1).
- No test fetches `/api/boards` twice (High #1).
- No test covers concurrent `products.update` and `products.moderate approve` (Medium #2).

## Recommended actions
1. Fix the cache-hit response copy, and add a two-request test.
2. Track cumulative refunds per payment, or add an operator reversal for `partial_refund` reviews.
3. Add an operator list of pending edits with their contents, and version-pin `products.moderate`.
4. Truncate IPv6 to /64 in `visitorHash`.
5. Fix the Low items, especially the dismissed-review refund `retry` loop and the provider-mismatch path.

## Metrics
- Typecheck: pass. Tests: 69/69 pass. No coverage tool or linter is configured.

## Unresolved questions
1. Is bip.ad (a custom domain, where the cache is active) the planned production host? That decides whether High #1 is live or latent.
2. Product policy: after several partial refunds that together equal the capture, should the bid be voided automatically or by an operator decision?
