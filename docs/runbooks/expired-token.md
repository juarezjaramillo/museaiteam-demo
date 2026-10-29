# Runbook: expired provider token

## Symptom

Runs fail at act time with `<provider> token expired — reconnect`,
or Setup shows a connection as broken.

## Diagnose

Which org + provider (replace ORG):

```sql
SELECT provider, expires_at, updated_at FROM oauth_tokens
WHERE org_id = 'ORG';
```

Recent failures:

```sql
SELECT created_at, detail FROM audit_log
WHERE event = 'run.failed' ORDER BY rowid DESC LIMIT 5;
```

## Fix

1. Ask the owner to open Setup → Connections → reconnect that provider
   (owner-only by design; support cannot connect on their behalf).
2. Confirm the new row: `updated_at` is fresh and `expires_at` is null
   or future.
3. Re-run or wait for the next scheduled session; no manual replay needed.

## Escalate

If reconnect loops (token dies within hours): the provider app's refresh
grant is broken — check the OAuth app settings, then rotate the app
secret.
