ALTER TABLE runs ADD COLUMN self_critique TEXT;
ALTER TABLE actions ADD COLUMN proof TEXT;
ALTER TABLE orgs ADD COLUMN idea_allowance_words INTEGER NOT NULL DEFAULT 250000;
ALTER TABLE orgs ADD COLUMN proposal_grace_hours INTEGER NOT NULL DEFAULT 72;

CREATE TABLE IF NOT EXISTS slack_seen_events (
  event_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proposals_out (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  kind TEXT NOT NULL,
  goal_id TEXT REFERENCES goals(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed',
  remind_at TEXT NOT NULL,
  start_at TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_out_org ON proposals_out(org_id, status);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_org ON feedback(org_id);

CREATE TABLE IF NOT EXISTS idea_spend (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  night TEXT NOT NULL,
  words INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, night)
);
