import { isPlaybookStatus, type Thumb } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { runDistill, runTicketThemes } from "./agents.js";
import { recentClosedTickets } from "./integrations/hubspot.js";
import { loadToken } from "./oauth.js";

export class BadPlaybook extends Error {}

/**
 * Rate one shipped action. Re-rating overwrites: one voice per founder
 * per artifact, so pile-ons are structurally impossible.
 */
export async function rateAction(
  env: Env,
  input: {
    orgId: string;
    runId: string;
    actionId: string;
    userId: string;
    thumb: Thumb;
    note?: string;
  },
): Promise<"ok" | "notfound"> {
  const action = await env.DB.prepare(
    "SELECT id FROM actions WHERE id = ? AND run_id = ?",
  )
    .bind(input.actionId, input.runId)
    .first<{ id: string }>();
  if (!action) return "notfound";
  await env.DB.prepare(
    `INSERT INTO ratings (id, org_id, run_id, action_id, rater_user_id,
       thumb, note) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(action_id, rater_user_id) DO UPDATE SET
       thumb = excluded.thumb, note = excluded.note,
       distilled = 0, created_at = datetime('now')`,
  )
    .bind(
      crypto.randomUUID(),
      input.orgId,
      input.runId,
      input.actionId,
      input.userId,
      input.thumb,
      input.note ?? "",
    )
    .run();
  await audit(env, input.runId, "human", "action.rated", {
    actionId: input.actionId,
    thumb: input.thumb,
  });
  return "ok";
}

export interface RatingView {
  id: string;
  actionId: string;
  actionKind: string;
  thumb: string;
  note: string;
  createdAt: string;
}

export async function runRatings(env: Env, runId: string): Promise<RatingView[]> {
  const rows = await env.DB.prepare(
    `SELECT r.id AS id, r.action_id AS actionId, a.kind AS actionKind,
       r.thumb AS thumb, r.note AS note, r.created_at AS createdAt
     FROM ratings r JOIN actions a ON a.id = r.action_id
     WHERE r.run_id = ? ORDER BY r.created_at, r.rowid`,
  )
    .bind(runId)
    .all<RatingView>();
  return rows.results ?? [];
}

export interface PlaybookView {
  id: string;
  system: string;
  tactic: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export async function listPlaybook(env: Env, orgId: string): Promise<PlaybookView[]> {
  const rows = await env.DB.prepare(
    `SELECT id, system, tactic, status, created_at AS createdAt,
       updated_at AS updatedAt FROM playbook_entries
     WHERE org_id = ? ORDER BY status, tactic LIMIT 200`,
  )
    .bind(orgId)
    .all<PlaybookView>();
  return rows.results ?? [];
}

/** Approved tactics, sorted: the exact lines squads read. */
export async function approvedPlaybook(env: Env, orgId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT tactic FROM playbook_entries WHERE org_id = ? AND status = 'approved' ORDER BY tactic",
  )
    .bind(orgId)
    .all<{ tactic: string }>();
  return (rows.results ?? []).map((r) => r.tactic);
}

export async function updatePlaybookEntry(
  env: Env,
  orgId: string,
  entryId: string,
  patch: { status?: string; tactic?: string },
): Promise<boolean> {
  if (patch.status !== undefined && !isPlaybookStatus(patch.status)) {
    throw new BadPlaybook(`bad status ${patch.status}`);
  }
  if (patch.tactic !== undefined && patch.tactic.trim().length < 10) {
    throw new BadPlaybook("tactic needs 10+ characters");
  }
  const sets = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.tactic !== undefined) {
    sets.push("tactic = ?");
    vals.push(patch.tactic.trim().slice(0, 300));
  }
  vals.push(entryId, orgId);
  const res = await env.DB.prepare(
    `UPDATE playbook_entries SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`,
  )
    .bind(...vals)
    .run();
  if ((res.meta.changes ?? 0) > 0) {
    await audit(env, null, "human", "playbook.updated", { org: orgId, entry: entryId, ...patch });
    return true;
  }
  return false;
}

/**
 * Nightly distill, driven by the 5-minute cron behind a day marker:
 * undistilled ratings become draft tactics, then mark distilled so a
 * rating is ever distilled once (re-rates reset the flag).
 */
/**
 * Nightly ticket themes: for orgs with HubSpot and a support-adjacent
 * goal, recurring complaint patterns in recently closed tickets become
 * lesson drafts. Capped at 3 per org per week; silent when empty.
 */
export async function tickTicketThemes(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const marker = await env.DB.prepare(
      "SELECT value FROM job_markers WHERE job = 'ticket-themes'",
    ).first<{ value: string }>();
    if (marker?.value === today) return;
    const orgs = await env.DB.prepare(
      `SELECT DISTINCT t.org_id AS id FROM oauth_tokens t JOIN goals g ON g.org_id = t.org_id
       WHERE t.provider = 'hubspot' AND g.status = 'active'
       AND (g.metric_source LIKE 'hubspot%' OR lower(g.title) LIKE '%support%' OR lower(g.title) LIKE '%ticket%')`,
    ).all<{ id: string }>();
    for (const org of orgs.results ?? []) {
      try {
        await themesForOrg(env, org.id);
      } catch (err) {
        await audit(env, null, "system", "themes.failed", {
          org: org.id,
          error: String(err).slice(0, 200),
        });
      }
    }
    await env.DB.prepare(
      "INSERT INTO job_markers (job, value) VALUES ('ticket-themes', ?) ON CONFLICT(job) DO UPDATE SET value = excluded.value",
    )
      .bind(today)
      .run();
  } catch (err) {
    await audit(env, null, "system", "themes.failed", {
      error: String(err).slice(0, 200),
    });
  }
}

async function themesForOrg(env: Env, orgId: string): Promise<void> {
  const have = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM playbook_entries WHERE org_id = ? AND system = 'tickets'
     AND status = 'draft' AND datetime(created_at) > datetime('now', '-7 days')`,
  )
    .bind(orgId)
    .first<{ n: number }>();
  if ((have?.n ?? 0) >= 3) return;
  const token = await loadToken(env, orgId, "hubspot");
  if (!token) return;
  const tickets = await recentClosedTickets(token);
  if (tickets.length < 2) return;
  const { tactics } = await runTicketThemes(
    env,
    tickets.map((t) => `- ${t.subject}\n  ${t.content}`.slice(0, 500)).join("\n"),
  );
  for (const t of tactics.slice(0, 3)) {
    await env.DB.prepare(
      "INSERT INTO playbook_entries (id, org_id, system, tactic, status) VALUES (?, ?, ?, ?, 'draft')",
    )
      .bind(crypto.randomUUID(), orgId, "tickets", t)
      .run();
  }
  await audit(env, null, "system", "themes.done", { org: orgId, drafts: tactics.length });
}

export async function distillLearning(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const marker = await env.DB.prepare(
      "SELECT value FROM job_markers WHERE job = 'learning-distill'",
    ).first<{ value: string }>();
    if (marker?.value === today) return;
    const orgs = await env.DB.prepare(
      "SELECT DISTINCT org_id AS id FROM ratings WHERE distilled = 0",
    ).all<{ id: string }>();
    for (const org of orgs.results ?? []) {
      try {
        await distillOrg(env, org.id);
      } catch (err) {
        await audit(env, null, "system", "distill.failed", {
          org: org.id,
          error: String(err).slice(0, 200),
        });
      }
    }
    await env.DB.prepare(
      `INSERT INTO job_markers (job, value) VALUES ('learning-distill', ?)
       ON CONFLICT(job) DO UPDATE SET value = excluded.value`,
    )
      .bind(today)
      .run();
  } catch (err) {
    await audit(env, null, "system", "distill.failed", {
      error: String(err).slice(0, 200),
    });
  }
}

async function distillOrg(env: Env, orgId: string): Promise<void> {
  const items = await env.DB.prepare(
    `SELECT r.id AS id, a.kind AS kind, r.thumb AS thumb, r.note AS note
     FROM ratings r JOIN actions a ON a.id = r.action_id
     WHERE r.org_id = ? AND r.distilled = 0 ORDER BY r.rowid LIMIT 50`,
  )
    .bind(orgId)
    .all<{ id: string; kind: string; thumb: string; note: string }>();
  const rows = items.results ?? [];
  if (rows.length === 0) return;
  const { tactics, tokens } = await runDistill(
    env,
    rows.map((r) => ({ actionKind: r.kind, thumb: r.thumb, note: r.note })),
  );
  for (const t of tactics) {
    await env.DB.prepare(
      "INSERT INTO playbook_entries (id, org_id, system, tactic, status) VALUES (?, ?, ?, ?, 'draft')",
    )
      .bind(crypto.randomUUID(), orgId, t.system, t.tactic)
      .run();
  }
  for (const r of rows) {
    await env.DB.prepare("UPDATE ratings SET distilled = 1 WHERE id = ?").bind(r.id).run();
  }
  await audit(env, null, "system", "distill.done", {
    org: orgId,
    ratings: rows.length,
    drafts: tactics.length,
    tokens,
  });
}
