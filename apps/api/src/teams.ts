import {
  CLASSIC_ROLES,
  MAX_TEAM_SEATS,
  isSeatRole,
  seatEmail,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { decideSeatRequest, requestSeats } from "./provision.js";

export interface Seat {
  id: string;
  role: string;
  email: string | null;
  hired: number;
  approved: number;
}

export type ReviewState = "reviewed" | "waiting" | "never";

export interface Team {
  id: string;
  name: string;
  ownerUserId: string | null;
  review: ReviewState;
  seats: Seat[];
}

/**
 * Owner sees all teams; a scoped member sees only their own. The scope
 * lives in the query, so no UI or future route can leak a foreign team
 * by forgetting a check.
 */
export async function listTeams(
  env: Env,
  orgId: string,
  memberId?: string,
): Promise<Team[]> {
  const teams = memberId
    ? await env.DB.prepare(
        "SELECT id, name, owner_user_id FROM teams WHERE org_id = ? AND owner_user_id = ? ORDER BY rowid",
      )
        .bind(orgId, memberId)
        .all<{ id: string; name: string; owner_user_id: string | null }>()
    : await env.DB.prepare(
        "SELECT id, name, owner_user_id FROM teams WHERE org_id = ? ORDER BY rowid",
      )
        .bind(orgId)
        .all<{ id: string; name: string; owner_user_id: string | null }>();
  const out: Team[] = [];
  for (const t of teams.results ?? []) {
    const seats = await env.DB.prepare(
      "SELECT id, role, email, hired, approved FROM seats WHERE team_id = ? ORDER BY rowid",
    )
      .bind(t.id)
      .all<Seat>();
    out.push({
      id: t.id,
      name: t.name,
      ownerUserId: t.owner_user_id ?? null,
      review: await teamReviewState(env, t.id),
      seats: seats.results ?? [],
    });
  }
  return out;
}

async function nextTeamName(env: Env, orgId: string): Promise<string> {
  const n = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM teams WHERE org_id = ?",
  )
    .bind(orgId)
    .first<{ n: number }>();
  return `Team ${(n?.n ?? 0) + 1}`;
}

export async function createTeam(
  env: Env,
  orgId: string,
  name?: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO teams (id, org_id, name) VALUES (?, ?, ?)")
    .bind(id, orgId, name ?? (await nextTeamName(env, orgId)))
    .run();
  return id;
}

async function seedClassicSeats(env: Env, teamId: string): Promise<void> {
  for (const role of CLASSIC_ROLES) {
    await env.DB.prepare(
      "INSERT INTO seats (id, team_id, role, hired, approved) VALUES (?, ?, ?, 1, 1)",
    )
      .bind(crypto.randomUUID(), teamId, role)
      .run();
  }
}

/** Every org is born with Team 1 and the classic approved quartet. */
export async function createTeamWithClassicSeats(
  env: Env,
  orgId: string,
): Promise<string> {
  const id = await createTeam(env, orgId, "Team 1");
  await seedClassicSeats(env, id);
  return id;
}

/** The org's first team, creating Team 1 when none exists. Total: never null. */
export async function ensureTeam(env: Env, orgId: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT id FROM teams WHERE org_id = ? ORDER BY rowid LIMIT 1",
  )
    .bind(orgId)
    .first<{ id: string }>();
  if (row) return row.id;
  return createTeamWithClassicSeats(env, orgId);
}

export async function teamInOrg(
  env: Env,
  orgId: string,
  teamId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM teams WHERE id = ? AND org_id = ?",
  )
    .bind(teamId, orgId)
    .first<{ id: string }>();
  return row !== null;
}

interface VisibleTeam {
  id: string;
  name: string;
  owner_user_id: string | null;
}

/**
 * The team row when `memberId` may see it, else null. A foreign team
 * is indistinguishable from a missing one: scoped reads 404 alike.
 */
async function visibleTeam(
  env: Env,
  orgId: string,
  teamId: string,
  memberId?: string,
): Promise<VisibleTeam | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, owner_user_id FROM teams WHERE id = ? AND org_id = ?",
  )
    .bind(teamId, orgId)
    .first<VisibleTeam>();
  if (!row) return null;
  if (memberId && row.owner_user_id !== memberId) return null;
  return row;
}

export class DuplicateSeat extends Error {}
export class BadRole extends Error {}
export class UnknownMember extends Error {}
export class SeatFrozen extends Error {}

/**
 * Assign a team to a human member (or back to the founder's bench
 * with null). The owner must already belong to the org: a team can
 * never point at a stranger.
 */
export async function setTeamOwner(
  env: Env,
  orgId: string,
  teamId: string,
  userId: string | null,
): Promise<void> {
  if (!(await teamInOrg(env, orgId, teamId))) throw new BadRole("unknown team");
  if (userId) {
    const member = await env.DB.prepare(
      "SELECT user_id FROM org_members WHERE org_id = ? AND user_id = ?",
    )
      .bind(orgId, userId)
      .first<{ user_id: string }>();
    if (!member) throw new UnknownMember(userId);
  }
  await env.DB.prepare("UPDATE teams SET owner_user_id = ? WHERE id = ?")
    .bind(userId, teamId)
    .run();
  await audit(env, null, "human", "team.owner", { org: orgId, team: teamId, owner: userId });
}

/**
 * Move a hire between teams. The target team must not already hold
 * the role (one PM per team) and frozen hires stay put.
 */
export async function moveSeat(
  env: Env,
  orgId: string,
  seatId: string,
  teamId: string,
): Promise<void> {
  if (!(await teamInOrg(env, orgId, teamId))) throw new BadRole("unknown team");
  const seat = await env.DB.prepare(
    `SELECT s.id, s.team_id, s.role, s.frozen_at FROM seats s
     JOIN teams t ON t.id = s.team_id WHERE s.id = ? AND t.org_id = ?`,
  )
    .bind(seatId, orgId)
    .first<{ id: string; team_id: string; role: string; frozen_at: string | null }>();
  if (!seat) throw new BadRole("unknown seat");
  if (seat.frozen_at) throw new SeatFrozen(seatId);
  if (seat.team_id === teamId) return;
  const clash = await env.DB.prepare(
    "SELECT id FROM seats WHERE team_id = ? AND role = ?",
  )
    .bind(teamId, seat.role)
    .first<{ id: string }>();
  if (clash) throw new DuplicateSeat(seat.role);
  await env.DB.prepare("UPDATE seats SET team_id = ? WHERE id = ?")
    .bind(teamId, seatId)
    .run();
  await audit(env, null, "human", "seat.moved", { org: orgId, seat: seatId, team: teamId });
}

/**
 * Founder hires a seat onto a team. Teams cap at 7: overflow lands on the
 * latest sibling with room, opening a new team only when all are full, so
 * overfull teams are unrepresentable. Returns the seat id and the team it
 * actually landed on.
 */
export async function hireSeat(
  env: Env,
  orgId: string,
  teamId: string,
  role: string,
): Promise<{ id: string; teamId: string; overflow: boolean }> {
  if (!isSeatRole(role)) throw new BadRole(`unknown role ${role}`);
  let target = teamId;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM seats WHERE team_id = ?",
  )
    .bind(target)
    .first<{ n: number }>();
  let overflow = false;
  if ((count?.n ?? 0) >= MAX_TEAM_SEATS) {
    // Latest sibling with room wins; a new team opens only when all are full.
    const room = await env.DB.prepare(
      `SELECT t.id FROM teams t LEFT JOIN seats s ON s.team_id = t.id
       WHERE t.org_id = ? GROUP BY t.id HAVING COUNT(s.id) < ?
       ORDER BY t.rowid DESC LIMIT 1`,
    )
      .bind(orgId, MAX_TEAM_SEATS)
      .first<{ id: string }>();
    target = room?.id ?? (await createTeam(env, orgId));
    overflow = true;
  }
  const dup = await env.DB.prepare(
    "SELECT id FROM seats WHERE team_id = ? AND role = ?",
  )
    .bind(target, role)
    .first<{ id: string }>();
  if (dup) throw new DuplicateSeat(`${role} already sits on this team`);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO seats (id, team_id, role, email, hired, approved) VALUES (?, ?, ?, ?, 1, 0)",
  )
    .bind(id, target, role, seatEmail(role, id))
    .run();
  await audit(env, null, "human", "seat.hired", { org: orgId, team: target, role, overflow });
  // Enrollment step 1: the inbox is live (email exists) and the seat
  // asks are proposed from the map the moment the hire exists.
  await requestSeats(env, orgId, id);
  return { id, teamId: target, overflow };
}

/**
 * The founder's one action per seat: flips hired and approved together, so
 * a seat is either fully on the roster or not debating. Idempotent.
 */
export async function approveSeat(
  env: Env,
  orgId: string,
  seatId: string,
): Promise<boolean> {
  const seat = await env.DB.prepare(
    `SELECT s.id, s.role, s.team_id FROM seats s
     JOIN teams t ON t.id = s.team_id
     WHERE s.id = ? AND t.org_id = ?`,
  )
    .bind(seatId, orgId)
    .first<{ id: string; role: string; team_id: string }>();
  if (!seat) return false;
  await env.DB.prepare(
    "UPDATE seats SET hired = 1, approved = 1 WHERE id = ?",
  )
    .bind(seatId)
    .run();
  await audit(env, null, "human", "seat.approved", {
    org: orgId,
    team: seat.team_id,
    role: seat.role,
  });
  // Approve-all: one founder action seats the hire AND releases its
  // tool asks into provisioning. No pending ask, nothing to release.
  const pending = await env.DB.prepare(
    "SELECT id FROM seat_requests WHERE seat_id = ? AND status = 'proposed' ORDER BY created_at LIMIT 1",
  )
    .bind(seatId)
    .first<{ id: string }>();
  if (pending) {
    const res = await decideSeatRequest(env, orgId, pending.id, `approve-all:${seatId}`, true);
    if (res === "trial") {
      // Trial: the seat joins, the paid asks stay proposed — the
      // founder releases them after subscribing. Never half-approved.
      await audit(env, null, "system", "seat.request_trial_held", { org: orgId, id: pending.id });
    }
  }
  return true;
}

/** Brief/review days are UTC calendar days: one brief per team per day. */
export function todayDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface TeamBrief {
  text: string;
  reviewedAt: string | null;
}

async function briefRow(
  env: Env,
  teamId: string,
  day: string,
): Promise<TeamBrief> {
  const row = await env.DB.prepare(
    "SELECT text, reviewed_at FROM team_briefs WHERE team_id = ? AND day = ?",
  )
    .bind(teamId, day)
    .first<{ text: string; reviewed_at: string | null }>();
  return { text: row?.text ?? "", reviewedAt: row?.reviewed_at ?? null };
}

/** Today's brief text, or "" when the team wrote nothing: safe to feed sessions. */
export async function todayBriefText(
  env: Env,
  orgId: string,
  teamId: string,
): Promise<string> {
  if (!(await teamInOrg(env, orgId, teamId))) return "";
  return (await briefRow(env, teamId, todayDay())).text;
}

export async function getBrief(
  env: Env,
  orgId: string,
  teamId: string,
  day = todayDay(),
  memberId?: string,
): Promise<TeamBrief> {
  if (!(await visibleTeam(env, orgId, teamId, memberId))) throw new BadRole("unknown team");
  return briefRow(env, teamId, day);
}

/** Upsert today's brief. One row per team per day exists by construction. */
export async function putBrief(
  env: Env,
  orgId: string,
  teamId: string,
  text: string,
  day = todayDay(),
  memberId?: string,
): Promise<void> {
  if (!(await visibleTeam(env, orgId, teamId, memberId))) throw new BadRole("unknown team");
  await env.DB.prepare(
    `INSERT INTO team_briefs (team_id, day, text, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(team_id, day) DO UPDATE SET text = excluded.text, updated_at = datetime('now')`,
  )
    .bind(teamId, day, text)
    .run();
  await audit(env, null, "human", "team.brief", { org: orgId, team: teamId, day });
}

/** Mark the day reviewed. Reviewing an unbriefed day still counts: the ritual is the review. */
export async function markReviewed(
  env: Env,
  orgId: string,
  teamId: string,
  day = todayDay(),
  memberId?: string,
): Promise<void> {
  if (!(await visibleTeam(env, orgId, teamId, memberId))) throw new BadRole("unknown team");
  await env.DB.prepare(
    `INSERT INTO team_briefs (team_id, day, text, reviewed_at, updated_at)
     VALUES (?, ?, '', datetime('now'), datetime('now'))
     ON CONFLICT(team_id, day) DO UPDATE SET reviewed_at = datetime('now'), updated_at = datetime('now')`,
  )
    .bind(teamId, day)
    .run();
  await audit(env, null, "human", "team.reviewed", { org: orgId, team: teamId, day });
}

async function lastReviewedAt(env: Env, teamId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT reviewed_at FROM team_briefs WHERE team_id = ? AND reviewed_at IS NOT NULL ORDER BY reviewed_at DESC LIMIT 1",
  )
    .bind(teamId)
    .first<{ reviewed_at: string }>();
  return row?.reviewed_at ?? null;
}

/**
 * reviewed: today is done. waiting: the team did something (or wrote
 * something) the reviewer hasn't signed off. never: nothing ever
 * happened — no rows, no runs, nothing to review.
 */
export async function teamReviewState(
  env: Env,
  teamId: string,
  day = todayDay(),
): Promise<ReviewState> {
  if ((await briefRow(env, teamId, day)).reviewedAt) return "reviewed";
  const briefs = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM team_briefs WHERE team_id = ?",
  )
    .bind(teamId)
    .first<{ n: number }>();
  if ((briefs?.n ?? 0) > 0) return "waiting";
  const run = await env.DB.prepare(
    "SELECT id FROM runs WHERE team_id = ? LIMIT 1",
  )
    .bind(teamId)
    .first<{ id: string }>();
  return run ? "waiting" : "never";
}

export interface OvernightRun {
  id: string;
  goal: string;
  status: string;
  kind: string;
  createdAt: string;
}

export interface PendingTeamAction {
  id: string;
  runId: string;
  kind: string;
  target: string;
  runGoal: string;
}

export interface ReviewPayload {
  team: { id: string; name: string; ownerUserId: string | null };
  day: string;
  brief: TeamBrief;
  overnight: OvernightRun[];
  pending: PendingTeamAction[];
}

/**
 * One screen per team per day: what the team did since the last
 * review, what waits for approval, today's brief. The empty cutoff
 * matches every run, so "never reviewed" needs no special case.
 */
export async function reviewPayload(
  env: Env,
  orgId: string,
  teamId: string,
  memberId?: string,
): Promise<ReviewPayload> {
  const team = await visibleTeam(env, orgId, teamId, memberId);
  if (!team) throw new BadRole("unknown team");
  const day = todayDay();
  const last = (await lastReviewedAt(env, teamId)) ?? "";
  const runs = await env.DB.prepare(
    "SELECT id, goal, status, kind, created_at FROM runs WHERE team_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20",
  )
    .bind(teamId, last)
    .all<{ id: string; goal: string; status: string; kind: string; created_at: string }>();
  const acts = await env.DB.prepare(
    `SELECT a.id, a.run_id, a.kind, a.target, r.goal FROM actions a
     JOIN runs r ON r.id = a.run_id
     WHERE r.team_id = ? AND a.status = 'pending' ORDER BY a.created_at LIMIT 50`,
  )
    .bind(teamId)
    .all<{ id: string; run_id: string; kind: string; target: string; goal: string }>();
  return {
    team: { id: team.id, name: team.name, ownerUserId: team.owner_user_id ?? null },
    day,
    brief: await briefRow(env, teamId, day),
    overnight: (runs.results ?? []).map((r) => ({
      id: r.id, goal: r.goal, status: r.status, kind: r.kind, createdAt: r.created_at,
    })),
    pending: (acts.results ?? []).map((a) => ({
      id: a.id, runId: a.run_id, kind: a.kind, target: a.target, runGoal: a.goal,
    })),
  };
}

/** Approved seat roles across the org: the only roles that may debate. */
export async function approvedRoles(
  env: Env,
  orgId: string,
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT s.role FROM seats s
     JOIN teams t ON t.id = s.team_id
     WHERE t.org_id = ? AND s.approved = 1`,
  )
    .bind(orgId)
    .all<{ role: string }>();
  return (rows.results ?? []).map((r) => r.role);
}
