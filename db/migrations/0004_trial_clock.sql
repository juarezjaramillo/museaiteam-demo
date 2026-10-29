-- D1 disallows expression defaults on ADD COLUMN, so new orgs get their
-- window from ensureOrg (the only creation site) and existing rows are
-- backfilled here to a fresh 14-day trial starting now.
ALTER TABLE orgs ADD COLUMN trial_started_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orgs ADD COLUMN trial_ends_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orgs ADD COLUMN grace_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orgs ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 0;
UPDATE orgs
SET trial_started_at = (strftime('%s','now') * 1000),
    trial_ends_at = (strftime('%s','now') * 1000 + 1209600000)
WHERE trial_started_at = 0;
