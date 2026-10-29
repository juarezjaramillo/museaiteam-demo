CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id);

-- One seat per role per team: duplicate-role squads are unrepresentable.
CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  role TEXT NOT NULL,
  hired INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (team_id, role)
);
CREATE INDEX IF NOT EXISTS idx_seats_team ON seats(team_id);

ALTER TABLE runs ADD COLUMN team_id TEXT REFERENCES teams(id);

-- Backfill: every org gets Team 1 with the classic approved quartet, and
-- existing runs are homed to it.
INSERT INTO teams (id, org_id, name)
SELECT 'team1-' || id, id, 'Team 1' FROM orgs;
INSERT INTO seats (id, team_id, role, hired, approved)
SELECT 'seat-' || t.id || '-pm', t.id, 'pm', 1, 1 FROM teams t;
INSERT INTO seats (id, team_id, role, hired, approved)
SELECT 'seat-' || t.id || '-marketer', t.id, 'marketer', 1, 1 FROM teams t;
INSERT INTO seats (id, team_id, role, hired, approved)
SELECT 'seat-' || t.id || '-engineer', t.id, 'engineer', 1, 1 FROM teams t;
INSERT INTO seats (id, team_id, role, hired, approved)
SELECT 'seat-' || t.id || '-analyst', t.id, 'analyst', 1, 1 FROM teams t;
UPDATE runs SET team_id = (
  SELECT id FROM teams WHERE teams.org_id = runs.org_id LIMIT 1
);
