# ADR-0004: PayPal + SePay adapters, simulated by default

Status: accepted for the MVP

## Providers
- The only providers are PayPal (Orders v2, USD) and the SePay Payment Gateway (VietQR, VND). No other provider is added, including as a fallback.

## Payment modes
`PAYMENT_MODE` takes one of three values:

- **`simulated`** (the default): the Worker makes no provider calls. The `/checkout/{id}` page shows test buttons to the owner only.
- **`sandbox`**: the provider sandbox APIs are called.
- **`live`**: honoured only when `LIVE_PAYMENTS=true`. Otherwise the mode falls back to `sandbox`.

Real sandbox credentials were out of scope for this MVP. The sandbox and live paths are written from the provider docs and are tested only with simulated webhooks.

## PayPal
- Orders are created server-side with a `PayPal-Request-Id` header.
- A payment is confirmed by either:
  - a webhook verified through `/v1/notifications/verify-webhook-signature`, or
  - the response of the server-side capture call.
- `PENDING` and `DENIED` captures never confirm a bid.
- `REFUNDED` and `REVERSED` run the refund path.

## SePay
- The checkout form is signed with HMAC-SHA256 over the fields in the documented order, then base64-encoded.
- IPN uses auth type `SECRET_KEY`. The `X-Secret-Key` header is compared in constant time.
- `ORDER_PAID` confirms a bid. `TRANSACTION_VOID` refunds it.
- The SePay Bank Webhook flow is not implemented.

## Exactly once
- Webhook events have a UNIQUE `(provider, event_id)`.
- Payments have a UNIQUE `bid_intent_id` and a UNIQUE `(provider, provider_payment_id)`.
- Contributions have a UNIQUE `bid_intent_id`.
- The paid amount and currency must equal the amount due. Otherwise the intent moves to `needs_review`.

## Late captures
A capture that arrives after the quote expired still settles at the locked price, because the money has arrived.
