import { KEYSTONE_SEAT, hireDisplayName, paidTools } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { boxSpend } from "./box.js";
import { audit } from "./db.js";
import { createGoal } from "./goals.js";
import { notify } from "./notify.js";
import { listSeatCredentials, type SeatCred } from "./seat-creds.js";
import { getSeat } from "./seat-mail.js";
import { RunConflict, RunThrottled, createWorkRun } from "./staffing.js";

const SESSION_ONE = "session_one";

/**
 * Session one: the moment a hire's keystone seat verifies, it starts
 * working — an onboarding goal plus its first run, with the remaining
 * seat asks ranked in the brief. Exactly once per seat: the milestone
 * row is the lock, so a racing verify can't start two.
 */
export async function maybeStartSessionOne(
  env: Env,
  orgId: string,
  seatId: string,
  verifiedTool: string,
): Promise<"started" | "skipped"> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) return "skipped";
  const keystone = (KEYSTONE_SEAT as Record<string, string>)[seat.role];
  if (!keystone || verifiedTool !== keystone) return "skipped";
  try {
    await env.DB.prepare("INSERT INTO seat_milestones (seat_id, milestone) VALUES (?, ?)")
      .bind(seatId, SESSION_ONE)
      .run();
  } catch {
    return "skipped";
  }
  const remaining = await env.DB.prepare(
    "SELECT tool, status FROM seat_provisions WHERE seat_id = ? AND status != 'verified' ORDER BY tool",
  )
    .bind(seatId)
    .all<{ tool: string; status: string }>();
  const asks = (remaining.results ?? []).map((r) => r.tool);
  try {
    const goalId = await createGoal(env, orgId, {
      teamId: seat.team_id,
      title: `Get the ${seat.role} hire working`,
    });
    const goal =
      `${seat.role} keystone ready (${keystone}).` +
      (asks.length > 0
        ? ` Work the plan with ${keystone} now; still waiting on: ${asks.join(", ")}.`
        : " All seats ready — full speed.");
    await createWorkRun(env, {
      orgId,
      goalId,
      teamId: seat.team_id,
      goal,
      kind: "work",
      briefNote: `Session one for the ${seat.role} hire (${seat.email ?? "no inbox"}).`,
    });
  } catch (err) {
    if (err instanceof RunThrottled || err instanceof RunConflict) {
      await audit(env, null, "system", "session_one_blocked", {
        org: orgId,
        seat: seatId,
        reason: String(err).slice(0, 160),
      });
      return "started";
    }
    // Real failure: release the milestone so the next verify retries.
    await env.DB.prepare("DELETE FROM seat_milestones WHERE seat_id = ? AND milestone = ?")
      .bind(seatId, SESSION_ONE)
      .run();
    throw err;
  }
  await notify(env, orgId, {
    kind: "seat.verified",
    title: `${hireDisplayName(seat.role)} is working — ${keystone} ready`.slice(0, 120),
    body:
      asks.length > 0
        ? `Session one started. Still waiting on: ${asks.join(", ")}.`
        : "Session one started. All seats ready.",
  });
  await audit(env, null, "system", "session_one_started", { org: orgId, seat: seatId });
  return "started";
}

/**
 * Weekly re-nudge for seat asks stuck on proposed. The nudged_at stamp
 * is the throttle: a ask re-pings at most once every 7 days, no matter
 * how often the tick runs.
 */
export async function nudgeSeatRequests(env: Env): Promise<number> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const rows = await env.DB.prepare(
    `SELECT r.id, r.org_id, r.tools_json, s.role FROM seat_requests r
     JOIN seats s ON s.id = r.seat_id
     WHERE r.status = 'proposed' AND r.created_at < ?
     AND (r.nudged_at IS NULL OR r.nudged_at < ?) LIMIT 50`,
  )
    .bind(weekAgo, weekAgo)
    .all<{ id: string; org_id: string; tools_json: string; role: string }>();
  let nudged = 0;
  for (const r of rows.results ?? []) {
    let count = 0;
    try {
      count = (JSON.parse(r.tools_json) as unknown[]).length;
    } catch {
      count = 0;
    }
    await notify(env, r.org_id, {
      kind: "seat.requested",
      title: `Still waiting: seats for ${hireDisplayName(r.role)} (${count} tools)`.slice(0, 120),
      body: "Approve all at once so the hire can start.",
    });
    await env.DB.prepare("UPDATE seat_requests SET nudged_at = datetime('now') WHERE id = ?")
      .bind(r.id)
      .run();
    nudged++;
  }
  return nudged;
}

export interface TeamSeat {
  id: string;
  role: string;
  email: string | null;
  approved: boolean;
  keystone: string | null;
  keystoneReady: boolean;
  sessionOne: boolean;
  on: string[];
  waiting: Array<{ tool: string; step: string; status: string; detail: string }>;
  box: string;
  spend: { seconds: number; cents: number } | null;
  request: { id: string; status: string; tools: string[]; paid: string[] } | null;
  logins: Array<{ tool: string; kind: string; status: string; expires: string | null }>;
}

/**
 * Team step, one call: per hire — seats on, seats waiting, box state,
 * month spend — plus org-wide doing-meanwhile notes (seatless skips
 * from recent runs, newest first).
 */
export async function teamSeats(
  env: Env,
  orgId: string,
): Promise<{ seats: TeamSeat[]; meanwhile: string[] }> {
  const seatRows = await env.DB.prepare(
    `SELECT s.id, s.role, s.email, s.approved FROM seats s
     JOIN teams t ON t.id = s.team_id WHERE t.org_id = ? ORDER BY s.role`,
  )
    .bind(orgId)
    .all<{ id: string; role: string; email: string | null; approved: number }>();
  const spend = await boxSpend(env, orgId, Date.now() - 30 * 86_400_000);
  const seats: TeamSeat[] = [];
  for (const s of seatRows.results ?? []) {
    const prov = await env.DB.prepare(
      "SELECT tool, step, status, detail FROM seat_provisions WHERE seat_id = ? ORDER BY tool",
    )
      .bind(s.id)
      .all<{ tool: string; step: string; status: string; detail: string }>();
    const box = await env.DB.prepare("SELECT status FROM box_state WHERE seat_id = ?")
      .bind(s.id)
      .first<{ status: string }>();
    const one = await env.DB.prepare(
      "SELECT milestone FROM seat_milestones WHERE seat_id = ? AND milestone = 'session_one'",
    )
      .bind(s.id)
      .first<{ milestone: string }>();
    const keystone = (KEYSTONE_SEAT as Record<string, string>)[s.role] ?? null;
    const verified = new Set(
      (prov.results ?? []).filter((p) => p.status === "verified").map((p) => p.tool),
    );
    const req = await env.DB.prepare(
      "SELECT id, tools_json, status FROM seat_requests WHERE seat_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(s.id)
      .first<{ id: string; tools_json: string; status: string }>();
    let request: TeamSeat["request"] = null;
    if (req) {
      let tools: string[] = [];
      try {
        tools = (JSON.parse(req.tools_json) as unknown[]).filter((t): t is string => typeof t === "string");
      } catch {
        tools = [];
      }
      request = { id: req.id, status: req.status, tools, paid: paidTools(tools) };
    }
    const creds: SeatCred[] = await listSeatCredentials(env, orgId, s.id).catch(() => []);
    seats.push({
      id: s.id,
      role: s.role,
      email: s.email,
      approved: s.approved === 1,
      keystone,
      keystoneReady: keystone !== null && verified.has(keystone),
      sessionOne: Boolean(one),
      on: [...verified].sort(),
      waiting: (prov.results ?? []).filter((p) => p.status !== "verified"),
      box: box?.status ?? "none",
      spend: spend.find((x) => x.seatId === s.id) ?? null,
      request,
      logins: creds.map((c) => ({ tool: c.tool, kind: c.kind, status: c.status, expires: c.expires_at })),
    });
  }
  const skips = await env.DB.prepare(
    `SELECT a.payload FROM actions a JOIN runs r ON r.id = a.run_id
     WHERE r.org_id = ? AND a.status = 'skipped' AND a.payload LIKE '%seatless%'
     ORDER BY a.rowid DESC LIMIT 5`,
  )
    .bind(orgId)
    .all<{ payload: string }>();
  const meanwhile: string[] = [];
  for (const row of skips.results ?? []) {
    try {
      const note = (JSON.parse(row.payload) as { note?: unknown }).note;
      if (typeof note === "string" && note && !meanwhile.includes(note)) meanwhile.push(note);
    } catch {
      /* ignore */
    }
  }
  return { seats, meanwhile };
}
