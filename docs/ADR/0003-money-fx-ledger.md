# ADR-0003: Money, FX and the double-entry ledger

Status: accepted for the MVP

## Money and FX
- Money is stored as integer minor units: USD cents and VND dong.
- `rank_units` are USD cents, locked when the quote is made.
- A VND quote costs `ceil(rank_units × FX_USD_VND / 100)`. The intent stores the rate (`FX_USD_VND`, source `config`) and the rounding rule.
- Quotes expire after `QUOTE_TTL_SECONDS`, which defaults to 900.

## Revenue split
Each contribution is split when it settles:

- **Ads:** floor(80% × gross).
- **Commission:** floor(5% × external cash). It applies only when the bid is the buyer's first external-cash bid and that bid qualifies a referral (owner decision, 2026-11-10; see ADR-0005).
- **Platform:** the remainder. That is 20% without a referral and about 15% with one.

The part of a bid paid from the commission wallet earns no commission, which prevents self-reward loops.

## Ledger
- `ledger_transactions` has a UNIQUE `(kind, reference_id)`.
- `ledger_entries` are signed amounts. Within each transaction they sum to zero per currency.

Accounts:

| Account | Purpose |
|---|---|
| `asset:cash:{provider}` | Cash received from a payment provider |
| `asset:cash:simulated:{provider}` | Simulated receipts (`PAYMENT_MODE=simulated`); never real money |
| `liability:ads_pending:{board}` | Ads share awaiting its cohort |
| `liability:ads_fund:{board}` | Ads share in a finalized cohort |
| `liability:wallet:{user}:{pending\|available\|reserved_bid\|reserved_payout}` | Commission owed to a user, by state |
| `revenue:platform` | Platform share |
| `asset:cash:bank_payouts` | Cash paid out by manual bank transfer |
| `asset:clawback_receivable:{user}` | Clawed-back commission a user still owes |

## Atomicity without transactions
- D1 has no interactive transactions, so every multi-row change is one `db.batch()`.
- A batch that depends on a state transition (`UPDATE ... WHERE state = ?`) also inserts a guard row into `batch_guards`. The insert violates NOT NULL exactly when the expected state is missing, which aborts the batch. A lost race fails loudly and is retried with fresh reads, instead of posting money for a transition that did not happen.
- `payment_reversals` (primary key `payment_id`) allows one refund or chargeback per payment, whatever the event kind.

## Wallet projection
- `wallet_balances` is a projection updated in the same batch as the ledger.
- CHECK (>= 0) constraints on its columns block overdrafts.
- `finance.reconcile` compares the projection with the ledger.

## Cohorts and refunds
- Cohort finalization moves each cutoff's ads share from `ads_pending` to `ads_fund` exactly once, enforced by a UNIQUE `bid_contribution_id`.
- A refund after the cohort was funded posts a corrective debit to `ads_fund` and lowers the flight's hard cap (never below what is already committed).
- Finalization takes every active, unallocated contribution assigned to this cutoff, plus stragglers assigned to an earlier cutoff whose cohort already exists. A settlement that committed just after its own cohort was finalized is funded by the next cohort instead of being lost, and running cutoffs out of order never moves a day's revenue into a later cohort. A cutoff that can no longer be locked (older than the 3-day catch-up window) rolls its revenue into the next cohort, so no ads share stays in `ads_pending` for good.
- Refund and finalization guard each other: the refund checks that the cohort membership it read still holds, and finalization checks that each included contribution is still active. The loser retries.

## Eligible revenue and currencies
- `eligible_revenue` is the confirmed bid value minus refunds made before finalization.
- Processing fees come out of the platform share.
- USD and VND cohorts are kept separate. Ads funds are not converted between currencies yet.
