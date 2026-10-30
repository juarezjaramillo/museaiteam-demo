# Seat cutover runbook: one login per hire

Moves an org from shared logins to per-hire seats, then flips the
cutover so hire paths read seat credentials only. Rollback window:
7 days from the flip (restore the pre-cut snapshot).

## 1. Snapshot (before anything)

```bash
cd apps/api
export CLOUDFLARE_API_TOKEN=$(cat ~/.config/museaiteam/cf-api-token)
npx wrangler d1 export museaiteam --remote --output=/tmp/pre-cut-<org>-<date>.sql
```

Keep the file 7 days past the flip.

## 2. Guided migration (owner, Hires page)

1. Open Hires → "One login per hire" → **Move hires to own logins**.
   Every hire gets its seat asks from the map; dead shared links
   retire on the spot.
2. Approve each hire (**Approve all**): seats the hire and releases
   its asks into provisioning.
3. For providers: connect **as the hire** — Setup connect links accept
   `?seat=<id>`, or paste a session on the Hires page ( Relay → Save
   login ). The grant vaults under the seat as kind `oauth`.
4. Watch each hire's keystone go ready; session one starts by itself.

## 3. Flip (owner, Hires page)

**Flip the switch** succeeds only when no retirable shared rows
remain (Slack stays by design: inbound events need the workspace
token). After the flip:

- hire reads are seat → nothing (no org fallback);
- new org rows are rejected (`OrgRetired`) with the per-hire path;
- each verified seat retires its org row automatically.

## 4. Rollback (7-day window)

```bash
# Restore the snapshot to a scratch database, verify, then swap:
npx wrangler d1 create museaiteam-rollback
npx wrangler d1 execute museaiteam-rollback --remote \
  --file=/tmp/pre-cut-<org>-<date>.sql
# Point the worker at the restored db (wrangler.toml database_id),
# redeploy, then delete the bad database.
```

Also reset the flag if the schema survived but the flip was wrong:

```sql
UPDATE orgs SET seat_cutover = 0 WHERE id = '<org>';
```

## 5. Offboarding (owner, Hires page)

**Offboard** on a hire: vendor revokes attempted (GitHub org removal
when the username + admin grant + org are known), logins wiped, desk
destroyed, inbox frozen 90 days, handoff session started, and anything
left over listed as tasks in the founder note. Frozen seats purge
automatically after 90 days (mail, logins, provisions, meter rows).
