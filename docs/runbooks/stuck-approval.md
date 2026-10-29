# Runbook: stuck approval

## Symptom

A session sits in `awaiting_approval` and nobody can move it, or
Approve returns an error.

## Diagnose

```sql
SELECT id, kind, status, attempt, resubmits FROM approvals
WHERE run_id = 'RUN' ORDER BY rowid;
```

- No `pre` row: the run never gated — check `runs.status` (it may have
  moved on already).
- `resubmits >= 3` with status pending: the cap path failed to settle —
  check for `approval.capped` in audit_log.
- `decidePreApproval` errors in `error.route` audit rows.

## Fix

1. Normal case: an owner/approver clicks Approve/Reject in Approvals —
   most "stuck" reports are role confusion (viewers can't decide).
2. Cap bug: settle by hand — `UPDATE approvals SET status='rejected'
   WHERE id='...'` then flip the run to failed with an audit note.
3. Report the bug with the run id; the sweep unblocks siblings.

## Escalate

If approvals across orgs stop deciding: suspect the workflow binding
(GOAL_RUN) — check /api/status and recent deploys first.
