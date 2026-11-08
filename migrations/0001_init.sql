-- BIP.AD initial schema. Timestamps are ISO-8601 UTC strings (lexicographically ordered).
-- Money is integer minor units (USD cents, VND dong). rank_units are USD cents locked at quote time.
-- D1 has no interactive transactions: every multi-row change runs in one db.batch(), and the
-- UNIQUE / CHECK constraints below are what make retries and races safe.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL
);

CREATE TABLE user_identities (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google', 'system')),
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);

CREATE TABLE referral_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE referral_attributions (
  id TEXT PRIMARY KEY,
  referred_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  referrer_user_id TEXT NOT NULL REFERENCES users(id),
  referral_code_id TEXT NOT NULL REFERENCES referral_codes(id),
  attribution_source TEXT NOT NULL,
  attributed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rejected')),
  CHECK (referred_user_id <> referrer_user_id)
);

CREATE TABLE successful_referrals (
  id TEXT PRIMARY KEY,
  attribution_id TEXT NOT NULL UNIQUE REFERENCES referral_attributions(id),
  referrer_user_id TEXT NOT NULL REFERENCES users(id),
  referred_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  first_qualifying_bid_intent_id TEXT NOT NULL,
  qualified_at TEXT NOT NULL,
  vest_at TEXT NOT NULL,
  vested_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'vested', 'clawed_back', 'fraud')),
  policy_version TEXT NOT NULL
);
CREATE INDEX successful_referrals_referrer ON successful_referrals (referrer_user_id, status, vested_at);

CREATE TABLE referral_commissions (
  id TEXT PRIMARY KEY,
  successful_referral_id TEXT NOT NULL REFERENCES successful_referrals(id),
  qualifying_bid_intent_id TEXT NOT NULL,
  referrer_user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  eligible_base_minor INTEGER NOT NULL CHECK (eligible_base_minor > 0),
  commission_minor INTEGER NOT NULL CHECK (commission_minor >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'available', 'clawed_back')),
  vest_at TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (successful_referral_id, qualifying_bid_intent_id, policy_version)
);

-- Projection of the wallet ledger accounts. CHECKs make an overdraft abort the whole batch.
CREATE TABLE wallet_balances (
  user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  pending_minor INTEGER NOT NULL DEFAULT 0 CHECK (pending_minor >= 0),
  available_minor INTEGER NOT NULL DEFAULT 0 CHECK (available_minor >= 0),
  reserved_bid_minor INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bid_minor >= 0),
  reserved_payout_minor INTEGER NOT NULL DEFAULT 0 CHECK (reserved_payout_minor >= 0),
  paid_minor INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  clawback_due_minor INTEGER NOT NULL DEFAULT 0 CHECK (clawback_due_minor >= 0),
  PRIMARY KEY (user_id, currency)
);

CREATE TABLE wallet_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  bid_intent_id TEXT,
  payout_request_id TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK ((bid_intent_id IS NULL) <> (payout_request_id IS NULL))
);
CREATE UNIQUE INDEX wallet_reservations_intent ON wallet_reservations (bid_intent_id) WHERE bid_intent_id IS NOT NULL;
CREATE UNIQUE INDEX wallet_reservations_payout ON wallet_reservations (payout_request_id) WHERE payout_request_id IS NOT NULL;

-- A reservation is closed exactly once: consumed by a settlement or released.
CREATE TABLE reservation_closures (
  reservation_id TEXT PRIMARY KEY REFERENCES wallet_reservations(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('consumed', 'released', 'paid', 'failed')),
  closed_at TEXT NOT NULL
);

CREATE TABLE payout_batches (
  id TEXT PRIMARY KEY,
  window_month TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'reconciled')),
  prepared_at TEXT NOT NULL,
  reconciled_at TEXT
);

CREATE TABLE payout_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  requested_minor INTEGER NOT NULL CHECK (requested_minor > 0),
  state TEXT NOT NULL CHECK (state IN ('requested', 'batched', 'paid', 'failed')),
  payout_method TEXT NOT NULL,
  beneficiary_reference TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  batch_id TEXT REFERENCES payout_batches(id),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE payout_transfers (
  id TEXT PRIMARY KEY,
  payout_batch_id TEXT NOT NULL REFERENCES payout_batches(id),
  payout_request_id TEXT NOT NULL UNIQUE REFERENCES payout_requests(id),
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  bank_transfer_reference TEXT NOT NULL UNIQUE,
  proof_ref TEXT NOT NULL,
  transferred_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reconciled')),
  created_at TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL,
  website_url TEXT NOT NULL,
  image_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'suspended')),
  is_sample INTEGER NOT NULL DEFAULT 0,
  current_page_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  create_key TEXT UNIQUE,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX products_owner ON products (owner_id);
CREATE INDEX products_status ON products (status, published_at);

CREATE TABLE product_page_versions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  version INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  moderation_status TEXT NOT NULL CHECK (moderation_status IN ('draft', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (product_id, version)
);

CREATE TABLE bid_intents (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  board TEXT NOT NULL CHECK (board IN ('daily', 'weekly', 'monthly')),
  rank_units INTEGER NOT NULL CHECK (rank_units > 0),
  quote_currency TEXT NOT NULL CHECK (quote_currency IN ('USD', 'VND')),
  quote_minor INTEGER NOT NULL CHECK (quote_minor > 0),
  fx_rate TEXT,
  fx_source TEXT NOT NULL,
  rounding_rule TEXT NOT NULL,
  quoted_at TEXT NOT NULL,
  quote_expires_at TEXT NOT NULL,
  wallet_applied_minor INTEGER NOT NULL DEFAULT 0 CHECK (wallet_applied_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('quoted', 'awaiting_payment', 'confirmed', 'expired', 'failed', 'cancelled', 'refunded', 'needs_review')),
  provider TEXT,
  provider_order_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (wallet_applied_minor <= quote_minor)
);
CREATE INDEX bid_intents_owner ON bid_intents (owner_id, created_at);
CREATE UNIQUE INDEX bid_intents_provider_order ON bid_intents (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;

-- One settled payment per bid intent; one row per provider payment.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  bid_intent_id TEXT NOT NULL UNIQUE REFERENCES bid_intents(id),
  provider TEXT NOT NULL CHECK (provider IN ('paypal', 'sepay', 'wallet')),
  provider_payment_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  cash_minor INTEGER NOT NULL CHECK (cash_minor >= 0),
  wallet_minor INTEGER NOT NULL CHECK (wallet_minor >= 0),
  state TEXT NOT NULL CHECK (state IN ('captured', 'refunded', 'disputed')),
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_payment_id)
);

CREATE TABLE bid_contributions (
  id TEXT PRIMARY KEY,
  bid_intent_id TEXT NOT NULL UNIQUE REFERENCES bid_intents(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  board TEXT NOT NULL CHECK (board IN ('daily', 'weekly', 'monthly')),
  rank_units INTEGER NOT NULL CHECK (rank_units > 0),
  currency TEXT NOT NULL,
  gross_minor INTEGER NOT NULL CHECK (gross_minor > 0),
  ads_minor INTEGER NOT NULL CHECK (ads_minor >= 0),
  commission_minor INTEGER NOT NULL CHECK (commission_minor >= 0),
  platform_minor INTEGER NOT NULL CHECK (platform_minor >= 0),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  assigned_cutoff_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'voided_after_refund')),
  created_at TEXT NOT NULL,
  voided_at TEXT,
  CHECK (ads_minor + commission_minor + platform_minor = gross_minor),
  CHECK (expires_at > starts_at)
);
CREATE INDEX bid_contributions_board ON bid_contributions (board, status, starts_at, expires_at);
CREATE INDEX bid_contributions_cutoff ON bid_contributions (board, assigned_cutoff_at);

-- Double-entry ledger. amount_minor > 0 is a debit, < 0 a credit; each transaction sums to 0 per currency.
CREATE TABLE ledger_transactions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  memo TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, reference_id)
);

CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL REFERENCES ledger_transactions(id),
  account TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  created_at TEXT NOT NULL
);
CREATE INDEX ledger_entries_account ON ledger_entries (account, currency);
CREATE INDEX ledger_entries_txn ON ledger_entries (txn_id);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  signature_verified INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  received_at TEXT NOT NULL,
  UNIQUE (provider, event_id)
);

CREATE TABLE board_snapshots (
  id TEXT PRIMARY KEY,
  board TEXT NOT NULL CHECK (board IN ('daily', 'weekly', 'monthly')),
  cutoff_at TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  ranking_policy_version TEXT NOT NULL,
  ranking_metric_window TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('frozen')),
  UNIQUE (board, cutoff_at)
);

CREATE TABLE board_snapshot_items (
  snapshot_id TEXT NOT NULL REFERENCES board_snapshots(id),
  rank INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  page_version_id TEXT,
  product_metadata_version INTEGER NOT NULL,
  rank_units INTEGER NOT NULL,
  owner_successful_referrals INTEGER NOT NULL,
  valid_unique_clicks INTEGER NOT NULL,
  valid_unique_views INTEGER NOT NULL,
  visibility_state TEXT NOT NULL CHECK (visibility_state IN ('visible', 'removed_from_publication')),
  PRIMARY KEY (snapshot_id, rank),
  UNIQUE (snapshot_id, product_id)
);

-- Snapshots are immutable: only visibility_state may change, and only towards removal.
CREATE TRIGGER board_snapshot_items_immutable BEFORE UPDATE ON board_snapshot_items
WHEN NEW.rank <> OLD.rank OR NEW.product_id <> OLD.product_id OR NEW.rank_units <> OLD.rank_units
  OR NEW.owner_successful_referrals <> OLD.owner_successful_referrals
  OR NEW.valid_unique_clicks <> OLD.valid_unique_clicks OR NEW.valid_unique_views <> OLD.valid_unique_views
  OR (OLD.visibility_state = 'removed_from_publication' AND NEW.visibility_state = 'visible')
BEGIN SELECT RAISE(ABORT, 'snapshot items are immutable'); END;
CREATE TRIGGER board_snapshot_items_no_delete BEFORE DELETE ON board_snapshot_items
BEGIN SELECT RAISE(ABORT, 'snapshot items are immutable'); END;

CREATE TABLE revenue_cohorts (
  id TEXT PRIMARY KEY,
  board TEXT NOT NULL CHECK (board IN ('daily', 'weekly', 'monthly')),
  cutoff_at TEXT NOT NULL,
  currency TEXT NOT NULL,
  eligible_revenue_minor INTEGER NOT NULL,
  external_cash_minor INTEGER NOT NULL,
  wallet_funded_minor INTEGER NOT NULL,
  ads_fund_minor INTEGER NOT NULL CHECK (ads_fund_minor >= 0),
  referral_commission_minor INTEGER NOT NULL CHECK (referral_commission_minor >= 0),
  operator_allocation_minor INTEGER NOT NULL CHECK (operator_allocation_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('finalized', 'funded', 'closed')),
  created_at TEXT NOT NULL,
  UNIQUE (board, cutoff_at, currency),
  CHECK (ads_fund_minor + referral_commission_minor + operator_allocation_minor = eligible_revenue_minor)
);

CREATE TABLE revenue_cohort_contributions (
  cohort_id TEXT NOT NULL REFERENCES revenue_cohorts(id),
  bid_contribution_id TEXT NOT NULL UNIQUE REFERENCES bid_contributions(id),
  allocated_amount_minor INTEGER NOT NULL,
  ads_minor INTEGER NOT NULL,
  PRIMARY KEY (cohort_id, bid_contribution_id)
);

CREATE TABLE ad_flights (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL UNIQUE REFERENCES revenue_cohorts(id),
  board TEXT NOT NULL,
  currency TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  spend_cap_minor INTEGER NOT NULL CHECK (spend_cap_minor >= 0),
  daily_cap_minor INTEGER NOT NULL CHECK (daily_cap_minor >= 0),
  planned_minor INTEGER NOT NULL DEFAULT 0,
  committed_minor INTEGER NOT NULL DEFAULT 0,
  spent_minor INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  adapter_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (planned_minor <= spend_cap_minor AND committed_minor <= spend_cap_minor AND spent_minor <= spend_cap_minor)
);

CREATE TABLE content_assets (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES board_snapshots(id),
  type TEXT NOT NULL,
  url TEXT,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (snapshot_id, type)
);

CREATE TABLE social_publications (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES board_snapshots(id),
  platform TEXT NOT NULL,
  external_post_id TEXT,
  url TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (snapshot_id, platform)
);

-- Deduplicated measurement: one row per product, event type, visitor and ICT day.
CREATE TABLE measurement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('product_card_impression', 'product_card_click', 'product_page_view', 'outbound_click')),
  visitor_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  UNIQUE (product_id, event_type, visitor_hash, day)
);
CREATE INDEX measurement_events_window ON measurement_events (event_type, occurred_at, product_id);

CREATE TABLE decision_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'defer')),
  reason_codes_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  resource_id TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX outbox_events_status ON outbox_events (status, created_at);

CREATE TABLE job_runs (
  job_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  detail TEXT,
  PRIMARY KEY (job_type, resource_id, version)
);
