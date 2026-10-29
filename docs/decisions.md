# Decision record

Grilled in two interview rounds (product, then stack). Settled = locked.
Revisit a branch deliberately, never by accident.

## Product

- **User:** tech businesses; example goal "lift onboarding activation 15%"
- **Output:** autonomous actions (PRs, Linear tickets, Slack posts), not just docs
- **UX:** dashboard; hero screen is the live debate + ruling feed
- **Lineup:** PM + Marketer + Engineer + Analyst; manager proposes roles from
  the goal, user confirms, manager may re-hire mid-run
- **Ruling:** majority vote; manager breaks ties and 5-minute timeouts
- **Metric:** analyst grounds baseline from uploaded data + timebox
- **Moat:** zero-config seniors that grow in persistent org memory; only user
  config is per-worker guardrails (systems, write scope, spend, escalation)
- **Money:** flat fee per AI worker/month under fair usage
- **Proof:** same-model one-shot baseline vs team artifacts + vote log, side by
  side
- **Track:** Startup; solo founder

## Autonomy posture (deliberately bold)

- Full auto + audit log; no approval gates; guardrails enforced per action
  (engineer→GitHub PRs, PM→Linear tickets, marketer→Slack posts), default-open
- Blast radius accepted: real writes, no isolated demo org ("trust the team")
- GitHub runs least-privilege (`public_repo` only, proven sufficient for
  branch + PR writes); the token physically cannot touch private repos
- Nets that ARE in: hard caps (3 debate rounds, cost ceiling, forced ruling),
  D1 kill-flag checked every Workflow step, one-click revert as compensating
  steps, guardrails screen shown wide-open with "prod would tighten this"

## Stack (all Cloudflare, TypeScript)

- Hono API Worker + Vite SPA on Pages; Auth.js + GitHub, D1 sessions
- One Cloudflare Workflow per goal run; steps for propose/vote/rule/act
- Workflow control flow rides on step return values, never caught exception
  types (identities don't survive step retries); a 5-min cron sweeper fails
  orphaned runs visibly instead of leaving them stuck
- D1 normalized tables (`db/schema.sql`); R2 + D1 metadata for artifacts
- Durable Object WebSocket broadcast for the feed (one object per run)
- Central typed Spark client calling the Meta Model API directly
  (`muse-spark-1.3`, OpenAI-compatible); JSON-schema outputs, retries,
  timeouts, metering on total_tokens (reasoning included)
- Org memory: ingest uploads + repo docs on connect, embed with Workers AI
  into Vectorize; incremental writes after each goal; recall over-fetches
  and filters by org in the Worker (server-side metadata filter silently
  matched nothing)
- Per-org integration tokens: encrypted D1 column, key in Worker secret
- Testing: record/replay Spark responses; scripted mocks only for loop tests

## Rejected (why)

- LangGraph/CrewAI: less custom manager logic to show off
- Next.js/OpenNext on CF: adapter edge-case risk for a solo 10-day build
- Supabase/Neon/Inngest: dropped when Cloudflare + D1 was chosen
- AI Gateway in front of Spark: dropped as an unneeded hop; direct calls
  with client-side metering are simpler to debug on demo day
- Paste-tokens auth: fastest, but full OAuth chosen for the Startup story —
  day-3 fallback if OAuth slips
- Sandbox mocks / dry-run toggle / isolated demo org: rejected twice; the
  demo runs live with revert + kill switch as the net
- Fine-tune per org: unshippable in 10 days; memory is retrieval + increments

## Open risks

1. Solo + Workflows + DOs + Vectorize at once — run Workflow + feed first
2. Three OAuth providers on Workers — day-3 fallback to pasted tokens
3. D1 limits at scale — blobs in R2, log rows lean
4. "Grow in org" needs one visible proof (goal 2 reuses goal 1)

## Trial & onboarding (interview 2026-10-27 — Final, accepted)

- Buyer: founder self-serve; entry: open signup
- Gate: connect one integration, but the catalog must span verticals:
  dev tools plus Shopify (ecommerce), HubSpot (CS/CRM), Notion (docs/tasks)
- Setup: 3-step wizard, signup → connect → run, skips allowed
- Offer: 14-day unlimited from signup; countdown banner + hard stop, data kept
- Billing: Stripe test mode, per-worker flat fee ($499), seats founder-picked
- Login: Google + magic-link email via Resend (no GitHub login)
- Sandbox: 3 vertical playbooks (cart abandonment/Shopify, response
  time/HubSpot, onboarding revamp/Notion)
- Unconnected runs take NO external actions; customer is notified instead
  (channel undecided)
- Seats = roster size assumed (open: meter per-goal participants instead?)
- Margin math: Spark $1.25/M in + $4.25/M out ≈ $3.05/M blended on our
  workload; $499 at 80% margin ≈ $100 cost ≈ 32M tokens (cap undecided)
- Manager span 7; 8th seat opens a sibling team (own manager, goals, bill)
- Squad routing: manager drafts per goal; founder approves each hire once,
  squads field automatically (no gate on runs)
- Unconnected runs notify via feed + email (CTA + would-have-done list)
- Day 14 blocks runs + baselines; config stays open; one 7-day grace on
  first late run for never-active trials
- Fair use: 25M tokens/worker/month (≈$76 cost, ~85% margin); cap hit
  throttles to 1 run/day until calendar-month reset (trial expiry wins)
- Wizard routes by one vertical question; step 3 prefills that playbook goal
- Sending domain: user's own (name + DNS pending)
- Seats = roster size; second team billed as its own seats (uncontested)
- User actions: Google OAuth app, Resend key + domain DNS, Stripe test keys

## Trial build checklist (spec — remaining work only)

Builds the Final trial contract above on the live system (Hono API,
Workflow runs, dashboard, GitHub/Linear/Slack, memory, revert). Ordered;
each task lands tested, typed, and deployed before the next starts.
Schema changes ship as `db/migrations/NNNN_*.sql`, applied local + remote.

### 0. Inputs (owner)

- Google OAuth app (ID + secret → `~/.config/museaiteam/google-oauth`)
- Resend key + sending domain + DNS records
- Stripe test keys (publishable + secret + webhook secret)
- Shopify, HubSpot, Notion OAuth apps (same file pattern, Day-3 style)
- Accept: all secrets set via `wrangler secret put`, never in repo

### 1. Auth + orgs

- Wire Auth.js (Google + Resend email) with the D1 adapter; tables exist
- One org per user, auto-created at signup (`orgs.owner_user_id`, new)
- Gate `/api/orgs/*` and run mutation routes on session (401 unauthed)
- Accept: Google signup and magic-link login both land in an owned org;
  logged-out API calls 401; callback creates org on first login

### 2. Trial clock + enforcement

- `orgs.trial_started_at/ends_at/grace_used/subscribed`; `GET /api/orgs/:org`
  returns status + days left for the banner
- Enforcement: expired + unsubscribed blocks run creation and baselines;
  config stays open; first run attempt after expiry grants 7 days once
- Accept: fresh org shows 14 days; expired org gets 403 on runs with a
  subscribe CTA; grace grants exactly once; data intact throughout

### 3. Wizard + playbooks

- Dashboard wizard: signup → vertical question → connect → prefilled run;
  every step skippable; vertical routes integration order
- 3 playbooks with goals + metrics: cart abandonment (Shopify), response
  time (HubSpot), onboarding revamp (Notion)
- Accept: new founder reaches a running goal in under 5 minutes; skips
  never strand the user; playbook goals prefill metric fields

### 4. Catalog: Shopify, HubSpot, Notion

- Mirror the existing provider pattern per vendor: OAuth connect/callback,
  one flagship action + undo, guardrail systems entries, revert support
- Suggested flagships: Shopify price/discount draft, HubSpot ticket triage
  note, Notion decision page; adjust per API reality
- Accept: each connects from the dashboard, ships one real artifact on a
  run, and reverts it cleanly; skipped rows appear when unconnected

### 5. Unconnected runs + email

- Unconnected runs take zero external actions (already true); add the
  email half: Resend digest (CTA + would-have-done list) to the owner
- Feed keeps skipped rows; email sends at most one per run
- Accept: sandbox run produces debate + skipped rows + exactly one email;
  no provider API is ever touched without a stored token

### 6. Teams + squads

- `teams` (org → many) and `seats` (team → roles, hired/approved flags);
  runs gain `team_id`; hire flow = founder approves each seat once
- Propose step drafts squads: manager picks ≤7 roles from approved seats
  (new Spark call, replay-safe); 8th seat opens a sibling team
- Accept: 10-seat roster fields ≤7 per goal without prompting; 8th hire
  creates team 2 with own runs; unapproved seats never debate

### 7. Billing + meter

- Pricing page ($499/worker, seats = roster size, 25M fair-use meter);
  Stripe test Checkout per seat count; webhook marks `subscribed`
- Meter: per-worker monthly tokens from run rows; cap hit throttles to
  1 run/day until calendar-month reset (trial expiry wins ties)
- Accept: test card converts an org end to end; meter matches summed
  usage; capped worker throttles with an upgrade email, then resets

### 8. Rehearsal

- Full pass as a new founder: signup → wizard → goal → artifacts →
  baseline → revert; record the backup video; fix whatever breaks
- Accept: one clean 3-minute run exists on video; demo script updated
  with the trial beats

## Overnight build (§§4–8) — shipped, creds pending

- §4 catalog: Shopify (per-shop OAuth, 15%-off win-back code + delete),
  HubSpot (granular scopes, pinned triage note with ticket-content
  fallback + matching undos, since some portals can't grant notes),
  Notion (OAuth, decision page under saved parent + archive). Provider
  registry + config table + validation in shared; revert covers all six
  systems; wizard/Setup show all live. No flagship needed stubbing.
- §5 digest: Resend email at run end (decision + would-have-done +
  CTA), claim-once marker, failures audited never thrown. Proven with
  a real delivery (Resend id logged).
- §6 teams: teams/seats with hired+approved, 7-seat cap with dense
  overflow, 8th hire opens a sibling, 10 seat roles + manager, squad
  pick Spark call when >7 approved (replay-safe prompt, sanitized
  output), lineup persisted, guardrails cover all roles. Proven: 8
  approved → manager fielded 3, unapproved never debated.
- §7 billing: pricing view, $499×seats Stripe Checkout, signed
  webhook (idempotent) flips subscribed, meter from run rows,
  25M×seats throttle to 1 run/day with upgrade email, trial wins
  ties. Meter proven live (fake + real usage); checkout/webhook
  await keys and are unit-tested including signature verification.
- §8: API rehearsal green (run→baseline→revert→digest→meter);
  demo-script rewritten with trial beats; morning handoff in
  `docs/morning-handoff.md`. Video + vendor/Stripe proofs are
  morning work (need accounts, keys, browser).
- Design notes: epoch-millis trial clock (no date parsing); shop
  bound in signed OAuth state (token↔store can't mismatch);
  conditional-UPDATE claims for grace/digest/webhook dedupe;
  UNIQUE(team, role) + overflow fill (overfull teams
  unrepresentable); sanitize-before-field squads.
- 63/63 tests, typecheck clean, migrations 0005–0008 remote only
  (local blocked on sandbox loopback — see handoff §6).

## Real product (Phases A–I, spec in `docs/real-product-spec.md`)

- Goals are containers (team + metric + deadline + schedule +
  approval mode); runs are sessions inside. Weekly auto light-checks,
  full run only on need. Stable squads frozen unless re-staffed.
  Parallel runs allowed with hire locks (queued waits).
- Approvals per-goal (post-hoc default, pre-approve optional). Any
  approver decides; revise→resubmit capped at 3, then fail loudly.
  Ruling attempt = rejections + 1. Rejected actions spawn revision
  child runs. Pre-approve gate ends the instance (days of waiting
  cost nothing); resume via fresh instance.
- Metrics auto-pulled (9-entry catalog) with playbook preset +
  founder entry fallback. Overdue flags but keeps working + notify.
- Six-system depth: merge/publish-as-is proof (code PRs, sub-issues,
  threads, targeted discounts, ticket triage, decision DB).
- Learning: rate any artifact → nightly distill drafts → human
  approve/edit/veto → approved tactics feed prompts.
- Seats: owner/approver/viewer now. Email + in-app notifications,
  80% fair-use alerts, CSV audit export. No API (extras = alerts +
  export).
- Dashboard: Goals (chart + timeline + schedule/mode), Runs
  (debate + actions + ratings), Approvals inbox, Hires (spend
  estimated), Playbook, Team/invites, Alerts, Billing, Setup
  (incl. Shopify showcase picker).
- Marketing: single page at `/site` (Hormozi order), live sandbox
  samples (kind=sandbox, would-do intents, IP-throttled 5/day,
  silent even on failure). Manager rules but never debates — preset
  squads are SeatRole-typed so a manager entry is a compile error.
- 88/88 tests, typecheck clean, migrations 0005–0013 remote
  (local still needs the founder terminal loop).

## Alive team (interview-settled; full spec in alive-team-spec.md)

- Idle: propose next work + new goals; 3 days silence (configurable
  24–168h) means go. Auto-start bounds: undoable + non-money +
  within Limits + within idea allowance.
- Slack: answer in-thread when tagged; DM for proactive reach + founder
  commands (approve, undo, status, stop).
- Learning: session self-critique + weekly retro + founder replies +
  support tickets + goal numbers as final judge.
- Trust: proof attached to every result; fixed named roster, all orgs.
- Spend: own ideas on a small nightly allowance + morning note.
- Dead weight: judged by usage later.

## Production readiness (interview-settled; full spec in production-spec.md)

- Audience: self-serve strangers; outage cost is lost trials.
- Foundation first: git + CI + error tracking, then blockers.
- Data: Cloudflare defaults trusted; no explicit backup/retention work.
- Tests: cover workflows/routes/integrations; billing must be exact.
- Security: full org-scoping audit + key rotation + least-privilege.
- Support: monitored inbox + status page + runbooks.
- Compliance (terms/privacy/DPA/delete-my-data): flagged, undecided.
