# ADR-0009: Transactional email through Cloudflare Email Service

Status: accepted.

## Context
Builders learned what happened to their products, bids and money only by asking their agent over MCP. They need a short notice when a product is published or rejected, a receipt when a bid is confirmed, the 03:12 lock results, and notices about commissions and payouts. Email must not be lost when the provider fails, must not be sent twice, and must respect users who switch it off.

## Decision
Email is a projection of the domain events that every state change already writes to `outbox_events` in the same `db.batch` ([`ledger.ts` `outboxStatement`](../../src/domain/ledger.ts)). Nothing in the domain code calls the mailer.

1. **Projector** ([`email-projector.ts`](../../src/email/email-projector.ts), mapping in [`email-event-mapping.ts`](../../src/email/email-event-mapping.ts) and [`email-lock-results-mapping.ts`](../../src/email/email-lock-results-mapping.ts)) reads events after a rowid cursor and turns each into zero or more rows in `email_outbox`. Every row has a unique `dedupe_key`, so replays and concurrent runs insert nothing twice. Every handled event gets a row in `email_event_receipts`. Events created before migration `0004` are acknowledged without email, so deploying never emails old history.
2. **Sender** ([`email-sender.ts`](../../src/email/email-sender.ts)) claims due rows with a conditional update (a 10 minute lease), checks the user's preferences again, renders the message ([`email-templates.ts`](../../src/email/email-templates.ts)) and sends it through the `EMAIL` `send_email` binding. Failures back off 5 min, 15 min, 1 h, 3 h and 6 h. The sixth failed attempt marks the row `failed`.
3. **When it runs** ([`process-emails.ts`](../../src/email/process-emails.ts)): in the background (`waitUntil`) after every mutating web request, user MCP call and new sign-in, and in the hourly cron as the last housekeeping step. It never throws into the request or the lock.

| Event | Email | Group |
|---|---|---|
| `UserCreated` | welcome | always sent |
| `ProductApproved` / `ProductRejected` / `ProductSuspended` | product decision, with the operator's reason | Products |
| `PaymentConfirmed` | bid receipt | always sent |
| `RefundRecorded` / `ChargebackRecorded` | bid reversed | always sent |
| `BoardSnapshotFrozen` | lock results: one email per owner per cutoff, listing visible products with a bid on any of the three boards | Boards |
| `CommissionAvailable` | commission available | Referrals |
| `PayoutTransferReconciled` | payout paid | always sent |

A user with no email on file, or who switched the group off, gets a row marked `skipped` with the reason, so the operator can see why nothing was sent.

## Preferences and unsubscribe
`/account` has a switch for each group. Each grouped email carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) pointing at `/email/unsubscribe?t=<token>&g=<group>`. GET only shows a confirmation, because link scanners follow GETs. POST switches the group off. The token is random per user and stored in `email_preferences`, not derived from `SESSION_SECRET`.

## Configuration
- `send_email` binding `EMAIL` (`remote: true`) and `EMAIL_FROM` (`bip.ad <noreply@bip.ad>`) in both environments of `wrangler.jsonc`. `EMAIL_REPLY_TO` is optional and unset, because `bip.ad` receives no mail.
- The `bip.ad` zone is onboarded for Email Sending (SPF and MX on `cf-bounce.bip.ad`, DKIM, DMARC). Sending to arbitrary recipients requires Workers Paid.
- Staging sends real email to every user. Subjects start with `[staging] ` whenever `PUBLIC_ORIGIN` is not `bip.ad`.
- Tests set `remoteBindings: false` and inject a fake transport.

## Operations
The operator MCP tool `emails.list` filters `email_outbox` by `status`, `user_id` and `kind` and returns the status, attempts, last error and Cloudflare message id, never the message body.

## Consequences
- Delivery is at least once per row at the provider boundary. A worker that dies after the provider accepted a message but before the row was marked `sent` resends after the lease expires. Rows are never resent once `sent`.
- An event whose mapping keeps failing holds the cursor and is retried on every run. Later events still project, and the error is logged.
- Lock results wait until all three snapshots of a cutoff exist. A cutoff too old to be locked again is emailed from the snapshots that exist.
- New email kinds need a domain event, a mapping and a template. Marketing email is out of scope.
