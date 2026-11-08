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

## Snapshots
- A snapshot is computed only from rows committed before the cutoff. Contributions voided after the cutoff still count.
- It is stored once per `(board, cutoff_at)`.
- Database triggers make snapshot rows immutable. The only change allowed is marking an item as removed from publication.

## Minimum bid
The minimum increment comes from `MIN_BID_UNITS` and `MIN_BID_INCREMENT_UNITS`. The sandbox default is 100 units, which is USD 1.
