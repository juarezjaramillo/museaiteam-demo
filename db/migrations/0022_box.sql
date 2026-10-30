-- Box state + metering. One box per seat; runs record raw seconds and
-- cost is computed at read time so rate changes never rewrite history.
CREATE TABLE IF NOT EXISTS box_state (
  seat_id TEXT PRIMARY KEY REFERENCES seats(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  status TEXT NOT NULL DEFAULT 'sleeping',
  woken_at INTEGER NOT NULL DEFAULT 0,
  last_tick INTEGER NOT NULL DEFAULT 0,
  wake_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_box_state_org ON box_state(org_id, status);

CREATE TABLE IF NOT EXISTS box_runs (
  id TEXT PRIMARY KEY,
  seat_id TEXT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  started_at INTEGER NOT NULL,
  stopped_at INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,
  instance_type TEXT NOT NULL DEFAULT 'basic',
  woken_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_box_runs_org ON box_runs(org_id, started_at);
CREATE INDEX IF NOT EXISTS idx_box_runs_seat ON box_runs(seat_id, started_at);

ALTER TABLE orgs ADD COLUMN box_max_concurrent INTEGER NOT NULL DEFAULT 3;
ALTER TABLE mcp_servers ADD COLUMN box_argv TEXT NOT NULL DEFAULT '';
ALTER TABLE seat_provisions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
