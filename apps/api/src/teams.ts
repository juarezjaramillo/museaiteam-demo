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

export interface Team {
  id: string;
  name: string;
  seats: Seat[];
}

export async function listTeams(env: Env, orgId: string): Promise<Team[]> {
  const teams = await env.DB.prepare(
    "SELECT id, name FROM teams WHERE org_id = ? ORDER BY rowid",
  )
    .bind(orgId)
    .all<{ id: string; name: string }>();
  const out: Team[] = [];
  for (const t of teams.results ?? []) {
    const seats = await env.DB.prepare(
      "SELECT id, role, email, hired, approved FROM seats WHERE team_id = ? ORDER BY rowid",
    )
      .bind(t.id)
      .all<Seat>();
    out.push({ id: t.id, name: t.name, seats: seats.results ?? [] });
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

export class DuplicateSeat extends Error {}
export class BadRole extends Error {}

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
