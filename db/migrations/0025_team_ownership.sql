ALTER TABLE teams ADD COLUMN owner_user_id TEXT REFERENCES users(id);

CREATE TABLE IF NOT EXISTS team_briefs (
  team_id TEXT NOT NULL REFERENCES teams(id),
  day TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, day)
);
CREATE INDEX IF NOT EXISTS idx_team_briefs_day ON team_briefs(day);
