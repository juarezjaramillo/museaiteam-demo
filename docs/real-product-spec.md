# Real product spec (v1)

From the product interview (marketing site, dashboard, real work, learning,
seats) plus the run-semantics interview (goals as containers, runs as
sessions). Builds on the live system. Ordered; each section lands tested,
typed, and deployed before the next starts. Schema changes ship as
`db/migrations/NNNN_*.sql`, applied local + remote.

Conventions from the trial build still hold: pure logic in
`packages/shared` with node-runner tests, conditional-UPDATE claims for
exactly-once effects, fail-closed skips with reasons, no ceremony.

## Glossary (settled)

- **Goal**: long-lived container — owning team, metric + baseline/target,
  deadline, schedule preset, approval mode, status. Persists weeks.
- **Run**: one work session inside a goal — debates, ships (or logs a
  monitoring outcome), writes a summary to goal history, ends.
- **Check**: lightweight scheduled tick — pull metrics, manager decides
  full run vs `monitoring, no action`. Metered at actuals (cheap).
- **Squad**: goal's hires, picked once, frozen unless the founder re-staffs.
- **Revision**: child run that re-ships a corrected artifact.

## 1. Goals core

- `goals` (org, team, title, metric_name/source, baseline, target,
  deadline, schedule preset, approval mode, status, squad JSON);
  `goal_events` (goal history timeline); `metric_points` (goal, ts,
  value, source pull|entry); runs gain `goal_id`, `kind`
  (work|check|revision), `parent_run_id`.
- Goal CRUD + status (active/paused/overdue/done); founder marks done,
  dashboard suggests when target met; deadline passing flips overdue,
  keeps working, notifies (see §7).
- Schedule presets: daily / weekdays / weekly pick-a-day; toggle on
  any goal. Cron worker starts a check each tick.
- Existing standalone runs keep working: run creation without a goal
  auto-creates a one-shot goal wrapper (no orphan runs, no UI fork).
- Accept: goal with deadline + schedule runs weekly checks alone;
  history shows every run summary + metric point; overdue flags,
  notifies, keeps working.

## 2. Staffing, locks, queue

- Squad picked once at goal creation from approved roster (existing
  pick when >7); stored on goal; re-staff button re-picks on demand.
- Hire lock: a hire in an active run can't join another; runs whose
  squadmate is busy wait in `queued` state, visible in history.
- Same system from parallel runs allowed (branches/tickets differ);
  last write wins, audit shows all.
- Accept: two goals sharing a hire serialize visibly (queued → live);
  re-staff swaps mid-goal squads; no hire ever double-booked.

## 3. Approvals + revisions

- Per-goal mode, default post-hoc. Pre-approve goals pause after the
  ruling; any approver (owner/approver seat) approves or rejects.
- Reject sends the plan back: manager re-rules with the note attached,
  asks again (bounded: 3 resubmits, then run fails visibly).
- Post-hoc: approve each artifact or request changes → revision child
  run re-ships; history shows the chain.
- Accept: pre-approve run pauses, resumes on approve, re-rules on
  reject; revision run links to its parent; unauthenticated or
  viewer-role approvals 403.

## 4. Dashboard (real)

- Goals list + goal page (timeline, metric chart from points, squad,
  schedule, approval mode, runs).
- Run history across goals with filters (goal, status, hire).
- Hire profiles: activity, artifacts shipped, ratings, token spend.
- Playbook tab: system-drafted entries from ratings (§6) to edit/veto.
- Notifications list (see §7) + seat management (see §7).
- Accept: a founder can assign, watch, approve, correct, and re-staff
  without touching D1 or wrangler; every number on screen traces to
  a stored row.

## 5. Metric pulls

- Fixed pull catalog (exact queries validated against each API at
  build time): Shopify orders/revenue/checkouts, HubSpot open tickets
  (+ reply stats if the API allows), GitHub PR counts, Linear issue
  flow, Slack message volume, Notion pages created.
- Playbook presets map metric → catalog entry; founder can change per
  goal or fall back to manual entry (required for off-system metrics
  like activation rate).
- Pulls run inside checks; failures record `metric.pull_failed` with
  reason and never fail the check.
- Scope upgrades where pulls need them (Shopify read_*, Slack history,
  etc.) + reconnect; documented in the setup UI per provider.
- Accept: each catalog entry returns a real number on a connected
  org; failures degrade to manual entry with a visible reason.

## 6. Work depth package

One slice per system, each proved with a real artifact + revert:

- GitHub: read repo context → branch → real code diff → mergeable PR.
- Linear: full lifecycle — create, progress updates, close, sub-tasks.
- Slack: threaded updates, replies, scheduled channel digests.
- Shopify: scheduled/targeted discounts + product copy updates.
- HubSpot: priority/status updates + follow-ups through resolution
  (note-first, content fallback stays).
- Notion: decision database with linked follow-up pages per run.
- Bar: artifacts a founder would merge/publish as-is with light review.
- Accept: each slice ships one real artifact and reverts it cleanly;
  guardrail write scopes extended per new write kind.

## 7. Learning loop

- Thumbs + optional note on every artifact (run view + hire profile).
- System distills ratings into playbook draft entries nightly (cron);
  founder edits/vetoes in the playbook tab; squad prompt reads the
  approved playbook every run (replay-safe: sorted entries).
- Accept: a vetoed tactic stops appearing; an approved entry appears
  in the next run's squad prompt (visible in a debug view or audit).

## 8. Seats, notifications, extras

- Human seats: owner (billing + everything), approver
  (approve/correct/assign), viewer (watch). Email invites via
  magic-link; first user is owner.
- Notifications: email + in-app list for approvals requested,
  decisions, completions, overdue flags, revision requests.
- Extras: 80%-of-fair-use email alert; one-click audit-log CSV export.
- Accept: invite → new login with correct permissions enforced on
  every route (viewer 403s on mutations); every notifiable event
  produces both an email and a list entry.

## 9. Marketing site (single page, Hormozi rules)

- One page, approved order: hero (offer + guarantee + sample CTA) →
  interactive sandbox sample run → three vertical replays
  (SaaS/ecom/SMB, replay + metric story each) → how-it-works →
  pricing stack anchored vs human hire → FAQ + final CTA.
- Offer: $499/worker/mo, first goal free with artifacts kept, cancel
  anytime. Starving-crowdverticals feed the sample-run presets.
- Sandbox sample: no signup, no external writes — live debate plus
  would-have-done list; rate-limited by IP; converts to signup.
- Accept: cold visitor reaches a running sample in under a minute;
  every claim on the page traces to a live behavior; Lighthouse-clean
  static delivery from the worker.

## 10. Rehearsal + demo refresh

- Full founder pass on video: signup → goal → weeks of checks (time
  compressed) → approval → revision → hire profile → billing.
- Demo script updated to the real-product arc; backup video recorded.
- Accept: one clean video exists; trial + real-product trains both run
  green (63+ tests, typecheck, migrations local + remote).
