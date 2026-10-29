# Runbook: rotate TOKEN_ENC_KEY

Zero-downtime rotation with automatic rewrap. Reads try the current
key, then the previous key; rows still on the previous key are
re-encrypted to the current key on read.

## Steps

1. Generate the new key (32 bytes hex, 64 chars):
   `openssl rand -hex 32` — keep it in `~/.config/museaiteam/` (600),
   never in chat or the repo.
2. Back up the current key as previous (proves the dual-read path):
   `wrangler secret put TOKEN_ENC_KEY_PREV` (paste the CURRENT key value).
   Deploy is automatic on secret change; wait 1 minute.
3. Confirm reads still work: open the dashboard, run any session read
   (`GET /api/orgs/:org/connections` should stay all-true).
4. Promote: `wrangler secret put TOKEN_ENC_KEY` (paste NEW key value).
   Wait 1 minute; reads now decrypt with new, fall back to previous.
5. Wait 7 days (covers weekly cron + long goals touching every token),
   or force rewrap now: for each provider with a token, any `loadToken`
   call rewraps — trigger via Connections refresh per org.
6. Remove the previous key: `wrangler secret delete TOKEN_ENC_KEY_PREV`.
7. Confirm: `wrangler secret list` shows only TOKEN_ENC_KEY; dashboard
   reads green; no `token decrypt failed` in audit_log:
   `SELECT COUNT(*) FROM audit_log WHERE event = 'error.route'`.

## Rollback

If step 4 breaks reads: `wrangler secret put TOKEN_ENC_KEY` with the
previous value back. Dual-read means either order is safe while both
secrets exist — the only bad state is NEITHER key matching a row,
which step 2→4 ordering makes unreachable.
