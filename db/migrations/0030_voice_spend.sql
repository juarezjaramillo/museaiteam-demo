CREATE TABLE IF NOT EXISTS voice_spend (
  org_id TEXT NOT NULL,
  month TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, month)
);
