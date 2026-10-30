CREATE TABLE IF NOT EXISTS seat_credentials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'token',
  login_user TEXT NOT NULL DEFAULT '',
  secret_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(seat_id, tool)
);
CREATE INDEX IF NOT EXISTS idx_seat_cred_seat ON seat_credentials(seat_id);

CREATE TABLE IF NOT EXISTS seat_tools (
  seat_id TEXT NOT NULL,
  mcp_server_id TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (seat_id, mcp_server_id)
);
