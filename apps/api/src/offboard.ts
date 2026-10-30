import { hireDisplayName } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { provider as boxProvider } from "./box.js";
import { audit } from "./db.js";
import { createGoal } from "./goals.js";
import { notify } from "./notify.js";
import { getProviderConfig } from "./oauth.js";
import { loadAdminGrant } from "./provision.js";
import {
  listSeatCredentials,
  wipeSeatCredentials,
  type SeatCred,
} from "./seat-creds.js";
import { getSeat } from "./seat-mail.js";
import { createWorkRun } from "./staffing.js";

/**
 * Best-effort vendor revoke for one vaulted login. Returns null when
 * the vendor confirms (or nothing needed doing), else a founder task.
 * GitHub is the only API revoke today: org membership delete needs the
 * hire's username, the admin grant, and a configured org — anything
 * missing becomes a task instead of a silent skip.
 */
async function revokeCred(
  env: Env,
  orgId: string,
  cred: SeatCred,
): Promise<string | null> {
  if (cred.tool !== "github" || !cred.login_user) {
    return `Remove the hire's ${cred.tool} seat at the vendor (${cred.kind} login vaulted, no API to pull it)`;
  }
  const [grant, cfg] = await Promise.all([
    loadAdminGrant(env, orgId, "github"),
    getProviderConfig(env, orgId, "github"),
  ]);
  const org = typeof cfg.org === "string" ? cfg.org : "";
  if (!grant || !org) {
    return `Remove @${cred.login_user} from the GitHub org ${org || "(configure the org in Setup first)"}`;
  }
  let last = "";
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(
        `https://api.github.com/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(cred.login_user)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${grant}`, accept: "application/vnd.github+json" } },
      );
      if (res.ok || res.status === 404) return null;
      last = `GitHub said ${res.status}`;
    } catch (err) {
      last = String(err).slice(0, 120);
    }
  }
  return `Remove @${cred.login_user} from the GitHub org (${last})`;
}

/**
 * Fire a seat: revoke loop (best effort, two retries) → handoff run →
 * box destroyed → inbox frozen (90d) → founder note with anything
 * un-revoked as tasks. Idempotent: firing a frozen seat re-reports.
 */
export async function fireSeat(
  env: Env,
  orgId: string,
  seatId: string,
): Promise<"fired" | "notfound"> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) return "notfound";
  const name = hireDisplayName(seat.role);
  const creds = await listSeatCredentials(env, orgId, seatId);
  const tasks: string[] = [];
  for (const cred of creds) {
    try {
      const task = await revokeCred(env, orgId, cred);
      if (task) tasks.push(task);
    } catch (err) {
      tasks.push(`Check the hire's ${cred.tool} seat (${String(err).slice(0, 100)})`);
    }
  }
  const wiped = await wipeSeatCredentials(env, orgId, seatId).catch(() => 0);
  await env.DB.prepare("DELETE FROM seat_tools WHERE seat_id = ?").bind(seatId).run();
  // Handoff: the team summarizes open work in a run of its own.
  try {
    const open = await env.DB.prepare(
      "SELECT tool, status FROM seat_provisions WHERE seat_id = ? AND status != 'verified'",
    )
      .bind(seatId)
      .all<{ tool: string; status: string }>();
    const pending = (open.results ?? []).map((r) => r.tool);
    const goalId = await createGoal(env, orgId, {
      teamId: seat.team_id,
      title: `Hand off ${name}'s open work`,
    });
    await createWorkRun(env, {
      orgId,
      goalId,
      teamId: seat.team_id,
      goal: `Hand off the fired ${seat.role}'s work. Unfinished seats: ${pending.length > 0 ? pending.join(", ") : "none"}. Vaulted logins wiped: ${wiped}.`,
      kind: "work",
      briefNote: `Handoff for ${name} (${seat.email ?? "no inbox"}).`,
    });
  } catch (err) {
    await audit(env, null, "system", "handoff_blocked", {
      org: orgId,
      seat: seatId,
      reason: String(err).slice(0, 160),
    }).catch(() => {});
  }
  await boxProvider().destroy(env, orgId, seatId).catch(() => {});
  await env.DB.prepare(
    "UPDATE seats SET hired = 0, approved = 0, frozen_at = datetime('now') WHERE id = ?",
  )
    .bind(seatId)
    .run();
  await audit(env, null, "human", "seat.fired", { org: orgId, seat: seatId, tasks: tasks.length });
  await notify(env, orgId, {
    kind: "seat.fired",
    title: `${name} offboarded`.slice(0, 120),
    body:
      tasks.length > 0
        ? `Left to do by hand:\n- ${tasks.slice(0, 8).join("\n- ")}`
        : "Logins wiped, desk destroyed, inbox frozen for 90 days.",
  });
  return "fired";
}

const FROZEN_TABLES = [
  "seat_mail",
  "seat_credentials",
  "seat_tools",
  "seat_provisions",
  "seat_requests",
  "seat_milestones",
  "box_runs",
  "box_state",
];

/**
 * Purge seats frozen over 90 days: mail, logins, provisions, meter
 * rows, then the seat itself. History in runs/audit keeps pointing at
 * the role name, never the deleted row.
 */
export async function sweepFrozenSeats(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id FROM seats WHERE frozen_at IS NOT NULL AND frozen_at < datetime('now', '-90 days') LIMIT 50",
  )
    .bind()
    .all<{ id: string }>();
  let swept = 0;
  for (const row of rows.results ?? []) {
    for (const table of FROZEN_TABLES) {
      await env.DB.prepare(`DELETE FROM ${table} WHERE seat_id = ?`).bind(row.id).run();
    }
    await env.DB.prepare("DELETE FROM seats WHERE id = ?").bind(row.id).run();
    swept++;
  }
  if (swept > 0) {
    await audit(env, null, "system", "seats.swept", { count: swept }).catch(() => {});
  }
  return swept;
}
