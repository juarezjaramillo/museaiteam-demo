CREATE TABLE IF NOT EXISTS org_seat_map (
  org_id TEXT NOT NULL,
  role TEXT NOT NULL,
  tools_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (org_id, role)
);

CREATE TABLE IF NOT EXISTS tool_admin_grants (
  org_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  secret_enc TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'granted',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, tool)
);

CREATE TABLE IF NOT EXISTS seat_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  tools_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'proposed',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seat_req_seat ON seat_requests(seat_id, status);

CREATE TABLE IF NOT EXISTS seat_provisions (
  seat_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  step TEXT NOT NULL DEFAULT 'invite',
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (seat_id, tool)
);
