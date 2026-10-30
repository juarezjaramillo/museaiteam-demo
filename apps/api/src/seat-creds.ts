import {
  decryptFromB64,
  encryptToB64,
  keyFromHex,
  ownerFor,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit, orgCutOver } from "./db.js";
import { loadToken, type Provider } from "./oauth.js";
import { getSeat } from "./seat-mail.js";

export type SeatCredKind = "password" | "token" | "oauth" | "session";

export interface SeatCred {
  tool: string;
  kind: SeatCredKind;
  login_user: string;
  status: string;
  updated_at: string;
  expires_at: string | null;
}

/** Epoch millis → UTC `YYYY-MM-DD HH:MM:SS`, the column's one format. */
export function expiresIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Save a hire login. Secrets are vaulted under the shared key; only
 * `token` kinds are API-usable today — password/oauth/session kinds
 * store now and activate with provisioning (phase 3) and the box
 * (phase 4). Status starts ok; verification flips it later.
 */
export async function setSeatCredential(
  env: Env,
  orgId: string,
  seatId: string,
  input: { tool: string; kind: SeatCredKind; secret: string; loginUser?: string; expiresAtMs?: number; refreshToken?: string | null },
): Promise<void> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) throw new Error("seat not found");
  if (input.expiresAtMs !== undefined && !(input.expiresAtMs > Date.now())) {
    throw new Error("expiry must be in the future");
  }
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  await env.DB.prepare(
    `INSERT INTO seat_credentials (id, org_id, seat_id, tool, kind, login_user,
       secret_enc, refresh_token_enc, expires_at, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', datetime('now'))
     ON CONFLICT(seat_id, tool) DO UPDATE SET
       kind = excluded.kind, login_user = excluded.login_user,
       secret_enc = excluded.secret_enc, refresh_token_enc = excluded.refresh_token_enc,
       expires_at = excluded.expires_at, status = 'ok', updated_at = datetime('now')`,
  )
    .bind(
      crypto.randomUUID(),
      orgId,
      seatId,
      input.tool.slice(0, 120),
      input.kind,
      (input.loginUser ?? "").slice(0, 200),
      await encryptToB64(key, input.secret),
      input.refreshToken ? await encryptToB64(key, input.refreshToken) : null,
      input.expiresAtMs === undefined ? null : expiresIso(input.expiresAtMs),
    )
    .run();
  await audit(env, null, "human", "seat.cred_saved", { org: orgId, seat: seatId, tool: input.tool });
}

export async function deleteSeatCredential(
  env: Env,
  orgId: string,
  seatId: string,
  tool: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM seat_credentials WHERE org_id = ? AND seat_id = ? AND tool = ?",
  )
    .bind(orgId, seatId, tool)
    .run();
  const gone = (res.meta.changes ?? 0) === 1;
  if (gone) {
    await audit(env, null, "human", "seat.cred_removed", { org: orgId, seat: seatId, tool });
  }
  return gone;
}

/** Wipe every login a seat holds. Offboarding calls this, nothing else. */
export async function wipeSeatCredentials(env: Env, orgId: string, seatId: string): Promise<number> {
  const res = await env.DB.prepare(
    "DELETE FROM seat_credentials WHERE org_id = ? AND seat_id = ?",
  )
    .bind(orgId, seatId)
    .run();
  await env.DB.prepare("DELETE FROM seat_tools WHERE seat_id = ?").bind(seatId).run();
  return res.meta.changes ?? 0;
}

export async function listSeatCredentials(env: Env, orgId: string, seatId: string): Promise<SeatCred[]> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) return [];
  const rows = await env.DB.prepare(
    "SELECT tool, kind, login_user, status, updated_at, expires_at FROM seat_credentials WHERE seat_id = ? ORDER BY tool",
  )
    .bind(seatId)
    .all<SeatCred>();
  return rows.results ?? [];
}

/**
 * A vaulted browser session: the secret, or null when missing, expired,
 * or unreadable. Null is the re-relay trigger — the hire asks for a
 * fresh session instead of failing mid-task.
 */
export async function seatSession(
  env: Env,
  orgId: string,
  seatId: string,
  tool: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT secret_enc, expires_at, status FROM seat_credentials WHERE org_id = ? AND seat_id = ? AND tool = ? AND kind = 'session'",
  )
    .bind(orgId, seatId, tool)
    .first<{ secret_enc: string; expires_at: string | null; status: string }>();
  if (!row || row.status !== "ok") return null;
  if (row.expires_at && row.expires_at <= expiresIso(Date.now())) return null;
  try {
    return await decryptSeatSecret(env, orgId, seatId, row);
  } catch {
    return null;
  }
}

/**
 * The vendor deleted the seat (or its key) out from under us: flip the
 * vaulted login ok → lost exactly once. True means newly lost — the
 * caller raises the seat.lost task; false means already known.
 */
export async function markSeatLost(
  env: Env,
  orgId: string,
  seatId: string,
  tool: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE seat_credentials SET status = 'lost', updated_at = datetime('now') WHERE org_id = ? AND seat_id = ? AND tool = ? AND status = 'ok'",
  )
    .bind(orgId, seatId, tool)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/**
 * Reroute check: unbound servers ride the org path (ready); bound
 * servers need the hire's own credential or the call skips — the hire
 * does other work meanwhile instead of failing.
 */
export async function seatReadyForServer(
  env: Env,
  orgId: string,
  seatId: string,
  serverId: string,
): Promise<boolean> {
  const bound = await seatToolIds(env, seatId);
  if (!bound.includes(serverId)) return true;
  return (await seatToken(env, orgId, seatId, `mcp:${serverId}`)) !== null;
}

async function decryptSeatSecret(
  env: Env,
  orgId: string,
  seatId: string,
  row: { secret_enc: string },
): Promise<string> {
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  try {
    return await decryptFromB64(key, row.secret_enc);
  } catch {
    if (!env.TOKEN_ENC_KEY_PREV) throw new Error("saved login cannot be read");
    const prev = keyFromHex(env.TOKEN_ENC_KEY_PREV);
    const text = await decryptFromB64(prev, row.secret_enc);
    await env.DB.prepare(
      "UPDATE seat_credentials SET secret_enc = ?, updated_at = datetime('now') WHERE org_id = ? AND seat_id = ?",
    )
      .bind(await encryptToB64(key, text), orgId, seatId)
      .run();
    return text;
  }
}

/**
 * The hire's token for a bespoke tool: its own `token` credential, or
 * null when it holds nothing usable. Password/oauth/session kinds
 * need provisioning/box and read as absent here.
 */
export async function seatToken(
  env: Env,
  orgId: string,
  seatId: string,
  tool: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT secret_enc, kind, status FROM seat_credentials WHERE org_id = ? AND seat_id = ? AND tool = ?",
  )
    .bind(orgId, seatId, tool)
    .first<{ secret_enc: string; kind: string; status: string }>();
  if (!row || row.kind !== "token" || row.status !== "ok") return null;
  try {
    return await decryptSeatSecret(env, orgId, seatId, row);
  } catch {
    return null;
  }
}

/** Approved seat id for a role on a team, if any. */
export async function seatForRole(
  env: Env,
  teamId: string,
  role: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM seats WHERE team_id = ? AND role = ? AND approved = 1",
  )
    .bind(teamId, role)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * The token a hire path calls a tool with: the authoring seat's own
 * login first, the org link as legacy fallback. The fallback dies at
 * cutover (phase 6) — every call through here is already seat-scoped.
 */
export async function hireToken(
  env: Env,
  orgId: string,
  teamId: string | null,
  provider: Provider,
): Promise<string | null> {
  if (teamId) {
    const seatId = await seatForRole(env, teamId, ownerFor(`${provider}.x`));
    if (seatId) {
      const token = await seatToken(env, orgId, seatId, provider).catch(() => null);
      if (token) return token;
    }
  }
  if (await orgCutOver(env, orgId)) return null;
  return loadToken(env, orgId, provider);
}

// --- seat MCP bindings ---

export async function bindSeatTool(env: Env, orgId: string, seatId: string, serverId: string): Promise<void> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) throw new Error("seat not found");
  const server = await env.DB.prepare("SELECT id FROM mcp_servers WHERE org_id = ? AND id = ?")
    .bind(orgId, serverId)
    .first<{ id: string }>();
  if (!server) throw new Error("server not found");
  await env.DB.prepare("INSERT OR IGNORE INTO seat_tools (seat_id, mcp_server_id) VALUES (?, ?)")
    .bind(seatId, serverId)
    .run();
  await audit(env, null, "human", "seat.tool_bound", { org: orgId, seat: seatId, server: serverId });
}

export async function unbindSeatTool(
  env: Env,
  orgId: string,
  seatId: string,
  serverId: string,
): Promise<boolean> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) return false;
  const res = await env.DB.prepare("DELETE FROM seat_tools WHERE seat_id = ? AND mcp_server_id = ?")
    .bind(seatId, serverId)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export async function seatToolIds(env: Env, seatId: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT mcp_server_id FROM seat_tools WHERE seat_id = ?")
    .bind(seatId)
    .all<{ mcp_server_id: string }>();
  return (rows.results ?? []).map((r) => r.mcp_server_id);
}
