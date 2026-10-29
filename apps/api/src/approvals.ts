import {
  actionLabel,
  gateVerdict,
  hasInverse,
  isMoneyKind,
  resubmitOutcome,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit, getRun, touchRun } from "./db.js";
import { addEvent, getGoal } from "./goals.js";
import { notify } from "./notify.js";
import { createWorkRun, settleFailedRun } from "./staffing.js";

/** Human seat role in an org; null = not a member. org_members is the
 *  working set; orgs.owner_user_id is the bootstrap root for orgs that
 *  predate their member row. */
export async function memberRole(
  env: Env,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(orgId, userId)
    .first<{ role: string }>();
  if (row) return row.role;
  const owner = await env.DB.prepare(
    "SELECT id FROM orgs WHERE id = ? AND owner_user_id = ?",
  )
    .bind(orgId, userId)
    .first<{ id: string }>();
  return owner ? "owner" : null;
}

/** Every org a user belongs to, owned or invited. */
export async function memberOrgs(
  env: Env,
  userId: string,
): Promise<Array<{ id: string; name: string; role: string }>> {
  const rows = await env.DB.prepare(
    `SELECT o.id AS id, o.name AS name,
       COALESCE(m.role, CASE WHEN o.owner_user_id = ? THEN 'owner' END) AS role
     FROM orgs o LEFT JOIN org_members m ON m.org_id = o.id AND m.user_id = ?
     WHERE m.user_id = ? OR o.owner_user_id = ?`,
  )
    .bind(userId, userId, userId, userId)
    .all<{ id: string; name: string; role: string | null }>();
  return (rows.results ?? [])
    .filter((r) => r.role !== null)
    .map((r) => ({ id: r.id, name: r.name, role: r.role as string }));
}

export async function addMember(
  env: Env,
  orgId: string,
  userId: string,
  role: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT(org_id, user_id) DO NOTHING`,
  )
    .bind(orgId, userId, role)
    .run();
}

export interface ApprovalView {
  id: string;
  runId: string;
  goalId: string | null;
  kind: string;
  actionId: string | null;
  attempt: number;
  status: string;
  resubmits: number;
  note: string;
  revisionRunId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  runGoal: string | null;
  actionKind: string | null;
  actionTarget: string | null;
}

export async function listApprovals(
  env: Env,
  orgId: string,
  status?: string,
): Promise<ApprovalView[]> {
  const res = await env.DB.prepare(
    `SELECT a.id AS id, a.run_id AS runId, a.goal_id AS goalId,
       a.kind AS kind, a.action_id AS actionId, a.attempt AS attempt,
       a.status AS status, a.resubmits AS resubmits, a.note AS note,
       a.revision_run_id AS revisionRunId, a.decided_by AS decidedBy,
       a.decided_at AS decidedAt, a.created_at AS createdAt,
       r.goal AS runGoal, act.kind AS actionKind, act.target AS actionTarget
     FROM approvals a JOIN runs r ON r.id = a.run_id
     LEFT JOIN actions act ON act.id = a.action_id
     WHERE a.org_id = ? ${status ? "AND a.status = ?" : ""}
     ORDER BY a.created_at DESC, a.rowid DESC LIMIT 100`,
  )
    .bind(...(status ? [orgId, status] : [orgId]))
    .all<ApprovalView>();
  return res.results ?? [];
}

async function rulingAttempt(env: Env, runId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT MAX(attempt) AS n FROM rulings WHERE run_id = ?",
  )
    .bind(runId)
    .first<{ n: number | null }>();
  return row?.n ?? null;
}

async function latestPreApproval(
  env: Env,
  runId: string,
): Promise<{ status: string; attempt: number } | null> {
  const row = await env.DB.prepare(
    `SELECT status, attempt FROM approvals WHERE run_id = ? AND kind = 'pre'
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(runId)
    .first<{ status: string; attempt: number }>();
  return row;
}

async function rejectionCount(env: Env, runId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM approvals
     WHERE run_id = ? AND kind = 'pre' AND status = 'rejected'`,
  )
    .bind(runId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The pre-approve gate, run by the workflow after every ruling.
 * Post-hoc goals proceed; pre-approve goals pause unless the current
 * ruling attempt was approved. Retry-safe: the pending row insert is
 * idempotent and side effects fire only when this call created it.
 */
export async function runGate(
  env: Env,
  runId: string,
): Promise<"proceed" | "paused"> {
  const run = await getRun(env, runId);
  if (!run || !run.goal_id) return "proceed";
  const goal = await getGoal(env, run.org_id, run.goal_id);
  const attempt = await rulingAttempt(env, runId);
  const latest = await latestPreApproval(env, runId);
  const verdict = gateVerdict({
    approvalMode: goal?.approval_mode ?? "posthoc",
    rulingAttempt: attempt,
    approvedAttempt:
      latest?.status === "approved" ? latest.attempt : null,
  });
  if (verdict === "proceed") return "proceed";
  const resubmits = await rejectionCount(env, runId);
  const ins = await env.DB.prepare(
    `INSERT INTO approvals (id, org_id, run_id, goal_id, kind, attempt,
       status, resubmits) VALUES (?, ?, ?, ?, 'pre', ?, 'pending', ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      run.org_id,
      runId,
      run.goal_id,
      attempt ?? 1,
      resubmits,
    )
    .run();
  await touchRun(env, runId, { status: "awaiting_approval" });
  if ((ins.meta.changes ?? 0) === 1) {
    await addEvent(env, run.goal_id, "run.awaiting_approval", run.goal.slice(0, 80), {
      runId,
      attempt,
    });
    await audit(env, runId, "workflow", "gate.paused", { attempt });
    await notify(env, run.org_id, {
      kind: "approval.requested",
      title: `Approval needed: ${run.goal.slice(0, 80)}`,
      body: `The team decided and is waiting for your call before acting.`,
    });
  }
  return "paused";
}

export type PreDecision = "approve" | "reject";

export type DecideOutcome =
  | { outcome: "notfound" }
  | { outcome: "none" }
  | { outcome: "conflict" }
  | { outcome: "approved" }
  | { outcome: "resubmitted"; resubmits: number }
  | { outcome: "failed" };

/**
 * Decide a pending pre-approval. Claim-first (conditional UPDATE) so
 * racing approvers can't both win; the resume workflow starts before
 * any notification, and a failed start rolls the claim back so the
 * run never strands in a decided-but-unresumed state.
 */
export async function decidePreApproval(
  env: Env,
  input: { runId: string; userId: string; decision: PreDecision; note?: string },
): Promise<DecideOutcome> {
  const run = await getRun(env, input.runId);
  if (!run) return { outcome: "notfound" };
  const pending = await env.DB.prepare(
    `SELECT id, resubmits FROM approvals
     WHERE run_id = ? AND kind = 'pre' AND status = 'pending'`,
  )
    .bind(input.runId)
    .first<{ id: string; resubmits: number }>();
  if (!pending) return { outcome: "none" };
  const status = input.decision === "approve" ? "approved" : "rejected";
  const attempt = (await rulingAttempt(env, input.runId)) ?? 1;
  const claimed = await env.DB.prepare(
    `UPDATE approvals SET status = ?, note = ?, attempt = ?, decided_by = ?,
       decided_at = datetime('now') WHERE id = ? AND status = 'pending'`,
  )
    .bind(status, input.note ?? "", attempt, input.userId, pending.id)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return { outcome: "conflict" };
  const rollback = () =>
    env.DB.prepare(
      `UPDATE approvals SET status = 'pending', decided_by = NULL,
         decided_at = NULL WHERE id = ? AND status = ? AND decided_by = ?`,
    )
      .bind(pending.id, status, input.userId)
      .run();

  if (input.decision === "approve") {
    try {
      await env.GOAL_RUN.create({
        params: { runId: input.runId, resume: "act" },
      });
    } catch (err) {
      await rollback();
      throw err;
    }
    if (run.goal_id) {
      await addEvent(env, run.goal_id, "run.approved", run.goal.slice(0, 80), {
        runId: run.id,
        decidedBy: input.userId,
      });
    }
    await audit(env, run.id, "human", "approval.approved", {
      decidedBy: input.userId,
    });
    await notify(env, run.org_id, {
      kind: "approval.decided",
      title: `Approved: ${run.goal.slice(0, 80)}`,
      body: `The team is acting on the approved plan.`,
    });
    return { outcome: "approved" };
  }

  if (resubmitOutcome(pending.resubmits) === "fail") {
    await settleFailedRun(env, run.id, `resubmit cap reached (${pending.resubmits})`);
    await notify(env, run.org_id, {
      kind: "approval.capped",
      title: `Session failed: ${run.goal.slice(0, 80)}`,
      body: `Rejected ${pending.resubmits + 1} times; the retry cap was reached.`,
    });
    return { outcome: "failed" };
  }
  try {
    await env.GOAL_RUN.create({
      params: { runId: input.runId, resume: "rerule" },
    });
  } catch (err) {
    await rollback();
    throw err;
  }
  if (run.goal_id) {
    await addEvent(env, run.goal_id, "run.resubmitted", run.goal.slice(0, 80), {
      runId: run.id,
      resubmits: pending.resubmits + 1,
      note: input.note ?? "",
    });
  }
  await audit(env, run.id, "human", "approval.rejected", {
    decidedBy: input.userId,
    resubmits: pending.resubmits + 1,
  });
  await notify(env, run.org_id, {
    kind: "approval.resubmitted",
    title: `Sent back: ${run.goal.slice(0, 80)}`,
    body: input.note ?? "The manager is re-ruling with your note attached.",
  });
  return { outcome: "resubmitted", resubmits: pending.resubmits + 1 };
}

/**
 * Post-hoc: bless one shipped action. Record-only, no workflow.
 * Idempotent by design: a pending review row is claimed, an already
 * decided action returns ok, so double taps and approve-all can never
 * stack duplicate rows.
 */
export async function approveAction(
  env: Env,
  input: { runId: string; actionId: string; userId: string; note?: string },
): Promise<"ok" | "notfound"> {
  const action = await env.DB.prepare(
    "SELECT id, kind FROM actions WHERE id = ? AND run_id = ?",
  )
    .bind(input.actionId, input.runId)
    .first<{ id: string; kind: string }>();
  const run = await getRun(env, input.runId);
  if (!action || !run) return "notfound";
  const existing = await env.DB.prepare(
    `SELECT id, status FROM approvals
     WHERE run_id = ? AND kind = 'post' AND action_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(input.runId, input.actionId)
    .first<{ id: string; status: string }>();
  if (existing && existing.status !== "pending") return "ok";
  if (existing) {
    await env.DB.prepare(
      `UPDATE approvals SET status = 'approved', note = ?, decided_by = ?,
         decided_at = datetime('now') WHERE id = ? AND status = 'pending'`,
    )
      .bind(input.note ?? "", input.userId, existing.id)
      .run();
    await audit(env, run.id, "human", "action.approved", {
      actionId: action.id,
      kind: action.kind,
    });
    return "ok";
  }
  await env.DB.prepare(
    `INSERT INTO approvals (id, org_id, run_id, goal_id, kind, action_id,
       status, note, decided_by, decided_at)
     VALUES (?, ?, ?, ?, 'post', ?, 'approved', ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      run.org_id,
      run.id,
      run.goal_id,
      action.id,
      input.note ?? "",
      input.userId,
    )
    .run();
  await audit(env, run.id, "human", "action.approved", {
    actionId: action.id,
    kind: action.kind,
  });
  return "ok";
}

/**
 * Post-hoc: request changes on one shipped action. Records the call
 * and spawns a revision child run carrying the note as its brief.
 */
export async function requestChanges(
  env: Env,
  input: {
    orgId: string;
    runId: string;
    actionId: string;
    userId: string;
    note: string;
  },
): Promise<
  | { outcome: "ok"; runId: string; status: "open" | "queued" }
  | { outcome: "notfound" }
> {
  const action = await env.DB.prepare(
    "SELECT id, kind FROM actions WHERE id = ? AND run_id = ?",
  )
    .bind(input.actionId, input.runId)
    .first<{ id: string; kind: string }>();
  const run = await getRun(env, input.runId);
  if (!action || !run || run.org_id !== input.orgId) return { outcome: "notfound" };
  const created = await createWorkRun(env, {
    orgId: input.orgId,
    goalId: run.goal_id,
    goal: run.goal,
    metricName: run.metric_name ?? undefined,
    metricBaseline: run.metric_baseline ?? undefined,
    metricTarget: run.metric_target ?? undefined,
    timeboxDays: run.timebox_days ?? undefined,
    kind: "revision",
    parentRunId: run.id,
    briefNote: input.note,
  });
  await env.DB.prepare(
    `INSERT INTO approvals (id, org_id, run_id, goal_id, kind, action_id,
       status, note, revision_run_id, decided_by, decided_at)
     VALUES (?, ?, ?, ?, 'post', ?, 'changes', ?, ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      input.orgId,
      run.id,
      run.goal_id,
      action.id,
      input.note,
      created.runId,
      input.userId,
    )
    .run();
  if (run.goal_id) {
    await addEvent(env, run.goal_id, "run.revision", run.goal.slice(0, 80), {
      runId: run.id,
      revisionRunId: created.runId,
      actionKind: action.kind,
    });
  }
  await audit(env, run.id, "human", "action.changes_requested", {
    actionId: action.id,
    revisionRunId: created.runId,
  });
  await notify(env, input.orgId, {
    kind: "approval.revision",
    title: `Revision requested: ${actionLabel(action.kind)}`,
    body: input.note,
  });
  return { outcome: "ok", runId: created.runId, status: created.status };
}

/**
 * Post-hoc auto-review: runs once when a review-after session settles.
 * A result is approved on sight only when all three hold: it is in the
 * undo map, it moves no money, and it stored a revert payload. Anything
 * else gets a pending review row for a human. Inserts are conflict-safe
 * and rows are skipped when already reviewed, so retries never double
 * count. Sandbox and check-first sessions are untouched.
 */
export async function autoReviewRun(
  env: Env,
  runId: string,
): Promise<{ auto: number; pending: number }> {
  const run = await getRun(env, runId);
  if (!run || !run.goal_id || run.kind === "sandbox") {
    return { auto: 0, pending: 0 };
  }
  const goal = await getGoal(env, run.org_id, run.goal_id);
  if (!goal || goal.approval_mode !== "posthoc") {
    return { auto: 0, pending: 0 };
  }
  const rows = await env.DB.prepare(
    `SELECT id, kind, revert_payload FROM actions
     WHERE run_id = ? AND status = 'done'
       AND target NOT LIKE 'closeout:%'
       AND id NOT IN (SELECT action_id FROM approvals
                      WHERE run_id = ? AND kind = 'post'
                        AND action_id IS NOT NULL)`,
  )
    .bind(runId, runId)
    .all<{ id: string; kind: string; revert_payload: string | null }>();
  let auto = 0;
  let pending = 0;
  for (const a of rows.results ?? []) {
    const safe =
      hasInverse(a.kind) && !isMoneyKind(a.kind) && !!a.revert_payload;
    if (safe) {
      await env.DB.prepare(
        `INSERT INTO approvals (id, org_id, run_id, goal_id, kind, action_id,
           status, note, decided_at)
         VALUES (?, ?, ?, ?, 'post', ?, 'approved',
           'Auto-approved: safe to undo, no money moved.', datetime('now'))
         ON CONFLICT DO NOTHING`,
      )
        .bind(crypto.randomUUID(), run.org_id, run.id, run.goal_id, a.id)
        .run();
      auto++;
    } else {
      await env.DB.prepare(
        `INSERT INTO approvals (id, org_id, run_id, goal_id, kind, action_id,
           status) VALUES (?, ?, ?, ?, 'post', ?, 'pending')
         ON CONFLICT DO NOTHING`,
      )
        .bind(crypto.randomUUID(), run.org_id, run.id, run.goal_id, a.id)
        .run();
      pending++;
    }
  }
  await audit(env, run.id, "system", "auto.review", { auto, pending });
  if (auto > 0) {
    await notify(env, run.org_id, {
      kind: "approval.auto",
      title:
        auto === 1
          ? `1 result auto-approved: ${run.goal.slice(0, 60)}`
          : `${auto} results auto-approved: ${run.goal.slice(0, 60)}`,
      body:
        pending === 0
          ? "All safe to undo. Nothing needs you."
          : `${pending} more need${pending === 1 ? "s" : ""} your call.`,
    });
  }
  return { auto, pending };
}
