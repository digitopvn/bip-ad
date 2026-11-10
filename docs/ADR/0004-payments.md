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

`PAYMENT_MODE` switches every provider at once, so each provider is offered only when its secrets are set (`providerEnabled` in [`checkout.ts`](../../src/payments/checkout.ts)): PayPal needs `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID`, and SePay needs `SEPAY_MERCHANT_ID`, `SEPAY_SECRET_KEY` and `SEPAY_IPN_SECRET`. The checkout page hides an unconfigured provider, and `/checkout/{id}/pay` and `boosts.checkout` refuse it before the intent changes. Simulated mode offers every provider.

The `/checkout/{id}` page shows the quote, wallet split, projected rank and pay buttons only to the intent's signed-in owner. Anyone else holding the URL sees the product name and a sign-in link that returns to the checkout (`checkoutLockedPage` in [`checkout.ts`](../../src/views/checkout.ts)). A checkout created over MCP is opened by the owner in a browser, so signing in there is the normal path.

Environments (2026-11-09, owner-approved): staging runs `sandbox` against PayPal's sandbox, and production runs `live` with `PAYPAL_API_BASE=https://api-m.paypal.com`. SePay is set up in neither, so VND quotes can be paid only from the wallet. `scripts/setup-paypal.sh staging|production` reads the REST app credentials with hidden prompts, checks them against PayPal, creates or reuses the webhook for `https://{host}/api/webhooks/paypal`, and stores the three secrets in the AgentKit vault and on the worker. `scripts/paypal-webhook-and-worker-secrets.mjs` does the same non-interactively for credentials already in the vault, run through `ak secrets run`. Neither database held simulated money when the mode changed; staging holds only the labelled sample boosts, which have no payments or ledger entries.

Real sandbox credentials were out of scope for the MVP, so the sandbox and live paths were written from the provider docs and tested with simulated webhooks. PayPal is verified end to end on staging's sandbox before production takes live money.

## PayPal
- Orders are created server-side with a `PayPal-Request-Id` header.
- A payment is confirmed by either:
  - a webhook verified through `/v1/notifications/verify-webhook-signature`, or
  - the response of the server-side capture call.
- The verification request carries the webhook body byte for byte (`verificationRequestBody` in [`paypal.ts`](../../src/payments/paypal.ts)), because PayPal checks the signature against the event exactly as it was sent.
- PayPal's return redirect (`GET /checkout/{id}/paypal-return?token=…`) has no side effects. It renders a page whose button POSTs to `/checkout/{id}/paypal-capture`, and only that POST captures the order. Link prefetchers and previews that follow the return URL therefore cannot capture. Both the return page and the capture POST need the owner's session as well as the order token. Anyone else, including an owner whose session expired at PayPal, is sent to `/login?next=` and comes back to the return page.
- `PENDING` and `DENIED` captures never confirm a bid.
- `REFUNDED` and `REVERSED` run the refund path. The capture is resolved through `links[rel=up]`.
- A `REFUNDED` event carries that refund's own amount. A **partial refund keeps the bid**: it is recorded in `payment_reviews` for the operator, and the ledger is not changed automatically. When the recorded refunds of a capture add up to the captured cash, the whole payment is reversed like a full refund and those reviews are closed.
- A capture sent through the other provider than the intent's is recorded for review; the intent is left untouched so the right provider can still pay it.
- A reversal of a capture that only exists as a review (never settled) changes no ledger entry; it dismisses the review, so money already returned cannot be settled. A partial refund of held money keeps the review open until the refunds reach the captured amount.
- An operator settlement claims the review before settling. A reversal that races it sees the claimed review, reverses the payment once it exists, or asks the provider to redeliver. A claim that is older than 10 minutes and has no payment means the settling request died; it is listed again in `payments.reviews` and can be settled or dismissed (including by a provider reversal).
- Dismissing a review fails its intent only when no other open capture review still needs that intent.

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

Chrome checks CSP `form-action` on every redirect after a form POST and blocks an unlisted host without any error page. The checkout form redirects to PayPal or SePay, so `form-action` lists those hosts. The MCP consent page (`/authorize`) sends no `form-action`, because its chain ends at the client's registered redirect URI, which can be any host including `http://localhost:<port>`; that is how MCP sign-in failed on staging.
