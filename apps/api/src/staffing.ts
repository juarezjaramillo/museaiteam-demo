import {
  CLASSIC_ROLES,
  SANDBOX_DAILY_LIMIT,
  SANDBOX_ORG_ID,
  SANDBOX_VOTE_WINDOW_MS,
  VOTE_TIMEOUT_MS,
  hireDisplayName,
  sandboxPreset,
  squadPlan,
  type SeatRole,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import {
  checkFairUse,
  maybeSendFairUseAlert,
  maybeSendUpgradeEmail,
} from "./billing.js";
import { audit, getRun, touchRun } from "./db.js";
import { publishEvent } from "./events.js";
import { notify } from "./notify.js";
import { runSquadPick } from "./agents.js";
import { addEvent, getGoal, recordRunSummary } from "./goals.js";
import { approvedRoles, ensureTeam, teamInOrg, todayBriefText } from "./teams.js";

export class RunConflict extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 409,
  ) {
    super(message);
  }
}
export class RunThrottled extends Error {
  constructor(public meter: unknown) {
    super("fair-use throttled");
  }
}

// Queued runs are waiters, not holders: only started runs lock their squad.
// (Counting queued here let a queued run block itself forever.)
// Ruled runs are mid-flight — debate done, squad still held.
const ACTIVE_STATUSES = ["open", "debating", "ruled", "acting", "awaiting_approval"];

/** Roles currently debating/acting in the org. Kill-flagged runs are
 *  already dead, so their squads are free immediately. */
export async function busyRoles(env: Env, orgId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    `SELECT lineup FROM runs WHERE org_id = ? AND kill_flag = 0
     AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`,
  )
    .bind(orgId, ...ACTIVE_STATUSES)
    .all<{ lineup: string }>();
  const busy = new Set<string>();
  for (const r of rows.results ?? []) {
    try {
      const lineup = JSON.parse(r.lineup) as unknown;
      if (Array.isArray(lineup)) {
        for (const role of lineup) {
          if (typeof role === "string") busy.add(role);
        }
      }
    } catch {
      /* ignore malformed lineups */
    }
  }
  return busy;
}

export async function squadFree(
  env: Env,
  orgId: string,
  squad: SeatRole[],
): Promise<boolean> {
  const busy = await busyRoles(env, orgId);
  return squad.every((r) => !busy.has(r));
}

async function pickFreshSquad(
  env: Env,
  goalTitle: string,
  metricLine: string,
  orgId: string,
): Promise<SeatRole[]> {
  const plan = squadPlan(await approvedRoles(env, orgId));
  if (!plan.needsPick) return plan.squad;
  const pick = await runSquadPick(env, goalTitle, metricLine, plan.roster);
  return pick.squad;
}

/**
 * Staff a goal's frozen squad. First caller wins via conditional claim;
 * racers re-read the winner. Never empty: the classic quartet backs an
 * empty roster (structurally impossible, guarded anyway).
 */
export async function staffGoalSquad(
  env: Env,
  orgId: string,
  goalId: string,
  goalTitle: string,
  metricLine: string,
): Promise<SeatRole[]> {
  const squad = await pickFreshSquad(env, goalTitle, metricLine, orgId);
  const finalSquad = squad.length > 0 ? squad : [...CLASSIC_ROLES];
  const claimed = await env.DB.prepare(
    "UPDATE goals SET squad = ? WHERE id = ? AND org_id = ? AND squad = '[]'",
  )
    .bind(JSON.stringify(finalSquad), goalId, orgId)
    .run();
  if ((claimed.meta.changes ?? 0) === 1) {
    await addEvent(env, goalId, "squad.staffed", `Squad: ${finalSquad.join(", ")}`, {
      squad: finalSquad,
    });
    return finalSquad;
  }
  const goal = await getGoal(env, orgId, goalId);
  return goal && goal.squad.length > 0 ? goal.squad : [...CLASSIC_ROLES];
}

/** Founder re-staff: unconditional, audited, effective for later runs. */
export async function restaffGoal(
  env: Env,
  orgId: string,
  goalId: string,
): Promise<SeatRole[] | null> {
  const goal = await getGoal(env, orgId, goalId);
  if (!goal) return null;
  const squad = await pickFreshSquad(env, goal.title, goal.metric_name ?? "", orgId);
  const finalSquad = squad.length > 0 ? squad : [...CLASSIC_ROLES];
  await env.DB.prepare("UPDATE goals SET squad = ? WHERE id = ?")
    .bind(JSON.stringify(finalSquad), goalId)
    .run();
  await addEvent(env, goalId, "squad.restaffed", `Squad: ${finalSquad.join(", ")}`, {
    squad: finalSquad,
  });
  return finalSquad;
}

export interface NewRunInput {
  orgId: string;
  goalId: string | null;
  teamId?: string;
  goal: string;
  metricName?: string;
  metricBaseline?: number;
  metricTarget?: number;
  timeboxDays?: number;
  voteWindowMs?: number;
  kind?: "work" | "revision" | "trigger";
  parentRunId?: string | null;
  briefNote?: string;
}

/**
 * Single creation site for staffed runs. Trial-grant is the caller's job
 * (user routes grant, system paths pure-read); everything downstream —
 * goal state, throttle, team, staffing, locks — lives here so no path
 * can skip a step.
 */
export async function createWorkRun(
  env: Env,
  input: NewRunInput,
): Promise<{ runId: string; status: "open" | "queued"; squad: SeatRole[] }> {
  let teamId = input.teamId ?? null;
  let goalBrief: string | null = null;
  if (input.goalId) {
    const goal = await getGoal(env, input.orgId, input.goalId);
    if (!goal) throw new RunConflict("unknown goal", 404);
    if (goal.status === "paused" || goal.status === "done") {
      throw new RunConflict(`goal is ${goal.status}`, 409);
    }
    teamId = goal.team_id ?? teamId;
    goalBrief = goal.brief_note;
  }
  if (input.teamId && teamId && input.teamId !== teamId) {
    throw new RunConflict("team does not match goal team", 400);
  }
  teamId = teamId ?? (await ensureTeam(env, input.orgId));
  if (!(await teamInOrg(env, input.orgId, teamId))) {
    throw new RunConflict("unknown team", 403);
  }
  if (input.parentRunId) {
    const parent = await getRun(env, input.parentRunId);
    if (!parent || parent.org_id !== input.orgId) {
      throw new RunConflict("unknown parent run", 404);
    }
  }
  const fair = await checkFairUse(env, input.orgId);
  if (!fair.allowed) {
    await maybeSendUpgradeEmail(env, input.orgId, fair.meter);
    throw new RunThrottled(fair.meter);
  }
  let squad: SeatRole[];
  if (input.goalId) {
    const goal = await getGoal(env, input.orgId, input.goalId);
    squad =
      goal && goal.squad.length > 0
        ? goal.squad
        : await staffGoalSquad(env, input.orgId, input.goalId, input.goal, "");
  } else {
    const fresh = await pickFreshSquad(env, input.goal, "", input.orgId);
    squad = fresh.length > 0 ? fresh : [...CLASSIC_ROLES];
  }
  const queued = !(await squadFree(env, input.orgId, squad));
  const runId = crypto.randomUUID();
  // The morning brief rides along: an explicit note wins, otherwise
  // the goal's own brief leads and today's team brief follows. Empty
  // briefs feed nothing, so unbriefed teams behave exactly as before.
  const briefNote =
    input.briefNote ??
    [goalBrief, await todayBriefText(env, input.orgId, teamId)]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
  await env.DB.prepare(
    `INSERT INTO runs (id, org_id, team_id, goal_id, kind, parent_run_id, goal,
      metric_name, metric_baseline, metric_target, timebox_days,
      vote_window_ms, lineup, status, brief_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      runId,
      input.orgId,
      teamId,
      input.goalId,
      input.kind ?? "work",
      input.parentRunId ?? null,
      input.goal,
      input.metricName ?? null,
      input.metricBaseline ?? null,
      input.metricTarget ?? null,
      input.timeboxDays ?? null,
      input.voteWindowMs ?? VOTE_TIMEOUT_MS,
      JSON.stringify(squad),
      queued ? "queued" : "open",
      briefNote,
    )
    .run();
  await audit(env, runId, "human", "run.created", {
    goal: input.goal,
    squad,
    queued,
  });
  await recordBorrowing(env, input.orgId, runId, teamId, squad, queued);
  if (input.goalId) {
    await addEvent(env, input.goalId, "run.started", input.goal.slice(0, 80), {
      runId,
      queued,
    });
  }
  if (!queued) {
    try {
      await env.GOAL_RUN.create({ params: { runId } });
    } catch (err) {
      // Created but never started: back to queued so the promoter
      // retries instead of stranding an open run with no instance.
      await env.DB.prepare("UPDATE runs SET status = 'queued' WHERE id = ?")
        .bind(runId)
        .run();
      await audit(env, runId, "workflow", "run.promote_failed", {
        error: String(err).slice(0, 200),
      });
      return { runId, status: "queued", squad };
    }
  }
  return { runId, status: queued ? "queued" : "open", squad };
}

function andList(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

interface SeatHome {
  role: string;
  team_id: string;
  name: string;
}

/**
 * Cross-team borrowing, logged where the founder looks. Squads are
 * roles picked org-wide; a role whose hired seat sits on another team
 * is a borrow: one audit line on the run, one notice to the founder.
 * A queued run waiting on another team's hire also gets a manager
 * ruling at attempt 0 — session rulings start at 1, so the two can
 * never collide, and latest-ruling reads still surface the session.
 */
export async function recordBorrowing(
  env: Env,
  orgId: string,
  runId: string,
  teamId: string,
  squad: SeatRole[],
  queued: boolean,
): Promise<void> {
  const homes = await env.DB.prepare(
    `SELECT s.role, s.team_id, t.name FROM seats s
     JOIN teams t ON t.id = s.team_id
     WHERE t.org_id = ? AND s.hired = 1 ORDER BY s.rowid`,
  )
    .bind(orgId)
    .all<SeatHome>();
  const rows = homes.results ?? [];
  const own =
    rows.find((r) => r.team_id === teamId)?.name ??
    (await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
      .bind(teamId)
      .first<{ name: string }>())?.name ??
    "This team";
  const borrowed: Array<{ role: string; from: string }> = [];
  for (const role of squad) {
    const seats = rows.filter((r) => r.role === role);
    if (seats.length === 0 || seats.some((s) => s.team_id === teamId)) continue;
    borrowed.push({ role, from: seats[0].name });
  }
  if (borrowed.length > 0) {
    const names = borrowed.map((b) => hireDisplayName(b.role));
    const lenders = [...new Set(borrowed.map((b) => b.from))];
    await audit(env, runId, "manager", "run.borrowed", {
      roles: borrowed.map((b) => b.role),
      from: lenders,
    });
    await notify(env, orgId, {
      kind: "run.borrowed",
      title: `${own} borrowed ${andList(names)} for tonight`,
      body: `${andList(names)} ${names.length === 1 ? "is" : "are"} on loan from ${andList(lenders)}.`,
    });
  }
  if (!queued) return;
  const active = await env.DB.prepare(
    `SELECT r.id, r.team_id, r.goal, r.lineup, t.name FROM runs r
     LEFT JOIN teams t ON t.id = r.team_id
     WHERE r.org_id = ? AND r.kill_flag = 0
     AND r.status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`,
  )
    .bind(orgId, ...ACTIVE_STATUSES)
    .all<{ id: string; team_id: string | null; goal: string; lineup: string; name: string | null }>();
  for (const row of active.results ?? []) {
    if (!row.team_id || row.team_id === teamId) continue;
    let lineup: unknown = [];
    try {
      lineup = JSON.parse(row.lineup);
    } catch {
      continue;
    }
    if (!Array.isArray(lineup)) continue;
    const clash = squad.find((r) => (lineup as unknown[]).includes(r));
    if (!clash) continue;
    const holder = row.name ?? "Another team";
    await env.DB.prepare(
      `INSERT INTO rulings (id, run_id, decision, rationale, decided_by,
         attempt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(
        crypto.randomUUID(),
        runId,
        "wait",
        `${hireDisplayName(clash)} is busy on ${holder}'s \u201c${row.goal.slice(0, 80)}\u201d tonight — this session starts when they're free.`,
        "manager",
        0,
      )
      .run();
    await audit(env, runId, "manager", "run.arbitrated", {
      role: clash,
      blockedBy: row.id,
    });
    return;
  }
}

export class SandboxThrottled extends Error {
  constructor() {
    super("sandbox daily limit reached");
  }
}

/**
 * Unauthenticated sample run for the marketing page. Fixed preset squad
 * (no locks, no queue, no fair-use — the IP throttle replaces all of
 * that), short vote window, kind "sandbox" so the workflow records
 * would-do intents instead of touching any outside system.
 */
export async function createSandboxRun(
  env: Env,
  ip: string,
  presetId: string,
): Promise<{ runId: string; preset: string }> {
  const preset = sandboxPreset(presetId);
  if (!preset) throw new RunConflict("unknown preset", 400);
  const day = new Date().toISOString().slice(0, 10);
  const hit = await env.DB.prepare(
    "SELECT count FROM sandbox_ips WHERE ip = ? AND day = ?",
  )
    .bind(ip, day)
    .first<{ count: number }>();
  if ((hit?.count ?? 0) >= SANDBOX_DAILY_LIMIT) throw new SandboxThrottled();
  await env.DB.prepare(
    `INSERT INTO sandbox_ips (ip, day, count) VALUES (?, ?, 1)
     ON CONFLICT (ip, day) DO UPDATE SET count = count + 1`,
  )
    .bind(ip, day)
    .run();
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO runs (id, org_id, kind, goal, metric_name, vote_window_ms,
      lineup, status)
     VALUES (?, ?, 'sandbox', ?, ?, ?, ?, 'open')`,
  )
    .bind(
      runId,
      SANDBOX_ORG_ID,
      preset.goal,
      preset.metricName,
      SANDBOX_VOTE_WINDOW_MS,
      JSON.stringify(preset.squad),
    )
    .run();
  await audit(env, runId, "sandbox", "run.created", {
    preset: preset.id,
    squad: preset.squad,
  });
  await env.GOAL_RUN.create({ params: { runId } });
  return { runId, preset: preset.id };
}

/**
 * Awaiting runs hold no workflow instance (the gate ended it), so a kill
 * during the wait has no tail to settle it. The kill route calls this to
 * close the run the same way finishHalted would.
 */
export async function settleAwaitingKill(
  env: Env,
  runId: string,
): Promise<void> {
  const run = await getRun(env, runId);
  if (!run || run.status !== "awaiting_approval") return;
  await touchRun(env, runId, { status: "halted" });
  await publishEvent(env, runId, { type: "status", runId, status: "halted" });
  await audit(env, runId, "human", "run.halted");
  await recordRunSummary(env, runId, "halted");
  await promoteQueued(env);
}

/**
 * The single failed-run settlement: workflow failures and the resubmit
 * cap both land here, so neither can skip the notification or alert.
 */
export async function settleFailedRun(
  env: Env,
  runId: string,
  message: string,
): Promise<void> {
  await touchRun(env, runId, { status: "failed" });
  await publishEvent(env, runId, { type: "status", runId, status: "failed" });
  await audit(env, runId, "workflow", "run.failed", { message });
  await recordRunSummary(env, runId, "failed");
  const run = await getRun(env, runId);
  // Sandbox samples are silent even when they fail: no members to tell.
  if (run && run.kind !== "sandbox") {
    await notify(env, run.org_id, {
      kind: "run.failed",
      title: `Session failed: ${run.goal.slice(0, 80)}`,
      body: message.slice(0, 300),
    }).catch(() => {});
    await maybeSendFairUseAlert(env, run.org_id).catch(() => {});
  }
  await promoteQueued(env);
}

/**
 * Promote queued runs whose squads freed up. Total: per-run try/catch,
 * conditional claims, safe to call from anywhere (workflow tails, kill
 * route, cron). Trial is re-read purely — a lapsed trial fails the run
 * visibly instead of starting it.
 */
export async function promoteQueued(env: Env): Promise<void> {
  let rows: Array<{ id: string; org_id: string; goal_id: string | null; lineup: string }>;
  try {
    const res = await env.DB.prepare(
      "SELECT id, org_id, goal_id, lineup FROM runs WHERE status = 'queued' ORDER BY rowid LIMIT 20",
    ).all<{ id: string; org_id: string; goal_id: string | null; lineup: string }>();
    rows = res.results ?? [];
  } catch {
    return;
  }
  for (const row of rows) {
    try {
      let squad: SeatRole[] = [];
      try {
        const parsed = JSON.parse(row.lineup) as unknown;
        if (Array.isArray(parsed)) {
          squad = parsed.filter((r): r is SeatRole => typeof r === "string");
        }
      } catch {
        /* unparseable lineup fails below via empty squad */
      }
      const trial = await env.DB.prepare(
        "SELECT trial_ends_at, grace_used, subscribed FROM orgs WHERE id = ?",
      )
        .bind(row.org_id)
        .first<{ trial_ends_at: number; grace_used: number; subscribed: number }>();
      const expired =
        !trial ||
        (trial.subscribed !== 1 && Date.now() >= trial.trial_ends_at);
      if (expired || squad.length === 0) {
        await env.DB.prepare(
          "UPDATE runs SET status = 'failed' WHERE id = ? AND status = 'queued'",
        )
          .bind(row.id)
          .run();
        await audit(env, row.id, "workflow", "run.failed", {
          message: expired ? "trial lapsed while queued" : "empty squad",
        });
        continue;
      }
      const fair = await checkFairUse(env, row.org_id);
      if (!fair.allowed) continue; // throttles lift daily; retry next tick
      if (!(await squadFree(env, row.org_id, squad))) continue;
      const claimed = await env.DB.prepare(
        "UPDATE runs SET status = 'open' WHERE id = ? AND status = 'queued'",
      )
        .bind(row.id)
        .run();
      if ((claimed.meta.changes ?? 0) !== 1) continue;
      try {
        await env.GOAL_RUN.create({ params: { runId: row.id } });
      } catch (err) {
        // Claimed but never started: release the claim so the next
        // tick retries instead of stranding an open run.
        await env.DB.prepare(
          "UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'open'",
        )
          .bind(row.id)
          .run();
        try {
          await audit(env, row.id, "workflow", "run.promote_failed", {
            error: String(err).slice(0, 200),
          });
        } catch {
          /* audit itself failed; nothing left to do */
        }
        continue;
      }
      await audit(env, row.id, "workflow", "run.promoted", {});
    } catch (err) {
      try {
        await audit(env, row.id, "workflow", "run.promote_failed", {
          error: String(err).slice(0, 200),
        });
      } catch {
        /* audit itself failed; nothing left to do */
      }
    }
  }
}
