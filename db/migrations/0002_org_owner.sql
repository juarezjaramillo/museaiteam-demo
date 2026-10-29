ALTER TABLE orgs ADD COLUMN owner_user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_orgs_owner ON orgs(owner_user_id);
