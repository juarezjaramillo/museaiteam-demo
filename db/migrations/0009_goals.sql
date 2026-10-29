-- Goals as containers; runs as sessions inside them.
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  team_id TEXT REFERENCES teams(id),
  title TEXT NOT NULL,
  metric_name TEXT,
  metric_source TEXT,
  metric_baseline REAL,
  metric_target REAL,
  deadline TEXT,
  schedule TEXT NOT NULL DEFAULT 'manual',
  approval_mode TEXT NOT NULL DEFAULT 'posthoc',
  status TEXT NOT NULL DEFAULT 'active',
  squad TEXT NOT NULL DEFAULT '[]',
  external_refs TEXT NOT NULL DEFAULT '{}',
  last_check_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goals_org ON goals(org_id);

CREATE TABLE IF NOT EXISTS goal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goal_events_goal ON goal_events(goal_id);

CREATE TABLE IF NOT EXISTS metric_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  value REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'entry'
);
CREATE INDEX IF NOT EXISTS idx_metric_points_goal ON metric_points(goal_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_org ON notifications(org_id);

ALTER TABLE runs ADD COLUMN goal_id TEXT REFERENCES goals(id);
ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id);
CREATE INDEX IF NOT EXISTS idx_runs_goal ON runs(goal_id);
