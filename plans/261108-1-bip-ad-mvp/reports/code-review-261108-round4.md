# Code Review Round 4: fix commit 0c8499a

## Scope
- Commit `0c8499a` ("fix: pin approvals to the reviewed version and roll over missed cutoffs"). Source changes are in `src/domain/{bidding,products,snapshot}.ts`, `src/mcp/operator-server.ts` and `src/payments/process.ts`, plus `test/hardening.test.ts` and three ADRs.
- I read the full diff and the code around it:
  - `finalizeCohort`, `runLock` and `runDueLocks`; `scheduledJob` in `src/index.ts`; `cutoffArg`.
  - `setBlocks`, `publishPage`, `updateProduct`, `submitProduct`, `moderateProduct` and `pendingModeration`.
  - `refund`, `settle`, `flagCaptureForReview`, `resolvePaymentReview` and `processEvent`/`apply`.
- Checks: `pnpm typecheck` passes. `pnpm test` passes: 7 files, 77 tests.
- Probes: six probe tests ran from a scratch vitest config outside the repo (`D:/Temp/claude/07f8b021a43bb7c2/1ec33839-214f-4c8f-87f1-7c7d782ce79f/scratchpad/probe4/r4.probe.ts`), against the real source and miniflare D1. The only repository file I wrote is this report.
  - **P1:** a submission is listed, then the owner calls `pages.publish` on an older draft. `approve` with the listed `product_version` passes, and the older page goes live.
  - **P2:** a page published *before* submission goes live on `approve`. `products.pending` showed the newer draft instead.
  - **P3:** capture A has the wrong amount and goes to review. Capture B is correct, but it goes to review because the intent is already `needs_review`. A provider refund of A dismisses review A automatically and marks the intent `failed`. Settling review B then throws `not_settleable`.
  - **P4:** a 1.00 partial refund of a 15.00 capture held in review dismisses the whole review. No open review is left.
  - **P5:** the operator settles a reviewed capture while the provider's refund of the same capture is processed. In 15 of 15 runs the result was: review `dismissed`, intent `confirmed`, contribution `active`, payment `captured`, and the refund event final (`reviewed_capture_reversed`).
  - **P6:** the cron is down past the window. Two bids are assigned to C and C+1, then `runDueLocks` runs at C+5, then the operator finalizes C+3 again. Each bid's revenue is counted exactly once (5000 in C+3, 7000 in C+4). No contribution is left unallocated, and the ledger is balanced.

## Overall assessment
- Medium 3, Low 1 and Low 2 are fixed for real. The cohort rollover cannot double-count, and it no longer leaves revenue stuck.
- Medium 1 is still incomplete. `setBlocks` now bumps the version, but the other path that changes a submission's live page (`publishPage`) does not. `products.pending` also shows a page that differs from the one approval publishes when a page was already published before submission.
- Medium 2 closes the sequential case only. A settle that runs at the same time as the provider refund still loses the refund. The new automatic dismissal also has two side effects (Low 1, Low 2).
- **No Critical or High issues remain.**

---

## Verification of claimed fixes

| Item | Verdict | Evidence |
|---|---|---|
| Medium 1: pin every approval to the reviewed version; page drafts bump it; `products.pending` shows the page approval would publish | **Partial** | `moderateProduct` now requires `expectedVersion` for every `approve` (`products.ts:211`). `setBlocks` bumps `products.version` in the same batch as the draft insert (`products.ts:281-285`). Not covered: the live branch of `publishPage` for an unpublished product (`products.ts:309-312` → `approvePageStatements`, `products.ts:193-198`) changes `current_page_version_id` without a version bump. `pendingModeration` shows `COALESCE(pending, latest)`, but `approve` publishes `COALESCE(current_page_version_id, latest)` (`publishLatestPageStatements`, `products.ts:188-189`). See Medium 1. |
| Medium 2: a reversal of a capture held in review dismisses the review | **Partial** | `process.ts:101-106` dismisses every `kind='capture'` review for the capture. This is correct when the refund arrives before or after the operator acts. It is not atomic with `resolve_review settle` (Medium 2 below). It also has side effects (Low 1, Low 2). |
| Medium 3: revenue of a cutoff older than the catch-up window rolls into the next cohort | **Fixed** | `snapshot.ts:68-71` adds `OR c.assigned_cutoff_at <= cutoff - CATCH_UP_DAYS`. P6 and the analysis below show it is complete and cannot double-count. |
| Low 1: dismissing keeps the wallet reservation of an intent that was not held | **Fixed** | `bidding.ts:479-482` fails the intent and releases the wallet only when the intent is `needs_review`. The new test covers the wrong-provider case. |
| Low 2: the partial-refund outbox event is written once | **Fixed** | See the outbox analysis below. |

### Rollover analysis (`finalizeCohort`, `runDueLocks`, `cutoffArg`)
- **The threshold is relative to the cohort's cutoff C, not to `now`.** A contribution assigned to C' is rolled into C only when C' <= C - 3d.
- **The cron cannot have locked C' yet.** `runDueLocks` runs L-2, L-1, L in that order, where L = `cutoffAtOrBefore(now)` and `now >= L`. Each run's threshold is older than every cutoff the cron can still lock.
- **The operator cannot lock C' either.** `cutoffArg` accepts `ms >= now - 3d`. Because `now >= C`, a C' of C - 3d is still lockable only when `now == C` to the millisecond.
- **Double-counting is impossible.** Even in that edge case, `revenue_cohort_contributions.bid_contribution_id UNIQUE` and the `NOT EXISTS` filter prevent it. The late cohort would only be a zero cohort.
- **Concurrent finalizations of two cutoffs are safe.** If both select the same orphan, one batch fails on the UNIQUE constraint. The loser finds no cohort of its own and retries (`snapshot.ts:116-120`).
- **Revenue no longer gets stuck.** Every cutoff that falls out of the window is at or below the threshold of every later cohort, and later cohorts are always created eventually. Even a cutoff that fails on every attempt only blocks the sequential `runDueLocks` loop until it ages out. The next run then sweeps it (behaviour already present before this commit).
- **Out-of-order runs inside the window still keep each day's revenue in its own cohort.** The round-2 test still passes.

### Outbox `INSERT ... SELECT WHERE EXISTS` (`bidding.ts:342-351`)
- The review insert and the outbox insert run in one D1 batch, which is a single transaction.
- If the review insert hits `ON CONFLICT DO NOTHING`, no row with the fresh `reviewId` exists, so the outbox insert writes nothing.
- A loop retry or a redelivery generates a new `reviewId` that never matches.
- The columns match `outboxStatement`, and `status` defaults to `pending`. This is correct.

### `setBlocks` bump and concurrency with `updateProduct`
- The draft insert and `version = version + 1` are atomic.
- When two `setBlocks` calls race, the loser fails on the page-version unique key and retries without a double bump.
- `updateProduct`'s `WHERE version = ?` turns a concurrent `setBlocks` into a `version_conflict` 409. That is the intended conservative outcome.
- `moderateProduct`'s guard turns it into a conflict too. No lost update.

---

## Critical
None.

## High
None.

## Medium

**1. Approving a submission can still publish a page the operator did not review (Medium 1 fix incomplete; confirmed by probes P1 and P2)**
- Where:
  - `products.ts:309-312`: `publishPage` on a non-published product takes the `live` branch whenever the regex screen passes. It calls `approvePageStatements` (`products.ts:193-198`), which sets `current_page_version_id` and does **not** bump `version`.
  - `products.ts:184-190`: `approve` runs `publishLatestPageStatements`, which keeps an existing `current_page_version_id` (`COALESCE(current_page_version_id, latest)`). It also marks the latest draft `approved` even when that draft is not the one that goes live.
  - `products.ts:262-264`: `pendingModeration` shows the pending page or, for a submission, the latest draft. It never shows `current_page_version_id`.
- Scenario A (P1), with AUTO_APPROVE_PRODUCTS=false, where the operator is the only real gate. The regex screen only catches a few keywords.
  1. The owner saves draft v1 (unacceptable content) and draft v2 (clean), then submits.
  2. The operator lists the product: version N, page v2.
  3. The owner calls `pages.publish` with `version: 1`. The product is `pending_review`, so v1 becomes current at once, and the version stays N.
  4. The operator approves with `product_version: N`. The guard passes, and v1 goes public.
- Scenario B (P2): no action is needed after the listing.
  1. The owner publishes v1 while the product is still a draft, then saves v2 and submits.
  2. `products.pending` shows v2. `approve` keeps v1 as current, so v1 is published, and v2 is marked `approved` but never shown.
- This contradicts ADR-0006 ("the page that approval would publish", "the operator approves exactly what they reviewed"). Round 3 asked for the `publishPage` live-branch bump explicitly.
- Fix:
  - Bump `version` in `approvePageStatements` (or in the `publishPage` live branch).
  - In `pendingModeration`, select `COALESCE(pending_page_version_id, current_page_version_id, latest)`, the same expression `approve` uses.
  - Alternatively, have `approve` on a submission publish exactly the page version shown, passed as or derived from the pinned version.

**2. A provider refund that runs at the same time as an operator settle of the same reviewed capture is lost (Medium 2 fix not atomic; confirmed by probe P5, 15 of 15 runs)**
- Where:
  - `process.ts:97-106`: `refund()` returns `unknown` because there is no `payments` row yet. Then the review is dismissed.
  - `bidding.ts:466-491`: `resolvePaymentReview('settle')` reads the review as `open`, calls `settle` (`:489`), and only then calls `close('settled')` (`:491`). That `close` is conditional (`AND status = 'open'`), but its result is never checked.
- Interleaving:
  1. The operator's settle reads the review as open.
  2. The refund webhook calls `refund()`, which finds no payment: `unknown`.
  3. `settle` commits the payment and the contribution.
  4. The webhook's dismiss reads the review as still open and closes it as `dismissed`.
  5. The operator's `close('settled')` changes nothing, and the tool still returns `settled`.
  6. The webhook event is stored as `reviewed_capture_reversed`, which is final, so redeliveries return `replayed`.
- Result:
  - The money is back with the payer, but the contribution stays `active` and ranks for its whole duration.
  - 80% of the bid is booked to `ads_pending` and later funded, and a referral commission may vest.
  - The review shows `dismissed` while a captured payment exists. Nothing flags the inconsistency, and `reconcile` balances.
- This is the outcome ADR-0004 now says can never happen ("money already returned can never be settled").
- Likelihood: low. It needs a chargeback or refund within the few D1 round trips of an operator settle. The impact is a full unbacked bid.
- Fix:
  - Make the review row the lock. In `resolvePaymentReview`, claim it first: `UPDATE payment_reviews SET status = 'settling' WHERE id = ? AND status = 'open'`, and require `meta.changes = 1`. Then settle, then mark it `settled`. Do the same for dismiss.
  - Or, after the dismiss loop in `apply`, call `refund()` again. If a payment now exists, reverse it instead of returning a final status.

## Low

**1. An automatic dismissal fails an intent that another open review still depends on (confirmed by probe P3)**
- Where: `process.ts:105` together with `bidding.ts:479-482`.
- Cause: `held` checks only that the intent is `needs_review`, not that *this* review put it there. Before this commit, dismissal was a deliberate operator action. Now a provider event triggers it.
- Scenario:
  1. A wrong-amount capture A sends the intent to `needs_review`.
  2. A correct capture B for the same intent is recorded as review `intent_needs_review`.
  3. The merchant refunds A, so the webhook dismisses review A and sets the intent to `failed`.
  4. Review B is still open, but `settle` now refuses it: `intent_failed` → `not_settleable`. A valid payment has to be refunded too, and the buyer loses the bid.
- Fix: fail the intent only when no other open `capture` review exists for it, or only when this review's reason moved the intent (anything except `intent_*` and `intent_provider_mismatch`).

**2. A partial refund of a capture held in review dismisses the whole review (confirmed by probe P4)**
- Where: `process.ts:101-106`. `ev.amountMinor` is ignored in the reviewed-capture branch.
- Scenario: a 15.00 capture is held in review, and a 1.00 partial refund arrives. The review becomes `dismissed` ("refund by provider"), so it leaves the open queue.
- Result: the remaining 14.00 is held by the platform with no open review, no ledger entry and no bid. The only trace is a dismissed review row.
- Impact is limited: PayPal refunds are merchant-initiated, so the operator usually knows about them.
- Fix: when `ev.amountMinor` is below the review's `amount_minor`, keep the review open and append the refund to it, for example as a `partial_refund` row on the same capture. Dismiss only on a full refund or a chargeback.

---

## Regression check of earlier hardening
- **Consent flow and the `/api/boards` cache:** `src/app.ts`, the auth routes and the views are not touched by this commit (`git diff --stat`).
- **Batch guards:** the `moderateProduct` version guard (`products.ts:219`) and `isGuardError` mapping are unchanged. The new `setBlocks` batch needs no guard because it is unconditional and atomic.
- **Payment reviews:** the `event_ref` keys (`capture:<id>`, provider event id for partials) are unchanged. `resolvePaymentReview` still returns early for a non-open review.
- **Simulated-money isolation:** the dismissal path writes no ledger entries. `cashAccount`, `payments.is_test` and payout exclusion are unchanged.

No regression found.

## Test-quality notes
- The new submission-pinning test covers only `setBlocks` after listing. It does not cover `pages.publish` after listing (P1), or a page published before submission (P2).
- The reviewed-capture test is sequential only. There is no test of settle and refund running together (P5).
- No test covers two capture reviews on one intent (P3) or a partial refund of a reviewed capture (P4).

## Recommended actions
1. Bump `version` on every change of `current_page_version_id`. Make `pendingModeration` show `COALESCE(pending, current, latest)`.
2. Claim the payment review atomically before settling or dismissing it.
3. Make the automatic dismissal fail the intent only when no other open capture review exists, and handle partial refunds of reviewed captures without dismissing.
4. Minor: the `products.moderate` tool description (`operator-server.ts:51`) still says the version is needed only for "pending changes". It is now needed for every approval.

## Metrics
- Typecheck: pass. Tests: 77/77 pass. No coverage tool or linter is configured.

## Unresolved questions
1. The `version_required` and `version_conflict` errors include the current version. An operator agent can retry with that number without listing again, which defeats the pin. Should the messages leave out the version so the agent has to call `products.pending` again?
