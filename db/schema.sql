-- MuseAITeam D1 schema (SQLite). Applies to local + remote:
-- wrangler d1 execute museaiteam --local --file=db/schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  trial_started_at INTEGER NOT NULL DEFAULT 0,
  trial_ends_at INTEGER NOT NULL DEFAULT 0,
  grace_used INTEGER NOT NULL DEFAULT 0,
  subscribed INTEGER NOT NULL DEFAULT 0,
  sub_status TEXT NOT NULL DEFAULT 'none',
  idea_allowance_words INTEGER NOT NULL DEFAULT 250000,
  proposal_grace_hours INTEGER NOT NULL DEFAULT 72,
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  mcp_server_id TEXT REFERENCES mcp_servers(id),
  mcp_tool TEXT,
  mcp_args TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_pre
  ON approvals(run_id) WHERE kind = 'pre' AND status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_post
  ON approvals(run_id, action_id) WHERE kind = 'post' AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approvals_org ON approvals(org_id, status);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  action_id TEXT NOT NULL REFERENCES actions(id),
  rater_user_id TEXT NOT NULL REFERENCES users(id),
  thumb TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  distilled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (action_id, rater_user_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_org ON ratings(org_id);
CREATE INDEX IF NOT EXISTS idx_ratings_run ON ratings(run_id);

CREATE TABLE IF NOT EXISTS playbook_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  system TEXT NOT NULL DEFAULT '',
  tactic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_playbook_org ON playbook_entries(org_id, status);

CREATE TABLE IF NOT EXISTS job_markers (
  job TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  goal TEXT NOT NULL,
  metric_name TEXT,
  metric_baseline REAL,
  metric_target REAL,
  timebox_days INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  team_id TEXT REFERENCES teams(id),
  goal_id TEXT REFERENCES goals(id),
  kind TEXT NOT NULL DEFAULT 'work',
  parent_run_id TEXT REFERENCES runs(id),
  kill_flag INTEGER NOT NULL DEFAULT 0,
  vote_window_ms INTEGER NOT NULL DEFAULT 300000,
  lineup TEXT NOT NULL DEFAULT '[]',
  brief_note TEXT NOT NULL DEFAULT '',
  rounds_used INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  digest_sent INTEGER NOT NULL DEFAULT 0,
  self_critique TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id);

CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  role TEXT NOT NULL,
  email TEXT,
  hired INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (team_id, role)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seats_email ON seats(email);

CREATE TABLE IF NOT EXISTS seat_mail (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  seat_id TEXT NOT NULL REFERENCES seats(id),
  message_id TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL DEFAULT '',
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seat_mail_seat ON seat_mail(seat_id, read_at);
CREATE INDEX IF NOT EXISTS idx_seats_team ON seats(team_id);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  team_id TEXT REFERENCES teams(id),
  title TEXT NOT NULL,
  metric_name TEXT,
  metric_source TEXT,
  metric_baseline REAL,
  metric_target REAL,
  deadline TEXT,
  schedule TEXT NOT NULL DEFAULT 'manual',
  approval_mode TEXT NOT NULL DEFAULT 'posthoc',
  status TEXT NOT NULL DEFAULT 'active',
  squad TEXT NOT NULL DEFAULT '[]',
  external_refs TEXT NOT NULL DEFAULT '{}',
  last_check_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goals_org ON goals(org_id);

CREATE TABLE IF NOT EXISTS goal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goal_events_goal ON goal_events(goal_id);

CREATE TABLE IF NOT EXISTS metric_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  value REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'entry'
);
CREATE INDEX IF NOT EXISTS idx_metric_points_goal ON metric_points(goal_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_org ON notifications(org_id);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_role TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  artifact_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_run ON proposals(run_id);

CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  agent_role TEXT NOT NULL,
  choice TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_votes_run ON votes(run_id);

CREATE TABLE IF NOT EXISTS rulings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rulings_run ON rulings(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS rulings_run_attempt ON rulings(run_id, attempt);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  revert_payload TEXT,
  proof TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_actions_run ON actions(run_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  r2_key TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);

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

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(id),
  org_id TEXT REFERENCES orgs(id),
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  provider TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, provider)
);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_config (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  provider TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, provider)
);

CREATE TABLE IF NOT EXISTS guardrails (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  worker_role TEXT NOT NULL,
  systems TEXT NOT NULL DEFAULT '[]',
  write_scope TEXT NOT NULL DEFAULT '[]',
  spend_cap_cents INTEGER NOT NULL DEFAULT 0,
  escalate_on TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, worker_role)
);

-- Auth.js (D1 adapter) tables
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  emailVerified TEXT,
  image TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  providerAccountId TEXT NOT NULL,
  refresh_token TEXT,
  access_token TEXT,
  expires_at INTEGER,
  token_type TEXT,
  scope TEXT,
  id_token TEXT,
  session_state TEXT,
  oauth_token_secret TEXT DEFAULT NULL,
  oauth_token TEXT DEFAULT NULL,
  UNIQUE (provider, providerAccountId)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT,
  sessionToken TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_tokens (
  identifier TEXT NOT NULL,
  token TEXT NOT NULL,
  expires TIMESTAMP NOT NULL,
  PRIMARY KEY (identifier, token)
);

CREATE TABLE IF NOT EXISTS sandbox_ips (
  ip TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);

CREATE TABLE IF NOT EXISTS slack_seen_events (
  event_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proposals_out (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  kind TEXT NOT NULL,
  goal_id TEXT REFERENCES goals(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed',
  remind_at TEXT NOT NULL,
  start_at TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_out_org ON proposals_out(org_id, status);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_org ON feedback(org_id);

CREATE TABLE IF NOT EXISTS idea_spend (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  night TEXT NOT NULL,
  words INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, night)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  auth TEXT NOT NULL DEFAULT 'none',
  auth_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'founder',
  status TEXT NOT NULL DEFAULT 'pending',
  spend_cap_cents INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, url)
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_org ON mcp_servers(org_id);

CREATE TABLE IF NOT EXISTS mcp_credentials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  server_id TEXT NOT NULL REFERENCES mcp_servers(id),
  label TEXT NOT NULL DEFAULT '',
  secret_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, server_id)
);

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  server_id TEXT PRIMARY KEY REFERENCES mcp_servers(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  client_id TEXT NOT NULL DEFAULT '',
  client_secret_enc TEXT,
  authorization_endpoint TEXT NOT NULL DEFAULT '',
  token_endpoint TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  code_verifier TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS peer_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  round INTEGER NOT NULL DEFAULT 1,
  reviewer TEXT NOT NULL,
  verdict TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  metric_touched TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL DEFAULT 'ok',
  revision_run_id TEXT REFERENCES runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, round)
);

CREATE TABLE IF NOT EXISTS seat_credentials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  seat_id TEXT NOT NULL REFERENCES seats(id),
  tool TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'token',
  login_user TEXT NOT NULL DEFAULT '',
  secret_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(seat_id, tool)
);
CREATE INDEX IF NOT EXISTS idx_seat_cred_seat ON seat_credentials(seat_id);

CREATE TABLE IF NOT EXISTS seat_tools (
  seat_id TEXT NOT NULL REFERENCES seats(id),
  mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (seat_id, mcp_server_id)
);
CREATE TABLE IF NOT EXISTS org_seat_map (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  role TEXT NOT NULL,
  tools_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (org_id, role)
);

CREATE TABLE IF NOT EXISTS tool_admin_grants (
  org_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  secret_enc TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'granted',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, tool)
);

CREATE TABLE IF NOT EXISTS seat_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  tools_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'proposed',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seat_req_seat ON seat_requests(seat_id, status);

CREATE TABLE IF NOT EXISTS seat_provisions (
  seat_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  step TEXT NOT NULL DEFAULT 'invite',
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (seat_id, tool)
);

