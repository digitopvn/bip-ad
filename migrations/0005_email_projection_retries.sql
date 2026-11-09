-- Retry state of domain events the email projector could not handle yet: a lock result waiting
-- for the remaining boards to freeze, or a mapping that failed. Until retry_after the event is
-- ignored, so it is neither re-mapped on every request nor counted as pending work. After too many
-- consecutive failures the projector acknowledges the event (receipt, no email) and logs it.
CREATE TABLE email_event_deferrals (
  event_id TEXT PRIMARY KEY,
  retry_after TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX email_event_deferrals_due ON email_event_deferrals (retry_after);

-- Highest outbox_events rowid the projector has looked at (handled or deferred). Newer events are
-- pending work; older unhandled ones are pending only once their deferral is due.
INSERT INTO email_settings (key, value) SELECT 'projection_high', value FROM email_settings WHERE key = 'projection_cursor';
-- Short lease so overlapping runs (request bursts, cron) do not project the same page at once.
INSERT INTO email_settings (key, value) VALUES ('projection_lease_until', '1970-01-01T00:00:00.000Z');
