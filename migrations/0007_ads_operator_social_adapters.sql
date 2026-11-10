-- Ads operator, social publishing and operator monitoring.
-- Ads run dry (ADS_MODE=dry_run) and social posting is mocked (SOCIAL_MODE=mock) until the owner
-- flips them; every request an adapter sends, or would send, is recorded in adapter_requests.

-- A paused flight remembers what it was doing so the operator can resume it exactly there.
ALTER TABLE ad_flights ADD COLUMN paused_reason TEXT;
ALTER TABLE ad_flights ADD COLUMN paused_at TEXT;
ALTER TABLE ad_flights ADD COLUMN paused_from_state TEXT;
ALTER TABLE ad_flights ADD COLUMN unallocated_minor INTEGER NOT NULL DEFAULT 0 CHECK (unallocated_minor >= 0);

-- The planner's split of one flight across ad channels. Amounts are whole currency units (in
-- minor units), so the provider budget is never rounded up past the flight's caps.
CREATE TABLE ad_flight_allocations (
  id TEXT PRIMARY KEY,
  flight_id TEXT NOT NULL REFERENCES ad_flights(id),
  channel TEXT NOT NULL,
  daily_minor INTEGER NOT NULL CHECK (daily_minor > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  -- planned: not sent; recorded: dry run stored the request; committed: live, reserved against the cap before sending;
  -- sent: the provider accepted it; failed: the provider refused it (dead letter).
  state TEXT NOT NULL CHECK (state IN ('planned', 'recorded', 'committed', 'sent', 'failed')),
  external_campaign_id TEXT,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (flight_id, channel)
);

-- Every adapter request, keyed by its idempotency key: a retry resends the stored request, so a
-- timeout never creates a second post or campaign. Credentials are never stored.
CREATE TABLE adapter_requests (
  id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL CHECK (adapter IN ('ads', 'social')),
  operation TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'live')),
  resource_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  body_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('recorded', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX adapter_requests_resource ON adapter_requests (resource_id);

-- Failed live adapter calls waiting for the operator (adapters.dead_letters / adapters.retry).
CREATE TABLE adapter_dead_letters (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES adapter_requests(id),
  error TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX adapter_dead_letters_status ON adapter_dead_letters (status, created_at);

-- Hourly provider metrics per flight. Without provider data the row says so (state no_data) and
-- carries no numbers; as_of_at and source are always set.
CREATE TABLE ad_metrics (
  id TEXT PRIMARY KEY,
  flight_id TEXT NOT NULL REFERENCES ad_flights(id),
  hour TEXT NOT NULL,
  as_of_at TEXT NOT NULL,
  source TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('no_data', 'reported')),
  spend_minor INTEGER,
  impressions INTEGER,
  clicks INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (flight_id, hour),
  CHECK (state = 'reported' OR (spend_minor IS NULL AND impressions IS NULL AND clicks IS NULL))
);

-- Runtime operator switches (the ads kill switch).
CREATE TABLE operator_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Alert emails to the operator (OPERATOR_ALERT_EMAIL), one per condition and period (dedupe_key).
CREATE TABLE operator_alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  detail_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX operator_alerts_status ON operator_alerts (status, created_at);
