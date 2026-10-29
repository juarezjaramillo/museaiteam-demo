CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  auth TEXT NOT NULL DEFAULT 'none',
  auth_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'founder',
  status TEXT NOT NULL DEFAULT 'pending',
  spend_cap_cents INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, url)
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_org ON mcp_servers(org_id);

CREATE TABLE IF NOT EXISTS mcp_credentials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  secret_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, server_id)
);

ALTER TABLE approvals ADD COLUMN mcp_server_id TEXT;
ALTER TABLE approvals ADD COLUMN mcp_tool TEXT;
ALTER TABLE approvals ADD COLUMN mcp_args TEXT;
