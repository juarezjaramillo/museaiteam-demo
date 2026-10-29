# Alive-team spec: the team speaks, proposes, and answers

Interview-settled. Six builds, in gap order. The team today only acts on
schedule or human start, never speaks first (except digests/alerts), and
cannot be talked to outside the dashboard. This spec closes that.

## Settled decisions (from interview)

- Idle: propose next work + new goals; 3 days of silence (configurable)
  means go. Auto-start bounds: reversible acts only, within Limits.
- Slack: answer in-thread when tagged.
- Learning: session self-critique + weekly team retro + three feeds
  (founder replies, support tickets, goal numbers as final judge).
- Trust: every result carries attached proof.
- Proactive channel: Slack DM; dashboard keeps history.
- Character: one fixed named team for every customer.
- Spend: own ideas run on a small allowance, then stop + morning note.
- Dead weight: judged by usage later, not now.

## 1. Inbound Slack (answers + DMs)

**Goal:** a tagged team answers in-thread; the team can DM the founder.

- New route `POST /api/slack/events`: verify Slack signature, handle
  `url_verification`, `app_mention`, and DM `message` events. Ignore
  bot/self messages and retries by `event_id` (store seen ids, 24h TTL).
- Mention → run one Spark turn with role-appropriate seat voice, session
  memory recall, and recent thread context (fetch via conversations API).
  Post answer back in-thread within 60s; on failure post "looking into
  it" once and retry async, never double-post (idempotency key per event).
- DM from founder → same, plus these commands: `approve <id>`,
  `undo`, `status`, `stop`. Anything else is a question or a brief:
  questions get answers, briefs become proposals (§2).
- Founder replies in any team thread are stored as feedback (§4).
- Scopes needed: `app_mentions:read`, `chat:write`, `im:history`,
  `channels:history` (thread context). Reconnect existing orgs.
- Acceptance: tag in #ai-team gets a correct in-thread answer < 60s;
  duplicate delivery posts once; DM `status` reports current work.

## 2. Proactive loop (propose → remind → auto-start)

**Goal:** an idle team proposes work; silence for the grace period means go.

- Idle = no open/awaiting run AND (no active goals OR all goals quiet
  7 days). Evaluated on the 5-min tick, at most one proposal per org/day.
- Proposal kinds: next-work (under an active goal), new-goal (title +
  why + first number). Written by manager seat, stored in new
  `proposals_out` table (id, org, kind, goal_id?, title, body, status,
  remind_at, start_at, run_id?).
- Lifecycle: `proposed` → notify (dashboard + Slack DM) → after 24h
  with no response, one reminder → after grace period (default 72h,
  org-configurable 24–168h), `started`: creates the run (next-work) or
  the goal + run (new-goal, schedule manual). Founder `approve` starts
  immediately; `reject`/feedback cancels (feedback → lessons feed).
- Auto-start bounds (all required): the night must have idea budget
  left, and next-work must run review-after so the sweep holds money
  acts for a human (new goals are born review-after + manual). Act
  kinds can't be known before the run debates, so the money bound is
  enforced post-hoc by the sweep rather than pre-run. A proposal that
  can't satisfy bounds is held with a reason instead of starting.
- Everything audited (`proposal.proposed/reminded/started/cancelled`).
- Acceptance: idle org gets exactly one proposal/day; 3-day silence
  starts a bounded run; rejection cancels with zero acts; money-moving
  proposal never auto-starts.

## 3. Retros + self-critique

**Goal:** every session judges itself; the team retros weekly.

- Session close (digest step): manager writes a self-critique (what
  moved the number, what it doubts, what it would change) stored on the
  run row (`self_critique` column) and shown in session detail + digest.
- Weekly retro job (cron tick, Mondays): manager reviews the week's
  sessions, ratings, and number deltas; writes one retro (wins, misses,
  3 tactic candidates) attached to the weekly digest; candidates enter
  Lessons as drafts for founder approval.
- No sessions that week → no retro, no noise.
- Acceptance: every settled run has a critique; Monday digest carries
  the retro with ≤3 candidates; empty weeks stay silent.

## 4. Feedback feeds (replies, tickets, numbers)

**Goal:** three signals teach the team besides ratings.

- Founder replies: thread replies + DM corrections stored in
  `feedback` table (org, source, text, run_id?) and recalled into
  future briefs like memory. Explicit correction ("no, do X") also
  drafts a lesson.
- Support tickets: nightly job samples recently closed HubSpot tickets
  for orgs with support-adjacent goals; recurring complaint themes
  become lesson drafts (max 3/week/org).
- Goal numbers: the weekly retro (§3) scores each session against its
  goal-number delta; sessions with no movement after 2 weeks flag the
  goal (dashboard banner: "this goal isn't moving — change or pause?").
- Acceptance: a DM correction changes the next session's brief
  (visible in recalled memory); ticket themes appear as drafts;
  stalled goals get flagged, not silently re-run.

## 5. Proof attached + named team

**Goal:** trust without opening external tools; hires with names.

- Proof: every done action stores `proof` JSON (before/after values
  where measurable, external URL, what changed in one line). Session
  detail and Home show it; actions without proof show "no proof
  recorded" rather than hiding.
- Names: fixed roster in shared (e.g. Maya/marketer, Raj/engineer,
  Priya/analyst, Sam/PM + Morgan/manager). Used in threads, digests,
  session detail ("who did what"), and Home. Same names, every org.
- Voice: each name keeps its seat lens; digests stay plain. No
  name changes per org (revisit deliberately, per decisions.md rule).
- Acceptance: session detail attributes every result to a name with
  proof or an explicit no-proof line; Slack answers sign as the seat.

## 6. Idea allowance + morning note

**Goal:** own ideas spend a little, then stop and report.

- New org setting `idea_allowance_words` (default 250k/night, owner
  editable). Unassigned work (proposals, idle watch, retros) meters
  against it; assigned work never does.
- Cap hit → stop, audit `allowance.exhausted`, and queue the morning
  note: what ran, what it spent, where it stopped, what needs the
  founder. Delivered via digest slot + Slack DM.
- Home shows allowance state ("ideas: 40k of 250k left tonight").
- Acceptance: allowance hit mid-proposal stops all unassigned work;
  morning note arrives with spend + stop point; assigned runs unaffected.

## Build order + notes

1 → 5 → 3 → 4 → 2 → 6. Slack first (unlocks replies feed + DM
channel); names+proof next (visible trust); retros/critique; feeds;
proactive loop; allowance last (it meters §2, so §2 ships with a
hardcoded default until §6 lands).

Non-goals: per-org naming, email commands, voice/phone, auto-start of
money acts (never — human always), retros on empty weeks.
