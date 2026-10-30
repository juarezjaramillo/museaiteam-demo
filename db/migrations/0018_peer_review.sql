CREATE TABLE IF NOT EXISTS peer_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  reviewer TEXT NOT NULL,
  verdict TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  metric_touched TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL DEFAULT 'ok',
  revision_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, round)
);
