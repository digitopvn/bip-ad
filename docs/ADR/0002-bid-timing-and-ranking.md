# ADR-0002: Bid lifetime, cutoff and ranking policy rank-v1

Status: accepted for the MVP. The owner must approve it before go-live.

## Bid lifetime
A contribution starts at `confirmed_at`, the moment the verified payment is committed to the database. It lasts:

- 24 hours on the Daily board;
- 7 × 24 hours on the Weekly board;
- 30 × 24 hours on the Monthly board. This is 30 days, not a calendar month.

## Cutoff
The cutoff is 03:12:00 Asia/Ho_Chi_Minh, which is 20:12:00 UTC because Vietnam has no daylight saving time.

- A payment confirmed at exactly 03:12:00.000, or later, belongs to the next cutoff. This is stored as `assigned_cutoff_at`.
- A snapshot counts only contributions with `starts_at` strictly before the cutoff.

## Sort order
Products are ordered by these keys, in priority order:

1. Active rank units, highest first.
2. The owner's vested successful referrals, most first.
3. Distinct visitors with a card click or outbound click in the 30 days ending at the cutoff, most first.
4. Distinct page-view visitors in the same window, most first.
5. When both products have a bid above zero: the product that reached its current amount earliest.
6. `published_at`, newest first.
7. `product_id`, ascending.

Keys 3 and 4 are read from `ranking_metric_rollups` (migration `0006`), never from raw `measurement_events` on a page view:

- The hourly cron writes a metric set ending at its run time, and each lock writes one stamped at the cutoff. A set is one `INSERT ... SELECT` over the 30-day window with the same filters as above.
- Live boards (`loadStandings` in [`ranking.ts`](../../src/domain/ranking.ts)) use the latest set, so their clicks and views can be up to about an hour old. Active bids and referrals stay live.
- Hourly sets are pruned after a day. Cutoff sets are kept, so the scores of every snapshot can be reproduced.

## Snapshots
- A snapshot is computed only from rows committed before the cutoff. Contributions voided after the cutoff still count.
- It uses the state of each product at the cutoff (`loadCutoffStandings`), from `product_state_history`. Triggers on `products` record every change of status, version and live page version, stamped with `updated_at`. A lock that runs late therefore:
  - includes a product that was published at the cutoff and suspended after it, stored as removed from publication;
  - pins the page version and product version that were live at the cutoff;
  - leaves out a product first published after the cutoff.
- Products that existed before migration `0006` have their current state backfilled from `published_at`. Page versions they had before that are not reconstructed.
- It is stored once per `(board, cutoff_at)`.
- Database triggers make snapshot rows immutable. The only change allowed is marking an item as removed from publication.

## D1 query limits
The lock and housekeeping cron invocations assume the Workers Free limit of 50 D1 queries per invocation. A `db.batch()` counts as one query.

- The header, items and outbox event of a snapshot commit in one batch. Items are inserted 200 per statement from a JSON parameter, which stays far below the 100 KB statement and 2 MB value limits at about 1,000 products.
- `scheduledJob` ([`index.ts`](../../src/index.ts)) meters every query against `SCHEDULED_QUERY_CAP` (45). Work runs in priority order: the lock and the catch-up of missed cutoffs, then the hourly metric rollup, then quote expiry, commission vesting and the AI moderation sweep. Each housekeeping step gets a page sized to the queries left.
- `runLock` starts a step (freeze, finalize or media of one board) only when the step's worst case fits (`LOCK_STEP_QUERIES` in [`snapshot.ts`](../../src/domain/snapshot.ts)). Otherwise the job stays `running` and the next hourly run resumes it. Finished steps only cost their "already done" check. Cutoffs are locked oldest first, and a later cutoff is not started while an earlier one is incomplete.
- One fresh cutoff fits in one invocation. Catching up three missed cutoffs takes about three hourly runs.

## Minimum bid
The minimum increment comes from `MIN_BID_UNITS` and `MIN_BID_INCREMENT_UNITS`. The sandbox default is 100 units, which is USD 1.
