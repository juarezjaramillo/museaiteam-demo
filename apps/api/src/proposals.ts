import { trialStatus, type TrialRow } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { runPropose } from "./agents.js";
import { chargeIdea, ideaBudget } from "./allowance.js";
import { BadGoal, createGoal, getGoal } from "./goals.js";
import type { McpServerRow } from "./mcp.js";
import { recall } from "./memory.js";
import { notify } from "./notify.js";
import { tryDMOwner } from "./slack-in.js";
import { RunConflict, RunThrottled, createWorkRun } from "./staffing.js";

export interface ProposalRow {
  id: string;
  kind: string;
  goal_id: string | null;
  title: string;
  body: string;
  status: string;
  remind_at: string;
  start_at: string;
  run_id: string | null;
  created_at: string;
}

/**
 * Proactive loop, on the 5-min tick. Advances due proposals
 * (remind → start) and drafts one fresh proposal per idle org per day.
 */
export async function tickProposals(env: Env): Promise<void> {
  const orgs = await env.DB.prepare(
    "SELECT id, trial_started_at, trial_ends_at, grace_used, subscribed FROM orgs WHERE id NOT IN ('demo', 'sandbox')",
  ).all<{ id: string } & TrialRow>();
  for (const org of orgs.results ?? []) {
    try {
      if (trialStatus(Date.now(), org).state === "expired") continue;
      await advanceDue(env, org.id);
      await draftIfIdle(env, org.id);
    } catch (err) {
      await audit(env, null, "system", "proposal.tick_failed", {
        org: org.id,
        error: String(err).slice(0, 200),
      });
    }
  }
}

async function advanceDue(env: Env, orgId: string): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT * FROM proposals_out WHERE org_id = ? AND status IN ('proposed', 'reminded')
     AND datetime(start_at) <= datetime('now') OR org_id = ? AND status = 'proposed'
     AND datetime(remind_at) <= datetime('now')`,
  )
    .bind(orgId, orgId)
    .all<ProposalRow>();
  for (const p of due.results ?? []) {
    try {
      const startDue = Date.parse(`${p.start_at}Z`) <= Date.now();
      if (p.status === "proposed" && !startDue) {
        await env.DB.prepare("UPDATE proposals_out SET status = 'reminded' WHERE id = ?")
          .bind(p.id)
          .run();
        await notify(env, orgId, {
          kind: "proposal.reminded",
          title: `Reminder: ${p.title}`.slice(0, 120),
          body: "Still queued. It starts on its own if you stay silent.",
          link: `proposal:${p.id}`,
        });
        await audit(env, null, "system", "proposal.reminded", { org: orgId, id: p.id });
        continue;
      }
      await startProposal(env, orgId, p);
    } catch (err) {
      await audit(env, null, "system", "proposal.advance_failed", {
        org: orgId,
        id: p.id,
        error: String(err).slice(0, 200),
      });
    }
  }
}

/**
 * Auto-start bounds, enforced before anything runs: the night must have
 * idea budget left, and next-work must run review-after so the sweep
 * holds money acts for a human. New goals are born review-after +
 * manual, so they always satisfy the second bound.
 */
async function startProposal(env: Env, orgId: string, p: ProposalRow): Promise<void> {
  // Signups never auto-start: creating the account is the founder's
  // hands, so silence holds the idea instead of starting a session.
  if (p.kind === "signup") {
    await holdProposal(env, orgId, p, "creating the account needs you");
    return;
  }
  const budget = await ideaBudget(env, orgId);
  if (budget.left <= 0) {
    await holdProposal(env, orgId, p, "nightly idea budget spent");
    return;
  }
  let goalId = p.goal_id;
  if (p.kind === "new-goal" || !goalId) {
    try {
      goalId = await createGoal(env, orgId, {
        title: p.title,
        schedule: "manual",
        approvalMode: "posthoc",
      });
    } catch (err) {
      if (err instanceof BadGoal) {
        await holdProposal(env, orgId, p, "idea too short to become a goal");
        return;
      }
      throw err;
    }
  } else {
    const goal = await getGoal(env, orgId, goalId);
    if (!goal || goal.status !== "active") {
      await holdProposal(env, orgId, p, "goal no longer active");
      return;
    }
    if (goal.approval_mode !== "posthoc") {
      await holdProposal(env, orgId, p, "goal needs check-first; a human must start it");
      return;
    }
  }
  try {
    const created = await createWorkRun(env, {
      orgId,
      goalId,
      goal: `${p.title} — ${p.body}`.slice(0, 500),
    });
    await env.DB.prepare(
      `UPDATE proposals_out SET status = 'started', run_id = ?, goal_id = ?,
       decided_at = datetime('now') WHERE id = ?`,
    )
      .bind(created.runId, goalId, p.id)
      .run();
    await notify(env, orgId, {
      kind: "proposal.started",
      title: `Started: ${p.title}`.slice(0, 120),
      body: "No response in time, so the team began. Undo is one tap.",
      link: `proposal:${p.id}`,
    });
    await audit(env, null, "system", "proposal.started", {
      org: orgId,
      id: p.id,
      runId: created.runId,
    });
  } catch (err) {
    if (err instanceof RunThrottled || err instanceof RunConflict) {
      await holdProposal(env, orgId, p, String(err).slice(0, 160));
      return;
    }
    throw err;
  }
}

async function holdProposal(env: Env, orgId: string, p: ProposalRow, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE proposals_out SET status = 'held', decided_at = datetime('now') WHERE id = ?`,
  )
    .bind(p.id)
    .run();
  await notify(env, orgId, {
    kind: "proposal.started",
    title: `Held: ${p.title}`.slice(0, 120),
    body: `The team did not start this on its own: ${reason}.`,
    link: `proposal:${p.id}`,
  });
  await audit(env, null, "system", "proposal.held", { org: orgId, id: p.id, reason });
}

async function draftIfIdle(env: Env, orgId: string): Promise<void> {
  const today = await env.DB.prepare(
    `SELECT id FROM proposals_out WHERE org_id = ?
     AND date(created_at) = date('now') LIMIT 1`,
  )
    .bind(orgId)
    .first<{ id: string }>();
  if (today) return;
  const live = await env.DB.prepare(
    `SELECT id FROM runs WHERE org_id = ?
     AND status NOT IN ('done', 'failed', 'halted') LIMIT 1`,
  )
    .bind(orgId)
    .first<{ id: string }>();
  if (live) return;
  const goals = await env.DB.prepare(
    "SELECT id, title, metric_name FROM goals WHERE org_id = ? AND status = 'active'",
  )
    .bind(orgId)
    .all<{ id: string; title: string; metric_name: string | null }>();
  const active = goals.results ?? [];
  if (active.length > 0) {
    const recent = await env.DB.prepare(
      `SELECT id FROM runs WHERE org_id = ? AND kind IN ('work', 'revision')
       AND datetime(created_at) > datetime('now', '-7 days') LIMIT 1`,
    )
      .bind(orgId)
      .first<{ id: string }>();
    if (recent) return;
  }
  const budget = await ideaBudget(env, orgId);
  if (budget.left <= 0) return;
  const numbers = await env.DB.prepare(
    `SELECT g.title AS t, (SELECT value FROM metric_points WHERE goal_id = g.id ORDER BY rowid DESC LIMIT 1) AS v
     FROM goals g WHERE g.org_id = ? AND g.status = 'active' LIMIT 8`,
  )
    .bind(orgId)
    .all<{ t: string; v: number | null }>();
  const memory = await recall(env, orgId, "what worked best").catch(() => []);
  const draft = await runPropose(env, {
    goals: active.map((g) => `- ${g.id}: ${g.title}${g.metric_name ? ` (${g.metric_name})` : ""}`).join("\n"),
    numbers: (numbers.results ?? [])
      .filter((n) => n.v !== null)
      .map((n) => `${n.t}: ${n.v}`)
      .join("; "),
    memory: memory.map((m) => m.text),
  });
  await chargeIdea(env, orgId, draft.tokens, "idle proposal");
  if (draft.title.trim().length < 8) {
    await audit(env, null, "system", "proposal.dropped_short", { org: orgId });
    return;
  }
  let kind = draft.kind;
  let goalId = draft.goalId;
  if (kind === "next-work" && !active.some((g) => g.id === goalId)) {
    kind = "new-goal";
    goalId = null;
  }
  const grace = await env.DB.prepare(
    "SELECT proposal_grace_hours FROM orgs WHERE id = ?",
  )
    .bind(orgId)
    .first<{ proposal_grace_hours: number | null }>();
  const hours = Math.min(168, Math.max(24, grace?.proposal_grace_hours ?? 72));
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO proposals_out (id, org_id, kind, goal_id, title, body, status, remind_at, start_at)
     VALUES (?, ?, ?, ?, ?, ?, 'proposed', datetime('now', '+1 day'), datetime('now', ?))`,
  )
    .bind(id, orgId, kind, goalId, draft.title, draft.body, `+${hours} hours`)
    .run();
  await notify(env, orgId, {
    kind: "proposal.proposed",
    title: `New idea: ${draft.title}`.slice(0, 120),
    body: `${draft.body.slice(0, 200)} Starts on its own in ${hours}h unless you answer.`,
    link: `proposal:${id}`,
  });
  await tryDMOwner(env, orgId, `New idea: ${draft.title}\n${draft.body.slice(0, 300)}\nStarts on its own in ${hours}h unless you answer.`).catch(() => {});
  await audit(env, null, "system", "proposal.proposed", { org: orgId, id });
}

export async function listProposals(env: Env, orgId: string): Promise<ProposalRow[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM proposals_out WHERE org_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50",
  )
    .bind(orgId)
    .all<ProposalRow>();
  return rows.results ?? [];
}

/**
 * The loop calls this when a server answers "who are you": the team
 * needs an account it cannot create itself. One pending signup per
 * server — repeats while the founder thinks are dropped, not stacked.
 */
export async function requestSignup(
  env: Env,
  orgId: string,
  server: McpServerRow,
  detail: string,
): Promise<string | null> {
  const title = `Connect ${server.name}`;
  const open = await env.DB.prepare(
    `SELECT id FROM proposals_out WHERE org_id = ? AND kind = 'signup'
     AND title = ? AND status IN ('proposed', 'reminded') LIMIT 1`,
  )
    .bind(orgId, title)
    .first<{ id: string }>();
  if (open) return null;
  const id = crypto.randomUUID();
  const body = [
    `The team tried to use ${server.name} (${server.url}) and was asked to sign in.`,
    server.spend_cap_cents > 0
      ? `Paid trials are OK up to $${(server.spend_cap_cents / 100).toFixed(2)} on this server.`
      : "Paid plans need your explicit OK — the cap on this server is $0.",
    `Server said: ${detail.slice(0, 200)}`,
  ].join(" ");
  await env.DB.prepare(
    `INSERT INTO proposals_out (id, org_id, kind, goal_id, title, body, status, remind_at, start_at)
     VALUES (?, ?, 'signup', NULL, ?, ?, 'proposed', datetime('now', '+1 day'), datetime('now', '+3 days'))`,
  )
    .bind(id, orgId, title, body)
    .run();
  await notify(env, orgId, {
    kind: "proposal.proposed",
    title: `New idea: ${title}`.slice(0, 120),
    body: `${body.slice(0, 200)} Approve for guided steps.`,
    link: `proposal:${id}`,
  });
  await tryDMOwner(env, orgId, `New idea: ${title}\n${body.slice(0, 300)}`).catch(() => {});
  await audit(env, null, "system", "proposal.signup_proposed", { org: orgId, id });
  return id;
}

/** Approve on a signup hands the founder guided-connect steps, not a session. */
async function startSignup(env: Env, orgId: string, p: ProposalRow): Promise<void> {
  await env.DB.prepare(
    "UPDATE proposals_out SET status = 'started', decided_at = datetime('now') WHERE id = ?",
  )
    .bind(p.id)
    .run();
  await notify(env, orgId, {
    kind: "proposal.started",
    title: `Connect it: ${p.title}`.slice(0, 120),
    body: "Three steps: 1) create the account on the service's site, 2) copy its API key, 3) paste it under Setup → Tool servers. The team picks it up from the next session.",
    link: `proposal:${p.id}`,
  });
  await audit(env, null, "human", "proposal.signup_approved", { org: orgId, id: p.id });
}

/** Founder decision on an idea: approve starts now, reject holds it. */
export async function decideProposal(
  env: Env,
  orgId: string,
  id: string,
  decision: "approve" | "reject",
  note?: string,
): Promise<"ok" | "notfound" | "decided"> {
  const row = await env.DB.prepare(
    "SELECT * FROM proposals_out WHERE id = ? AND org_id = ?",
  )
    .bind(id, orgId)
    .first<ProposalRow>();
  if (!row) return "notfound";
  if (row.status !== "proposed" && row.status !== "reminded") return "decided";
  if (row.kind === "signup" && decision === "approve") {
    await startSignup(env, orgId, row);
    return "ok";
  }
  if (decision === "reject") {
    await env.DB.prepare(
      "UPDATE proposals_out SET status = 'rejected', decided_at = datetime('now') WHERE id = ?",
    )
      .bind(id)
      .run();
    await audit(env, null, "human", "proposal.rejected", { org: orgId, id, note: note ?? "" });
    return "ok";
  }
  await startProposal(env, orgId, row);
  return "ok";
}
