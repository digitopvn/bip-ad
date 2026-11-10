# ADR-0005: Referral policy ref-v1, commission wallet and manual payouts

Status: accepted. All referral, wallet and payout defaults below are owner-approved (2026-11-10), including the first-external-cash-bid commission rule.

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
- The commission is 5% of the external-cash part of that first bid only (owner decision, 2026-11-10). There is no lifetime commission: later bids by the same account earn none, and a bid paid entirely from the wallet earns none and does not use up the referral. Enforced by `referralQualification` in [`referrals.ts`](../../src/domain/referrals.ts).
- It stays `pending` until the hold period ends, then becomes `available`.
- A refund or chargeback claws it back: first from pending, then from available, and any remainder is recorded as a receivable.
- Vesting and clawback guard each other, so a commission clawed back while it vests never becomes spendable.

## Wallet
- The available balance can pay for all or part of a bid.
- Funds are reserved first and consumed only when the bid settles.
- A reservation is either consumed or released, never both. The primary key of `reservation_closures` enforces this.
- Users cannot transfer wallet funds to each other.

## Payouts
1. `payouts.request` reserves available funds. It is refused while `PAYMENT_MODE=simulated`, and commissions created by simulated payments (`is_test`) are excluded from the payable balance in every mode. The minimum is `MIN_PAYOUT_USD_CENTS` or `MIN_PAYOUT_VND`. Beneficiary details are encrypted with AES-GCM (see [PII encryption](#pii-encryption)).
2. The operator prepares a monthly batch.
3. The operator makes each bank transfer by hand, then records it with the reference, the exact amount and proof. Transfers can be recorded only on days 01–10 (ICT).

Nothing transfers money automatically.

## PII encryption
Beneficiary details are sealed with the dedicated worker secret `PII_ENCRYPTION_KEY` (at least 32 characters), not with `SESSION_SECRET`, so rotating the session secret never touches stored payout details. The code is `encryptField` / `decryptField` in [`crypto.ts`](../../src/lib/crypto.ts).

- New values use `v2.<kid>.<iv>.<ciphertext>`. The kid is a short SHA-256 fingerprint of the key, and `v2.<kid>` is bound as AES-GCM additional data.
- Values written before this key existed are `v1.<iv>.<ciphertext>` and are still opened with `SESSION_SECRET`. They are not re-encrypted, so `SESSION_SECRET` must not be rotated while `v1.` rows remain in `payout_requests`.
- While `PII_ENCRYPTION_KEY` is unset or too short, `payouts.request` fails with `payouts_unavailable` (503). Nothing falls back to `SESSION_SECRET` for new writes.
- Rotation: move the old value to `PII_ENCRYPTION_KEY_PREVIOUS`, set a new `PII_ENCRYPTION_KEY`, and deploy. New values use the new key; values are opened by the key whose kid they carry. Drop the previous key once no row uses its kid.
