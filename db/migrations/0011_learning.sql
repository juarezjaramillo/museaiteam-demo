-- Learning loop: artifact ratings distill into playbook tactics.
CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  action_id TEXT NOT NULL REFERENCES actions(id),
  rater_user_id TEXT NOT NULL REFERENCES users(id),
  thumb TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  distilled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (action_id, rater_user_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_org ON ratings(org_id);
CREATE INDEX IF NOT EXISTS idx_ratings_run ON ratings(run_id);

CREATE TABLE IF NOT EXISTS playbook_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  system TEXT NOT NULL DEFAULT '',
  tactic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_playbook_org ON playbook_entries(org_id, status);

CREATE TABLE IF NOT EXISTS job_markers (
  job TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
