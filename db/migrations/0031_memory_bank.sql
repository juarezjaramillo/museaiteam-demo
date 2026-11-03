CREATE TABLE IF NOT EXISTS company_profile (
  org_id TEXT PRIMARY KEY,
  icp TEXT NOT NULL DEFAULT '',
  offering TEXT NOT NULL DEFAULT '',
  customer_count TEXT NOT NULL DEFAULT '',
  employee_count TEXT NOT NULL DEFAULT '',
  help_center TEXT NOT NULL DEFAULT '',
  pricing TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  competitors TEXT NOT NULL DEFAULT '',
  complaint_themes TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT NOT NULL DEFAULT 'system'
);
CREATE TABLE IF NOT EXISTS memory_gather_state (
  org_id TEXT NOT NULL,
  source TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  chunks INTEGER NOT NULL DEFAULT 0,
  gathered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, source)
);
ALTER TABLE orgs ADD COLUMN website_url TEXT NOT NULL DEFAULT '';
