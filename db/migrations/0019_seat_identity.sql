ALTER TABLE seats ADD COLUMN email TEXT;
UPDATE seats SET email = role || '-' || substr(replace(id, '-', ''), 1, 12) || '@hires.museaiteam.com' WHERE email IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_seats_email ON seats(email);

CREATE TABLE IF NOT EXISTS seat_mail (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL DEFAULT '',
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seat_mail_seat ON seat_mail(seat_id, read_at);
