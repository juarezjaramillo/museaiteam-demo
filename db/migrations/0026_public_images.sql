CREATE TABLE IF NOT EXISTS public_images (
  token TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  org_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_public_images_action ON public_images(action_id);
