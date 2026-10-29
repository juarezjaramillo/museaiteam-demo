-- Per-org, per-provider connection settings that are not tokens:
-- Shopify store domain, Notion parent page, etc. Tokens live in oauth_tokens.
CREATE TABLE IF NOT EXISTS provider_config (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  provider TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, provider)
);
