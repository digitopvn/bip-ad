# ADR-0004: PayPal + SePay adapters, simulated by default

Status: accepted for the MVP

## Providers
- The only providers are PayPal (Orders v2, USD) and the SePay Payment Gateway (VietQR, VND). No other provider is added, including as a fallback.

## Payment modes
`PAYMENT_MODE` takes one of three values:

- **`simulated`** (the default when unset): the Worker makes no provider calls. The `/checkout/{id}` page shows test buttons to the owner only. Simulated receipts are booked to `asset:cash:simulated:{provider}`, flagged `is_test`, and capped at USD 1,000 per bid. Commissions they create are flagged `is_test` and are never payable (ADR-0005). A database that has held simulated money must not be reused for sandbox or live.
- **`sandbox`**: the provider sandbox APIs are called.
- **`live`**: honoured only when `LIVE_PAYMENTS=true`. Otherwise the mode falls back to `sandbox`.

Any other non-empty value (for example `Live`) is a configuration error: the Worker fails closed instead of guessing.

Real sandbox credentials were out of scope for this MVP. The sandbox and live paths are written from the provider docs and are tested only with simulated webhooks.

## PayPal
- Orders are created server-side with a `PayPal-Request-Id` header.
- A payment is confirmed by either:
  - a webhook verified through `/v1/notifications/verify-webhook-signature`, or
  - the response of the server-side capture call.
- `PENDING` and `DENIED` captures never confirm a bid.
- `REFUNDED` and `REVERSED` run the refund path. The capture is resolved through `links[rel=up]`.
- A `REFUNDED` event carries that refund's own amount. A **partial refund keeps the bid**: it is recorded in `payment_reviews` for the operator, and the ledger is not changed automatically. When the recorded refunds of a capture add up to the captured cash, the whole payment is reversed like a full refund and those reviews are closed.
- A capture sent through the other provider than the intent's is recorded for review; the intent is left untouched so the right provider can still pay it.
- A reversal of a capture that only exists as a review (never settled) changes nothing and is not retried.

## SePay
- The checkout form is signed with HMAC-SHA256 over the fields in the documented order, then base64-encoded.
- IPN uses auth type `SECRET_KEY`. The `X-Secret-Key` header is compared in constant time.
- `ORDER_PAID` confirms a bid. `TRANSACTION_VOID` refunds it.
- The SePay Bank Webhook flow is not implemented.

## Exactly once
- Webhook events have a UNIQUE `(provider, event_id)`.
- Payments have a UNIQUE `bid_intent_id` and a UNIQUE `(provider, provider_payment_id)`.
- Contributions have a UNIQUE `bid_intent_id`.
- The paid amount and currency must equal the amount due.

## Delivery and retries
- The `webhook_events` row is a delivery log, not a lock. A redelivery of an event whose status is still `received` (a crashed run), `failed` or `retry` is processed again; settlement and refunds are idempotent by their own UNIQUE keys.
- Processing errors mark the event `failed` and answer 503, so the provider redelivers.
- A refund or chargeback for a payment not recorded yet (it arrived before its capture) is marked `retry` and answers 503.

## Money that cannot settle automatically
A verified capture that does not match its intent is never silently kept. Examples: a wrong amount or currency, an intent that is closed or already paid, or a wallet reservation that was already released.

1. It is recorded in `payment_reviews`.
2. The intent moves to `needs_review`, and any wallet reservation is released.
3. The operator resolves it with `payments.resolve_review`: `settle` only for a capture of exactly the full locked quote with no wallet portion, otherwise `dismiss` after refunding at the provider.

Wallet funds can be applied only to a fresh quote, before checkout starts, so the amount a PayPal order or SePay form was built for never changes.

## Late captures
A capture that arrives after the quote expired still settles at the locked price, because the money has arrived.
