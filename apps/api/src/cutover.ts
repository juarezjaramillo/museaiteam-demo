import { isKnownProvider } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit, orgCutOver } from "./db.js";
import { notify } from "./notify.js";
import type { TokenSet } from "./oauth.js";
import { seatToken, setSeatCredential } from "./seat-creds.js";

/**
 * Providers whose org row is a workspace link, not a hire login. Slack
 * inbound events need the workspace token, so the org row survives the
 * cutover while hire paths still go seat-only.
 */
const WORKSPACE_LINKS = new Set(["slack"]);

/**
 * Per-hire OAuth landing: the founder connected AS the hire, so the
 * token vaults under the seat (kind oauth) instead of the org. Runs
 * before and after cutover — this is the re-connect path itself.
 */
export async function finishSeatConnect(
  env: Env,
  orgId: string,
  seatId: string,
  provider: string,
  tokens: TokenSet,
): Promise<void> {
  const ms = tokens.expiresAt ? Date.parse(tokens.expiresAt) : NaN;
  await setSeatCredential(env, orgId, seatId, {
    tool: provider,
    kind: "oauth",
    secret: tokens.access,
    refreshToken: tokens.refresh,
    expiresAtMs: Number.isFinite(ms) && ms > Date.now() ? ms : undefined,
  });
}

export interface CutoverStatus {
  cutOver: boolean;
  /** Org providers still on the org link (retire or migrate them). */
  providers: string[];
  /** Org MCP servers still on the org key. */
  servers: string[];
  /** Workspace links that stay by design (Slack inbound). */
  kept: string[];
}

async function orgProviders(env: Env, orgId: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT provider FROM oauth_tokens WHERE org_id = ?")
    .bind(orgId)
    .all<{ provider: string }>();
  return (rows.results ?? []).map((r) => r.provider);
}

async function orgServers(env: Env, orgId: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT server_id FROM mcp_credentials WHERE org_id = ?")
    .bind(orgId)
    .all<{ server_id: string }>();
  return (rows.results ?? []).map((r) => r.server_id);
}

export async function cutoverStatus(env: Env, orgId: string): Promise<CutoverStatus> {
  const [cutOver, providers, servers] = await Promise.all([
    orgCutOver(env, orgId),
    orgProviders(env, orgId),
    orgServers(env, orgId),
  ]);
  return {
    cutOver,
    providers: providers.filter((p) => !WORKSPACE_LINKS.has(p)),
    servers,
    kept: providers.filter((p) => WORKSPACE_LINKS.has(p)),
  };
}

/**
 * Flip the cutover: allowed only when no retirable org rows remain.
 * Workspace links (Slack) stay by design and never block.
 */
export async function flipCutover(
  env: Env,
  orgId: string,
): Promise<{ ok: true } | { ok: false; providers: string[]; servers: string[] }> {
  const status = await cutoverStatus(env, orgId);
  if (status.providers.length > 0 || status.servers.length > 0) {
    return { ok: false, providers: status.providers, servers: status.servers };
  }
  await env.DB.prepare("UPDATE orgs SET seat_cutover = 1 WHERE id = ?").bind(orgId).run();
  await audit(env, null, "human", "seat.cutover", { org: orgId });
  await notify(env, orgId, {
    kind: "seat.verified",
    title: "Hires are fully on their own logins",
    body: "Org links retired. Every hire now works as itself.",
  });
  return { ok: true };
}

/**
 * Retire the org row for a tool once no hire needs it: every seat that
 * ever provisioned it is verified, or nobody ever did (dead link).
 * Called after each verify and from the migrate sweep.
 */
export async function retireOrgLinkIfDone(env: Env, orgId: string, tool: string): Promise<"retired" | "kept"> {
  if (tool.startsWith("mcp:")) {
    const serverId = tool.slice(4);
    const org = await env.DB.prepare(
      "SELECT server_id FROM mcp_credentials WHERE org_id = ? AND server_id = ?",
    )
      .bind(orgId, serverId)
      .first<{ server_id: string }>();
    if (!org) return "kept";
    const bound = await env.DB.prepare("SELECT seat_id FROM seat_tools WHERE mcp_server_id = ?")
      .bind(serverId)
      .all<{ seat_id: string }>();
    const seats = (bound.results ?? []).map((r) => r.seat_id);
    if (seats.length === 0) return "kept"; // founder decides: bind or delete
    for (const seatId of seats) {
      if (!(await seatToken(env, orgId, seatId, `mcp:${serverId}`).catch(() => null))) return "kept";
    }
    await env.DB.prepare("DELETE FROM mcp_credentials WHERE org_id = ? AND server_id = ?")
      .bind(orgId, serverId)
      .run();
    await audit(env, null, "system", "mcp.org_retired", { org: orgId, server: serverId });
    return "retired";
  }
  if (!isKnownProvider(tool) || WORKSPACE_LINKS.has(tool)) return "kept";
  const org = await env.DB.prepare("SELECT provider FROM oauth_tokens WHERE org_id = ? AND provider = ?")
    .bind(orgId, tool)
    .first<{ provider: string }>();
  if (!org) return "kept";
  const wanters = await env.DB.prepare(
    `SELECT p.seat_id, p.status FROM seat_provisions p JOIN seats s ON s.id = p.seat_id
     JOIN teams t ON t.id = s.team_id WHERE t.org_id = ? AND p.tool = ?`,
  )
    .bind(orgId, tool)
    .all<{ seat_id: string; status: string }>();
  const rows = wanters.results ?? [];
  if (rows.length > 0 && rows.some((r) => r.status !== "verified")) return "kept";
  await env.DB.prepare("DELETE FROM oauth_tokens WHERE org_id = ? AND provider = ?")
    .bind(orgId, tool)
    .run();
  await audit(env, null, "system", "integration.org_retired", { org: orgId, provider: tool });
  await notify(env, orgId, {
    kind: "seat.verified",
    title: `Org ${tool} link retired — hires use their own`,
    body: rows.length === 0 ? "Nobody used it." : "Every hire verified its own seat.",
  });
  return "retired";
}

/** Founder-driven: drop one org MCP key (bind or delete decides the rest). */
export async function retireServerSecret(env: Env, orgId: string, serverId: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM mcp_credentials WHERE org_id = ? AND server_id = ?")
    .bind(orgId, serverId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return false;
  await audit(env, null, "human", "mcp.org_retired", { org: orgId, server: serverId });
  return true;
}
