# Employee spec: hires as employees, not bots

Every interview decision in one place. Today hires borrow the
founder's logins (org-level OAuth, outside bot). After this, each hire
is an employee: its own inbox, its own seats, its own computer.

## 0. Settled decisions

- Identity: managed inbox per hire on our domain; hire holds its own
  vaulted password logins; tagged AI in every tool (`Priya (AI)`).
  Inboxes send and receive; external sends still ask first.
- Credentials: full per-hire cutover (no org fallback afterward).
- Provisioning: one scoped admin grant per tool (invite/manage users
  only, exact list shown) → we provision all seats via API forever.
  Refusing degrades to manual per-seat invite tasks, never blocks.
- No-API tools: one-time login relay (founder logs in once in a shown
  window; vaulted session lets hire browsers act after).
- Seats: default map per role + hires may request more; one approval
  per hire (paid total upfront); paid seats warn; trial blocks paid.
- SSO-walled tools: unsupported in v1.
- Enrollment: keystone seat unlocks session one → work plan + ranked
  asks → progressive grants; hire reroutes meanwhile; Team step shows
  per-hire seat state; ignored asks re-nudge weekly.
- The box: Cloudflare Containers, one persistent box per hire,
  sleeping when idle; Chromium inside the box (no browser vendor);
  dumb box (tools/files/browser — brain stays in worker); secrets
  injected per wake, never on disk.
- Offboarding: firing auto-revokes logins where APIs allow, hands off
  open work, logs the trail.
- Migration: hard cut — guided per-hire re-connect, then org links die.

## 1. Identity + inbox

- Seats gain `email` (`<role>-<shortid>@hires.museaiteam.com`, one
  domain, derived never typed) at hire time; uniqueness on email.
- Inbound: Cloudflare Email Routing → worker → stored per seat
  (`seat_mail` table, 90-day retention) + notifies hire loop.
- Outbound: Resend (existing key) from the seat address; every send
  is an external send under today's gates (asks first unless the
  approval mode says otherwise).
- Hire reads mail through a worker API (never raw store access):
  list/unread/mark-read per seat, scoped by seat id.

## 2. Credential model (per-seat cutover)

- New `seat_credentials` table: (seat_id, tool, kind, secret_enc,
  login_user, status, updated_at). Kinds: `password`, `token`,
  `oauth`, `session` (relayed browser session). Same vault key +
  rotation path as today.
- `oauth_tokens` and `mcp_credentials` stop taking new org rows at
  cutover; reads fall through seat → (nothing). Migration (§8)
  re-homes or retires each row.
- Every tool call site takes a seat: bespoke clients resolve the
  seat's token; MCP calls use the seat's server binding
  (`seat_tools`: seat_id → mcp_server_id + credential).
- Least privilege by construction: a seat's queries can only return
  its own rows (all access via `seat_id = ?` helpers, no org-wide
  credential reads in hire paths).

## 3. The box

- One Cloudflare Container per seat, from our image (Chromium +
  node + python + thin driver). Created at hire, destroyed at fire.
- Lifecycle: wake on hire need (session start, browser task);
  `sleepAfter` idle; files persist via snapshot/R2; secrets arrive
  per wake over the relay and live in memory only.
- Driver API (box side, thin): `browse(task)` (CDP steps under a
  step cap), `run(cmd)` (allowlisted commands only — no arbitrary
  shell from the model; the worker composes commands), `files`
  (read/write/list under the hire home). MCP servers run in-box as
  supervised processes; the worker calls them over the relay. This
  lifts the remote-only rule for box tools only — same gates
  (sensitive asks, trust per service).
- Provider interface (`BoxProvider`) behind the worker so vendors
  stay swappable; Cloudflare first.
- Quota: per-org box CPU/memory caps in settings; sleep keeps idle
  near zero. Spend metered per hire, visible in Team step.

## 4. Provisioning

- `seat_map` defaults (shared): engineer→GitHub, pm→Linear,
  marketer→(HubSpot, social), analyst→(Sheets-grade tools…),
  designer→Figma, qa→(Linear, GitHub), support→(Intercom, inbox),
  researcher→(web), writer→(Notion), ops→(finance tools).
  Owner-editable per org (`org_seat_map` overrides).
- Admin grants: per tool, OAuth with user-management scopes only;
  Setup shows the exact scope list pre-grant. Stored per org
  (`tool_admin_grants`), used only by provisioning/offboarding —
  never by hire work paths.
- Seat request flow: map seats + hire requests → one approval per
  hire (paid total, per-seat prices from `seat_prices` catalog where
  known, else "price unknown") → provision each: SCIM/API invite →
  inbox accept → login/token mint → verify (a read call as the hire).
  Failed step → retries twice, then a guided task for the founder.
- Trial: paid-seat approvals hidden until subscribed; free seats flow.
- Login relay: no-API tools get a relayed login window (Cloudflare
  Durable-Object-held session page); resulting session vaults as
  kind `session` with expiry; refresh = re-relay on demand.

## 5. Enrollment (fast path)

1. Hire created → inbox live in seconds → seat asks computed from
   map (+ keystone flagged).
2. Approve-all → provisioning runs → keystone seat verifies →
   session one starts immediately: work plan + ranked remaining asks.
3. Each grant verifies → hire picks up blocked work (reroute
   planner skips seatless tools per call, no full stops).
4. Team step: per hire — seats on / waiting / doing-meanwhile.
5. Unapproved asks re-nudge weekly (existing proposal rhythm);
   denied asks close with a note and the hire plans around them.

## 6. Offboarding

- Fire seat → revoke loop: API deprovision per seat credential
  (best effort, two retries) → handoff session (open work summary
  to the team) → box destroyed → inbox frozen (90d) → audit trail
  + founder note listing anything un-revoked as tasks.
- Customer deleting a seat at the vendor first: next auth failure
  becomes a `seat.lost` task (re-request or accept), never silent.

## 7. Migration (hard cut)

- Cutover release: org links enter `retiring` (work, but Setup
  banners each with its per-hire path). Guided migration per hire:
  copy-what's-possible (same-vendor re-OAuth as the hire where the
  vendor allows employee-linking, else fresh provision), verify,
  then the org row retires. No org hire-path reads after the last
  seat verifies. Rollback = restore org rows from the pre-cut
  snapshot (documented runbook, 7-day window).
- Shipped notes: the flip (`POST /cutover/flip`) requires zero
  retirable org rows; Slack stays by design (inbound needs the
  workspace token) while hire Slack reads still go seat-only.
  GitHub offboard revoke needs the hire username + admin grant +
  `provider_config.github.org`. Runbook: `docs/runbooks/seat-cutover.md`.

## 8. Effects on today's code

- Staffing: seats gain email/inbox/box; hire flow adds provisioning.
- OAuth/MCP: per-seat tokens + bindings; MCP client gains box-local
  transport; trust/sensitive gates unchanged, evaluated per seat.
- Act phase: every call resolves seat credentials; reroute skips
  seatless tools with honest `skipped` proofs.
- Approvals inbox: seat approvals (one per hire) + paid totals.
- Setup: Tools step splits org-admin grants from hire seats; Team
  step gains seat state; new seat-map editor.
- Billing: box meter per hire; trial paid-seat block.
- Revert/audit: per-seat attribution everywhere.

## Build order

1. Seat identity + inbox (tables, routing, mail API).
2. Per-seat credentials + re-scoped call sites (no box yet).
3. Seat map + approvals + provisioning loop (API tools first).
4. The box (provider, image, driver, relay) + in-box Chromium.
5. Enrollment flow + reroute + Team seat view.
6. Offboarding + migration + hard cut.

## Non-goals

SSO enrolment, customer-domain email, org-fallback reads after cut,
arbitrary model shell in boxes, persistent box secrets, paid seats
on trial, per-tool custom scope requests beyond the scoped list.
