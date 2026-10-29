# Runbook: suspected abuse

## Symptom

Word-budget burn with no customer value, 429 spikes, weird signup bursts,
sandbox farming from one IP range.

## Diagnose

- Rate-limit hits are silent by design; check volume instead:

```sql
SELECT COUNT(*) FROM runs
WHERE datetime(created_at) > datetime('now', '-1 hour');
```

```sql
SELECT ip, day, count FROM sandbox_ips ORDER BY count DESC LIMIT 10;
```

- One org burning: `SELECT org_id, COUNT(*) FROM runs
  WHERE datetime(created_at) > datetime('now', '-1 day')
  GROUP BY org_id ORDER BY 2 DESC LIMIT 5;`

## Fix

1. Kill live runs for the abusive org (dashboard Stop or the kill route).
2. Tighten: lower that org's fair-use band or set
   `idea_allowance_words = 0` to freeze unassigned spend.
3. If it is a stranger trial: expire the trial
   (`trial_ends_at` to yesterday) and audit why.
4. Block an IP range only at the Cloudflare edge (rule, never code).

## Escalate

Coordinated abuse (many orgs, one pattern) or anything touching another
customer's data: treat as a security incident — founder immediately,
then the key-rotation and scope runbooks.
