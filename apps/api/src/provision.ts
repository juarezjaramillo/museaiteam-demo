import {
  KEYSTONE_SEAT,
  SEAT_MAP_DEFAULT,
  decryptFromB64,
  encryptToB64,
  firstUrl,
  hireDisplayName,
  isSeatMapRole,
  keyFromHex,
  paidTools,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { BoxQuota, boxConfigured, provider } from "./box.js";
import { retireOrgLinkIfDone } from "./cutover.js";
import { audit } from "./db.js";
import { maybeStartSessionOne } from "./enroll.js";
import { notify } from "./notify.js";
import { getSeat, listSeatMail } from "./seat-mail.js";
import { trialGate } from "./trial.js";

export type ProvisionStrategy = "api" | "browser" | "manual";

/**
 * How a tool gets provisioned. Only GitHub has a real invite API
 * today; everything else queues for the box browser (phase 4) with a
 * manual task as the last resort. No fictional APIs.
 */
export function strategyFor(tool: string): ProvisionStrategy {
  if (tool === "github") return "api";
  return "browser";
}

export async function seatMapFor(
  env: Env,
  orgId: string,
  role: string,
): Promise<{ tools: string[]; overridden: boolean }> {
  const fallback = (SEAT_MAP_DEFAULT as Record<string, string[]>)[role] ?? [];
  const row = await env.DB.prepare(
    "SELECT tools_json FROM org_seat_map WHERE org_id = ? AND role = ?",
  )
    .bind(orgId, role)
    .first<{ tools_json: string }>();
  if (!row) return { tools: fallback, overridden: false };
  try {
    const tools = JSON.parse(row.tools_json) as unknown;
    if (Array.isArray(tools)) {
      return { tools: tools.filter((t): t is string => typeof t === "string"), overridden: true };
    }
  } catch {
    /* fall through to default */
  }
  return { tools: fallback, overridden: false };
}

export async function setSeatMap(
  env: Env,
  orgId: string,
  role: string,
  tools: string[],
): Promise<void> {
  if (!isSeatMapRole(role)) throw new Error(`unknown role ${role}`);
  await env.DB.prepare(
    `INSERT INTO org_seat_map (org_id, role, tools_json) VALUES (?, ?, ?)
     ON CONFLICT(org_id, role) DO UPDATE SET tools_json = excluded.tools_json`,
  )
    .bind(orgId, role, JSON.stringify(tools.slice(0, 20)))
    .run();
  await audit(env, null, "human", "seatmap.updated", { org: orgId, role });
}

export interface SeatRequest {
  id: string;
  seat_id: string;
  tools: string[];
  status: string;
  created_at: string;
}

export function normalizeTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return [...new Set(
    tools
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase().slice(0, 120))
      .filter(Boolean),
  )].slice(0, 20);
}

/** Tools with no live coverage: not verified, provisioning, or asked. */
export async function uncoveredTools(env: Env, seatId: string, tools: string[]): Promise<string[]> {
  const live = await env.DB.prepare(
    "SELECT tool FROM seat_provisions WHERE seat_id = ? AND status IN ('verified', 'pending', 'waiting')",
  )
    .bind(seatId)
    .all<{ tool: string }>();
  const covered = new Set((live.results ?? []).map((r) => r.tool));
  const open = await env.DB.prepare(
    "SELECT tools_json FROM seat_requests WHERE seat_id = ? AND status = 'proposed'",
  )
    .bind(seatId)
    .all<{ tools_json: string }>();
  for (const r of open.results ?? []) {
    try {
      for (const t of JSON.parse(r.tools_json) as unknown[]) {
        if (typeof t === "string") covered.add(t);
      }
    } catch {
      /* ignore */
    }
  }
  return tools.filter((t) => !covered.has(t));
}

async function paidBlocked(env: Env, orgId: string, tools: string[]): Promise<string[]> {
  const gate = await trialGate(env, orgId);
  return gate.status.subscribed ? [] : paidTools(tools);
}

/**
 * What the hire is waiting on, as brief lines: open asks plus seats
 * still provisioning. Empty means fully seated.
 */
export async function seatAskLines(env: Env, seatId: string): Promise<string[]> {
  const lines: string[] = [];
  const open = await env.DB.prepare(
    "SELECT tools_json FROM seat_requests WHERE seat_id = ? AND status = 'proposed'",
  )
    .bind(seatId)
    .all<{ tools_json: string }>();
  for (const r of open.results ?? []) {
    try {
      const tools = (JSON.parse(r.tools_json) as unknown[]).filter((t): t is string => typeof t === "string");
      if (tools.length > 0) lines.push(`asked the founder for: ${tools.join(", ")} (waiting on approval)`);
    } catch {
      /* ignore */
    }
  }
  const prov = await env.DB.prepare(
    "SELECT tool, detail FROM seat_provisions WHERE seat_id = ? AND status IN ('pending', 'waiting') ORDER BY tool",
  )
    .bind(seatId)
    .all<{ tool: string; detail: string }>();
  for (const r of prov.results ?? []) {
    lines.push(`${r.tool}: getting ready${r.detail ? ` — ${r.detail.slice(0, 120)}` : ""}`);
  }
  return lines;
}

/**
 * The hire asks for seats mid-work: files once per tool (merging into
 * the open card), notifies once per new tool. Returns what was filed —
 * empty means everything was already covered, never an error.
 */
export async function askForSeats(
  env: Env,
  orgId: string,
  seatId: string,
  tools: unknown,
  reason: string,
): Promise<{ requestId: string | null; filed: string[] }> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) throw new Error("seat not found");
  const fresh = await uncoveredTools(env, seatId, normalizeTools(tools));
  const open = await env.DB.prepare(
    "SELECT id, tools_json FROM seat_requests WHERE seat_id = ? AND status = 'proposed' LIMIT 1",
  )
    .bind(seatId)
    .first<{ id: string; tools_json: string }>();
  if (fresh.length === 0) return { requestId: open?.id ?? null, filed: [] };
  let requestId: string;
  let merged: string[];
  if (open) {
    let current: string[] = [];
    try {
      current = (JSON.parse(open.tools_json) as unknown[]).filter((t): t is string => typeof t === "string");
    } catch {
      current = [];
    }
    merged = [...new Set([...current, ...fresh])].slice(0, 20);
    await env.DB.prepare("UPDATE seat_requests SET tools_json = ?, nudged_at = NULL WHERE id = ?")
      .bind(JSON.stringify(merged), open.id)
      .run();
    requestId = open.id;
  } else {
    requestId = crypto.randomUUID();
    merged = fresh;
    await env.DB.prepare(
      "INSERT INTO seat_requests (id, org_id, seat_id, tools_json, status) VALUES (?, ?, ?, ?, 'proposed')",
    )
      .bind(requestId, orgId, seatId, JSON.stringify(merged))
      .run();
  }
  const paid = paidTools(merged);
  await notify(env, orgId, {
    kind: "seat.requested",
    title: `${hireDisplayName(seat.role)} asked for ${fresh.join(", ")}`.slice(0, 120),
    body: `${reason.slice(0, 200)}${paid.length > 0 ? ` Paid seats in the card: ${paid.join(", ")}.` : ""}`,
  });
  await audit(env, null, "system", "seat.asked", { org: orgId, seat: seatId, tools: fresh });
  return { requestId, filed: fresh };
}

/**
 * The founder grants tools directly: no ask card, straight to
 * provisions, audited as a grant. Trial still blocks paid tools.
 */
export async function grantSeats(
  env: Env,
  orgId: string,
  seatId: string,
  userId: string,
  tools: unknown,
): Promise<{ granted: string[] } | { trial: string[] }> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) throw new Error("seat not found");
  const fresh = await uncoveredTools(env, seatId, normalizeTools(tools));
  if (fresh.length === 0) return { granted: [] };
  const blocked = await paidBlocked(env, orgId, fresh);
  if (blocked.length > 0) return { trial: blocked };
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO seat_requests (id, org_id, seat_id, tools_json, status, decided_by, decided_at) VALUES (?, ?, ?, ?, 'approved', ?, datetime('now'))",
  )
    .bind(id, orgId, seatId, JSON.stringify(fresh), userId)
    .run();
  for (const tool of fresh) {
    await env.DB.prepare(
      `INSERT INTO seat_provisions (seat_id, tool, step, status) VALUES (?, ?, 'invite', 'pending')
       ON CONFLICT(seat_id, tool) DO UPDATE SET step = 'invite', status = 'pending', detail = '', updated_at = datetime('now')`,
    )
      .bind(seatId, tool)
      .run();
  }
  await audit(env, null, "human", "seat.granted", { org: orgId, seat: seatId, tools: fresh });
  return { granted: fresh };
}

/**
 * Compute a hire's asks: map tools + extras, minus tools already
 * verified. One open request per seat — repeats return the open one.
 */
export async function requestSeats(
  env: Env,
  orgId: string,
  seatId: string,
  extras: string[] = [],
): Promise<SeatRequest> {
  const seat = await getSeat(env, orgId, seatId);
  if (!seat) throw new Error("seat not found");
  const open = await env.DB.prepare(
    "SELECT id, tools_json, status, created_at FROM seat_requests WHERE seat_id = ? AND status = 'proposed' LIMIT 1",
  )
    .bind(seatId)
    .first<{ id: string; tools_json: string; status: string; created_at: string }>();
  if (open) {
    return { id: open.id, seat_id: seatId, tools: JSON.parse(open.tools_json) as string[], status: open.status, created_at: open.created_at };
  }
  const { tools } = await seatMapFor(env, orgId, seat.role);
  const verified = await env.DB.prepare(
    "SELECT tool FROM seat_provisions WHERE seat_id = ? AND status = 'verified'",
  )
    .bind(seatId)
    .all<{ tool: string }>();
  const have = new Set((verified.results ?? []).map((r) => r.tool));
  const asks = [...new Set([...tools, ...extras])].filter((t) => !have.has(t)).slice(0, 20);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO seat_requests (id, org_id, seat_id, tools_json, status) VALUES (?, ?, ?, ?, 'proposed')",
  )
    .bind(id, orgId, seatId, JSON.stringify(asks))
    .run();
  const paid = paidTools(asks);
  await notify(env, orgId, {
    kind: "seat.requested",
    title: `Seats for ${seat.role}: ${asks.length} tools`.slice(0, 120),
    body: paid.length > 0 ? `Includes paid seats: ${paid.join(", ")}. Approve all at once.` : "All free tools. Approve all at once.",
  });
  await audit(env, null, "system", "seat.requested", { org: orgId, seat: seatId, tools: asks.length });
  return { id, seat_id: seatId, tools: asks, status: "proposed", created_at: "" };
}

export async function decideSeatRequest(
  env: Env,
  orgId: string,
  requestId: string,
  userId: string,
  approve: boolean,
  exclude: string[] = [],
): Promise<"ok" | "notfound" | "decided" | "trial"> {
  const row = await env.DB.prepare(
    "SELECT id, seat_id, tools_json, status FROM seat_requests WHERE id = ? AND org_id = ?",
  )
    .bind(requestId, orgId)
    .first<{ id: string; seat_id: string; tools_json: string; status: string }>();
  if (!row) return "notfound";
  if (row.status !== "proposed") return "decided";
  const tools = JSON.parse(row.tools_json) as string[];
  const excluded = new Set(normalizeTools(exclude));
  const approved = tools.filter((t) => !excluded.has(t));
  if (approve && approved.length === 0) approve = false;
  if (approve) {
    // Trial gate lives here, not in the route, so no caller — UI,
    // approve-all, future API — can release paid seats unpaid.
    const blocked = await paidBlocked(env, orgId, approved);
    if (blocked.length > 0) return "trial";
  }
  const status = approve ? "approved" : "denied";
  const claimed = await env.DB.prepare(
    "UPDATE seat_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), tools_json = ? WHERE id = ? AND status = 'proposed'",
  )
    .bind(status, userId, JSON.stringify(approve ? approved : tools), row.id)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return "decided";
  await audit(env, null, "human", "seat.request_decided", {
    org: orgId,
    id: row.id,
    status,
    excluded: [...excluded].filter((t) => tools.includes(t)),
  });
  if (approve) {
    for (const tool of approved) {
      await env.DB.prepare(
        `INSERT INTO seat_provisions (seat_id, tool, step, status) VALUES (?, ?, 'invite', 'pending')
         ON CONFLICT(seat_id, tool) DO UPDATE SET step = 'invite', status = 'pending', detail = '', updated_at = datetime('now')`,
      )
        .bind(row.seat_id, tool)
        .run();
    }
  } else {
    // Denied asks close with a note: the hire plans around them, and
    // the founder sees what was refused and why it matters.
    const seat = await getSeat(env, orgId, row.seat_id).catch(() => null);
    await notify(env, orgId, {
      kind: "seat.requested",
      title: `Seat asks denied for ${seat?.role ?? "hire"} — planning around them`.slice(0, 120),
      body: `Denied: ${tools.join(", ")}. The hire will work without these.`,
    });
  }
  return "ok";
}

export async function keystoneVerified(env: Env, seatId: string, role: string): Promise<boolean> {
  const keystone = (KEYSTONE_SEAT as Record<string, string>)[role];
  if (!keystone) return true;
  const row = await env.DB.prepare(
    "SELECT tool FROM seat_provisions WHERE seat_id = ? AND tool = ? AND status = 'verified' LIMIT 1",
  )
    .bind(seatId, keystone)
    .first<{ tool: string }>();
  return !!row;
}

// --- admin grants ---

export async function saveAdminGrant(
  env: Env,
  orgId: string,
  tool: string,
  scopes: string[],
  secret: string,
): Promise<void> {
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  await env.DB.prepare(
    `INSERT INTO tool_admin_grants (org_id, tool, scopes_json, secret_enc, status, updated_at)
     VALUES (?, ?, ?, ?, 'granted', datetime('now'))
     ON CONFLICT(org_id, tool) DO UPDATE SET
       scopes_json = excluded.scopes_json, secret_enc = excluded.secret_enc,
       status = 'granted', updated_at = datetime('now')`,
  )
    .bind(orgId, tool, JSON.stringify(scopes), await encryptToB64(key, secret))
    .run();
  await audit(env, null, "human", "grant.saved", { org: orgId, tool });
}

export async function loadAdminGrant(env: Env, orgId: string, tool: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT secret_enc FROM tool_admin_grants WHERE org_id = ? AND tool = ? AND status = 'granted'",
  )
    .bind(orgId, tool)
    .first<{ secret_enc: string }>();
  if (!row?.secret_enc) return null;
  try {
    return await decryptFromB64(keyFromHex(env.TOKEN_ENC_KEY), row.secret_enc);
  } catch {
    return null;
  }
}

// --- provisioning tick ---

interface ProvisionRow {
  seat_id: string;
  tool: string;
  step: string;
  status: string;
}

async function setProvision(
  env: Env,
  seatId: string,
  tool: string,
  step: string,
  status: string,
  detail: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE seat_provisions SET step = ?, status = ?, detail = ?, updated_at = datetime('now') WHERE seat_id = ? AND tool = ?",
  )
    .bind(step, status, detail.slice(0, 300), seatId, tool)
    .run();
}

/**
 * GitHub org invite via API. Needs the hire's GitHub username — which
 * only exists after the hire creates its account (box browser). Until
 * then the step waits honestly instead of failing.
 */
async function provisionGithub(
  env: Env,
  orgId: string,
  seatId: string,
  email: string | null,
): Promise<void> {
  const grant = await loadAdminGrant(env, orgId, "github");
  if (!grant) {
    await setProvision(env, seatId, "github", "invite", "waiting", "needs the GitHub admin grant in Setup");
    return;
  }
  // GitHub invites by username, not email: without the hire's username
  // (minted at account creation) there is nothing to call yet.
  await setProvision(env, seatId, "github", "invite", "waiting", "waiting on the hire's GitHub username");
}

/**
 * Browser provisioning: the hire opens its own invite email link in its
 * box. Mail first — a box never wakes with nothing to do. Three
 * failed attempts become a guided task for the founder, never a
 * silent stall.
 */
async function attemptBrowserProvision(
  env: Env,
  orgId: string,
  seatId: string,
  tool: string,
  attempts: number,
): Promise<void> {
  if (!boxConfigured(env)) {
    await setProvision(env, seatId, tool, "invite", "waiting", "queued for the hire's browser");
    return;
  }
  const mail = await listSeatMail(env, orgId, seatId, false);
  const url = mail.map((m) => firstUrl(`${m.subject}\n${m.body}`)).find((u) => u);
  if (!url) {
    await setProvision(env, seatId, tool, "invite", "pending", "waiting for the invite email");
    return;
  }
  const box = provider();
  try {
    await box.wake(env, orgId, seatId, `provision:${tool}`);
    const res = (await box.call(
      env,
      seatId,
      "/browse",
      { steps: [{ op: "goto", url }, { op: "wait", ms: 2000 }, { op: "snapshot" }] },
      120_000,
    )) as { snapshots?: Array<{ title?: string }> };
    const title = res.snapshots?.[0]?.title?.slice(0, 80) ?? "the invite page";
    await setProvision(env, seatId, tool, "invite", "waiting", `opened the invite (${title}) — waiting on the account`);
  } catch (err) {
    if (err instanceof BoxQuota) {
      await setProvision(env, seatId, tool, "invite", "pending", "hire computers are busy — retrying");
      return;
    }
    const n = attempts + 1;
    await env.DB.prepare("UPDATE seat_provisions SET attempts = ? WHERE seat_id = ? AND tool = ?")
      .bind(n, seatId, tool)
      .run();
    if (n >= 3) {
      await setProvision(env, seatId, tool, "invite", "failed", `the browser could not open the invite: ${String(err).slice(0, 160)}`);
      await notify(env, orgId, {
        kind: "provision.failed",
        title: `${tool} seat needs a hand`.slice(0, 120),
        body: `The hire tried 3 times to open its ${tool} invite and failed. Check the invite link, then re-run provisioning.`,
      });
    } else {
      await setProvision(env, seatId, tool, "invite", "pending", `browser attempt ${n} failed — retrying`);
    }
  }
}

/**
 * Advance every pending provision one step. API tools act; browser
 * tools open their invite in the hire's box.
 */
export async function tickProvisions(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT p.seat_id, p.tool, p.step, p.status, p.attempts, t.org_id, s.email, s.role
     FROM seat_provisions p
     JOIN seats s ON s.id = p.seat_id
     JOIN teams t ON t.id = s.team_id
     WHERE p.status IN ('pending', 'waiting') AND s.frozen_at IS NULL LIMIT 50`,
  )
    .bind()
    .all<ProvisionRow & { org_id: string; email: string | null; role: string; attempts: number }>();
  let acted = 0;
  for (const r of rows.results ?? []) {
    try {
      const strategy = strategyFor(r.tool);
      if (strategy === "api" && r.status === "pending") {
        if (r.tool === "github") {
          await provisionGithub(env, r.org_id, r.seat_id, r.email);
          acted++;
        }
      } else if (strategy === "browser" && r.status === "pending") {
        await attemptBrowserProvision(env, r.org_id, r.seat_id, r.tool, r.attempts ?? 0);
        acted++;
      }
    } catch (err) {
      await setProvision(env, r.seat_id, r.tool, r.step, "failed", String(err)).catch(() => {});
    }
  }
  return acted;
}

/**
 * Verify a seat tool with a read call as the hire, then mark verified.
 * Only token-backed tools verify today; the rest verify at first box use.
 */
export async function verifySeatTool(
  env: Env,
  orgId: string,
  seatId: string,
  tool: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT kind, status FROM seat_credentials WHERE org_id = ? AND seat_id = ? AND tool = ?",
  )
    .bind(orgId, seatId, tool)
    .first<{ kind: string; status: string }>();
  if (!row || row.kind !== "token" || row.status !== "ok") return false;
  await env.DB.prepare(
    `INSERT INTO seat_provisions (seat_id, tool, step, status) VALUES (?, ?, 'verify', 'verified')
     ON CONFLICT(seat_id, tool) DO UPDATE SET step = 'verify', status = 'verified', updated_at = datetime('now')`,
  )
    .bind(seatId, tool)
    .run();
  await audit(env, null, "system", "seat.verified", { org: orgId, seat: seatId, tool });
  // The org link retires once nobody needs it; a failed sweep never
  // fails the verify — the next one retries.
  await retireOrgLinkIfDone(env, orgId, tool).catch(() => {});
  // Keystone verified unlocks session one. A blocked session start
  // never fails the verify itself — the milestone records the attempt.
  await maybeStartSessionOne(env, orgId, seatId, tool).catch(async (err) => {
    await audit(env, null, "system", "session_one_blocked", {
      org: orgId,
      seat: seatId,
      reason: String(err).slice(0, 160),
    }).catch(() => {});
  });
  return true;
}
