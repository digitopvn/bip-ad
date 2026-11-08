# Code Review Round 7: fix commit d9fd70a

## Scope
- Commit `d9fd70a` ("fix: close partial-refund reviews only after full reversal and reopen only own settlement claim").
- Source changes:
  - `src/payments/process.ts` (`apply()`, refund branch): the `partial_refund` close moved after the `again` and `settled` checks, so it runs only on the `reviewed_capture_reversed` branch.
  - `src/domain/bidding.ts` (`resolvePaymentReview`): both reopen `UPDATE`s now go through `reopenClaim()`, which is `WHERE id = ? AND status = 'settled' AND resolved_at = ?` (this request's `now`).
- Also changed: one new test in `test/hardening.test.ts`, and the round-6 report.
- Code read for context: `refund()` (`bidding.ts:332-425`), `flagCaptureForReview`, the `settle` entry with `fromReview`, `processEvent`, and the round-5 test helpers.
- Checks:
  - `pnpm typecheck` passes.
  - `pnpm test` passes: 7 files, 86 tests (85 before, plus the new one).
- Probes: seven probe tests ran from a scratch vitest config outside the repo, against the real source and miniflare D1. They are in `D:/Temp/claude/07f8b021a43bb7c2/1ec33839-214f-4c8f-87f1-7c7d782ce79f/scratchpad/probe7/r7.probe.ts`. They reuse the round-6 D1 wrapper to force exact interleavings. The only repository file I wrote is this report.

| Probe | Scenario | Result |
|---|---|---|
| R1 | Round-6 Q5 again: the settle request is still alive 11 min after its claim. A refund dismisses the "stale" claim, then the settle is refused. | Webhook `reviewed_capture_reversed`. The operator gets `intent_failed`. The review **stays `dismissed`** (round 6: reopened to `open`). |
| R2 | A slow request claimed at t0. A second request re-claims at tB, then the slow settle is refused. | The review stays `settled` with `resolved_at = tB`. The newer claim is not wiped. |
| R3 | Own claim, settle refused (`intent_failed`) | Reopened to `open`, with resolution and `resolved_at` set to NULL. |
| R3b | Own claim, `settle` throws (forced error on the intent read) | Reopened to `open`. The error propagates. |
| R4 | Partial refund of 5.00, fresh claim, completing refund of 10.00 (`retry`). The operator settle then commits, and the 10.00 event is redelivered. | The partial rows are still `open` after `retry`. The settle succeeds. On redelivery the result is `refunded`: the partial rows become `settled` / "payment fully reversed", the contribution is voided, the intent is `refunded`, and the ledger is balanced. |
| R5 | Same as R4 up to `retry`, but the claim dies (goes stale), then redelivery | `reviewed_capture_reversed`. The review is `dismissed`, and the partial rows are `dismissed` / "capture fully reversed". |
| R6 | Round-6 theoretical 2, worse variant: the intent is not held (`awaiting_payment`), the settle is slow, and a stale-claim dismiss lands mid-settle | Webhook `reviewed_capture_reversed` (final). The operator settle **succeeds**: the intent is `confirmed`, 1 active contribution, and the review row says `dismissed`. Not fixed by this commit (see below). |

## Overall assessment
- Both claimed fixes are correct and covered.
- This commit introduces no new defect. **No Critical, High, Medium or Low findings.**
- One residual: the cheap reopen fix narrows round-6 theoretical item 2, but it does not close it. The commit message only claims the reopen part, so this is a scope note, not a regression.

---

## Verification of claimed fixes

| Round-6 item | Verdict | Evidence |
|---|---|---|
| Low 1: partial-refund rows closed while the capture review was still claimed and the result was `retry` | **Fixed** | `process.ts:117-124`. The close now runs only after `again.status === 'unknown'` and no `settled` capture review exists. The new test and R4 show both rows stay `open` on `retry`. Every way out of `retry` still closes them. **(1) The settlement commits:** the redelivered event takes `refund()`'s partial branch. The insert is idempotent through `ON CONFLICT (provider, event_ref)`, the total reaches the capture, and the reversal batch closes the rows as `settled` / "payment fully reversed" (R4). This is now the correct audit trail. Before, the rows were already `dismissed`. **(2) The operator settles while the same delivery is running:** `again` reverses the payment, and the same batch closes the rows. **(3) The claim dies:** once the claim is stale, the redelivery dismisses the capture review and closes the rows as `dismissed` (R5). **(4) The settle is refused:** the claim reopens to `open`, and the redelivery follows the normal dismiss path. Only one new early exit skips the close, and it cannot leave rows open: `again` returning `duplicate` requires a `payment_reversals` row, and that row is written in the same batch that closes the partial rows. |
| Theoretical 2: unconditional reopen wipes a dismissal or a newer claim | **Fixed (reopen part)** | `bidding.ts:513`. The condition `status = 'settled' AND resolved_at = now` matches only this request's claim. **Not a dismissal:** its status is `dismissed` (R1). **Not a newer claim:** a takeover needs `resolved_at <= now - STALE_CLAIM_MS`, so the new claim's `resolved_at` can never equal the old request's `now` (R2). The bind order `(rv.id, now)` matches the placeholders. Both values use the same `iso()` format as the claim write, so exact string equality is safe. `settle` never writes this review row: `flagCaptureForReview` uses `INSERT ... ON CONFLICT DO NOTHING`, and `settle` returns before reaching it. So the reopen still matches in the refused and thrown paths (R3, R3b). |

---

## Critical
None.

## High
None.

## Medium
None.

## Low
None introduced by this commit.

## Theoretical edge cases

**Residual of round-6 theoretical item 2: a slow settle can still commit after its claim was taken over (R6)**
- This commit applied round 6's "cheap" option (a conditional reopen), not the "complete" one (a guard in `settle`'s batch).
- Two consequences of the takeover are now handled. A refused or failed slow settle no longer corrupts the review state.
- A slow settle that *succeeds* still commits:
  - The case: a non-held intent (for example a wrong-provider capture whose intent stays `awaiting_payment`) whose claim was dismissed by a provider refund after `STALE_CLAIM_MS`.
  - Result: the bid stays active, but the money went back. The review row says `dismissed`, and the refund event is final as `reviewed_capture_reversed`.
- It still needs one request to stay alive for more than 10 minutes between its claim and `settle`'s batch, so it remains theoretical.
- Complete fix: pass the claim timestamp into `settle` when `fromReview` is set. Then add `guardStatement(db, "EXISTS (SELECT 1 FROM payment_reviews WHERE id = ? AND status = 'settled' AND resolved_at = ?)", reviewId, claimNow)` to its settlement batch, and treat a guard failure as a refusal.

Theoretical items 1 and 3 from round 6 are tracked elsewhere and are not repeated here.

## Informational
- The new test asserts only the `retry` state, not the follow-up redelivery. R4 and R5 cover both follow-ups (the payment path and the stale path). A regression test for R4 would lock in the `settled` / "payment fully reversed" audit outcome.

## Recommended actions
1. None required for this commit.
2. Optionally, add the `settle`-batch claim guard to close the residual of theoretical item 2.
3. Optionally, add an R4-style test for redelivery after the settlement commits.

## Metrics
- Typecheck: pass.
- Tests: 86/86 pass.
- Probes: 7/7 ran.
- No coverage tool or linter is configured.

## Unresolved questions
1. The round-5 policy question is still open: should settling a held capture after a partial refund be allowed for the full quote? R4 shows that this settle succeeds today. The bid is active until the completing refund is redelivered.
