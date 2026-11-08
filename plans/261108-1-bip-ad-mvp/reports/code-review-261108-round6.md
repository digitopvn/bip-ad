# Code Review Round 6: fix commit 4521085

## Scope
- Commit `4521085` ("fix: let dead settlement claims be resolved again and close partial-refund reviews").
- Source changes:
  - `src/domain/bidding.ts`: `STALE_CLAIM_MS`, `RESOLVABLE_REVIEW`, and `resolvePaymentReview`.
  - `src/payments/process.ts`: `apply()` now closes `partial_refund` rows.
  - `src/mcp/operator-server.ts`: the default `payments.reviews` listing and the `products.moderate` description.
- Also changed: four new tests in `test/hardening.test.ts`, and ADR-0004.
- Code read for context: `settle`, `flagCaptureForReview`, `refund`, `releaseWallet`, `guardStatement` (`ledger.ts:101`), `processEvent` and `apply()`, and the `payments` and `payment_reviews` schemas.
- Checks:
  - `pnpm typecheck` passes.
  - `pnpm test` passes: 7 files, 85 tests.
- Probes: eight probe tests ran from a scratch vitest config outside the repo, against the real source and miniflare D1. They are in `D:/Temp/claude/07f8b021a43bb7c2/1ec33839-214f-4c8f-87f1-7c7d782ce79f/scratchpad/probe6/r6.probe.ts` and `r6b.probe.ts`. Q4 and Q5 wrap the D1 binding to force exact interleavings. The only repository file I wrote is this report.

| Probe | Scenario | Result |
|---|---|---|
| Q1 | Claim 9m59s old vs exactly 10m old; resume; list afterwards | The 9m59s claim is not resolvable. The 10m claim is listed (`<=` is inclusive), resumes to `settled` with one payment, and then drops off the listing. Ledger balanced. |
| Q2 | Two operators resume the same stale claim concurrently | Exactly one claim `UPDATE` wins. One payment. Both callers get `settled`. Ledger balanced. |
| Q3 | Two dismisses with the same `nowMs` and the same note, concurrently | Both return `dismissed`, and **2 `deny` decision logs** are written (theoretical edge case 1). |
| Q4 | The dismiss reads the review as open, then the operator claims it before the dismiss batch | The guard aborts the batch. Result `settled`, 0 `deny` logs, intent stays `needs_review`. Round-5 Low 2 is fixed. |
| Q5 | The settling request is still alive 11 min after its claim; a refund dismisses the "stale" claim, then the settle runs | Webhook `reviewed_capture_reversed`. The operator gets `intent_failed`, and its unconditional reopen turns the `dismissed` review back to `open` (theoretical edge case 2). |
| Q6 | A fresh claim plus a partial refund that completes the capture | Returns `retry`. The `partial_refund` rows are already `dismissed` ("capture fully reversed") while the capture review is still claimed (Low 1). |
| Q7 | Capture review A has a stale claim; sibling capture review B on the same intent is dismissed | The intent becomes `failed`, because `others` counts only `open`. Resuming A is then refused (`intent_failed`), and A reopens (theoretical edge case 3). |
| Q8 | The exact `payments.reviews` default SQL | Runs with one bind. The plan uses `payment_reviews_open` (MULTI-INDEX OR) and the `payments (provider, provider_payment_id)` unique index for the `NOT EXISTS`. |

## Overall assessment
- All three round-5 findings and the stale tool description are fixed.
- The binding counts are correct:
  - `RESOLVABLE_REVIEW` has exactly one placeholder.
  - The resolvable `SELECT` takes 2 binds, and the dismiss `UPDATE` and the claim `UPDATE` take 4 each.
  - Every call site supplies them in the right order. Tests and Q8 run each statement.
- A fresh claim cannot be dismissed: the existing test covers this, and so do Q1 and Q4.
- The stale definition (a `settled` capture review with no `payments` row for the same provider and capture) is sound for existing data. Every pre-round-5 `settled` capture review was closed after `settle` returned `settled` or `duplicate`, and both imply a payment row with that exact key (`settle`, `bidding.ts:246-248`). `partial_refund` rows are excluded by `kind = 'capture'`.
- **No Critical, High or Medium issues.** One genuine Low (cosmetic). The other findings are theoretical: each needs a same-millisecond collision, a request that stays alive for more than 10 minutes, or two capture reviews on one intent combined with a dead claim.

---

## Verification of claimed fixes

| Round-5 item | Verdict | Evidence |
|---|---|---|
| Medium 1: a crash between the claim and `settle` strands the review | **Fixed (resumable)** | `RESOLVABLE_REVIEW` (`bidding.ts:462-463`) makes a claim older than 10 minutes with no payment resolvable again. The pre-check (`:479`), the dismiss `UPDATE` (`:486`) and the claim `UPDATE` (`:508`) all use it, and the claim stays atomic per statement (Q2). In `apply()`, the refund's dismiss now closes a stale claim, so the result is `reviewed_capture_reversed` instead of an endless `retry` (test, Q5). Inside the 10-minute window the refund still returns `retry`. PayPal's multi-day retry schedule covers that, and SePay has no refund action. The listing shows stale claims (Q1, Q8). |
| Low 1: held `partial_refund` rows never closed | **Fixed** | `process.ts:116-117`. The new test asserts 0 open rows. See Low 1 below for the ordering nit. |
| Low 2: dismiss side effects applied when the close did not | **Fixed** | Guarded batch: `bidding.ts:484-496`. If the guard fails, there is no decision log, no intent update and no `releaseWallet` (Q4). The guard identifies "my close" by `(status, resolved_at, resolution)`, not by row changes. That is the source of theoretical edge case 1. |
| `products.moderate` description | **Fixed** | `operator-server.ts:51`. |
| ADR | **Updated** | ADR-0004 line 29 describes the 10-minute stale rule. |

---

## Critical
None.

## High
None.

## Medium
None.

## Low

**1. Partial-refund rows are closed even when the capture review was not (genuine, cosmetic; confirmed by Q6)**
- Where: `process.ts:116-117`. The `UPDATE` runs right after the `held` dismiss loop, without checking that the dismiss applied.
- Scenario: the capture review is freshly claimed. A partial refund completes the captured amount, and the dismiss returns `settled` early. The partial rows become `dismissed` / `capture fully reversed`, but `apply()` returns `retry` because the capture may still settle.
- Effect:
  - If the settlement commits, the payment's own reversal on redelivery is still correct. `refund()` sums `partial_refund` rows regardless of their status (`bidding.ts:352-354`), and its close `UPDATE` finds nothing left to close.
  - The audit trail is wrong, though. The rows say "capture fully reversed" while the bid was briefly active, and their status is `dismissed` instead of the `settled` / "payment fully reversed" that the payment path writes.
- Fix: run the close only when no capture review for this capture is still claimed, for example by adding `AND NOT EXISTS (SELECT 1 FROM payment_reviews c WHERE c.provider = ? AND c.provider_payment_id = ? AND c.kind = 'capture' AND c.status = 'settled')`. Or move it after the `again`/`settled` checks, on the `reviewed_capture_reversed` branch only.

## Theoretical edge cases (not genuine defects today)

**1. The dismiss guard passes for a concurrent identical dismiss (Q3)**
- The guard (`bidding.ts:488`) accepts any row that is `dismissed` with the same `resolved_at` and `resolution`.
- Two concurrent dismisses with the same millisecond and the same note both pass. Example: two concurrent deliveries of one refund event. `processEvent` lets a redelivery of a `received` event run again, and the Workers clock is shared within an isolate.
- Result: duplicate `deny` decision logs. The intent `UPDATE` is idempotent (`AND status = 'needs_review'`), and `releaseWallet` is idempotent through the `reservation_closures` PK. No money impact.
- Tighter guard: `guardStatement(db, 'changes() = 1')` placed right after the `UPDATE`. In SQLite, `changes()` reports the previous statement on the same connection, and a D1 batch runs on one connection. Verify this on D1 before relying on it.

**2. A request still alive after `STALE_CLAIM_MS` reopens a review that was dismissed meanwhile (Q5)**
- The reopen `UPDATE`s (`bidding.ts:517, 521`) are unconditional (`WHERE id = ?`). They do not check that the row still holds this request's claim.
- In Q5 the end state is safe: an `open` review whose intent is `failed`, and dismissing it is side-effect free. But there is a worse variant. If the review's intent was never moved to `needs_review` (a wrong-provider capture: `held = false`, intent still `awaiting_payment`), the slow `settle` can **succeed** after a provider refund has already dismissed the review and finished as `reviewed_capture_reversed`. That event is final and is not redelivered, so the bid stays active for money that was returned.
- This needs a single request to stay alive for more than 10 minutes between its claim and `settle`'s batch. It is not realistic for a few D1 round trips, so I list it as theoretical.
- Fixes:
  - Cheap: make the reopen conditional, `WHERE id = ? AND status = 'settled' AND resolved_at = ?` (this request's `now`).
  - Complete: the round-5 "atomic" option. Add `guardStatement(EXISTS review id AND status='settled' AND resolved_at = claimNow)` to `settle`'s batch, so a settlement whose claim was taken over cannot commit.

**3. `others` ignores claimed or stale sibling capture reviews (Q7)**
- `bidding.ts:481` counts only `status = 'open'`. Suppose capture review A on an intent is claimed (fresh or stale), and sibling B is dismissed. B's dismiss treats the intent as unneeded and fails it. A's settlement or resume is then refused with `intent_failed`, and A's money has to be refunded by hand.
- The fresh-claim variant predates this commit, since the claim status `settled` came in round 5. The stale variant is new.
- It needs two capture reviews on one intent, which is rare, plus the timing.
- Fix: use `(${RESOLVABLE_REVIEW} OR (status = 'settled' AND kind = 'capture' AND NOT EXISTS payment))` in `others`. In other words, count any capture review that has no payment yet and is not dismissed.

**4. Still open from round 5 (unchanged, informational)**
- A fresh claim answers a second `settle` or `dismiss` with `settled` (Q1 `fresh`), even if that claim later fails.
- The settle decision log is still written outside the batch.

## Informational
- The default `payments.reviews` listing shows stale claims as `status: 'settled'`, with nothing that tells them apart from real settlements in the `?status=settled` view. A computed column, for example `CASE WHEN status = 'settled' THEN 'stale_claim' END AS needs`, would help the operator.
- `operator.health` does not count payment reviews at all. This predates the commit. A stale-claim count there would surface dead claims without waiting for a listing.
- No test exercises the `payments.reviews` tool itself. Q8 covers its SQL.

## Recommended actions
1. Gate the partial-refund close on the capture review actually being closed (Low 1).
2. Optionally, make the reopen `UPDATE`s conditional on this request's claim (theoretical edge case 2). It is a one-line change.
3. Optionally, tighten the dismiss guard to `changes() = 1`, and count claimed siblings in `others` (theoretical edge cases 1 and 3).

## Metrics
- Typecheck: pass.
- Tests: 85/85 pass.
- Probes: 8/8 ran.
- No coverage tool or linter is configured.

## Unresolved questions
1. The round-5 policy question is still open: should settling a held capture after a partial refund be allowed for the full quote?
