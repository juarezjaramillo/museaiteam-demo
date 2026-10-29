# Runbook: failed run

## Symptom

`run.failed` notification, or a session stuck in failed in Progress.

## Diagnose

```sql
SELECT detail FROM audit_log
WHERE run_id = 'RUN' AND event = 'run.failed'
ORDER BY rowid DESC LIMIT 1;
```

Common causes in order: expired provider token (see expired-token.md),
Spark outage/overload (`Meta API` errors), guardrail misconfiguration,
a provider API change (new error strings from Linear/HubSpot/etc).

Also check liveness state:

```sql
SELECT status, kill_flag, rounds_used FROM runs WHERE id = 'RUN';
```

## Fix

1. Fix the underlying cause (usually reconnect).
2. Tell the owner to start a fresh session; failed runs never auto-retry
   (by design — retries could double-ship).
3. If the failure is a product bug: file it, link the run id, and say so
   on the status page if other orgs are affected.

## Escalate

5+ failed runs in an hour triggers the fail-rate alert automatically —
treat that as a partial outage, not a ticket.
