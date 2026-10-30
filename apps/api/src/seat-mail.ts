import { parseHireAddress } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { notify } from "./notify.js";

export interface SeatMail {
  id: string;
  from_addr: string;
  subject: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface SeatRow {
  id: string;
  team_id: string;
  role: string;
  email: string | null;
  hired: number;
  approved: number;
}

/** Seat by id, org-scoped. Every mail path starts here. */
export async function getSeat(env: Env, orgId: string, seatId: string): Promise<SeatRow | null> {
  return env.DB.prepare(
    `SELECT s.id, s.team_id, s.role, s.email, s.hired, s.approved FROM seats s
     JOIN teams t ON t.id = s.team_id WHERE s.id = ? AND t.org_id = ?`,
  )
    .bind(seatId, orgId)
    .first<SeatRow>();
}

/**
 * Inbound: route one message to its hire inbox. Unknown addresses are
 * dropped (audited) — the inbox accepts mail only for real seats.
 */
export async function receiveSeatMail(
  env: Env,
  input: { to: string[]; cc?: string[]; from: string; subject: string; body: string; messageId?: string },
): Promise<"stored" | "dropped"> {
  const addr = parseHireAddress([...input.to, ...(input.cc ?? [])]);
  if (!addr) {
    await audit(env, null, "system", "mail.unrouted", { to: input.to.slice(0, 3).join(",") });
    return "dropped";
  }
  const seat = await env.DB.prepare(
    `SELECT s.id, s.frozen_at, t.org_id FROM seats s JOIN teams t ON t.id = s.team_id WHERE s.email = ?`,
  )
    .bind(addr)
    .first<{ id: string; frozen_at: string | null; org_id: string }>();
  if (!seat) {
    await audit(env, null, "system", "mail.unknown_seat", { to: addr });
    return "dropped";
  }
  if (seat.frozen_at) {
    await audit(env, null, "system", "mail.frozen", { to: addr });
    return "dropped";
  }
  // Invite loops and double deliveries land once per message id.
  if (input.messageId) {
    const dup = await env.DB.prepare(
      "SELECT id FROM seat_mail WHERE seat_id = ? AND message_id = ? LIMIT 1",
    )
      .bind(seat.id, input.messageId)
      .first<{ id: string }>();
    if (dup) return "stored";
  }
  await env.DB.prepare(
    `INSERT INTO seat_mail (id, org_id, seat_id, message_id, from_addr, to_addr, subject, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      seat.org_id,
      seat.id,
      input.messageId ?? "",
      input.from.slice(0, 200),
      addr,
      input.subject.slice(0, 200),
      input.body.slice(0, 20000),
    )
    .run();
  await notify(env, seat.org_id, {
    kind: "mail.received",
    title: `Mail for ${addr.split("@")[0]}: ${input.subject.slice(0, 80)}`,
    body: input.body.slice(0, 200),
  }).catch(() => {});
  return "stored";
}

/** Hire + founder mail API: newest first, bodies clipped for prompts. */
export async function listSeatMail(
  env: Env,
  orgId: string,
  seatId: string,
  unreadOnly: boolean,
): Promise<SeatMail[]> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) return [];
  const rows = await env.DB.prepare(
    `SELECT id, from_addr, subject, substr(body, 1, 2000) AS body, read_at, created_at
     FROM seat_mail WHERE seat_id = ? ${unreadOnly ? "AND read_at IS NULL" : ""}
     ORDER BY rowid DESC LIMIT 50`,
  )
    .bind(seatId)
    .all<SeatMail>();
  return rows.results ?? [];
}

export async function markMailRead(
  env: Env,
  orgId: string,
  seatId: string,
  mailId: string,
): Promise<boolean> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) return false;
  const res = await env.DB.prepare(
    "UPDATE seat_mail SET read_at = datetime('now') WHERE id = ? AND seat_id = ? AND read_at IS NULL",
  )
    .bind(mailId, seatId)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/**
 * Outbound as the hire. External-send gates apply at the call site;
 * this only moves the bytes (and needs the hires domain verified in
 * Resend — a 403 says so plainly).
 */
export async function sendSeatMail(
  env: Env,
  orgId: string,
  seatId: string,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat?.email) throw new Error("seat has no inbox");
  if (!env.RESEND_API_KEY) throw new Error("email is not configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: seat.email, to, subject, text: body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Resend: ${res.status} ${(json.message ?? "").slice(0, 150)}`);
  }
  await audit(env, null, "system", "mail.sent", { org: orgId, seat: seatId, to });
}
