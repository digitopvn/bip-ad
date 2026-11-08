-- Guards that make a D1 batch abort when a state transition it depends on did not happen.
-- D1 has no interactive transactions, so "UPDATE ... WHERE state = ?" matching 0 rows must
-- fail the batch explicitly: INSERT INTO batch_guards SELECT NULL WHERE NOT (<condition>)
-- violates NOT NULL exactly when the condition is false, and inserts nothing otherwise.
CREATE TABLE batch_guards (ok INTEGER NOT NULL);

-- One reversal (refund or chargeback) per payment, whatever the event kind.
CREATE TABLE payment_reversals (
  payment_id TEXT PRIMARY KEY REFERENCES payments(id),
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'chargeback')),
  created_at TEXT NOT NULL
);

-- Money the providers reported that could not be applied automatically: captures that do not
-- match their intent, captures for closed intents, partial refunds. The operator resolves them.
CREATE TABLE payment_reviews (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('capture', 'partial_refund')),
  bid_intent_id TEXT,
  provider_payment_id TEXT,
  currency TEXT,
  amount_minor INTEGER,
  reason TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('open', 'settled', 'dismissed')),
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (provider, event_ref)
);
CREATE INDEX payment_reviews_open ON payment_reviews (status, created_at);

-- Simulated (test-mode) money is flagged so it can never become a payable balance.
ALTER TABLE payments ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
ALTER TABLE referral_commissions ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

-- Edits to a published product wait for moderation instead of going live immediately.
ALTER TABLE products ADD COLUMN pending_edit_json TEXT;
ALTER TABLE products ADD COLUMN pending_page_version_id TEXT;
