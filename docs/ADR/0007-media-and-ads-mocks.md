# ADR-0007: Video, social and ads adapters are mocks in this MVP

Status: accepted. Phases 4–5 are out of scope.

## Video
The lock records a Top 10 "video composition" for each board: a JSON document with the snapshot URL and the items, plus its SHA-256 content hash. Its status is `mocked`. No MP4 is rendered.

## Social
Publications for X, Facebook and YouTube are recorded with state `mocked`. Nothing is posted.

## Ads
- Each funded cohort gets an `ad_flight` with hard caps:
  - `spend_cap` = the cohort's ads fund;
  - `daily_cap` = fund / days.
- The flight's `adapter_status` is `mocked`.
- `ads.execute` checks the caps and the board on the server, logs the decision, and spends nothing.
- A cohort with no new revenue creates no flight, so there is never a $0 campaign.
