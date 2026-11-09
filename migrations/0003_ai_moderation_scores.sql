-- AI moderation scores, one row per stage per product version. Answers are kept raw so the policy
-- can be re-evaluated; the verdict and reasons are what the policy decided at the time.
CREATE TABLE moderation_scores (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  product_version INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('fast', 'full')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('allow', 'defer')),
  risk REAL,
  reasons_json TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  evidence_json TEXT,
  landing_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX moderation_scores_product ON moderation_scores (product_id, product_version, created_at);
