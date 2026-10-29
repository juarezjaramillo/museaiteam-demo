-- Human seats: email invites with roles; audit rows gain org scope
-- (backfilled for run-linked rows) for the per-org CSV export.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  accepted INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(org_id);
CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);

ALTER TABLE audit_log ADD COLUMN org_id TEXT REFERENCES orgs(id);
UPDATE audit_log SET org_id = (SELECT org_id FROM runs WHERE runs.id = audit_log.run_id)
  WHERE run_id IS NOT NULL;
