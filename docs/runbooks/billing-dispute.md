# Runbook: billing dispute

## Symptom

"I was charged wrong", "I cancelled but got billed", "the team stopped
but I'm paying".

## Diagnose

```sql
SELECT subscribed, sub_status, stripe_customer_id FROM orgs WHERE id = 'ORG';
SELECT event, created_at FROM audit_log
WHERE event LIKE 'billing%' ORDER BY rowid DESC LIMIT 10;
```

Then open the customer in the Stripe dashboard (test or live matching
the org) and compare: subscription status, invoices, cancels.

## Fix

- Charged after cancel: Stripe is source of truth — refund there if it
  agrees with the customer, then flip `subscribed`/`sub_status` to match
  and audit the manual fix.
- Paid but team stopped: usually `past_due` confusion or trial gate —
  check `trial_ends_at`/`grace_used`, fix the card, confirm a session
  starts.
- Never answer money questions from memory: quote the Stripe invoice id
  back to the customer.

## Escalate

Anything over one month's charge, or suspected fraud: pause the org's
runs (kill live runs), loop in the founder before refunding.
