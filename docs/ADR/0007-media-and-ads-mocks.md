# ADR-0007: Video, social and ads adapters behind owner-controlled flags

Status: accepted (2026-11-10). Replaces "media and ads are mocks".

The adapters are real Zernio integrations, but nothing public or paid happens until the owner flips a flag. Defaults are the same in staging and production (`wrangler.jsonc`).

| Adapter | Flag | Default | What the default does |
|---|---|---|---|
| Video | none | mock | The lock records a Top 10 composition (JSON with the snapshot URL and items) and its SHA-256, status `mocked`. No MP4 is rendered. |
| Social | `SOCIAL_MODE` = `mock` \| `live` | `mock` | The lock records X, Facebook and YouTube publications as `mocked`. Nothing is posted. |
| Ads | `ADS_MODE` = `dry_run` \| `live` | `dry_run` | Flights are planned and executed as recorded requests. Nothing is sent, committed or spent. |

`ADS_MODE=live` is honoured only with `ADS_LIVE_APPROVED=true`, the same way `PAYMENT_MODE=live` needs `LIVE_PAYMENTS=true` (`src/domain/config.ts`). An unset mode is the safe default. A typo fails at startup.

## Request log and dead letters
- Every adapter request is stored in `adapter_requests` before it is sent, or instead of being sent in a dry run (`src/ads/adapter-call-log.ts`). The row is keyed by an idempotency key, which is also sent as Zernio's `Idempotency-Key` header. A retry resends the stored request, so a timeout cannot create a second post or campaign.
- The API key is added at send time and never stored.
- A failed live call opens a row in `adapter_dead_letters`. The operator lists these with `adapters.dead_letters` and resends with `adapters.retry`. A retry is refused once the adapter is no longer live.

## Social (`src/social/`)
- With `SOCIAL_MODE=live`, the operator calls `social.publish` after checking the video. The call makes one `POST /v1/posts` per platform with `publishNow: true`. The targets are X (Zernio slug `twitter`), Facebook, YouTube and TikTok.
- YouTube and TikTok need a `video_url`. Without one they are recorded as `blocked_no_video`. A platform without a `ZERNIO_ACCOUNT_*` id is recorded as `not_configured`.
- Publishing is not automatic in the lock, because no MP4 renderer exists yet.

## Ads (`src/ads/`)
- The 03:12 lock creates one `ad_flight` per funded cohort. Its caps are `spend_cap` = the cohort's 80% ads fund and `daily_cap` = fund / days. A cohort with no new revenue creates no flight.
- The hourly cycle runs these steps (`ads-hourly-cycle.ts`):
  - It checks the kill switch and `finance.reconcile`. If either fails, it pauses every unfinished flight.
  - Otherwise it plans and executes due flights.
  - It records hourly metrics and queues operator alerts.
- The planner is deterministic (`ads-flight-planner.ts`) and works on one flight at a time, so it never crosses boards. Its budgets are whole currency units, and three things always hold:
  - the sum of daily budgets is within `daily_cap`;
  - the sum of amounts is within `spend_cap`;
  - each channel gets at least its minimum.
- Money that no channel can take stays `unallocated` on the flight. An optional channel-preference hook exists. It is off, and it can only reorder or drop channels.
- Channels come from `ZERNIO_ADS_ACCOUNTS`, a JSON list of channel, `accountId`, `adAccountId` and `minDailyMinor`. With none configured, flights are `held`.
- A dry-run execution records the exact `POST /v1/ads/create` body (daily budget in whole units, start/end, link to the snapshot). Committed and spent stay 0.
- A live execution first commits the allocation against the cap in one guarded batch, then sends it.
- Metrics are recorded hourly with `as_of_at` and `source`. Provider ingestion does not exist yet, so every row is an explicit `no_data` row and no numbers are stored.
- `ads.report` covers ended flights: cap, planned, committed, spent and unspent, with reasons. Unspent money stays with its board and is never operator revenue.
- The public `/transparency` page shows funds, flights, caps, `as_of_at` and source, labelled "dry run".

## Not confirmed in the Zernio docs (2026-11-10)
- The shape of the `campaigns` array in `POST /v1/ads/campaigns/bulk-status`. We send campaign id strings.
- The campaign id field in the `POST /v1/ads/create` response. `parseCreatedCampaignId` tries the known spellings.
- `firstComment` support per platform. Snapshot links go in the caption instead.
- A metrics endpoint for hourly ingestion.

Check these before setting `ADS_MODE=live`.
