-- Offboarding + cutover: frozen inboxes and the per-hire cutover flag.
ALTER TABLE seats ADD COLUMN frozen_at TEXT;
ALTER TABLE orgs ADD COLUMN seat_cutover INTEGER NOT NULL DEFAULT 0;
