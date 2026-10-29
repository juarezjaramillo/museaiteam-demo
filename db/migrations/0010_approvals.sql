-- Approvals + revisions: human members with roles, pre-approve gates,
-- post-hoc artifact calls, idempotent ruling attempts, revision briefs.
CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  goal_id TEXT REFERENCES goals(id),
  kind TEXT NOT NULL,
  action_id TEXT REFERENCES actions(id),
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  resubmits INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  revision_run_id TEXT REFERENCES runs(id),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_pre
  ON approvals(run_id) WHERE kind = 'pre' AND status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_post
  ON approvals(run_id, action_id) WHERE kind = 'post' AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approvals_org ON approvals(org_id, status);

ALTER TABLE rulings ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS rulings_run_attempt ON rulings(run_id, attempt);

ALTER TABLE runs ADD COLUMN brief_note TEXT NOT NULL DEFAULT '';

INSERT INTO org_members (org_id, user_id, role)
  SELECT id, owner_user_id, 'owner' FROM orgs WHERE owner_user_id IS NOT NULL
  ON CONFLICT(org_id, user_id) DO NOTHING;
