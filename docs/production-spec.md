# Production spec: self-serve ready

Interview-settled for strangers with credit cards. Foundation first,
then the launch blockers. Data stays on Cloudflare defaults (explicit
call); compliance (terms/privacy/DPA/delete-my-data) is flagged but
undecided — it rides with §3 or waits for the first enterprise ask.

## 1. Git + CI

**Goal:** no deploy ships without gates; every change is reviewable.

- Init git in `~/Projects/museaiteam`, first commit = current tree,
  remote to `juarezjaramillo/museaiteam-demo` (or a new private repo —
  founder picks at build time).
- Branch protection on main: PR + green checks required.
- CI (GitHub Actions): `npm test` (all workspaces), `npm run typecheck`,
  `npm run build` (api + web), jargon grep on changed copy, wrangler
  dry-run deploy. PRs show the checklist; red blocks merge.
- Deploys from main only, via CI (wrangler + pages), never from laptop.
- Acceptance: a PR with a failing test cannot merge; main always
  matches what's live; `git log` explains every production change.

## 2. Error tracking + alerting

**Goal:** no silent outage; the founder learns before the customer.

- Sentry (or equivalent) on worker + web: uncaught exceptions, failed
  workflow steps, failed Spark calls, with org/run tags (no secrets,
  no token contents).
- Replace fire-and-forget `.catch(() => {})` on critical paths
  (digest, settle, billing webhook, Slack inbound) with capture +
  audit; keep silent only where a retry or fallback already covers it.
- Alerts: worker error spike, cron tick failure, run-fail rate above
  baseline → email immediately. Trial-loss definition: any paying-org
  run failing twice in a row pages the digest path, not silent.
- Acceptance: throw in staging → Sentry issue with org/run tags in
  under a minute; kill the worker route → alert email, not silence.

## 3. Security review

**Goal:** strangers' data cannot cross orgs, tokens, or sessions.

- Audit every route + cron + inbound webhook for org scoping:
  enumerate all `roleOrg`/`runRole`/`memberRole` call sites, prove each
  resolves the org from the session (never from client input alone),
  fix or flag each miss. Record the matrix in
  `docs/security-matrix.md`.
- Rotate `TOKEN_ENC_KEY` with a dual-read window (decrypt old, write
  new), then revoke old. Document the rotation runbook.
- OAuth scopes: least privilege per provider; drop anything unused;
  reconnect matrix for scope changes.
- Sessions: confirm expiry + revocation on sign-out; cookies
  HttpOnly/Secure/SameSite; no tokens in logs or errors.
- Acceptance: matrix shows every route with its check; rotation
  completes with zero failed decrypts; a probe with org B's session
  cannot read org A's data on any route.

## 4. Abuse defense

**Goal:** bots can't burn word budget or hammer auth.

- Per-IP + per-org rate limits (Cloudflare Rate Limiting or Durable
  Object counters) on: sign-in/magic link, run creation, Slack events,
  sandbox, billing checkout. Limits: auth 10/min/IP, runs 30/hr/org,
  inbound 120/min/IP, sandbox keeps its 5/day.
- Costly endpoints (run start, propose, retro) require an active
  trial/subscription — no anonymous Spark spend, ever.
- Abuse audit events + a dashboard banner at 80% of any limit.
- Acceptance: scripted burst past each limit gets 429s; no anonymous
  path reaches a Spark call (prove by code search + probe).

## 5. Billing correctness

**Goal:** money paths behave exactly; dunning and cancel verified live.

- Failed card: Stripe smart retries + email at each attempt + dashboard
  banner; grace behavior locked (read-only? paused runs?) and tested.
- Cancellation: immediate effect on limits, end-of-cycle access rules
  written down, no further charges; prove with a test-mode cancel.
- Enforcement: plan word cap, seat count, and trial grace enforced at
  run start AND cron (no background path bypasses the gate).
- Every path proven live in Stripe test mode, then cleaned.
- Acceptance: fail a card → retries + emails + banner on schedule;
  cancel → limits flip same minute, zero stray charges; an expired
  org cannot start runs by any path.

## 6. Integration tests

**Goal:** the money-and-systems paths are covered, not hand-probed.

- Harness (miniflare or staged worker + test D1): run lifecycle
  (create → debate → approve → act → digest), post-hoc sweep
  classification, revert incl. kept-parent guard, billing webhook
  (subscribe/fail/cancel), Slack signature + DM commands, proposal
  remind/hold/start transitions.
- External systems stubbed at the fetch boundary with recorded
  fixtures; replay mode for Spark stays (no live model spend in CI).
- Runs in CI on every PR; nightly full pass against staging.
- Acceptance: the suite catches an injected regression in each of:
  sweep classification, revert guard, billing gate, proposal hold.

## 7. Support + status

**Goal:** a stranger can reach a human and see system health.

- Monitored support inbox (e.g. support@fernwaylabs.com) linked from
  Setup + error states; first reply within one business day.
- Public status page (Cloudflare-friendly: worker + D1 + queue depth
  checks) with incident history.
- Runbooks in `docs/runbooks/`: expired provider token, failed run,
  stuck approval, billing dispute, suspected abuse. Each: symptom,
  diagnose (exact queries), fix, when to escalate.
- Acceptance: token-expiry runbook resolves a staged expiry in under
  15 minutes following only the written steps.

## Build order + non-goals

1 → 2 → 3 → 4 → 5 → 6 → 7. Each section deploys and proves before
the next starts.

Non-goals (unless decided later): multi-region, SOC 2, data export,
per-org SSO, on-call paging (trials, not contracts — email alerts
suffice).
