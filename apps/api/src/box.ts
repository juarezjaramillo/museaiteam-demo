import { boxCostCents, type BoxState } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";

export class BoxError extends Error {}
export class BoxQuota extends BoxError {}
export class BoxOffline extends BoxError {}

export type BoxPath = "/browse" | "/run" | "/files" | "/mcp" | "/ping";

/**
 * One box per seat, swappable vendor behind this interface. The worker
 * holds the brain: it composes every driver call, decrypts seat secrets
 * per call, and meters every wake. The box holds tools/files/browser
 * and keeps secrets in memory only.
 */
export interface BoxProvider {
  state(env: Env, seatId: string): Promise<BoxState>;
  wake(env: Env, orgId: string, seatId: string, reason: string): Promise<void>;
  call(env: Env, seatId: string, path: BoxPath, body: unknown, timeoutMs?: number): Promise<unknown>;
  destroy(env: Env, orgId: string, seatId: string): Promise<void>;
}

export function boxConfigured(env: Env): boolean {
  return Boolean((env as Env & { HIRE_BOX?: unknown }).HIRE_BOX);
}

function ns(env: Env): DurableObjectNamespace {
  return (env as Env & { HIRE_BOX: DurableObjectNamespace }).HIRE_BOX;
}

async function quota(env: Env, orgId: string): Promise<{ max: number; running: number }> {
  const org = await env.DB.prepare("SELECT box_max_concurrent FROM orgs WHERE id = ?")
    .bind(orgId)
    .first<{ box_max_concurrent: number }>();
  const run = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM box_state WHERE org_id = ? AND status = 'running'",
  )
    .bind(orgId)
    .first<{ n: number }>();
  return { max: org?.box_max_concurrent ?? 3, running: run?.n ?? 0 };
}

async function markRunning(env: Env, orgId: string, seatId: string, reason: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO box_state (seat_id, org_id, status, woken_at, last_tick, wake_count)
     VALUES (?, ?, 'running', ?, ?, 1)
     ON CONFLICT(seat_id) DO UPDATE SET
       status = 'running', woken_at = excluded.woken_at,
       last_tick = excluded.last_tick, wake_count = wake_count + 1`,
  )
    .bind(seatId, orgId, now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO box_runs (id, seat_id, org_id, started_at, instance_type, woken_by) VALUES (?, ?, ?, ?, 'basic', ?)",
  )
    .bind(crypto.randomUUID(), seatId, orgId, now, reason.slice(0, 80))
    .run();
}

/**
 * Cloudflare Containers behind the HireBox durable object. `getByName`
 * makes the seat id the box id — no mapping table can drift. A plain
 * fetch wakes a sleeping box (containerFetch auto-starts), so wake is
 * quota + meter + ping, and every call re-touches the meter.
 */
export const cfBox: BoxProvider = {
  async state(env, seatId) {
    if (!boxConfigured(env)) return "none";
    const row = await env.DB.prepare("SELECT status FROM box_state WHERE seat_id = ?")
      .bind(seatId)
      .first<{ status: string }>();
    return row?.status === "running" ? "running" : row ? "sleeping" : "none";
  },

  async wake(env, orgId, seatId, reason) {
    if (!boxConfigured(env)) throw new BoxOffline("hire boxes are not connected yet");
    const q = await quota(env, orgId);
    const cur = await env.DB.prepare("SELECT status FROM box_state WHERE seat_id = ?")
      .bind(seatId)
      .first<{ status: string }>();
    if (cur?.status === "running") {
      await env.DB.prepare("UPDATE box_state SET last_tick = ? WHERE seat_id = ?")
        .bind(Date.now(), seatId)
        .run();
      return;
    }
    if (q.running >= q.max) {
      throw new BoxQuota(`only ${q.max} hire computers awake at once — one is sleeping soon`);
    }
    const res = await ns(env)
      .getByName(seatId)
      .fetch(new Request("http://box/ping"));
    if (!res.ok) throw new BoxError(`box would not wake (http ${res.status})`);
    await markRunning(env, orgId, seatId, reason);
    await audit(env, null, "system", "box.wake", { org: orgId, seat: seatId, reason: reason.slice(0, 80) });
  },

  async call(env, seatId, path, body, timeoutMs = 60_000) {
    if (!boxConfigured(env)) throw new BoxOffline("hire boxes are not connected yet");
    const res = await ns(env)
      .getByName(seatId)
      .fetch(
        new Request(`http://box${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !json || json.ok !== true) {
      throw new BoxError(String(json?.error ?? `box call failed (http ${res.status})`).slice(0, 300));
    }
    await env.DB.prepare("UPDATE box_state SET last_tick = ? WHERE seat_id = ?")
      .bind(Date.now(), seatId)
      .run();
    return json;
  },

  async destroy(env, orgId, seatId) {
    if (boxConfigured(env)) {
      await ns(env)
        .getByName(seatId)
        .fetch(new Request("http://box/__do/destroy", { method: "POST" }));
    }
    await env.DB.prepare("DELETE FROM box_state WHERE seat_id = ?").bind(seatId).run();
    await audit(env, null, "system", "box.destroy", { org: orgId, seat: seatId });
  },
};

export function provider(): BoxProvider {
  return cfBox;
}

/** Spend per seat since `sinceMs`, raw seconds × estimate rates. */
export async function boxSpend(
  env: Env,
  orgId: string,
  sinceMs: number,
): Promise<Array<{ seatId: string; role: string; seconds: number; cents: number }>> {
  const rows = await env.DB.prepare(
    `SELECT r.seat_id, s.role, r.seconds, r.instance_type
     FROM box_runs r JOIN seats s ON s.id = r.seat_id
     WHERE r.org_id = ? AND r.started_at >= ?`,
  )
    .bind(orgId, sinceMs)
    .all<{ seat_id: string; role: string; seconds: number; instance_type: string }>();
  const by = new Map<string, { seatId: string; role: string; seconds: number; cents: number }>();
  for (const r of rows.results ?? []) {
    const cur = by.get(r.seat_id) ?? { seatId: r.seat_id, role: r.role, seconds: 0, cents: 0 };
    cur.seconds += r.seconds;
    cur.cents += boxCostCents(r.seconds, r.instance_type);
    by.set(r.seat_id, cur);
  }
  return [...by.values()].sort((a, b) => b.seconds - a.seconds);
}

/**
 * Close runs whose box never reported stopping. Sleep is 10 minutes, so
 * anything still "running" after 3 hours is a missed onStop, not a
 * 3-hour run: cap the span honestly instead of billing infinity.
 */
export async function reconcileBoxes(env: Env): Promise<number> {
  const cutoff = Date.now() - 3 * 3_600_000;
  const stale = await env.DB.prepare(
    `SELECT r.id, r.seat_id, r.started_at FROM box_runs r
     JOIN box_state s ON s.seat_id = r.seat_id
     WHERE r.stopped_at = 0 AND s.status = 'running' AND r.started_at < ?`,
  )
    .bind(cutoff)
    .all<{ id: string; seat_id: string; started_at: number }>();
  for (const r of stale.results ?? []) {
    const seconds = Math.min(Math.round((Date.now() - r.started_at) / 1000), 3 * 3600);
    await env.DB.prepare("UPDATE box_runs SET stopped_at = ?, seconds = ? WHERE id = ?")
      .bind(Date.now(), seconds, r.id)
      .run();
    await env.DB.prepare("UPDATE box_state SET status = 'sleeping', last_tick = ? WHERE seat_id = ?")
      .bind(Date.now(), r.seat_id)
      .run();
  }
  return (stale.results ?? []).length;
}
