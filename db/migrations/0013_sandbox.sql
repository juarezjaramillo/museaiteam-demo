-- Sandbox sample runs: IP throttle + ownerless org.
CREATE TABLE IF NOT EXISTS sandbox_ips (
  ip TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);

-- The sandbox org holds sample runs. No owner, no trial, no billing.
INSERT OR IGNORE INTO orgs (id, name, owner_user_id, trial_started_at, trial_ends_at)
VALUES ('sandbox', 'Sandbox', NULL, 0, 0);
