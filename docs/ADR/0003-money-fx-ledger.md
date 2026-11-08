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
- **Commission:** floor(5% × external cash). It applies only when the bid is the buyer's first external-cash bid and that bid qualifies a referral.
- **Platform:** the remainder. That is 20% without a referral and about 15% with one.

The part of a bid paid from the commission wallet earns no commission, which prevents self-reward loops.

## Ledger
- `ledger_transactions` has a UNIQUE `(kind, reference_id)`.
- `ledger_entries` are signed amounts. Within each transaction they sum to zero per currency.

Accounts:

| Account | Purpose |
|---|---|
| `asset:cash:{provider}` | Cash received from a payment provider |
| `liability:ads_pending:{board}` | Ads share awaiting its cohort |
| `liability:ads_fund:{board}` | Ads share in a finalized cohort |
| `liability:wallet:{user}:{pending\|available\|reserved_bid\|reserved_payout}` | Commission owed to a user, by state |
| `revenue:platform` | Platform share |
| `asset:cash:bank_payouts` | Cash paid out by manual bank transfer |
| `asset:clawback_receivable:{user}` | Clawed-back commission a user still owes |

## Wallet projection
- `wallet_balances` is a projection updated in the same batch as the ledger.
- CHECK (>= 0) constraints on its columns block overdrafts.
- `finance.reconcile` compares the projection with the ledger.

## Cohorts and refunds
- Cohort finalization moves each cutoff's ads share from `ads_pending` to `ads_fund` exactly once, enforced by a UNIQUE `bid_contribution_id`.
- A refund after the cohort was funded posts a corrective debit to `ads_fund`.

## Eligible revenue and currencies
- `eligible_revenue` is the confirmed bid value minus refunds made before finalization.
- Processing fees come out of the platform share.
- USD and VND cohorts are kept separate. Ads funds are not converted between currencies yet.
