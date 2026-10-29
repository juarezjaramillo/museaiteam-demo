import type { Env } from "./bindings.js";
import { audit, getRun } from "./db.js";
import { approveAction, decidePreApproval } from "./approvals.js";
import { executeRevert } from "./revert.js";
import { promoteQueued, settleAwaitingKill } from "./staffing.js";
import { notify } from "./notify.js";
import { recall } from "./memory.js";
import { addFeedback, recallFeedback } from "./feedback.js";
import { runAnswer, runTriage } from "./agents.js";
import { getProviderConfig, loadToken } from "./oauth.js";
import {
  postDM,
  replyToThread,
  threadReplies,
} from "./integrations/slack.js";

/** HMAC check for Slack event callbacks; rejects stale replays. */
export async function verifySlack(
  env: Env,
  raw: string,
  timestamp: string,
  signature: string,
): Promise<boolean> {
  if (!env.SLACK_SIGNING_SECRET) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${raw}`),
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}` === signature;
}

/** Claim an event id; retries return false so Slack retries never double-act. */
export async function claimEvent(env: Env, eventId: string): Promise<boolean> {
  const ins = await env.DB.prepare(
    "INSERT INTO slack_seen_events (event_id) VALUES (?) ON CONFLICT DO NOTHING",
  )
    .bind(eventId)
    .run();
  await env.DB.prepare(
    "DELETE FROM slack_seen_events WHERE datetime(created_at) < datetime('now', '-1 day')",
  ).run();
  return (ins.meta.changes ?? 0) === 1;
}

export async function orgForTeam(env: Env, teamId: string): Promise<string | null> {
  const rows = await env.DB.prepare(
    "SELECT org_id, config FROM provider_config WHERE provider = 'slack'",
  ).all<{ org_id: string; config: string }>();
  for (const r of rows.results ?? []) {
    try {
      const cfg = JSON.parse(r.config) as { teamId?: unknown };
      if (cfg.teamId === teamId) return r.org_id;
    } catch {
      /* skip */
    }
  }
  return null;
}

export interface SlackEvent {
  type: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  channel_type?: string;
}

/** Async event body: ack already sent, so this never blocks Slack's 3s clock. */
export async function handleSlackEvent(
  env: Env,
  teamId: string,
  eventId: string,
  event: SlackEvent,
): Promise<void> {
  if (event.subtype === "bot_message" || event.bot_id) return;
  if (!(await claimEvent(env, eventId))) return;
  const orgId = await orgForTeam(env, teamId);
  if (!orgId) {
    await audit(env, null, "system", "slack.unknown_team", { team: teamId });
    return;
  }
  const token = await loadToken(env, orgId, "slack");
  if (!token) return;
  try {
    if (event.type === "app_mention") {
      await answerMention(env, orgId, token, event);
    } else if (
      event.type === "message" &&
      event.channel_type === "im" &&
      !event.subtype
    ) {
      await answerDM(env, orgId, token, event);
    }
  } catch (err) {
    await audit(env, null, "system", "slack.answer_failed", {
      org: orgId,
      error: String(err).slice(0, 200),
    });
  }
}

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

async function answerMention(
  env: Env,
  orgId: string,
  token: string,
  event: SlackEvent,
): Promise<void> {
  const channel = event.channel ?? "";
  const ts = event.ts ?? "";
  const threadTs = event.thread_ts ?? ts;
  const question = stripMention(event.text ?? "");
  if (!channel || !ts || !question) return;
  const [replies, memory, feedback] = await Promise.all([
    threadReplies(token, channel, threadTs).catch(() => []),
    recall(env, orgId, question).catch(() => []),
    recallFeedback(env, orgId).catch(() => []),
  ]);
  const thread = replies.map((r) => `${r.user}: ${r.text}`).join("\n");
  const { text } = await runAnswer(env, {
    question,
    thread,
    memory: memory.map((m) => m.text),
    feedback,
  });
  await addFeedback(env, orgId, "slack-thread", question).catch(() => {});
  await replyToThread(token, channel, threadTs, `${text}\n— Morgan`);
  await audit(env, null, "system", "slack.mentioned", { org: orgId });
}

async function answerDM(
  env: Env,
  orgId: string,
  token: string,
  event: SlackEvent,
): Promise<void> {
  const user = event.user ?? "";
  const channel = event.channel ?? "";
  const text = (event.text ?? "").trim();
  if (!user || !channel || !text) return;
  const cfg = await getProviderConfig(env, orgId, "slack");
  if (typeof cfg.installerUserId !== "string" || cfg.installerUserId !== user) {
    await replyToThread(token, channel, event.ts ?? "", "I only take orders from the team's owner here.");
    return;
  }
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = (rest[0] ?? "").toLowerCase();
  const reply = (t: string) => replyToThread(token, channel, event.ts ?? "", t);
  switch (cmd.toLowerCase()) {
    case "status":
      await reply(await statusLine(env, orgId));
      return;
    case "approve":
      await reply(await dmApprove(env, orgId, arg));
      return;
    case "undo":
      await reply(await dmUndo(env, orgId, arg));
      return;
    case "stop":
      await reply(await dmStop(env, orgId));
      return;
    default:
      break;
  }
  const { kind } = await runTriage(env, text);
  if (kind === "brief") {
    const ideaId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO proposals_out (id, org_id, kind, title, body, status, remind_at, start_at)
       VALUES (?, ?, 'brief', ?, ?, 'proposed', datetime('now', '+1 day'), datetime('now', '+3 days'))`,
    )
      .bind(ideaId, orgId, text.slice(0, 120), text.slice(0, 1000))
      .run();
    await notify(env, orgId, {
      kind: "proposal.proposed",
      title: `New idea from Slack: ${text.slice(0, 80)}`,
      body: "Say approve to start it, or reject with a note.",
      link: `proposal:${ideaId}`,
    });
    await reply("Queued as an idea. Say approve + the idea id to start it, or reject it from Approvals.");
    return;
  }
  const memory = await recall(env, orgId, text).catch(() => []);
  const feedback = await recallFeedback(env, orgId).catch(() => []);
  const { text: answer } = await runAnswer(env, {
    question: text,
    thread: "",
    memory: memory.map((m) => m.text),
    feedback,
  });
  await addFeedback(env, orgId, "slack-dm", text).catch(() => {});
  await reply(`${answer}\n— Morgan`);
}

async function statusLine(env: Env, orgId: string): Promise<string> {
  const runs = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM runs WHERE org_id = ?
     AND status NOT IN ('done', 'failed', 'halted')`,
  )
    .bind(orgId)
    .first<{ n: number }>();
  const pend = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND status = 'pending'",
  )
    .bind(orgId)
    .first<{ n: number }>();
  const ideas = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM proposals_out WHERE org_id = ? AND status = 'proposed'",
  )
    .bind(orgId)
    .first<{ n: number }>();
  return `${runs?.n ?? 0} active sessions, ${pend?.n ?? 0} waiting on you, ${ideas?.n ?? 0} ideas queued.`;
}

async function ownerId(env: Env, orgId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT owner_user_id FROM orgs WHERE id = ?")
    .bind(orgId)
    .first<{ owner_user_id: string | null }>();
  return row?.owner_user_id ?? "slack";
}

async function dmApprove(env: Env, orgId: string, prefix: string): Promise<string> {
  if (!prefix) return "Say approve + the first letters of the wait id (see Approvals).";
  const rows = await env.DB.prepare(
    `SELECT id, kind, run_id, action_id FROM approvals
     WHERE org_id = ? AND status = 'pending' AND id LIKE ? LIMIT 2`,
  )
    .bind(orgId, `${prefix}%`)
    .all<{ id: string; kind: string; run_id: string; action_id: string | null }>();
  const found = rows.results ?? [];
  if (found.length === 0) return "No waiting item starts with that.";
  if (found.length > 1) return "That matches more than one — add more letters.";
  const a = found[0];
  const userId = await ownerId(env, orgId);
  if (a.kind === "pre") {
    const res = await decidePreApproval(env, { runId: a.run_id, userId, decision: "approve" });
    return res.outcome === "approved" ? "Approved — the team is acting." : `Could not approve (${res.outcome}).`;
  }
  if (!a.action_id) return "That wait has nothing to approve.";
  const res = await approveAction(env, { runId: a.run_id, actionId: a.action_id, userId });
  return res === "ok" ? "Approved." : "Could not approve it.";
}

async function dmUndo(env: Env, orgId: string, prefix: string): Promise<string> {
  if (!prefix) return "Say undo + the first letters of the session id.";
  const rows = await env.DB.prepare(
    "SELECT id FROM runs WHERE org_id = ? AND id LIKE ? LIMIT 2",
  )
    .bind(orgId, `${prefix}%`)
    .all<{ id: string }>();
  const found = rows.results ?? [];
  if (found.length === 0) return "No session starts with that.";
  if (found.length > 1) return "That matches more than one — add more letters.";
  await audit(env, found[0].id, "human", "revert.requested");
  const result = await executeRevert(env, orgId, found[0].id);
  return result.failed.length === 0
    ? `Undone: ${result.reverted.length} taken back.`
    : `Took back ${result.reverted.length}, ${result.failed.length} failed.`;
}

async function dmStop(env: Env, orgId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT id FROM runs WHERE org_id = ?
     AND status NOT IN ('done', 'failed', 'halted')
     ORDER BY rowid DESC LIMIT 1`,
  )
    .bind(orgId)
    .first<{ id: string }>();
  if (!row) return "Nothing is running.";
  await env.DB.prepare("UPDATE runs SET kill_flag = 1, updated_at = datetime('now') WHERE id = ?")
    .bind(row.id)
    .run();
  await audit(env, row.id, "human", "run.kill_requested");
  await settleAwaitingKill(env, row.id);
  await promoteQueued(env);
  return "Stopped.";
}

/**
 * Proactive reach: best-effort DM, never a dashboard row. Callers always
 * notify separately, so a failed DM can never duplicate the alert —
 * one event, one row, by construction.
 */
export async function tryDMOwner(env: Env, orgId: string, text: string): Promise<boolean> {
  const token = await loadToken(env, orgId, "slack");
  const cfg = await getProviderConfig(env, orgId, "slack");
  const userId = typeof cfg.installerUserId === "string" ? cfg.installerUserId : "";
  if (!token || !userId) return false;
  try {
    await postDM(token, userId, text);
    return true;
  } catch (err) {
    await audit(env, null, "system", "slack.dm_failed", {
      org: orgId,
      error: String(err).slice(0, 200),
    });
    return false;
  }
}
