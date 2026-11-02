# Teams spec: one founder, many employee-teams, one shared pool

Every interview decision in one place. Today one org has teams of
hires and one founder watching. After this, each human employee gets
their own AI team from the founder's shared bench: the employee
briefs in the morning and reviews at night, the founder sees
everything, and hires collaborate across teams with the manager AI
arbitrating. Non-engineers first; support is the wedge.

## 0. Settled decisions (from interviews)

- Buyer: the founder pulls out the credit card. Employees are the
  daily users; the founder is the customer.
- Superpower: work done autonomously — no new human hires, no one
  sitting there driving an assistant at 11pm.
- Human in the loop at the beginning and the end first (brief +
  review); eventually sometimes fully out.
- Founder sees everything: every team, session, draft, decision.
- Wedge: non-engineers. Support first: every ticket answered in
  minutes, 24/7, in the customer's language.
- Employee pitch: "Your AI team handles even the complex parts,
  overnight." The human stays the approver.
- Seats multiply: each team bills its hires. Price per hire falls as
  hires grow, to a floor (proposed tiers in §5).
- Shared pool: hires are not split per team; they are assigned from
  the bench and can collaborate across teams.
- Manager AI arbitrates across teams when needed.
- Everything may change: startup product, no sacred design.

## 1. Team model (evolves today's teams)

- `teams` gains `owner_user_id` (nullable FK to users): the human
  employee the team serves. `NULL` = the founder's bench
  (unassigned hires wait here; the founder's own team).
- One team per employee is the shape, not a rule: the founder may
  run several teams, or none, from the bench.
- Seats keep single-team assignment (existing `seats.team_id`):
  assignment IS the team. Moving a hire between teams is one
  reassignment, immediate, logged.
- Goals already carry `team_id`: a team's work is its goals'
  sessions. No goal may float without a team.
- UNIQUE(team_id, role) stays: one PM per team, etc.

## 2. Brief + review ritual (the core loop)

- One screen per team per day, two halves:
  - **Overnight review:** what the team did since the last review
    (sessions, results, drafts waiting), each approvable inline.
  - **Today's brief:** free text from the reviewer ("today matters:
    the Acme tickets and the refund queue"). Stored per team per
    day in `team_briefs` (team_id, day, text, reviewed_at).
- The brief feeds the next sessions' context (like today's goal
  text does); the review marks the day reviewed.
- Reviewer = the team's owner employee; the founder may review any
  team. Unreviewed teams show plainly in oversight (§4).
- No separate evening step in v1: morning review + today's brief in
  one screen is the whole ritual. Fewer steps win.

## 3. Collaboration + manager arbitration (v1)

- Session staffing may borrow hires from other teams (the manager's
  existing which-seats judgment, extended across the pool).
- Every borrow is logged on the run and notified once to the
  founder: "Morgan borrowed Priya (AI) for Sam's team tonight."
- True conflict arbitration (two teams, one hire, same night) is a
  manager ruling, recorded like session rulings and visible in
  oversight. No new UI in v1 beyond the log line.
- Hires never split attention inside one session: one seat, one
  session at a time (today's invariant, unchanged).

## 4. Oversight (founder sees everything)

- Already true and unchanged: Home, Progress, Approvals, Hires,
  Alerts stay org-wide for the owner.
- New: Teams view — every team, its owner, its hires, last review
  state (reviewed / waiting / never), tonight's plan.
- Visibility default (confirm): members see only teams they own;
  owner sees all. Enforcement at the query layer, not the UI.

## 5. Pricing: cheaper per hire, to a floor (proposed)

- Monthly = hired seats × tier price, tiered by total hired seats:
  1–2 $499 · 3–5 $449 · 6–10 $399 · 11–20 $349 · 21+ $299.
  The $299 floor is the cap. Numbers are proposed, tiers are the
  design: one pure function `hirePrice(seats)` in shared, used by
  checkout, meter, and Billing page alike.
- Trial stays 14 days + grace; trial still blocks paid seats.
- Existing subscribers move to tiers on next invoice (startup,
  few customers — no grandfathering machinery).

## 6. Support wedge: first template

- Support brief template in shared, prefilled when a team's brief
  is empty: tonight's queue, VIPs, anything sensitive to hold.
- First-reply time is the template's metric (manual entry until a
  helpdesk pull exists in the catalog).
- Template is text + metric suggestion only. No support-only code
  paths: it must work through §2 like every team.

## 7. Migration

- Existing teams get `owner_user_id = NULL`: everything the founder
  has today becomes the founder's bench, zero behavior change.
- Founder assigns teams to members from the new Teams view.
- Billing math switches to §5 tiers; seats counted as today
  (hired = 1).
- No data migration beyond the new nullable column + new tables.

## 8. Effects on today's code

- `db/migrations/0025_teams.sql`: teams.owner_user_id,
  team_briefs table.
- `packages/shared/src/billing.ts`: `hirePrice(seats)` tiers;
  `packages/shared/src/briefs.ts` (new): support template.
- `apps/api/src/teams.ts`: assign team to member, move seat between
  teams, per-team review payload (overnight results + pending +
  brief get/put + mark reviewed).
- `apps/api/src/staffing.ts`: borrow across teams + borrow log
  lines; `workflow.ts`: brief text into session context.
- `apps/api/src/index.ts`: query scoping by team ownership for
  non-owners (members see own teams only).
- `apps/web`: Teams view (new), per-team Review screen (new),
  Billing tier math, Setup Team step gains owner picker.
- Tests: tier math pinned; ownership scoping pinned; brief round
  trip pinned.

## Build order

- A. Ownership + assignment: column, assign/move endpoints,
  Teams view, Setup owner picker.
- B. Review ritual: briefs table, review payload, Review screen,
  review states in Teams view.
- C. Pricing tiers: `hirePrice`, checkout + meter + Billing page.
- D. Borrowing: staffing across teams + log + notify.
- E. Support template + member scoping enforcement.

## Non-goals (v1)

- Conflict-arbitration UI beyond the log line.
- Helpdesk metric pulls (template uses manual entry).
- Employee-to-employee messaging, permissions beyond owner/own.
- Grandfathered pricing, per-team billing splits (one invoice).

## Open confirmations (defaults in this spec)

1. Members see only their own teams; owner sees all. (§4)
2. Tier numbers in §5 (design fixed, numbers proposed).
3. Existing subscribers move to tiers immediately. (§5)
