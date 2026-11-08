# ADR-0005: Referral policy ref-v1, commission wallet and manual payouts

Status: MVP defaults. The owner must approve them before go-live.

## Attribution
- `/r/{code}` sets a signed cookie that lasts 30 days (`REFERRAL_ATTRIBUTION_DAYS`).
- The cookie is applied only when a new account is created.
- An account has one referrer, and it is never replaced.
- Self-referrals and accounts with the referrer's email address are rejected.

## Successful referral
- A referral succeeds when the referred account's first bid paid with external cash is confirmed.
- It counts in ranking only after it vests, `REFERRAL_HOLD_DAYS` (30) later.
- It counts once per referred account, however many bids that account places.

## Commission
- The commission is 5% of the external-cash part of that first bid only. There is no lifetime commission.
- It stays `pending` until the hold period ends, then becomes `available`.
- A refund or chargeback claws it back: first from pending, then from available, and any remainder is recorded as a receivable.

## Wallet
- The available balance can pay for all or part of a bid.
- Funds are reserved first and consumed only when the bid settles.
- A reservation is either consumed or released, never both. The primary key of `reservation_closures` enforces this.
- Users cannot transfer wallet funds to each other.

## Payouts
1. `payouts.request` reserves available funds. The minimum is `MIN_PAYOUT_USD_CENTS` or `MIN_PAYOUT_VND`. Beneficiary details are encrypted with AES-GCM.
2. The operator prepares a monthly batch.
3. The operator makes each bank transfer by hand, then records it with the reference, the exact amount and proof. Transfers can be recorded only on days 01–10 (ICT).

Nothing transfers money automatically.
