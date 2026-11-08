# Code Review Round 5: fix commit 7173aa8

## Scope
- Commit `7173aa8` ("fix: pin submission pages and serialize review settlement with reversals"). Source changes are in `src/domain/bidding.ts` (`resolvePaymentReview`), `src/domain/products.ts` (`publishLatestPageStatements`, `approvePageStatements`, `moderateProduct` messages, `pendingModeration`, `publishPage`) and `src/payments/process.ts` (`apply()` reversal branch). Also four new tests in `test/hardening.test.ts` and two ADR edits.
- I read the full diff and the code it depends on: `settle`, `flagCaptureForReview`, `refund`, `releaseWallet`, `processEvent`, the webhook routes (`app.ts:379,388`), the operator tools `payments.reviews`, `payments.resolve_review` and `products.moderate`, and the public product route (`app.ts:86-93`).
- Checks: `pnpm typecheck` passes. `pnpm test` passes: 7 files, 81 tests.
- Probes: five probe tests ran from a scratch vitest config outside the repo (`D:/Temp/claude/07f8b021a43bb7c2/1ec33839-214f-4c8f-87f1-7c7d782ce79f/scratchpad/probe5/r5.probe.ts`), against the real source and miniflare D1. P4 and P5 wrap the D1 binding to force exact interleavings between the webhook and the operator. The only repository file I wrote is this report.
  - **P1:** a review is left in the state right after the claim `UPDATE` (worker terminated before `settle`). Result: `resolve_review settle` and `dismiss` both return `settled`. No open review, no payment, intent `needs_review`. Three deliveries of the provider refund return `retry`, `retry`, `retry`.
  - **P2:** partial refunds of 5.00 and 10.00 arrive for a 15.00 capture held in review. Result: `partial_review`, then `reviewed_capture_reversed`. The capture review is `dismissed`, but **both `partial_refund` rows stay `open`**.
  - **P3:** settle and refund race on 60 fresh reviews with a staggered operator start. 25/25 and 60/60 runs end consistent: either the refund dismissed first (no payment, intent `failed`), or the settlement won and the redelivery reversed it (payment `refunded`). The ledger is balanced.
  - **P4/P5:** forced interleaving. The webhook's dismiss reads the review as open, the operator claims it, and then the dismiss batch commits. Result: the operator gets `not_settleable: intent_failed`, the review is reopened (`open`), the webhook returns `retry`, and the redelivery dismisses it. No money is lost. Side effects: a second `PaymentNeedsReview` outbox event, and a `deny` decision log for a dismissal that did not apply (see Low 2).

## Overall assessment
- All four round-4 findings are fixed for the reported scenarios, and so is the version-leak question. The settle/refund race no longer loses a refund (P3, P4, P5).
- The commit introduces one new crash-safety regression. A claimed review uses the terminal status `settled`, so a crash between the claim and `settle` leaves money with no bid, no open review and no tool to recover it (Medium 1, a theoretical edge case).
- The held-capture partial-refund path forgets to close its own `partial_refund` rows (Low 1, a genuine defect with low impact).
- **No Critical or High issues remain.**

---

## Verification of claimed fixes

| Item | Verdict | Evidence |
|---|---|---|
| Medium 1: page publishes bump the version; approval publishes the page `products.pending` shows | **Fixed** | `publishPage`'s live branch calls `approvePageStatements(..., true)`, which adds `version = version + 1` (`products.ts:193-197, 312`). `pendingModeration` now resolves `COALESCE(pending, CASE pending_review THEN COALESCE(current, latest))` (`products.ts:263-264`). `approve` runs `publishLatestPageStatements` (current, or latest when none) and then, if there is one, `approvePageStatements(pending)` (`products.ts:224, 229`). These are the same expression and order. `publishLatestPageStatements` now marks the page that becomes current as approved, not the latest draft (`products.ts:186-189`). Both round-4 scenarios (P1, P2) now fail with `version_conflict`, or show the page that is actually published. The new test covers both. |
| Medium 2: the operator claims the review first; a racing reversal reverses the payment or returns `retry` | **Fixed (race)**, with a regression in crash safety | The claim is `UPDATE ... SET status='settled' WHERE status='open'`, and `meta.changes` is checked (`bidding.ts:492-496`). The reopen runs on a throw or a refusal (`:500-506`). In `apply()`, the dismiss is a no-op on a claimed review, `refund()` runs again (`process.ts:117`), and a claimed review with no payment returns `retry` (`:119-120`). The webhook route answers 503 on `retry` (`app.ts:379, 388`), so the provider redelivers. P3, P4 and P5 confirm this. Regression: Medium 1 below. |
| Low 1: dismissing fails the intent only when no other open capture review needs it | **Fixed** | `others` query (`bidding.ts:479-480`). The test covers two capture reviews on one intent. |
| Low 2: partial refunds of a held capture keep the review open until they reach the captured amount | **Fixed**, but incomplete cleanup | `process.ts:105-114` records a `partial_refund` row keyed by the provider event id (idempotent on redelivery) and sums every `partial_refund` row for the capture. The rows are not closed when the sum completes (Low 1 below). |
| Question: version errors no longer reveal the current version | **Fixed** | `products.ts:212, 214, 253`. The version is still visible in the `products.moderate` response and in `products.pending`. That is the intended source. |

---

## Critical
None.

## High
None.

## Medium

**1. A crash between the review claim and `settle` strands the money: no bid, no open review, and no recovery path (theoretical edge case; needs the invocation to die between two sequential D1 calls; confirmed by probe P1)**
- Where:
  - `bidding.ts:492` claims with the **terminal** status `settled`, as its own statement.
  - `settle` runs as a separate call (`:499`). The reopen in the `catch` (`:501`) runs only if the isolate is still alive, and only if that `UPDATE` succeeds.
- Failure scenario:
  - The claim commits. Then the Worker invocation is terminated: CPU or wall-time limit, isolate eviction, a deploy, or request cancellation. Or `settle` throws on a transient D1 error, and the reopen `UPDATE` fails the same way.
  - The review now reads `settled`, and no `payments` row exists.
- What happens next:
  - `payments.reviews` lists only `open` by default (`operator-server.ts:115`). The review leaves the operator's queue.
  - `resolve_review` returns `{status: 'settled'}` early for both `settle` and `dismiss` (`bidding.ts:471`). The operator cannot finish the settlement or dismiss it.
  - The intent stays `needs_review` forever. The customer's money is held with no contribution.
  - If the merchant then refunds, `apply()` sees a `settled` capture review with no payment and returns `retry` on every delivery (`process.ts:119-120`). PayPal stops redelivering after its retry window. The webhook event ends `retry`, and nothing alerts anyone.
- Why this is a regression: before this commit, the same crash (`settle` committed, `close('settled')` not run) left the review `open` with a payment. Settling again returned `duplicate` and closed it, so that state could recover.
- Fix (either option):
  - **Atomic:** pass the review id into `settle`, and put `UPDATE payment_reviews SET status='settled' ... WHERE id=? AND status='open'` plus a `guardStatement` on it into settle's batch. A dismiss that won first then rolls the settlement back. A settlement that won first makes the dismiss's `close` change nothing, and `apply()` already reverses the payment afterwards.
  - **Resumable:** claim with a distinct `settling` status. Have `resolvePaymentReview` resume a `settling` review (`settle` is idempotent and returns `duplicate`, then mark it `settled`). Show `settling` in `payments.reviews` and `operator.health`. Let `apply()` treat `settling` like the current claimed case (`retry`).

## Low

**1. Partial refunds of a held capture that complete the refund leave their `partial_refund` reviews open (genuine defect; confirmed by probe P2)**
- Where: `process.ts:108-115`. The dismiss loop iterates only over `held` (`kind = 'capture'`). The `partial_refund` rows inserted at `:108` are never closed.
- The settled-payment path closes them in the reversal batch (`bidding.ts:414-415`, `'payment fully reversed'`). The held path has no equivalent.
- Scenario: a 15.00 capture is held. Refunds of 5.00 and 10.00 arrive. The capture review is `dismissed`, and two `partial_refund` reviews stay `open` in the operator queue for money that has been returned in full.
- Impact: queue noise only. Dismissing them is safe, because `others` finds no open capture review and the intent is no longer `needs_review`. But the operator has to work out by hand that nothing is left.
- Fix: when the sum reaches `captured`, close the capture's open `partial_refund` rows in the same step, for example `UPDATE payment_reviews SET status='dismissed', resolution='capture fully refunded' WHERE provider=? AND provider_payment_id=? AND kind='partial_refund' AND status='open'`.

**2. The dismiss batch applies its side effects even when the review close did not apply (genuine but benign race; confirmed by probes P4 and P5)**
- Where: `bidding.ts:473-483`. `close()` puts the conditional review `UPDATE` (`AND status='open'`) in a batch with an unconditional decision log and the intent `UPDATE ... SET status='failed'`. `releaseWallet` then runs on the `held` value read earlier. `meta.changes` of the review update is never checked.
- Scenario: the webhook's dismiss reads the review as open, the operator claims it, and then the dismiss batch commits. Results:
  - The intent becomes `failed`. The operator's settle is refused with `intent_failed`, and `flagCaptureForReview` emits a second `PaymentNeedsReview` outbox event.
  - `decision_logs` records a `deny` by `system:provider` for a review that was never dismissed.
  - With a different timing (P4 without the extra gate), the settlement reads the intent before the batch. It then overwrites `failed` with `confirmed`, because settle's intent `UPDATE` has no status guard (`bidding.ts:276`). The audit log then shows a provider `deny` followed by an operator `allow` on the same review. The later redelivery reverses the payment correctly.
- Impact: no money is lost in any interleaving I could force, and the final states are consistent after redelivery. The audit trail and the outbox are misleading, though, and the operator gets an error for a refund that was already handled.
- Fix: put a guard on the review transition in the batch (`guardStatement(... status = 'dismissed' AND resolution = ?)`), or check `r[0].meta.changes` and skip the intent update and wallet release when it is 0. The atomic fix for Medium 1 also removes most of this.

**3. Theoretical edge cases (operator misuse or a crash; no action required now)**
- **Double settle by the operator:** two concurrent `resolve_review settle` calls on the same review. The loser of the claim returns `{status: 'settled'}` (`bidding.ts:493-495`) while the winner may still be refused and reopen. The second call reports success that did not happen.
- **Missing audit entry:** the settle decision log is now written after `settle`, as its own statement (`bidding.ts:508`). A crash between them leaves a settled payment with no `payments.resolve_review` decision log. Before this commit, the log was in the `close` batch.
- **Settling after a partial refund:** a held capture that already received a partial refund can still be settled for the full quote, because `resolvePaymentReview` does not check `partial_refund` rows. This matches the ADR-0004 policy (a partial refund keeps the bid), and later refunds still sum correctly across both paths. I list it so that the policy is a deliberate choice.
- **Spurious `approved` status:** when a `pending_review` product has a deferred `pending_page_version_id` and no current page, `approve` marks the latest draft `approved` with a `published_at` (`publishLatestPageStatements`) before `approvePageStatements` makes the pending page current. This is cosmetic: public rendering uses `current_page_version_id`, and `?preview=` is owner-only (`app.ts:90`). The owner's `pages.preview` will show `moderation_status: approved` for a draft that never went live.

---

## Reversal path analysis (`apply()`, `process.ts:96-121`)
- **Only one capture review per capture:** `event_ref = capture:<id>` is UNIQUE per provider, so `held` has at most one row, and `held[0].amount_minor` is the captured amount.
- **Partial sums:** both paths key `partial_refund` rows by the provider event id (`process.ts:110` and `bidding.ts:346`). A redelivery, or an event that moves from the held path to the payment path after a settlement, is never counted twice. The sums include rows from both paths, so a refund series that starts before settlement and finishes after it still triggers the full reversal (`bidding.ts:352-354`).
- **The second `refund()` call (`:117`) has no `amountMinor`:** this is correct. It is reached only for a full event, or after the partial sum has already reached the capture. A payment that appeared meanwhile is then fully reversed.
- **The `retry` loop:** it ends when the claimed settlement commits (the next delivery reverses it) or is refused (the review reopens, and the next delivery dismisses it). It does not end in the stuck state of Medium 1.

## Products analysis
- The two statements in `publishLatestPageStatements` run in order inside one batch, so the second one sees the `current_page_version_id` the first one set.
- Every path that changes what approval would publish now bumps `version`:
  - `setBlocks` (`:284`)
  - `publishPage`, both branches (`:312-313`)
  - `updateProduct` (`:123-126`)
- `moderateProduct`'s guard (`:219`) turns a change made during approval into `version_conflict`.
- `publishPage` itself has no version guard, but it only increments. Any interleaving with an approval makes the approval fail. It can never pass an unreviewed page.

## Regression check of earlier hardening
- **Untouched:** `git diff --stat` shows only `bidding.ts`, `products.ts`, `process.ts`, tests and ADRs. Consent, the `/api/boards` cache, auth routes, views, the snapshot rollover and the wallet code are not touched.
- **Batch guards:** the `moderateProduct` version guard and the `isGuardError` mapping are unchanged. `refund()` still closes the settled-path partial reviews in its reversal batch.
- **Simulated-money isolation:** the new held-path `partial_refund` row copies `is_test` from the capture review. No ledger entries are written on the held path.
- **Webhook semantics:** `retry` is not final (`process.ts:56`) and maps to HTTP 503. Redelivery tests still pass.

No regression found other than Medium 1.

## Test-quality notes
- The race test (`hardening.test.ts`, "a provider reversal racing an operator settlement") always hits the same interleaving in miniflare (P3: 25/25 identical outcomes). It never exercises the dismiss-reads-open-then-claim ordering (P4/P5) or a crash after the claim (P1).
- The held partial-refund test checks only the capture review's status. It does not check the `partial_refund` rows (Low 1).
- The `products.moderate` tool description (`operator-server.ts:51`) still says the version is needed only for "approving pending changes". It is needed for every approval (round-4 recommendation 4, still open).

## Recommended actions
1. Make the review transition atomic with `settle`, or use a resumable `settling` status (Medium 1).
2. Close the held capture's `partial_refund` rows when the refunds reach the capture (Low 1).
3. Make the dismiss side effects conditional on the review close actually applying (Low 2).
4. Fix the `products.moderate` tool description.

## Metrics
- Typecheck: pass. Tests: 81/81 pass. No coverage tool or linter is configured.

## Unresolved questions
1. Is settling a held capture after a partial refund for the full quote the intended policy (see the theoretical edge cases under Low 3), or should `resolvePaymentReview` refuse while `partial_refund` rows exist for the capture?
