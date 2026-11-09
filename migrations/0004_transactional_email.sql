-- Transactional email. The email projector (src/email/) reads domain events from outbox_events,
-- turns each into zero or more email_outbox rows, and the sender delivers due rows through the
-- Cloudflare Email Service binding. outbox_events itself is never modified here.

-- One row per email to send. dedupe_key makes replaying an event (or two concurrent projector
-- runs) a no-op: INSERT ... ON CONFLICT (dedupe_key) DO NOTHING.
CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  group_name TEXT CHECK (group_name IN ('products', 'boards', 'referrals')),
  dedupe_key TEXT NOT NULL UNIQUE,
  to_address TEXT,
  data_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  skip_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  provider_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX email_outbox_due ON email_outbox (status, next_attempt_at);
CREATE INDEX email_outbox_user ON email_outbox (user_id, created_at);

-- Opt-out groups (1 = on). Mandatory emails (welcome, receipts, reversals, payouts) have no group.
-- The unsubscribe token is the only credential of the one-click unsubscribe link.
CREATE TABLE email_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  products INTEGER NOT NULL DEFAULT 1 CHECK (products IN (0, 1)),
  boards INTEGER NOT NULL DEFAULT 1 CHECK (boards IN (0, 1)),
  referrals INTEGER NOT NULL DEFAULT 1 CHECK (referrals IN (0, 1)),
  unsubscribe_token TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL
);

-- A domain event the email projector has handled (whether or not it produced an email).
CREATE TABLE email_event_receipts (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE email_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Events created before this migration ran are never emailed (no backfill of old events).
INSERT INTO email_settings (key, value) VALUES ('projection_start', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
-- Scan cursor over outbox_events insertion order (rowid): events at or below it are all handled,
-- so an idle projector run reads one index entry instead of the whole event history.
INSERT INTO email_settings (key, value) VALUES ('projection_cursor', CAST((SELECT COALESCE(MAX(rowid), 0) FROM outbox_events) AS TEXT));
