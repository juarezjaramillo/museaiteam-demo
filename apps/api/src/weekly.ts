import { digestWeek, trialStatus, type TrialRow } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { checkGuard } from "./guards.js";
import { runRetro } from "./agents.js";
import { findChannelId, postMessage } from "./integrations/slack.js";
import { notify } from "./notify.js";
import {
  getProviderConfig,
  loadToken,
  setProviderConfig,
} from "./oauth.js";

/**
 * Weekly channel digest, one per org per ISO week. The provider config
 * carries the posted-week marker, so overlapping cron ticks can't
 * double-post: the marker write is the claim.
 */
export async function maybePostWeeklyDigest(env: Env): Promise<void> {
  const orgs = await env.DB.prepare(
    "SELECT DISTINCT org_id AS id FROM oauth_tokens WHERE provider = 'slack'",
  ).all<{ id: string }>();
  for (const org of orgs.results ?? []) {
    try {
      await digestForOrg(env, org.id);
    } catch (err) {
      await audit(env, null, "system", "digest.failed", {
        org: org.id,
        error: String(err).slice(0, 200),
      });
    }
  }
}

async function digestForOrg(env: Env, orgId: string): Promise<void> {
  const trial = await env.DB.prepare(
    "SELECT trial_started_at, trial_ends_at, grace_used, subscribed FROM orgs WHERE id = ?",
  )
    .bind(orgId)
    .first<TrialRow>();
  if (!trial || trialStatus(Date.now(), trial).state === "expired") return;
  const cfg = await getProviderConfig(env, orgId, "slack");
  const week = digestWeek();
  if (cfg.last_digest_week === week) return;
  if (!(await checkGuard(env, orgId, "marketer", "slack", "digest")).allowed) return;
  const token = await loadToken(env, orgId, "slack");
  if (!token) return;
  const channel = await findChannelId(token, env.DEMO_SLACK_CHANNEL);
  if (!channel) return;
  const counts = await env.DB.prepare(
    `SELECT status, COUNT(*) AS c FROM runs WHERE org_id = ?
     AND kind IN ('work', 'revision') AND datetime(created_at) > datetime('now', '-7 days')
     GROUP BY status`,
  )
    .bind(orgId)
    .all<{ status: string; c: number }>();
  const ships = await env.DB.prepare(
    `SELECT ru.decision AS d FROM rulings ru JOIN runs r ON r.id = ru.run_id
     WHERE r.org_id = ? AND datetime(r.created_at) > datetime('now', '-7 days')
     ORDER BY r.rowid DESC LIMIT 3`,
  )
    .bind(orgId)
    .all<{ d: string }>();
  const by = new Map((counts.results ?? []).map((r) => [r.status, r.c]));
  const done = by.get("done") ?? 0;
  const awaiting = by.get("awaiting_approval") ?? 0;
  const failed = (by.get("failed") ?? 0) + (by.get("halted") ?? 0);
  const lines = [
    `:bar_chart: AI team — week ${week}`,
    `• ${done} session${done === 1 ? "" : "s"} shipped${awaiting ? `, ${awaiting} awaiting approval` : ""}${failed ? `, ${failed} failed` : ""}`,
    ...((ships.results ?? []).map((s) => `• ${s.d.slice(0, 100)}`)),
  ];
  if (done > 0) {
    try {
      const retro = await retroForOrg(env, orgId);
      if (retro) {
        lines.push(`Retro (Morgan): ${retro.retro.slice(0, 400)}`);
        for (const t of retro.tactics) {
          await env.DB.prepare(
            "INSERT INTO playbook_entries (id, org_id, system, tactic, status) VALUES (?, ?, ?, ?, 'draft')",
          )
            .bind(crypto.randomUUID(), orgId, "retro", t)
            .run();
        }
      }
    } catch (err) {
      await audit(env, null, "system", "digest.retro_failed", {
        org: orgId,
        error: String(err).slice(0, 200),
      });
    }
  }
  await postMessage(token, channel, lines.join("\n"));
  await notify(env, orgId, {
    kind: "digest.weekly",
    title: `Week ${week}: ${done} session${done === 1 ? "" : "s"} finished`,
    body: lines.slice(1).join("\n").slice(0, 500),
  });
  await setProviderConfig(env, orgId, "slack", { ...cfg, last_digest_week: week });
  await audit(env, null, "system", "digest.weekly_posted", { org: orgId, week });
}

async function retroForOrg(
  env: Env,
  orgId: string,
): Promise<{ retro: string; tactics: string[] } | null> {
  const rows = await env.DB.prepare(
    `SELECT goal, self_critique FROM runs WHERE org_id = ?
     AND kind IN ('work', 'revision') AND status = 'done'
     AND datetime(created_at) > datetime('now', '-7 days')
     ORDER BY rowid DESC LIMIT 10`,
  )
    .bind(orgId)
    .all<{ goal: string; self_critique: string | null }>();
  const sessions = (rows.results ?? [])
    .map((r) => `- ${r.goal.slice(0, 80)}${r.self_critique ? ` / judged: ${r.self_critique.slice(0, 200)}` : ""}`)
    .join("\n");
  if (!sessions) return null;
  const deltas = await env.DB.prepare(
    `SELECT g.title AS t, (SELECT value FROM metric_points WHERE goal_id = g.id ORDER BY rowid DESC LIMIT 1) AS last,
       (SELECT value FROM metric_points WHERE goal_id = g.id ORDER BY rowid DESC LIMIT 1 OFFSET 6) AS prev
     FROM goals g WHERE g.org_id = ? AND g.status = 'active' LIMIT 10`,
  )
    .bind(orgId)
    .all<{ t: string; last: number | null; prev: number | null }>();
  const numbers = (deltas.results ?? [])
    .filter((d) => d.last !== null)
    .map((d) => `${d.t.slice(0, 40)}: ${d.prev ?? "?"} -> ${d.last}`)
    .join("; ");
  const { retro, tactics } = await runRetro(env, {
    weekLine: `Week numbers: ${numbers || "(no numbers yet)"}`,
    sessions,
  });
  return { retro, tactics };
}
