CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  server_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT NOT NULL DEFAULT '',
  client_secret_enc TEXT,
  authorization_endpoint TEXT NOT NULL DEFAULT '',
  token_endpoint TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  code_verifier TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

ALTER TABLE mcp_credentials ADD COLUMN refresh_token_enc TEXT;
ALTER TABLE mcp_credentials ADD COLUMN expires_at TEXT;
