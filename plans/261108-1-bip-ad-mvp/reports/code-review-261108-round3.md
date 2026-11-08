# Code Review Round 3: fix commit 7a63d6f

## Scope
- Commit `7a63d6f` ("fix: close review gaps in refunds, moderation and caching"). Source changes are in `src/app.ts`, `src/domain/{bidding,measurement,products,snapshot}.ts`, `src/mcp/operator-server.ts`, `src/payments/process.ts`, two test files, and three ADRs. I read the full diff and the surrounding code: `refund`, `settle`, `flagCaptureForReview`, `releaseWallet`, `resolvePaymentReview`, `processEvent`/`apply`, the products module, `finalizeCohort`/`runLock`/`runDueLocks`, `cutoffArg`, and the board cache route.
- Checks: `pnpm typecheck` passes. `pnpm test` passes: 7 files, 73 tests.
- Probes: four probe tests ran from a scratch vitest config outside the repo, against the real source and miniflare D1. No repository file was changed except this report.
  - P1a: an owner edits a `pending_review` submission after the operator listed it. `approve` with no version publishes the edited `website_url`.
  - P1b: an owner swaps the page of a `pending_review` submission after review. `approve` with the reviewed `product_version` still passes, and the swapped page goes live.
  - P2: a void arrives for a capture held as a review. It becomes `ignored:reviewed_capture`. The operator then settles the review, and the contribution stays `active` with the payment `captured`. Redelivering the void returns `replayed`.
  - P3: two concurrent partial refunds (7.00 + 8.00 on 15.00) return `refunded` + `duplicate`. The contribution is voided and the ledger is balanced.

## Overall assessment
- The fixes for High #1, M#1 and M#3 are real and complete. The concurrent partial-refund path is sound (P3).
- Three fixes introduce or leave a defect:
  - M#2: version binding does not cover first submissions (Medium #1).
  - L1: the new "ignore" status for reviewed captures loses refunds when the review is later settled (Medium #2).
  - L5: the new finalize query can leave revenue permanently unfunded (Medium #3).
- **No Critical or High issues remain.**

---

## Verification of claimed fixes

| Item | Verdict | Evidence |
|---|---|---|
| High #1: cache hit returns 500 | **Fixed** | `app.ts:333` returns `new Response(hit.body, hit)`, so its headers are mutable. The stored copy was cloned before `secureHeaders` ran, so on a hit the middleware adds its headers to the new response. The test fetches twice and checks `nosniff`. |
| M#1: cumulative partial refunds | **Fixed** | `bidding.ts:339-351` records each refund by its event id, then sums all `partial_refund` rows for the capture. Each request sums only after its own insert has committed, so two concurrent partials cannot both stop below the total. Only one reversal wins (PK on `payment_reversals`), and P3 confirms it. Open partial reviews are closed in the reversal batch. A replay is caught by `webhook_events`. If the event is re-processed after a failure, the insert is a no-op and the sum still triggers the reversal. |
| M#2: version binding and `products.pending` | **Partial** | This works for held edits on *published* products: `updateProduct` and the deferred `publishPage` bump `version`, and `moderateProduct` requires and guards it. Submissions (`pending_review`) are not covered. See Medium #1. |
| M#3: IPv6 /64 visitor key | **Fixed** | `networkKey` expands `::`, lowercases, strips leading zeros and keeps 4 hextets. The test proves that compressed and full forms give the same key. The only input is `cf-connecting-ip` (`app.ts:366`), which is never IPv4-mapped. |
| L1: reversal of reviewed-only captures | **Fixed, with a new defect** | `process.ts:96-102` now returns a final status instead of retrying forever. But the refund is dropped without any record, even when the review is still open and settleable. See Medium #2. |
| L2: provider-mismatch review | **Fixed, with a new defect** | `process.ts:89-92` routes the capture to `flagCaptureForReview(..., null, ...)`, and the intent is left untouched. Dismissing that review releases the live intent's wallet reservation. See Low #1. |
| L3: reject keeps suspended | **Fixed** | `products.ts:217` keeps `p.status` when it is `suspended`. `submitProduct` and `updateProduct` already refuse suspended products. |
| L4: wallet-only simulated bids flagged | **Fixed** | `app.ts:170` passes `isTest: cfg.paymentMode === 'simulated'`, and `payments.is_test` is set. |
| L5: out-of-order finalize | **Fixed, with a new defect** | `snapshot.ts:64-66` takes stragglers only from cutoffs that already have a cohort. Running C and then C-1 keeps each day's revenue in its own cohort, as the test shows. But a cutoff that never gets a cohort now strands its revenue. See Medium #3. |

Earlier fixes, re-checked:
- **Consent flow**: no change in this commit. The only `app.ts` hunks are the wallet settle call and the cache line.
- **Batch guards**: same pattern. The new moderation guard uses `EXISTS(...)`, and `isGuardError` matches only `batch_guards`.
- **Payment reviews**: the event-ref keys are unchanged.
- **Simulated-money isolation**: `cashAccount` and payout exclusion are unchanged.

No regression found.

---

## Critical
None.

## High
None.

## Medium

**1. Approving a submission is not pinned to what the operator reviewed (M#2 incomplete; confirmed by probes P1a and P1b)**
- Where:
  - `products.ts:210-213`: `version_required` applies only when `pending_edit_json` or `pending_page_version_id` is set.
  - `products.ts:303-306`: for an unpublished product, `publishPage` makes the page current without bumping `version`.
  - `products.ts:224`: `approve` publishes the latest page version.
  - `products.ts:260-266`: `pendingModeration` returns page content only for a pending page version.
- Scenario (AUTO_APPROVE_PRODUCTS=false, where the operator is the only gate):
  - (a) The operator lists a submission (`pending_review`, version 1, `https://good.example.com`). The owner calls `products.update` with a new `website_url`, which applies directly because the product is unpublished. The operator calls `approve` without a version, which is allowed. The edited URL goes live, and `/go/:slug` redirects to it (P1a).
  - (b) The operator approves *with* the reviewed version 1. Between review and approval, the owner ran `pages.set_blocks` and `pages.publish`. The version stays 1, the guard passes, and the swapped page goes live (P1b).
  - (c) `products.pending` returns `pending_blocks_json = null` for every submission. The operator cannot see the page content they are approving.
- This contradicts the new ADR-0006 text: "the operator approves exactly what they reviewed".
- Fix:
  - Require `product_version` for every `approve`.
  - Bump `version` whenever `current_page_version_id` changes or a page version is created (`setBlocks`, the live branch of `publishPage`).
  - Return the page that `approve` would publish in `products.pending`: `COALESCE(pending_page_version_id, current_page_version_id, latest)`.

**2. A refund of a capture that is held for review is dropped for good, and the operator can still settle it (confirmed by probe P2)**
- Where: `process.ts:98-102` and `resolvePaymentReview` (`bidding.ts:479-486`).
- Cause:
  - When no `payments` row exists but any `kind='capture'` review row exists, the event is marked `ignored:reviewed_capture`. That status is final (`FINAL()`), so redeliveries return `replayed`.
  - Nothing is written to the review.
  - `resolvePaymentReview('settle')` does not check for a reversal.
- Scenario:
  1. A capture is sent to review (provider mismatch, or an intent that was still `quoted`).
  2. Before the operator acts, the payer gets a refund, or the bank voids the transaction or opens a chargeback. The event is ignored.
  3. The operator settles the review, which looks normal. A contribution is created and ranks for its whole duration, 80% goes to the ads accounts, and a referral commission may vest. All of this is funded by cash that was returned.
- Before this commit, the refund kept `retry`ing, so the next redelivery after the settlement would have reversed it.
- Fix: when the review is `open`, record the reversal on it. For example, set `status = 'dismissed'` with resolution `reversed at provider`, or insert a `capture_reversed` review row that `resolvePaymentReview` checks. If the review was already settled into a payment, the `payments` lookup handles it. Keep `ignored` only for reviews that are `dismissed`.

**3. Revenue for a cutoff that never gets a cohort is never funded (regression from the L5 fix)**
- Where: `snapshot.ts:64-66` together with `runDueLocks` (`lookbackDays = 2`) and `cutoffArg`, which refuses cutoffs more than 3 days old (`CATCH_UP_DAYS`).
- Cause: a contribution assigned to cutoff C' < C is now taken only if a cohort for C' already exists. Before, the next cohort swept it in (`<=`).
- Scenario:
  - The cron is down, or `runLock` for one cutoff keeps throwing (for example in `freezeBoard`), for longer than the catch-up window.
  - That cutoff never gets a cohort, and the operator cannot backfill it (`invalid_cutoff`).
  - Its contributions stay `active` and unallocated for good. Their 80% ads share sits in `liability:ads_pending:*` with no cohort, no flight and no eligible-revenue record.
  - Every later cohort skips them, because the condition `EXISTS revenue_cohorts(cutoff_at = assigned)` is never true.
- The ledger stays balanced, so `reconcile` does not flag it.
- Fix: keep the out-of-order protection, and still sweep orphans. For example, also take `c.assigned_cutoff_at < ?` when `assigned_cutoff_at` is older than the catch-up window. Or refuse to finalize C while an earlier cutoff *inside* the window has no cohort, which was the round-2 suggestion.

## Low

**1. Dismissing a provider-mismatch review releases the wallet reservation of an intent that is still payable.**
- Where: `bidding.ts:474-477`.
- Cause: `dismiss` always calls `releaseWallet(rv.bid_intent_id)`. For `intent_provider_mismatch`, the intent was deliberately left `awaiting_payment`, so its reservation is still open.
- Scenario: an intent with a wallet portion gets a wrong-provider capture. The operator dismisses it, as the error text tells them to ("dismiss it and refund at the provider"), and the reservation is released.
- Result: when the buyer then pays through the right provider, `settle` finds no reservation and flags `wallet_reservation_missing`. `resolvePaymentReview` refuses to settle it because `wallet_applied_minor ≠ 0`, so a correct payment must be refunded.
- Fix: release the wallet on dismiss only when the intent is `needs_review`, the same condition already used for setting it to `failed`.

**2. `PartialRefundNeedsReview` outbox rows are duplicated on retries.**
- Where: `bidding.ts:342-347`.
- Cause: the outbox statement is not tied to the `ON CONFLICT DO NOTHING` insert. It is added again on every loop attempt after a reversal conflict, and on every redelivery of a `failed` or `retry` event.
- Impact: only consumers that are not idempotent are affected.

---

## Test-quality notes
- No test covers editing a submission between listing and approval (Medium #1).
- No test covers a refund of a reviewed capture followed by `resolve_review settle` (Medium #2). The L1 path has no test at all.
- The L5 test covers only out-of-order runs, not a cutoff that never gets a cohort (Medium #3).

## Recommended actions
1. Require and bump `version` for every approval path, including page changes on unpublished products. Show the page to be published in `products.pending`.
2. Record reversals of reviewed captures on the review, and block `settle` for a reversed capture.
3. Sweep contributions whose cutoff is outside the catch-up window and has no cohort.
4. Guard `releaseWallet` on dismiss by the intent status.

## Metrics
- Typecheck: pass. Tests: 73/73 pass. No coverage tool or linter is configured.

## Unresolved questions
1. For Medium #3: if a cutoff is missed beyond the window, should its revenue go to the next cohort, or should it be held for a manual operator backfill? Either is fine, but one of them must exist.
