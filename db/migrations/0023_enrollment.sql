-- Enrollment: one-shot milestones per seat (session_one) and re-nudge
-- tracking for unapproved seat asks.
CREATE TABLE IF NOT EXISTS seat_milestones (
  seat_id TEXT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  milestone TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (seat_id, milestone)
);

ALTER TABLE seat_requests ADD COLUMN nudged_at TEXT;
