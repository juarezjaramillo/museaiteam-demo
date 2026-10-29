import {
  isApprovalMode,
  isGoalStatus,
  isMetricSource,
  isSchedule,
  metricPreset,
  type SeatRole,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit, getRun } from "./db.js";
import { teamInOrg } from "./teams.js";

export interface Goal {
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
  approval_mode: string;
  status: string;
  squad: SeatRole[];
  external_refs: Record<string, string>;
  last_check_at: string | null;
  created_at: string;
}

export interface GoalInput {
  teamId?: string;
  title: string;
  metricName?: string;
  metricSource?: string;
  metricBaseline?: number;
  metricTarget?: number;
  deadline?: string;
  schedule?: string;
  approvalMode?: string;
}

export class BadGoal extends Error {}

function parseGoal(row: Record<string, unknown> & { id: string }): Goal {
  let squad: SeatRole[] = [];
  let refs: Record<string, string> = {};
  try {
    const s = JSON.parse(String(row.squad ?? "[]")) as unknown;
    if (Array.isArray(s)) squad = s.filter((r): r is SeatRole => typeof r === "string");
  } catch {
    /* keep empty */
  }
  try {
    const r = JSON.parse(String(row.external_refs ?? "{}")) as unknown;
    if (r && typeof r === "object") refs = r as Record<string, string>;
  } catch {
    /* keep empty */
  }
  return {
    id: row.id,
    org_id: String(row.org_id),
    team_id: (row.team_id as string | null) ?? null,
    title: String(row.title),
    metric_name: (row.metric_name as string | null) ?? null,
    metric_source: (row.metric_source as string | null) ?? null,
    metric_baseline: (row.metric_baseline as number | null) ?? null,
    metric_target: (row.metric_target as number | null) ?? null,
    deadline: (row.deadline as string | null) ?? null,
    schedule: String(row.schedule ?? "manual"),
    approval_mode: String(row.approval_mode ?? "posthoc"),
    status: String(row.status ?? "active"),
    squad,
    external_refs: refs,
    last_check_at: (row.last_check_at as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
  };
}

interface CleanGoal {
  teamId: string | null;
  title: string;
  metricName?: string;
  metricSource?: string;
  metricBaseline?: number;
  metricTarget?: number;
  deadline?: string;
  schedule: string;
  approvalMode: string;
}

function checked(input: GoalInput): CleanGoal {
  const title = input.title.trim();
  if (title.length < 8) throw new BadGoal("goal title needs 8+ characters");
  const schedule = input.schedule ?? "manual";
  if (!isSchedule(schedule)) throw new BadGoal(`bad schedule ${schedule}`);
  const approvalMode = input.approvalMode ?? "posthoc";
  if (!isApprovalMode(approvalMode)) {
    throw new BadGoal(`bad approval mode ${approvalMode}`);
  }
  if (input.deadline !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.deadline)) {
    throw new BadGoal("deadline must be YYYY-MM-DD");
  }
  if (input.metricSource !== undefined && !isMetricSource(input.metricSource)) {
    throw new BadGoal(`bad metric source ${input.metricSource}`);
  }
  return {
    teamId: input.teamId ?? null,
    title,
    metricName: input.metricName,
    // No metric at all stays null; a named metric without a source gets
    // the playbook preset (or explicit manual when nothing matches).
    metricSource:
      input.metricSource ??
      (input.metricName ? metricPreset(input.metricName) : undefined),
    metricBaseline: input.metricBaseline,
    metricTarget: input.metricTarget,
    deadline: input.deadline,
    schedule,
    approvalMode,
  };
}

export async function createGoal(
  env: Env,
  orgId: string,
  input: GoalInput,
): Promise<string> {
  const g = checked(input);
  if (g.teamId && !(await teamInOrg(env, orgId, g.teamId))) {
    throw new BadGoal("unknown team");
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO goals (id, org_id, team_id, title, metric_name, metric_source,
      metric_baseline, metric_target, deadline, schedule, approval_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      orgId,
      g.teamId,
      g.title,
      g.metricName ?? null,
      g.metricSource ?? null,
      g.metricBaseline ?? null,
      g.metricTarget ?? null,
      g.deadline ?? null,
      g.schedule,
      g.approvalMode,
    )
    .run();
  // The squad staffs lazily at the first work run (§2 claim) so creation
  // stays fast and pick tokens meter to the run that needs them.
  await addEvent(env, id, "goal.created", g.title, { schedule: g.schedule });
  await audit(env, null, "human", "goal.created", { org: orgId, goal: id });
  return id;
}

export async function getGoal(
  env: Env,
  orgId: string,
  goalId: string,
): Promise<Goal | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM goals WHERE id = ? AND org_id = ?",
  )
    .bind(goalId, orgId)
    .first<Record<string, unknown> & { id: string }>();
  return row ? parseGoal(row) : null;
}

export async function listGoals(env: Env, orgId: string): Promise<Goal[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM goals WHERE org_id = ? ORDER BY rowid DESC",
  )
    .bind(orgId)
    .all<Record<string, unknown> & { id: string }>();
  return (rows.results ?? []).map(parseGoal);
}

export async function updateGoal(
  env: Env,
  orgId: string,
  goalId: string,
  patch: Partial<
    Pick<
      Goal,
      | "title"
      | "metric_name"
      | "metric_source"
      | "metric_baseline"
      | "metric_target"
      | "deadline"
      | "schedule"
      | "approval_mode"
      | "status"
    >
  >,
): Promise<boolean> {
  if (patch.schedule !== undefined && !isSchedule(patch.schedule)) {
    throw new BadGoal(`bad schedule ${patch.schedule}`);
  }
  if (patch.approval_mode !== undefined && !isApprovalMode(patch.approval_mode)) {
    throw new BadGoal(`bad approval mode ${patch.approval_mode}`);
  }
  if (patch.status !== undefined && !isGoalStatus(patch.status)) {
    throw new BadGoal(`bad status ${patch.status}`);
  }
  if (
    patch.metric_source !== undefined &&
    patch.metric_source !== null &&
    !isMetricSource(patch.metric_source)
  ) {
    throw new BadGoal(`bad metric source ${patch.metric_source}`);
  }
  if (
    patch.title !== undefined ||
    patch.metric_name !== undefined ||
    patch.metric_source !== undefined ||
    patch.metric_baseline !== undefined ||
    patch.metric_target !== undefined ||
    patch.deadline !== undefined
  ) {
    const title = patch.title?.trim();
    if (title !== undefined && title.length < 8) {
      throw new BadGoal("goal title needs 8+ characters");
    }
    if (patch.deadline !== undefined && patch.deadline !== null && !/^\d{4}-\d{2}-\d{2}$/.test(patch.deadline)) {
      throw new BadGoal("deadline must be YYYY-MM-DD");
    }
  }
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  for (const [col, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    sets.push(`${col} = ?`);
    vals.push(val);
  }
  if (vals.length === 0) return true;
  vals.push(goalId, orgId);
  const res = await env.DB.prepare(
    `UPDATE goals SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`,
  )
    .bind(...vals)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function addEvent(
  env: Env,
  goalId: string,
  kind: string,
  title: string,
  detail: unknown = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO goal_events (goal_id, kind, title, detail) VALUES (?, ?, ?, ?)",
  )
    .bind(goalId, kind, title, JSON.stringify(detail))
    .run();
}

export async function recordMetricPoint(
  env: Env,
  goalId: string,
  value: number,
  source: "pull" | "entry",
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO metric_points (goal_id, value, source) VALUES (?, ?, ?)",
  )
    .bind(goalId, value, source)
    .run();
  await addEvent(env, goalId, "metric.point", `Metric: ${value} (${source})`, {
    value,
    source,
  });
}

export interface TimelineEntry {
  kind: string;
  title: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export async function goalTimeline(
  env: Env,
  goalId: string,
): Promise<TimelineEntry[]> {
  const rows = await env.DB.prepare(
    "SELECT kind, title, detail, created_at FROM goal_events WHERE goal_id = ? ORDER BY rowid DESC LIMIT 100",
  )
    .bind(goalId)
    .all<{ kind: string; title: string; detail: string; created_at: string }>();
  return (rows.results ?? []).map((r) => {
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(r.detail) as Record<string, unknown>;
    } catch {
      /* keep empty */
    }
    return { kind: r.kind, title: r.title, detail, created_at: r.created_at };
  });
}

export async function metricSeries(
  env: Env,
  goalId: string,
): Promise<Array<{ ts: string; value: number; source: string }>> {
  const rows = await env.DB.prepare(
    "SELECT ts, value, source FROM metric_points WHERE goal_id = ? ORDER BY rowid LIMIT 365",
  )
    .bind(goalId)
    .all<{ ts: string; value: number; source: string }>();
  return rows.results ?? [];
}

/** Closes the run's chapter in its goal history: ruling + artifacts + cost. */
export async function recordRunSummary(
  env: Env,
  runId: string,
  status: string,
): Promise<void> {
  try {
    const run = await getRun(env, runId);
    if (!run?.goal_id) return;
    const ruling = await env.DB.prepare(
      `SELECT decision FROM rulings WHERE run_id = ?
       ORDER BY attempt DESC LIMIT 1`,
    )
      .bind(runId)
      .first<{ decision: string }>();
    const actions = await env.DB.prepare(
      "SELECT kind, status FROM actions WHERE run_id = ? ORDER BY rowid",
    )
      .bind(runId)
      .all<{ kind: string; status: string }>();
    await addEvent(env, run.goal_id, `run.${status}`, run.goal.slice(0, 80), {
      runId,
      decision: ruling?.decision ?? null,
      actions: (actions.results ?? []).map((a) => `${a.kind}:${a.status}`),
      tokens: run.tokens_used,
    });
  } catch {
    /* history is best-effort; the run already settled */
  }
}
