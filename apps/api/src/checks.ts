import {
  isGoalDue,
  isOverdue,
  lastTickBefore,
  trialStatus,
  type TrialRow,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { runCheckDecide } from "./agents.js";
import { maybeSendFairUseAlert } from "./billing.js";
import { audit } from "./db.js";
import {
  addEvent,
  goalTimeline,
  metricSeries,
} from "./goals.js";
import { notify } from "./notify.js";
import { pullGoalMetric } from "./pulls.js";
import { RunConflict, RunThrottled, createWorkRun } from "./staffing.js";

function parseSqliteTs(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

interface DueGoal {
  id: string;
  org_id: string;
  team_id: string | null;
  title: string;
  metric_name: string | null;
  metric_source: string | null;
  metric_baseline: number | null;
  metric_target: number | null;
  deadline: string | null;
  schedule: string;
  status: string;
  last_check_at: string | null;
}

async function trialExpired(env: Env, orgId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT trial_started_at, trial_ends_at, grace_used, subscribed FROM orgs WHERE id = ?",
  )
    .bind(orgId)
    .first<TrialRow>();
  if (!row) return true;
  // Pure read: cron must never grant grace as a side effect.
  return trialStatus(Date.now(), row).state === "expired";
}

async function skippedToday(env: Env, goalId: string, kind: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM goal_events WHERE goal_id = ? AND kind = ?
     AND date(created_at) = date('now') LIMIT 1`,
  )
    .bind(goalId, kind)
    .first<{ x: number }>();
  return !!row;
}

/**
 * One scheduled tick for one goal: claim the tick, run the manager's
 * check-in inline (no workflow: it's one pull + one small call), and
 * either start a work run or log a monitoring outcome. Failures land
 * on the goal timeline, never throw past the per-goal boundary.
 */
export async function runCheck(env: Env, goal: DueGoal): Promise<void> {
  if (await trialExpired(env, goal.org_id)) {
    if (!(await skippedToday(env, goal.id, "tick.skipped"))) {
      await addEvent(env, goal.id, "tick.skipped", "Trial expired — checks paused", {
        reason: "trial_expired",
      });
    }
    return;
  }
  await flipOverdueScheduled(env, goal);
  const tick = lastTickBefore(goal.schedule, Date.now());
  if (tick === null) return;
  const tickStart = new Date(tick).toISOString().slice(0, 19).replace("T", " ");
  const claimed = await env.DB.prepare(
    `UPDATE goals SET last_check_at = datetime('now')
     WHERE id = ? AND (last_check_at IS NULL OR last_check_at < ?)`,
  )
    .bind(goal.id, tickStart)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return;

  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO runs (id, org_id, team_id, goal_id, kind, goal, status)
     VALUES (?, ?, ?, ?, 'check', ?, 'open')`,
  )
    .bind(runId, goal.org_id, goal.team_id, goal.id, `Check: ${goal.title}`.slice(0, 200))
    .run();
  try {
    // Fresh point first (or a visible pull failure), then the manager
    // reads the series. Total by construction; belt and braces below.
    try {
      await pullGoalMetric(env, goal);
    } catch {
      /* metric is best-effort; the check still runs */
    }
    const series = await metricSeries(env, goal.id);
    const latest = series.length > 0 ? series[series.length - 1] : null;
    const metricLine = [
      goal.metric_name ? `metric: ${goal.metric_name}` : "metric: (none set)",
      goal.metric_baseline != null ? `baseline: ${goal.metric_baseline}` : null,
      goal.metric_target != null ? `target: ${goal.metric_target}` : null,
      latest ? `latest: ${latest.value} (${latest.source}, ${latest.ts})` : "latest: (no data)",
    ]
      .filter(Boolean)
      .join("; ");
    const timeline = await goalTimeline(env, goal.id);
    const historyLine = timeline
      .slice(0, 5)
      .map((e) => `${e.kind}: ${e.title}`)
      .join(" | ");
    const { decision, tokens } = await runCheckDecide(
      env,
      goal.title,
      metricLine,
      historyLine,
    );
    await env.DB.prepare(
      "UPDATE runs SET tokens_used = ?, status = 'done' WHERE id = ?",
    )
      .bind(tokens, runId)
      .run();
    await maybeSendFairUseAlert(env, goal.org_id).catch(() => {});
    if (decision.action === "run") {
      try {
        const created = await createWorkRun(env, {
          orgId: goal.org_id,
          goalId: goal.id,
          goal: goal.title,
          metricName: goal.metric_name ?? undefined,
          metricBaseline: goal.metric_baseline ?? undefined,
          metricTarget: goal.metric_target ?? undefined,
        });
        await addEvent(env, goal.id, "check.triggered", decision.note, {
          runId: created.runId,
          queued: created.status === "queued",
        });
      } catch (err) {
        const reason =
          err instanceof RunThrottled
            ? "fair-use throttled"
            : err instanceof RunConflict
              ? String(err).slice(0, 120)
              : `failed: ${String(err).slice(0, 120)}`;
        await addEvent(env, goal.id, "check.blocked", decision.note, { reason });
      }
    } else {
      await addEvent(env, goal.id, "check.monitoring", decision.note, { runId });
    }
  } catch (err) {
    await env.DB.prepare("UPDATE runs SET status = 'failed' WHERE id = ?")
      .bind(runId)
      .run();
    await addEvent(env, goal.id, "check.failed", "Check-in failed", {
      runId,
      error: String(err).slice(0, 300),
    });
  }
}

/** Cron entry: tick due goals, flip past-due deadlines with notice. */
export async function tickGoals(env: Env): Promise<void> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id, org_id, team_id, title, metric_name, metric_source,
      metric_baseline, metric_target, deadline, schedule, status, last_check_at
     FROM goals WHERE status IN ('active', 'overdue') AND schedule != 'manual'`,
  ).all<DueGoal>();
  for (const goal of rows.results ?? []) {
    try {
      if (!isGoalDue(goal.schedule, parseSqliteTs(goal.last_check_at), now)) {
        continue;
      }
      await runCheck(env, goal);
    } catch (err) {
      await audit(env, null, "system", "tick.failed", {
        goal: goal.id,
        error: String(err).slice(0, 200),
      });
    }
  }
  // Manual-schedule goals never tick, but their deadlines still lapse.
  const pastDue = await env.DB.prepare(
    `SELECT id, org_id, title FROM goals
     WHERE status = 'active' AND deadline IS NOT NULL AND deadline != ''
     AND deadline < date('now')`,
  ).all<{ id: string; org_id: string; title: string }>();
  for (const goal of pastDue.results ?? []) {
    try {
      await env.DB.prepare("UPDATE goals SET status = 'overdue' WHERE id = ?")
        .bind(goal.id)
        .run();
      await addEvent(env, goal.id, "goal.overdue", "Deadline passed — still working", {});
      await notify(env, goal.org_id, {
        kind: "goal.overdue",
        title: `Overdue: ${goal.title}`.slice(0, 120),
        body: "The deadline passed with the goal still open. Check-ins continue; close or extend it when ready.",
      });
    } catch (err) {
      await audit(env, null, "system", "tick.failed", {
        goal: goal.id,
        error: String(err).slice(0, 200),
      });
    }
  }
}

/**
 * Stalled goals: active, older than 14 days, number unmoved (or never
 * recorded) across the last 14 days. Flagged once per week with an
 * event + notification, never re-run silently.
 */
export async function tickStalled(env: Env): Promise<void> {
  const goals = await env.DB.prepare(
    `SELECT id, org_id, title FROM goals
     WHERE status = 'active' AND datetime(created_at) < datetime('now', '-14 days')`,
  ).all<{ id: string; org_id: string; title: string }>();
  for (const g of goals.results ?? []) {
    try {
      const recent = await env.DB.prepare(
        `SELECT id FROM goal_events WHERE goal_id = ? AND kind = 'goal.stalled'
         AND datetime(created_at) > datetime('now', '-7 days') LIMIT 1`,
      )
        .bind(g.id)
        .first<{ id: string }>();
      if (recent) continue;
      const first = await env.DB.prepare(
        "SELECT value FROM metric_points WHERE goal_id = ? ORDER BY rowid ASC LIMIT 1",
      )
        .bind(g.id)
        .first<{ value: number }>();
      const last = await env.DB.prepare(
        "SELECT value FROM metric_points WHERE goal_id = ? ORDER BY rowid DESC LIMIT 1",
      )
        .bind(g.id)
        .first<{ value: number }>();
      if (first && last && first.value !== last.value) continue;
      await addEvent(env, g.id, "goal.stalled", "Number unmoved for 14 days", {});
      await notify(env, g.org_id, {
        kind: "goal.stalled",
        title: `Stalled: ${g.title}`.slice(0, 120),
        body: "The number has not moved in 2 weeks. Change the goal, or pause it.",
      });
    } catch (err) {
      await audit(env, null, "system", "tick.stalled_failed", {
        goal: g.id,
        error: String(err).slice(0, 200),
      });
    }
  }
}

/** Deadline check for ticked (scheduled) goals: flip + notify once. */
export async function flipOverdueScheduled(env: Env, goal: DueGoal): Promise<void> {
  if (goal.status !== "active" || !isOverdue(goal.deadline, Date.now())) return;
  await env.DB.prepare("UPDATE goals SET status = 'overdue' WHERE id = ?")
    .bind(goal.id)
    .run();
  await addEvent(env, goal.id, "goal.overdue", "Deadline passed — still working", {});
  await notify(env, goal.org_id, {
    kind: "goal.overdue",
    title: `Overdue: ${goal.title}`.slice(0, 120),
    body: "The deadline passed with the goal still open. Check-ins continue; close or extend it when ready.",
  });
}
