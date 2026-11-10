-- Ranking metric rollups: live boards read the click/view tie-breakers from a precomputed set
-- instead of counting 30 days of measurement_events on every page view. A set is written hourly
-- by the cron ('hourly', pruned after a day) and once per cutoff ('cutoff', kept: the snapshot of
-- that cutoff is reproducible from it).
CREATE TABLE ranking_metric_rollup_runs (
  as_of_at TEXT PRIMARY KEY,           -- window end (inclusive)
  window_start TEXT NOT NULL,          -- window start (exclusive)
  kind TEXT NOT NULL CHECK (kind IN ('hourly', 'cutoff')),
  filter_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ranking_metric_rollup_runs_kind ON ranking_metric_rollup_runs (kind, as_of_at);

-- One row per product with at least one counted event in the window; a missing row means zero.
CREATE TABLE ranking_metric_rollups (
  as_of_at TEXT NOT NULL REFERENCES ranking_metric_rollup_runs(as_of_at),
  product_id TEXT NOT NULL REFERENCES products(id),
  valid_unique_clicks INTEGER NOT NULL,
  valid_unique_views INTEGER NOT NULL,
  PRIMARY KEY (as_of_at, product_id)
) WITHOUT ROWID;

-- Product state history, so a snapshot taken late uses the state at its cutoff: a product
-- suspended after the cutoff stays in, and the page version pinned is the one live at the cutoff.
-- Written by triggers on every change of status, version or live page, stamped with updated_at
-- (every status change and page publish sets it in the same statement or batch).
CREATE TABLE product_state_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  status TEXT NOT NULL,
  product_version INTEGER NOT NULL,
  page_version_id TEXT,
  changed_at TEXT NOT NULL
);
CREATE INDEX product_state_history_product ON product_state_history (product_id, changed_at);

CREATE TRIGGER product_state_history_insert AFTER INSERT ON products
BEGIN
  INSERT INTO product_state_history (product_id, status, product_version, page_version_id, changed_at)
  VALUES (NEW.id, NEW.status, NEW.version, NEW.current_page_version_id,
          CASE WHEN NEW.status = 'published' THEN COALESCE(NEW.published_at, NEW.updated_at) ELSE NEW.updated_at END);
END;

CREATE TRIGGER product_state_history_update AFTER UPDATE OF status, version, current_page_version_id ON products
WHEN NEW.status IS NOT OLD.status OR NEW.version IS NOT OLD.version OR NEW.current_page_version_id IS NOT OLD.current_page_version_id
BEGIN
  INSERT INTO product_state_history (product_id, status, product_version, page_version_id, changed_at)
  VALUES (NEW.id, NEW.status, NEW.version, NEW.current_page_version_id, NEW.updated_at);
END;

-- Backfill: products that were ever published get their current state at published_at; products
-- that are no longer published also get their current status at their last update. Earlier page
-- versions of existing products are not known and are not reconstructed.
INSERT INTO product_state_history (product_id, status, product_version, page_version_id, changed_at)
SELECT id, 'published', version, current_page_version_id, published_at FROM products WHERE published_at IS NOT NULL;
INSERT INTO product_state_history (product_id, status, product_version, page_version_id, changed_at)
SELECT id, status, version, current_page_version_id, updated_at FROM products WHERE published_at IS NULL OR status <> 'published';

-- First metric set, so live boards keep their tie-breakers until the first hourly cron writes one.
INSERT INTO ranking_metric_rollup_runs (as_of_at, window_start, kind, filter_version, created_at)
VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days'), 'hourly', 'visitor-day-dedup-v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT INTO ranking_metric_rollups (as_of_at, product_id, valid_unique_clicks, valid_unique_views)
SELECT r.as_of_at, e.product_id,
       COUNT(DISTINCT CASE WHEN e.event_type IN ('product_card_click', 'outbound_click') THEN e.visitor_hash END),
       COUNT(DISTINCT CASE WHEN e.event_type = 'product_page_view' THEN e.visitor_hash END)
FROM ranking_metric_rollup_runs r
JOIN measurement_events e ON e.occurred_at > r.window_start AND e.occurred_at <= r.as_of_at
  AND e.event_type IN ('product_card_click', 'outbound_click', 'product_page_view')
GROUP BY r.as_of_at, e.product_id;
