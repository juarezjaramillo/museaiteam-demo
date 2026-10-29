import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  PROVIDER_IDS,
  SEAT_ROLES,
  mayDecideApproval,
  normalizeShop,
  trialStatus,
  validateProviderConfig,
  verifyState,
} from "@museaiteam/shared";
import { z } from "zod";
import type { Env } from "./bindings.js";
import {
  approveAction,
  decidePreApproval,
  listApprovals,
  memberOrgs,
  memberRole,
  requestChanges,
} from "./approvals.js";
import {
  authHandler,
  ensureOrg,
  getSessionUser,
  requireSession,
  type SessionUser,
} from "./auth.js";
import { runBaseline } from "./baseline.js";
import { audit, getRun } from "./db.js";
import { ingestGitHub, ingestUpload } from "./ingest.js";
import { listProducts } from "./integrations/shopify.js";
import {
  BadInvite,
  acceptInvite,
  createInvite,
  listInvites,
  revokeInvite,
} from "./invites.js";
import {
  BadPlaybook,
  distillLearning,
  listPlaybook,
  rateAction,
  runRatings,
  tickTicketThemes,
  updatePlaybookEntry,
} from "./learning.js";
import { executeRevert } from "./revert.js";
import {
  ProviderNotConfigured,
  connectUrl,
  finishConnect,
  getProviderConfig,
  isProvider,
  loadToken,
  setProviderConfig,
} from "./oauth.js";
import { pullGoalMetric } from "./pulls.js";
import { sweepStuckRuns } from "./sweep.js";
import { maybePostWeeklyDigest } from "./weekly.js";
import { trialExpiredBody, trialGate } from "./trial.js";
import {
  BadGoal,
  createGoal,
  getGoal,
  goalTimeline,
  listGoals,
  metricSeries,
  recordMetricPoint,
  updateGoal,
} from "./goals.js";
import { tickGoals, tickStalled } from "./checks.js";
import { decideProposal, listProposals, tickProposals } from "./proposals.js";
import { ideaBudget } from "./allowance.js";
import {
  RunConflict,
  RunThrottled,
  SandboxThrottled,
  createSandboxRun,
  createWorkRun,
  promoteQueued,
  restaffGoal,
  settleAwaitingKill,
} from "./staffing.js";
import {
  createCheckoutSession,
  getMeter,
  handleStripeWebhook,
  rosterSeats,
  stripeConfigured,
} from "./billing.js";
import {
  BadRole,
  DuplicateSeat,
  approveSeat,
  hireSeat,
  listTeams,
  teamInOrg,
} from "./teams.js";
import { handleSlackEvent, verifySlack, type SlackEvent } from "./slack-in.js";
import { guardTick, reportError, tickErrorWatch } from "./report.js";
import { clientIp, takeHit } from "./ratelimit.js";

export { RunFeed } from "./feed.js";
export { RateLimit } from "./ratelimit.js";
export { GoalRunWorkflow } from "./workflow.js";

type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };
const app = new Hono<AppEnv>();

app.onError(async (err, c) => {
  await reportError(c.env, { kind: "route", error: `${c.req.method} ${c.req.path}: ${err}` });
  return c.json({ error: "internal error" }, 500);
});

type Role = "owner" | "approver" | "viewer";
const EVERYONE: Role[] = ["owner", "approver", "viewer"];
const DECIDERS: Role[] = ["owner", "approver"];
const OWNERS: Role[] = ["owner"];

/**
 * The :org route guard. Null unless the caller holds one of the allowed
 * roles — owners everything, approvers work decisions, viewers reads.
 */
async function roleOrg(
  c: Context<AppEnv>,
  ...allowed: Role[]
): Promise<string | null> {
  const org = c.req.param("org") ?? "";
  if (!org) return null;
  const role = await memberRole(c.env, org, c.get("user").id);
  if (!role || !allowed.includes(role as Role)) return null;
  return org;
}

/** Run-route guard: 404 for strangers, 403 for under-roled members. */
async function runRole(
  c: Context<AppEnv>,
  run: { org_id: string },
  ...allowed: Role[]
): Promise<"ok" | "notfound" | "forbidden"> {
  const role = await memberRole(c.env, run.org_id, c.get("user").id);
  if (!role) return "notfound";
  if (!allowed.includes(role as Role)) return "forbidden";
  return "ok";
}

// Pages dashboard + local dev may call the API cross-origin.
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin") ?? "";
  // Credentialed CORS is allowlisted to our own surfaces: any *.pages.dev
  // would let a stranger's site call the API as the victim.
  const allowed =
    /^https:\/\/([a-z0-9-]+\.)?museaiteam\.pages\.dev$/.test(origin) ||
    /^http:\/\/localhost(:\d+)?$/.test(origin) ||
    (origin !== "" && origin === c.env.APP_URL);
  if (allowed) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Vary", "Origin");
  }
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    c.header("Access-Control-Allow-Headers", "content-type,authorization");
    return c.body(null, 204);
  }
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

// Approval decisions intentionally live above the requireSession gate
// so unauthenticated and viewer-role deciders both 403. (Missing runs
// still 404, like every other route.) Do not move these below.
async function approvalDecider(
  c: Context<AppEnv>,
  orgId: string,
): Promise<SessionUser | null> {
  const user = await getSessionUser(c.env, c.req.raw);
  if (!user) return null;
  const role = await memberRole(c.env, orgId, user.id);
  if (!mayDecideApproval(role)) return null;
  return user;
}

app.post(
  "/api/runs/:id/approve",
  zValidator(
    "json",
    z.object({
      decision: z.enum(["approve", "reject"]),
      note: z.string().max(2000).optional(),
    }),
  ),
  async (c) => {
    const run = await getRun(c.env, c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const user = await approvalDecider(c, run.org_id);
    if (!user) return c.json({ error: "forbidden" }, 403);
    const gate = await trialGate(c.env, run.org_id);
    if (!gate.allowed) return c.json(trialExpiredBody(gate.status), 403);
    const body = c.req.valid("json");
    const res = await decidePreApproval(c.env, {
      runId: run.id,
      userId: user.id,
      decision: body.decision,
      note: body.note,
    });
    switch (res.outcome) {
      case "notfound":
        return c.json({ error: "not found" }, 404);
      case "none":
        return c.json({ error: "no pending approval" }, 409);
      case "conflict":
        return c.json({ error: "already decided" }, 409);
      case "approved":
        return c.json({ ok: true, outcome: "approved" });
      case "resubmitted":
        return c.json({ ok: true, outcome: "resubmitted", resubmits: res.resubmits });
      case "failed":
        return c.json({ ok: true, outcome: "failed", reason: "resubmit cap reached" });
    }
  },
);

app.post(
  "/api/runs/:id/actions/:actionId/approve",
  zValidator("json", z.object({ note: z.string().max(2000).optional() })),
  async (c) => {
    const run = await getRun(c.env, c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const user = await approvalDecider(c, run.org_id);
    if (!user) return c.json({ error: "forbidden" }, 403);
    const res = await approveAction(c.env, {
      runId: run.id,
      actionId: c.req.param("actionId"),
      userId: user.id,
      note: c.req.valid("json").note,
    });
    if (res === "notfound") return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  },
);

app.post(
  "/api/runs/:id/actions/:actionId/request-changes",
  zValidator("json", z.object({ note: z.string().min(1).max(2000) })),
  async (c) => {
    const run = await getRun(c.env, c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const user = await approvalDecider(c, run.org_id);
    if (!user) return c.json({ error: "forbidden" }, 403);
    const gate = await trialGate(c.env, run.org_id);
    if (!gate.allowed) return c.json(trialExpiredBody(gate.status), 403);
    try {
      const res = await requestChanges(c.env, {
        orgId: run.org_id,
        runId: run.id,
        actionId: c.req.param("actionId"),
        userId: user.id,
        note: c.req.valid("json").note,
      });
      if (res.outcome === "notfound") return c.json({ error: "not found" }, 404);
      return c.json({ ok: true, runId: res.runId, status: res.status }, 201);
    } catch (err) {
      if (err instanceof RunThrottled) {
        return c.json({ error: "fair_use_throttled", meter: err.meter }, 403);
      }
      if (err instanceof RunConflict) {
        return c.json({ error: String(err).slice(0, 160) }, err.status);
      }
      throw err;
    }
  },
);

app.post(
  "/api/runs/:id/actions/:actionId/rate",
  zValidator(
    "json",
    z.object({ thumb: z.enum(["up", "down"]), note: z.string().max(1000).optional() }),
  ),
  async (c) => {
    const run = await getRun(c.env, c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const user = await approvalDecider(c, run.org_id);
    if (!user) return c.json({ error: "forbidden" }, 403);
    const body = c.req.valid("json");
    const res = await rateAction(c.env, {
      orgId: run.org_id,
      runId: run.id,
      actionId: c.req.param("actionId"),
      userId: user.id,
      thumb: body.thumb,
      note: body.note,
    });
    if (res === "notfound") return c.json({ error: "not found" }, 404);
    return c.json({ ok: true }, 201);
  },
);

app.patch(
  "/api/orgs/:org/playbook/:entryId",
  zValidator(
    "json",
    z.object({ status: z.string().optional(), tactic: z.string().max(300).optional() }),
  ),
  async (c) => {
    const org = c.req.param("org") ?? "";
    const user = await approvalDecider(c, org);
    if (!user) return c.json({ error: "forbidden" }, 403);
    try {
      const ok = await updatePlaybookEntry(
        c.env,
        org,
        c.req.param("entryId"),
        c.req.valid("json"),
      );
      if (!ok) return c.json({ error: "not found" }, 404);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof BadPlaybook) {
        return c.json({ error: String(err).slice(0, 160) }, 400);
      }
      throw err;
    }
  },
);

app.use("/api/runs/*", requireSession);
app.use("/api/orgs/*", requireSession);
app.use("/api/me", requireSession);
app.use("/api/me/*", requireSession);
app.use("/api/invites/*", requireSession);

// Sandbox sample runs: intentionally unauthenticated (the IP throttle is
// the gate). Reads are sandbox-kind-only so no customer run ever leaks.
app.post(
  "/api/sandbox/run",
  zValidator("json", z.object({ preset: z.string().min(1).max(32) })),
  async (c) => {
    const ip =
      c.req.header("CF-Connecting-IP")?.trim() ||
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
      "unknown";
    try {
      const res = await createSandboxRun(c.env, ip, c.req.valid("json").preset);
      return c.json({ ok: true, runId: res.runId, preset: res.preset }, 201);
    } catch (err) {
      if (err instanceof SandboxThrottled) {
        return c.json({ error: "daily limit reached — come back tomorrow" }, 429);
      }
      if (err instanceof RunConflict) {
        return c.json({ error: String(err).slice(0, 160) }, err.status);
      }
      throw err;
    }
  },
);

app.get("/api/sandbox/runs/:id", async (c) => {
  const run = await getRun(c.env, c.req.param("id"));
  if (!run || run.kind !== "sandbox") {
    return c.json({ error: "not found" }, 404);
  }
  const proposals = await c.env.DB.prepare(
    "SELECT id, agent_role, title, body FROM proposals WHERE run_id = ? ORDER BY created_at",
  )
    .bind(run.id)
    .all<{ id: string; agent_role: string; title: string; body: string }>();
  const votes = await c.env.DB.prepare(
    "SELECT agent_role, proposal_id, choice, reason FROM votes WHERE run_id = ? ORDER BY created_at",
  )
    .bind(run.id)
    .all<{ agent_role: string; proposal_id: string; choice: string; reason: string }>();
  const ruling = await c.env.DB.prepare(
    `SELECT decision, rationale, decided_by, attempt FROM rulings
     WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`,
  )
    .bind(run.id)
    .first<{ decision: string; rationale: string; decided_by: string; attempt: number }>();
  const actions = await c.env.DB.prepare(
    "SELECT id, kind, target, status, payload FROM actions WHERE run_id = ? ORDER BY created_at",
  )
    .bind(run.id)
    .all<{ id: string; kind: string; target: string; status: string; payload: string }>();
  return c.json({
    run: {
      id: run.id,
      status: run.status,
      goal: run.goal,
      lineup: run.lineup,
      tokens_used: run.tokens_used,
    },
    proposals: proposals.results ?? [],
    votes: votes.results ?? [],
    ruling,
    actions: actions.results ?? [],
  });
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const orgId = await ensureOrg(c.env, user.id, user.email ?? null);
  return c.json({ user: { id: user.id, email: user.email }, orgId });
});

app.get("/api/me/orgs", async (c) => {
  const user = c.get("user");
  await ensureOrg(c.env, user.id, user.email ?? null);
  return c.json({ orgs: await memberOrgs(c.env, user.id) });
});

app.post("/api/invites/:token/accept", async (c) => {
  if (!(await takeHit(c.env, `invites:${clientIp(c.req.raw)}`, 20, 3600))) {
    return c.json({ error: "too many requests" }, 429);
  }
  const user = c.get("user");
  const res = await acceptInvite(c.env, c.req.param("token"), user.id, user.email ?? null);
  switch (res.outcome) {
    case "ok":
      return c.json({ ok: true, orgId: res.orgId, role: res.role });
    case "mismatch":
      return c.json({ error: "invite is for a different email" }, 403);
    case "used":
      return c.json({ error: "invite already accepted" }, 409);
    case "expired":
      return c.json({ error: "invite expired" }, 410);
    case "invalid":
      return c.json({ error: "not found" }, 404);
  }
});

app.post(
  "/api/runs",
  zValidator(
    "json",
    z.object({
      orgId: z.string().optional(),
      teamId: z.string().optional(),
      goalId: z.string().optional(),
      parentRunId: z.string().optional(),
      goal: z.string().min(8),
      metricName: z.string().optional(),
      metricBaseline: z.number().optional(),
      metricTarget: z.number().optional(),
      timeboxDays: z.number().optional(),
      voteWindowMs: z.number().int().min(5000).max(1800000).optional(),
      briefNote: z.string().max(2000).optional(),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    // Runs land in the caller's own org unless they name a member org.
    // Either way the caller needs a deciding seat there.
    const user = c.get("user");
    const orgId =
      body.orgId ?? (await ensureOrg(c.env, user.id, user.email ?? null));
    const role = await memberRole(c.env, orgId, user.id);
    if (!role || !DECIDERS.includes(role as Role)) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!(await takeHit(c.env, `runs:${orgId}`, 30, 3600))) {
      return c.json({ error: "too many sessions — try again in an hour" }, 429);
    }
    const gate = await trialGate(c.env, orgId);
    if (!gate.allowed) return c.json(trialExpiredBody(gate.status), 403);
    try {
      // Goal-less runs get a one-shot wrapper goal: every run belongs
      // somewhere, and the dashboard has a single shape to render.
      let goalId = body.goalId ?? null;
      if (!goalId) {
        goalId = await createGoal(c.env, orgId, {
          teamId: body.teamId,
          title: body.goal.slice(0, 200),
          metricName: body.metricName,
          metricBaseline: body.metricBaseline,
          metricTarget: body.metricTarget,
        });
      }
      const created = await createWorkRun(c.env, {
        orgId,
        goalId,
        teamId: body.teamId,
        goal: body.goal,
        metricName: body.metricName,
        metricBaseline: body.metricBaseline,
        metricTarget: body.metricTarget,
        timeboxDays: body.timeboxDays,
        voteWindowMs: body.voteWindowMs,
        kind: body.parentRunId ? "revision" : "work",
        parentRunId: body.parentRunId,
        briefNote: body.briefNote,
      });
      return c.json({ runId: created.runId, status: created.status }, 201);
    } catch (err) {
      if (err instanceof RunThrottled) {
        return c.json(
          {
            error: "fair_use_throttled",
            meter: err.meter,
            message:
              "Fair-use cap reached — runs throttled to 1/day until the month resets.",
          },
          403,
        );
      }
      if (err instanceof RunConflict) {
        return c.json({ error: String(err).slice(0, 160) }, err.status);
      }
      if (err instanceof BadGoal) {
        return c.json({ error: String(err).slice(0, 160) }, 400);
      }
      throw err;
    }
  },
);

app.get("/api/runs/:id", async (c) => {
  const run = await getRun(c.env, c.req.param("id"));
  if (!run) return c.json({ error: "not found" }, 404);
  const access = await runRole(c, run, ...EVERYONE);
  if (access !== "ok") return c.json({ error: access === "notfound" ? "not found" : "forbidden" }, access === "notfound" ? 404 : 403);
  return c.json(run);
});

app.post("/api/runs/:id/kill", async (c) => {
  const id = c.req.param("id");
  const run = await getRun(c.env, id);
  if (!run) return c.json({ error: "not found" }, 404);
  const access = await runRole(c, run, ...OWNERS);
  if (access !== "ok") return c.json({ error: access === "notfound" ? "not found" : "forbidden" }, access === "notfound" ? 404 : 403);
  await c.env.DB.prepare(
    "UPDATE runs SET kill_flag = 1, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(id)
    .run();
  await audit(c.env, id, "human", "run.kill_requested");
  // Awaiting runs hold no workflow instance, so settle them directly;
  // kill-flagged runs free their squads immediately; wake the queue.
  await settleAwaitingKill(c.env, id);
  await promoteQueued(c.env);
  return c.json({ ok: true });
});

app.post("/api/runs/:id/revert", async (c) => {
  const id = c.req.param("id");
  const run = await getRun(c.env, id);
  if (!run) return c.json({ error: "not found" }, 404);
  const access = await runRole(c, run, ...OWNERS);
  if (access !== "ok") return c.json({ error: access === "notfound" ? "not found" : "forbidden" }, access === "notfound" ? 404 : 403);
  await audit(c.env, id, "human", "revert.requested");
  const result = await executeRevert(c.env, run.org_id, id);
  return c.json({ ok: result.failed.length === 0, ...result });
});

app.post("/api/runs/:id/baseline", async (c) => {
  const id = c.req.param("id");
  const run = await getRun(c.env, id);
  if (!run) return c.json({ error: "not found" }, 404);
  const access = await runRole(c, run, ...DECIDERS);
  if (access !== "ok") return c.json({ error: access === "notfound" ? "not found" : "forbidden" }, access === "notfound" ? 404 : 403);
  const gate = await trialGate(c.env, run.org_id);
  if (!gate.allowed) return c.json(trialExpiredBody(gate.status), 403);
  try {
    return c.json(await runBaseline(c.env, id));
  } catch (err) {
    return c.json({ error: String(err).slice(0, 200) }, 502);
  }
});

app.get("/api/runs/:id/events", async (c) => {
  const run = await getRun(c.env, c.req.param("id"));
  if (!run) return c.json({ error: "not found" }, 404);
  const access = await runRole(c, run, ...EVERYONE);
  if (access !== "ok") return c.json({ error: access === "notfound" ? "not found" : "forbidden" }, access === "notfound" ? 404 : 403);
  const stub = c.env.FEED.idFromName(c.req.param("id"));
  return c.env.FEED.get(stub).fetch(c.req.raw);
});

app.get("/api/runs/:id/ratings", async (c) => {
  const run = await getRun(c.env, c.req.param("id"));
  if (!run) return c.json({ error: "not found" }, 404);
  const role = await memberRole(c.env, run.org_id, c.get("user").id);
  if (!role) return c.json({ error: "not found" }, 404);
  return c.json({ ratings: await runRatings(c.env, run.id) });
});

app.get("/api/runs/:id/detail", async (c) => {
  const run = await getRun(c.env, c.req.param("id"));
  if (!run) return c.json({ error: "not found" }, 404);
  const access = await runRole(c, run, ...EVERYONE);
  if (access !== "ok") {
    return c.json(
      { error: access === "notfound" ? "not found" : "forbidden" },
      access === "notfound" ? 404 : 403,
    );
  }
  const id = run.id;
  const q = <T>(sql: string) =>
    c.env.DB.prepare(sql).bind(id).all<T>().then((r) => r.results ?? []);
  const proposals = await q<{
    id: string;
    agent_role: string;
    title: string;
    body: string;
  }>("SELECT id, agent_role, title, body FROM proposals WHERE run_id = ? ORDER BY rowid");
  const votes = await q<{
    agent_role: string;
    proposal_id: string;
    choice: string;
    reason: string;
  }>("SELECT agent_role, proposal_id, choice, reason FROM votes WHERE run_id = ? ORDER BY rowid");
  const ruling = await c.env.DB.prepare(
    `SELECT decision, rationale, decided_by, attempt FROM rulings
     WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`,
  )
    .bind(id)
    .first<{ decision: string; rationale: string; decided_by: string; attempt: number }>();
  const actions = await q<{
    id: string;
    kind: string;
    target: string;
    status: string;
    payload: string;
    proof: string | null;
  }>("SELECT id, kind, target, status, payload, proof FROM actions WHERE run_id = ? ORDER BY rowid");
  const children = await c.env.DB.prepare(
    "SELECT id, kind, status, goal FROM runs WHERE parent_run_id = ? ORDER BY rowid",
  )
    .bind(id)
    .all<{ id: string; kind: string; status: string; goal: string }>();
  return c.json({
    run,
    proposals,
    votes,
    ruling,
    actions,
    ratings: await runRatings(c.env, id),
    children: children.results ?? [],
  });
});

const GUARD_WORKERS = ["manager", ...SEAT_ROLES];
// Demo defaults are wide open; spend_cap_cents 0 means unlimited.
const OPEN_GUARDS = {
  systems: ["github", "linear", "slack", "shopify", "hubspot", "notion"],
  write_scope: [
    "pr",
    "code",
    "ticket",
    "subtask",
    "comment",
    "transition",
    "message",
    "thread",
    "digest",
    "discount",
    "product",
    "note",
    "triage",
    "followup",
    "page",
    "db",
  ],
  spend_cap_cents: 0,
  escalate_on: [] as string[],
};

app.get("/api/orgs/:org/guardrails", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    "SELECT worker_role, systems, write_scope, spend_cap_cents, escalate_on FROM guardrails WHERE org_id = ?",
  )
    .bind(org)
    .all<{
      worker_role: string;
      systems: string;
      write_scope: string;
      spend_cap_cents: number;
      escalate_on: string;
    }>();
  const stored = new Map((rows.results ?? []).map((r) => [r.worker_role, r]));
  return c.json(
    GUARD_WORKERS.map((worker) => {
      const row = stored.get(worker);
      if (!row) return { worker_role: worker, ...OPEN_GUARDS, configured: false };
      return {
        worker_role: worker,
        systems: JSON.parse(row.systems),
        write_scope: JSON.parse(row.write_scope),
        spend_cap_cents: row.spend_cap_cents,
        escalate_on: JSON.parse(row.escalate_on),
        configured: true,
      };
    }),
  );
});

app.put(
  "/api/orgs/:org/guardrails",
  zValidator(
    "json",
    z.object({
      worker_role: z.enum(["manager", ...SEAT_ROLES]),
      systems: z.array(z.string()).max(32),
      write_scope: z.array(z.string()).max(32),
      spend_cap_cents: z.number().int().min(0),
      escalate_on: z.array(z.string()).max(32),
    }),
  ),
  async (c) => {
    const org = await roleOrg(c, ...OWNERS);
    if (!org) return c.json({ error: "forbidden" }, 403);
    const b = c.req.valid("json");
    await c.env.DB.prepare(
      `INSERT INTO guardrails (org_id, worker_role, systems, write_scope,
        spend_cap_cents, escalate_on, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(org_id, worker_role) DO UPDATE SET
         systems = excluded.systems, write_scope = excluded.write_scope,
         spend_cap_cents = excluded.spend_cap_cents,
         escalate_on = excluded.escalate_on, updated_at = datetime('now')`,
    )
      .bind(
        org,
        b.worker_role,
        JSON.stringify(b.systems),
        JSON.stringify(b.write_scope),
        b.spend_cap_cents,
        JSON.stringify(b.escalate_on),
      )
      .run();
    await audit(c.env, null, "human", "guardrails.updated", {
      org,
      worker: b.worker_role,
    });
    return c.json({ ok: true });
  },
);

app.post("/api/orgs/:org/ingest/upload", async (c) => {
  const org = await roleOrg(c, ...DECIDERS);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "multipart field 'file' required" }, 400);
  }
  if (file.size > 1024 * 1024) {
    return c.json({ error: "file too large (1MB max)" }, 413);
  }
  const result = await ingestUpload(
    c.env,
    org,
    file.name || "upload.txt",
    await file.arrayBuffer(),
  );
  await audit(c.env, null, "human", "ingest.upload", { org, ...result });
  return c.json(result, 201);
});

app.post(
  "/api/orgs/:org/ingest/github",
  zValidator(
    "json",
    z.object({ token: z.string().min(10), repo: z.string().min(3) }),
  ),
  async (c) => {
    const org = await roleOrg(c, ...DECIDERS);
    if (!org) return c.json({ error: "forbidden" }, 403);
    const { token, repo } = c.req.valid("json");
    // One-shot: the token is used for this ingest only, never stored.
    const result = await ingestGitHub(c.env, org, token, repo);
    await audit(c.env, null, "human", "ingest.github", { org, repo, ...result });
    return c.json(result, 201);
  },
);

app.get("/api/auth/:provider/connect", async (c) => {
  const provider = c.req.param("provider");
  const org = c.req.query("org") ?? "";
  if (!isProvider(provider) || !org || org.length > 64) {
    return c.json({ error: "unknown provider or bad org" }, 400);
  }
  // Binding a provider account to an org is owner-only: without this,
  // anyone who knows an org id could attach their own accounts to it.
  const user = await getSessionUser(c.env, c.req.raw);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const role = await memberRole(c.env, org, user.id);
  if (role !== "owner") return c.json({ error: "forbidden" }, 403);
  if (provider === "shopify") {
    const shop = normalizeShop(c.req.query("shop") ?? "");
    if (!shop) {
      return c.json(
        { error: "shopify connect needs ?shop=your-store.myshopify.com" },
        400,
      );
    }
  }
  const base = new URL(c.req.url).origin;
  try {
    const url = await connectUrl(
      c.env,
      provider,
      org,
      base,
      c.req.query("shop") ?? undefined,
    );
    return c.redirect(url, 302);
  } catch (err) {
    if (err instanceof ProviderNotConfigured) {
      return c.json({ error: String(err).slice(0, 160) }, 503);
    }
    return c.json({ error: String(err).slice(0, 160) }, 400);
  }
});

app.post("/api/slack/events", async (c) => {
  if (!(await takeHit(c.env, `slack:${clientIp(c.req.raw)}`, 120, 60))) {
    return c.json({ error: "too many requests" }, 429);
  }
  const raw = await c.req.text();
  const ok = await verifySlack(
    c.env,
    raw,
    c.req.header("x-slack-request-timestamp") ?? "",
    c.req.header("x-slack-signature") ?? "",
  );
  if (!ok) return c.json({ error: "bad signature" }, 401);
  let body: {
    type?: string;
    challenge?: string;
    team_id?: string;
    event_id?: string;
    event?: SlackEvent;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json({ error: "bad body" }, 400);
  }
  if (body.type === "url_verification") {
    return c.json({ challenge: body.challenge ?? "" });
  }
  if (body.type === "event_callback" && body.event && body.team_id && body.event_id) {
    c.executionCtx.waitUntil(
      handleSlackEvent(c.env, body.team_id, body.event_id, body.event).catch(() => {}),
    );
  }
  return c.json({ ok: true });
});

app.get("/api/auth/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  const fail = (msg: string) =>
    c.redirect(`${c.env.APP_URL}/?error=${encodeURIComponent(msg)}`, 302);
  if (!isProvider(provider) || !code || !state) {
    return fail(`${provider} connect failed`);
  }
  {
    // The completer must own the org the state binds: the sign-in cookie
    // survives the provider round-trip, so a missing session is a forgery.
    const user = await getSessionUser(c.env, c.req.raw);
    const { org } = await verifyState(c.env.AUTH_SECRET, state).catch(() => ({
      org: "",
      shop: null,
    }));
    const role = user && org ? await memberRole(c.env, org, user.id) : null;
    if (!user || role !== "owner") {
      return fail(`${provider} connect needs an owner session`);
    }
  }
  try {
    const base = new URL(c.req.url).origin;
    const { org, grantedScope } = await finishConnect(
      c.env,
      provider,
      code,
      state,
      base,
    );
    await audit(c.env, null, "human", "integration.connected", {
      org,
      provider,
      grantedScope: grantedScope ?? "unknown",
    });
    return c.redirect(
      `${c.env.APP_URL}/?connected=${provider}&org=${encodeURIComponent(org)}`,
      302,
    );
  } catch (err) {
    return fail(`${provider}: ${String(err).slice(0, 120)}`);
  }
});

app.get("/api/orgs/:org", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const row = await c.env.DB.prepare(
    `SELECT id, name, trial_started_at, trial_ends_at, grace_used, subscribed,
       idea_allowance_words, proposal_grace_hours
     FROM orgs WHERE id = ?`,
  )
    .bind(org)
    .first<{
      id: string;
      name: string;
      trial_started_at: number;
      trial_ends_at: number;
      grace_used: number;
      subscribed: number;
      idea_allowance_words: number;
      proposal_grace_hours: number;
    }>();
  if (!row) return c.json({ error: "not found" }, 404);
  // Pure read: only run/baseline attempts may grant grace, never a banner fetch.
  return c.json({
    id: row.id,
    name: row.name,
    trial: trialStatus(Date.now(), row),
    ideas: {
      ...(await ideaBudget(c.env, org)),
      graceHours: row.proposal_grace_hours,
    },
  });
});

app.put(
  "/api/orgs/:org/settings",
  zValidator(
    "json",
    z.object({
      idea_allowance_words: z.number().int().min(0).max(10000000).optional(),
      proposal_grace_hours: z.number().int().min(24).max(168).optional(),
    }),
  ),
  async (c) => {
    const org = await roleOrg(c, ...OWNERS);
    if (!org) return c.json({ error: "forbidden" }, 403);
    const b = c.req.valid("json");
    if (b.idea_allowance_words !== undefined) {
      await c.env.DB.prepare("UPDATE orgs SET idea_allowance_words = ? WHERE id = ?")
        .bind(b.idea_allowance_words, org)
        .run();
    }
    if (b.proposal_grace_hours !== undefined) {
      await c.env.DB.prepare("UPDATE orgs SET proposal_grace_hours = ? WHERE id = ?")
        .bind(b.proposal_grace_hours, org)
        .run();
    }
    await audit(c.env, null, "human", "org.settings_updated", { org });
    return c.json({ ok: true });
  },
);

app.get("/api/orgs/:org/connections", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const out: Record<string, boolean> = {};
  for (const p of PROVIDER_IDS) {
    out[p] = (await loadToken(c.env, org, p)) !== null;
  }
  return c.json(out);
});

app.get("/api/orgs/:org/config/:provider", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  const provider = c.req.param("provider");
  if (!org) return c.json({ error: "forbidden" }, 403);
  if (!isProvider(provider)) return c.json({ error: "unknown provider" }, 400);
  return c.json({ config: await getProviderConfig(c.env, org, provider) });
});

app.put(
  "/api/orgs/:org/config/:provider",
  zValidator("json", z.object({ config: z.record(z.unknown()) })),
  async (c) => {
    const org = await roleOrg(c, ...OWNERS);
    const provider = c.req.param("provider");
    if (!org) return c.json({ error: "forbidden" }, 403);
    if (!isProvider(provider)) {
      return c.json({ error: "unknown provider" }, 400);
    }
    const { config } = c.req.valid("json");
    const check = validateProviderConfig(provider, config);
    if (!check.ok) return c.json({ error: check.error }, 400);
    // Store the canonical shop domain so the OAuth state and the saved
    // config can never disagree on spelling.
    const canonical =
      provider === "shopify"
        ? { ...config, shop: normalizeShop(String(config.shop)) }
        : config;
    await setProviderConfig(c.env, org, provider, canonical);
    await audit(c.env, null, "human", "provider.config_saved", {
      org,
      provider,
    });
    return c.json({ ok: true });
  },
);

app.get("/api/orgs/:org/shopify/products", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const token = await loadToken(c.env, org, "shopify");
  if (!token) return c.json({ error: "shopify not connected" }, 409);
  const { shop } = await getProviderConfig(c.env, org, "shopify");
  if (typeof shop !== "string" || !shop) {
    return c.json({ error: "shopify shop not configured" }, 409);
  }
  try {
    return c.json({ products: await listProducts(shop, token) });
  } catch (err) {
    return c.json({ error: String(err).slice(0, 200) }, 502);
  }
});

app.get("/api/orgs/:org/teams", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  return c.json({ teams: await listTeams(c.env, org) });
});

app.post(
  "/api/orgs/:org/teams/:teamId/seats",
  zValidator("json", z.object({ role: z.string().min(1) })),
  async (c) => {
    const org = await roleOrg(c, ...OWNERS);
    if (!org) return c.json({ error: "forbidden" }, 403);
    const teamId = c.req.param("teamId");
    if (!(await teamInOrg(c.env, org, teamId))) {
      return c.json({ error: "unknown team" }, 404);
    }
    try {
      const seat = await hireSeat(c.env, org, teamId, c.req.valid("json").role);
      return c.json(seat, 201);
    } catch (err) {
      if (err instanceof DuplicateSeat) {
        return c.json({ error: String(err).slice(0, 160) }, 409);
      }
      if (err instanceof BadRole) {
        return c.json({ error: String(err).slice(0, 160) }, 400);
      }
      throw err;
    }
  },
);

app.post("/api/orgs/:org/seats/:seatId/approve", async (c) => {
  const org = await roleOrg(c, ...OWNERS);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const ok = await approveSeat(c.env, org, c.req.param("seatId"));
  if (!ok) return c.json({ error: "unknown seat" }, 404);
  return c.json({ ok: true });
});

app.get("/api/orgs/:org/goals", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  return c.json({ goals: await listGoals(c.env, org) });
});

app.post(
  "/api/orgs/:org/goals",
  zValidator(
    "json",
    z.object({
      teamId: z.string().optional(),
      title: z.string().min(8).max(200),
      metricName: z.string().optional(),
      metricSource: z.string().optional(),
      metricBaseline: z.number().optional(),
      metricTarget: z.number().optional(),
      deadline: z.string().optional(),
      schedule: z.string().optional(),
      approvalMode: z.string().optional(),
    }),
  ),
  async (c) => {
    const org = await roleOrg(c, ...DECIDERS);
    if (!org) return c.json({ error: "forbidden" }, 403);
    try {
      const id = await createGoal(c.env, org, c.req.valid("json"));
      return c.json({ id }, 201);
    } catch (err) {
      if (err instanceof BadGoal) {
        return c.json({ error: String(err).slice(0, 160) }, 400);
      }
      throw err;
    }
  },
);

app.get("/api/orgs/:org/goals/:goalId", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const goal = await getGoal(c.env, org, c.req.param("goalId"));
  if (!goal) return c.json({ error: "not found" }, 404);
  return c.json({
    goal,
    timeline: await goalTimeline(c.env, goal.id),
    series: await metricSeries(c.env, goal.id),
  });
});

app.patch(
  "/api/orgs/:org/goals/:goalId",
  zValidator(
    "json",
    z.object({
      title: z.string().min(8).max(200).optional(),
      metric_name: z.string().nullable().optional(),
      metric_source: z.string().nullable().optional(),
      metric_baseline: z.number().nullable().optional(),
      metric_target: z.number().nullable().optional(),
      deadline: z.string().nullable().optional(),
      schedule: z.string().optional(),
      approval_mode: z.string().optional(),
      status: z.string().optional(),
    }),
  ),
  async (c) => {
    const org = await roleOrg(c, ...DECIDERS);
    if (!org) return c.json({ error: "forbidden" }, 403);
    try {
      const ok = await updateGoal(c.env, org, c.req.param("goalId"), c.req.valid("json"));
      if (!ok) return c.json({ error: "not found" }, 404);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof BadGoal) {
        return c.json({ error: String(err).slice(0, 160) }, 400);
      }
      throw err;
    }
  },
);

app.post("/api/orgs/:org/goals/:goalId/restaff", async (c) => {
  const org = await roleOrg(c, ...DECIDERS);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const squad = await restaffGoal(c.env, org, c.req.param("goalId"));
  if (!squad) return c.json({ error: "not found" }, 404);
  return c.json({ squad });
});

app.post(
  "/api/orgs/:org/goals/:goalId/metrics",
  zValidator("json", z.object({ value: z.number() })),
  async (c) => {
    const org = await roleOrg(c, ...DECIDERS);
    if (!org) return c.json({ error: "forbidden" }, 403);
    const goal = await getGoal(c.env, org, c.req.param("goalId"));
    if (!goal) return c.json({ error: "not found" }, 404);
    await recordMetricPoint(c.env, goal.id, c.req.valid("json").value, "entry");
    return c.json({ ok: true }, 201);
  },
);

app.post("/api/orgs/:org/goals/:goalId/pull", async (c) => {
  const org = await roleOrg(c, ...DECIDERS);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const goal = await getGoal(c.env, org, c.req.param("goalId"));
  if (!goal) return c.json({ error: "not found" }, 404);
  const res = await pullGoalMetric(c.env, goal);
  if (res.status === "pulled") {
    return c.json({ ok: true, value: res.value, detail: res.detail });
  }
  if (res.status === "failed") return c.json({ ok: false, reason: res.reason });
  return c.json({ ok: false, reason: "manual metric — enter a value" }, 409);
});

app.get("/api/orgs/:org/runs", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const goal = c.req.query("goal") ?? null;
  const status = c.req.query("status") ?? null;
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
  const conds = ["org_id = ?"];
  const vals: unknown[] = [org];
  if (goal) {
    conds.push("goal_id = ?");
    vals.push(goal);
  }
  if (status) {
    conds.push("status = ?");
    vals.push(status);
  }
  vals.push(limit);
  const rows = await c.env.DB.prepare(
    `SELECT id, goal_id, kind, goal, status, lineup, tokens_used, created_at,
      (SELECT decision FROM rulings WHERE run_id = runs.id
       ORDER BY attempt DESC LIMIT 1) AS outcome,
      (SELECT p.title FROM proposals p
       LEFT JOIN votes v ON v.proposal_id = p.id AND v.choice = 'for'
       WHERE p.run_id = runs.id GROUP BY p.id
       ORDER BY COUNT(v.proposal_id) DESC, p.rowid LIMIT 1) AS top_suggestion,
      (SELECT COUNT(*) FROM actions
       WHERE run_id = runs.id AND status = 'done'
       AND target NOT LIKE 'closeout:%') AS ships
     FROM runs WHERE ${conds.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
  )
    .bind(...vals)
    .all<{
      id: string;
      goal_id: string | null;
      kind: string;
      goal: string;
      status: string;
      lineup: string;
      tokens_used: number;
      created_at: string;
      outcome: string | null;
      top_suggestion: string | null;
      ships: number;
    }>();
  return c.json({ runs: rows.results ?? [] });
});

app.get("/api/orgs/:org/approvals", async (c) => {
  const org = c.req.param("org") ?? "";
  // Any human member watches; §8 invites add non-owners here.
  const role = await memberRole(c.env, org, c.get("user").id);
  if (!role) return c.json({ error: "not found" }, 404);
  const status = c.req.query("status") || undefined;
  if (status && !["pending", "approved", "rejected", "changes"].includes(status)) {
    return c.json({ error: "bad status" }, 400);
  }
  return c.json({ approvals: await listApprovals(c.env, org, status) });
});

app.post("/api/orgs/:org/approvals/approve-all", async (c) => {
  const org = c.req.param("org") ?? "";
  const user = await approvalDecider(c, org);
  if (!user) return c.json({ error: "forbidden" }, 403);
  const gate = await trialGate(c.env, org);
  if (!gate.allowed) return c.json(trialExpiredBody(gate.status), 403);
  const pend = await listApprovals(c.env, org, "pending");
  let approved = 0;
  const failed: string[] = [];
  for (const p of pend) {
    try {
      if (p.kind === "pre") {
        const res = await decidePreApproval(c.env, {
          runId: p.runId,
          userId: user.id,
          decision: "approve",
        });
        if (res.outcome === "approved") approved++;
        else failed.push(p.id);
      } else if (p.actionId) {
        const res = await approveAction(c.env, {
          runId: p.runId,
          actionId: p.actionId,
          userId: user.id,
        });
        if (res === "ok") approved++;
        else failed.push(p.id);
      }
    } catch {
      failed.push(p.id);
    }
  }
  return c.json({ ok: true, approved, failed });
});

/** Latest shipped results across the org's sessions, newest first. */
app.get("/api/orgs/:org/activity", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT a.id AS id, a.kind AS kind, a.target AS target,
       a.status AS status, a.created_at AS createdAt, a.run_id AS runId,
       r.kind AS runKind, r.status AS runStatus,
       r.goal_id AS goalId, r.goal AS goal
     FROM actions a JOIN runs r ON r.id = a.run_id
     WHERE r.org_id = ? AND r.kind != 'sandbox'
       AND a.target NOT LIKE 'closeout:%'
     ORDER BY a.created_at DESC, a.rowid DESC LIMIT 20`,
  )
    .bind(org)
    .all<{
      id: string;
      kind: string;
      target: string;
      status: string;
      createdAt: string;
      runId: string;
      runKind: string;
      runStatus: string;
      goalId: string | null;
      goal: string;
    }>();
  return c.json({ activity: rows.results ?? [] });
});

app.get("/api/orgs/:org/proposals", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  return c.json({ proposals: await listProposals(c.env, org) });
});

app.post(
  "/api/orgs/:org/proposals/:id/decide",
  zValidator("json", z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(2000).optional() })),
  async (c) => {
    const org = await roleOrg(c, ...DECIDERS);
    if (!org) return c.json({ error: "forbidden" }, 403);
    const gate = await trialGate(c.env, org);
    if (!gate.allowed) return c.json(trialExpiredBody(gate.status), 403);
    const b = c.req.valid("json");
    const res = await decideProposal(c.env, org, c.req.param("id"), b.decision, b.note);
    if (res === "notfound") return c.json({ error: "not found" }, 404);
    if (res === "decided") return c.json({ error: "already decided" }, 409);
    return c.json({ ok: true });
  },
);

app.get("/api/orgs/:org/playbook", async (c) => {
  const org = c.req.param("org") ?? "";
  const role = await memberRole(c.env, org, c.get("user").id);
  if (!role) return c.json({ error: "not found" }, 404);
  return c.json({ entries: await listPlaybook(c.env, org) });
});

app.post(
  "/api/orgs/:org/invites",
  zValidator("json", z.object({ email: z.string().max(320), role: z.string() })),
  async (c) => {
    const org = await roleOrg(c, ...OWNERS);
    if (!org) return c.json({ error: "forbidden" }, 403);
    try {
      const body = c.req.valid("json");
      const invite = await createInvite(c.env, org, body.email, body.role, c.get("user").id);
      return c.json({ ok: true, id: invite.id, emailed: invite.emailed }, 201);
    } catch (err) {
      if (err instanceof BadInvite) {
        return c.json({ error: String(err).slice(0, 160) }, 400);
      }
      throw err;
    }
  },
);

app.get("/api/orgs/:org/invites", async (c) => {
  const org = await roleOrg(c, ...OWNERS);
  if (!org) return c.json({ error: "forbidden" }, 403);
  return c.json({ invites: await listInvites(c.env, org) });
});

app.delete("/api/orgs/:org/invites/:inviteId", async (c) => {
  const org = await roleOrg(c, ...OWNERS);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const ok = await revokeInvite(c.env, org, c.req.param("inviteId"));
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/orgs/:org/notifications", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const unreadOnly = c.req.query("unread") === "1";
  const rows = await c.env.DB.prepare(
    `SELECT id, kind, title, body, link, read, created_at AS createdAt
     FROM notifications WHERE org_id = ? ${unreadOnly ? "AND read = 0" : ""}
     ORDER BY rowid DESC LIMIT 100`,
  )
    .bind(org)
    .all<{
      id: string;
      kind: string;
      title: string;
      body: string;
      link: string;
      read: number;
      createdAt: string;
    }>();
  return c.json({ notifications: rows.results ?? [] });
});

app.post("/api/orgs/:org/notifications/:id/read", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  await c.env.DB.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND org_id = ?")
    .bind(c.req.param("id"), org)
    .run();
  return c.json({ ok: true });
});

app.get("/api/orgs/:org/members", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT m.user_id AS id, u.email AS email, m.role AS role,
       m.created_at AS createdAt FROM org_members m
     LEFT JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.rowid`,
  )
    .bind(org)
    .all<{ id: string; email: string | null; role: string; createdAt: string }>();
  return c.json({ members: rows.results ?? [] });
});

app.get("/api/orgs/:org/hires", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  // System → owning seat. Tokens split evenly across the debating squad:
  // an estimate, labeled as such in the UI.
  const SYSTEM_ROLE: Record<string, string> = {
    github: "engineer",
    linear: "pm",
    notion: "pm",
    slack: "marketer",
    shopify: "marketer",
    hubspot: "analyst",
  };
  const roles = ["manager", "engineer", "pm", "marketer", "analyst"];
  const shape: Record<string, { runs: number; proposals: number; votes: number; shipped: number; up: number; down: number; tokens: number }> = {};
  for (const r of roles) {
    shape[r] = { runs: 0, proposals: 0, votes: 0, shipped: 0, up: 0, down: 0, tokens: 0 };
  }
  const runs = await c.env.DB.prepare(
    "SELECT id, lineup, tokens_used FROM runs WHERE org_id = ?",
  )
    .bind(org)
    .all<{ id: string; lineup: string; tokens_used: number }>();
  for (const r of runs.results ?? []) {
    let squad: string[] = [];
    try {
      squad = JSON.parse(r.lineup) as string[];
    } catch {
      /* legacy row */
    }
    const share = squad.length > 0 ? Math.floor((r.tokens_used ?? 0) / squad.length) : 0;
    const seen = new Set(["manager", ...squad]);
    for (const role of seen) {
      if (!shape[role]) continue;
      shape[role].runs += 1;
      shape[role].tokens += share;
    }
  }
  const props = await c.env.DB.prepare(
    `SELECT p.agent_role AS role, COUNT(*) AS c FROM proposals p
     JOIN runs r ON r.id = p.run_id WHERE r.org_id = ? GROUP BY p.agent_role`,
  )
    .bind(org)
    .all<{ role: string; c: number }>();
  for (const p of props.results ?? []) {
    if (shape[p.role]) shape[p.role].proposals += p.c;
  }
  const votes = await c.env.DB.prepare(
    `SELECT v.agent_role AS role, COUNT(*) AS c FROM votes v
     JOIN runs r ON r.id = v.run_id WHERE r.org_id = ? GROUP BY v.agent_role`,
  )
    .bind(org)
    .all<{ role: string; c: number }>();
  for (const v of votes.results ?? []) {
    if (shape[v.role]) shape[v.role].votes += v.c;
  }
  const actions = await c.env.DB.prepare(
    `SELECT a.kind AS kind FROM actions a JOIN runs r ON r.id = a.run_id
     WHERE r.org_id = ? AND a.status = 'done' AND a.target NOT LIKE 'closeout%'`,
  )
    .bind(org)
    .all<{ kind: string }>();
  for (const a of actions.results ?? []) {
    const role = SYSTEM_ROLE[a.kind.split(".")[0]];
    if (role) shape[role].shipped += 1;
  }
  const ratings = await c.env.DB.prepare(
    `SELECT a.kind AS kind, r.thumb AS thumb FROM ratings r
     JOIN actions a ON a.id = r.action_id JOIN runs ru ON ru.id = r.run_id
     WHERE ru.org_id = ?`,
  )
    .bind(org)
    .all<{ kind: string; thumb: string }>();
  for (const t of ratings.results ?? []) {
    const role = SYSTEM_ROLE[t.kind.split(".")[0]];
    if (!role) continue;
    if (t.thumb === "up") shape[role].up += 1;
    else shape[role].down += 1;
  }
  return c.json({
    hires: roles.map((role) => ({ role, ...shape[role], tokensEstimated: true })),
  });
});

app.get("/api/orgs/:org/audit.csv", async (c) => {
  const org = await roleOrg(c, ...EVERYONE);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT id, created_at, run_id, actor, event, detail FROM audit_log
     WHERE org_id = ? ORDER BY id DESC LIMIT 5000`,
  )
    .bind(org)
    .all<{
      id: number;
      created_at: string;
      run_id: string | null;
      actor: string;
      event: string;
      detail: string;
    }>();
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    "id,created_at,run_id,actor,event,detail",
    ...(rows.results ?? []).map((r) =>
      [r.id, r.created_at, r.run_id, r.actor, r.event, r.detail].map(cell).join(","),
    ),
  ].join("\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv",
      "content-disposition": `attachment; filename="audit-${org.slice(0, 8)}.csv"`,
    },
  });
});

app.get("/api/orgs/:org/billing", async (c) => {
  const org = await roleOrg(c, ...OWNERS);
  if (!org) return c.json({ error: "forbidden" }, 403);
  const row = await c.env.DB.prepare(
    "SELECT subscribed, sub_status FROM orgs WHERE id = ?",
  )
    .bind(org)
    .first<{ subscribed: number; sub_status: string }>();
  return c.json({
    subscribed: (row?.subscribed ?? 0) === 1,
    subStatus: row?.sub_status ?? "none",
    seats: await rosterSeats(c.env, org),
    meter: await getMeter(c.env, org),
    pricePerWorker: "$499",
    checkoutReady: stripeConfigured(c.env),
  });
});

app.post("/api/orgs/:org/checkout", async (c) => {
  const org = await roleOrg(c, ...OWNERS);
  if (!org) return c.json({ error: "forbidden" }, 403);
  if (!(await takeHit(c.env, `checkout:${org}`, 10, 3600))) {
    return c.json({ error: "too many requests" }, 429);
  }
  if (!stripeConfigured(c.env)) {
    return c.json({ error: "stripe not configured" }, 503);
  }
  try {
    return c.json({ url: await createCheckoutSession(c.env, org) });
  } catch (err) {
    return c.json({ error: String(err).slice(0, 200) }, 502);
  }
});

// Unsigned by design: Stripe authenticates via the webhook signature.
app.post("/api/stripe/webhook", async (c) => {
  const result = await handleStripeWebhook(
    c.env,
    await c.req.text(),
    c.req.header("stripe-signature") ?? "",
  );
  return c.json(result.body, result.status);
});

// Registered last: provider OAuth routes above take precedence.
app.all("/api/auth/*", async (c) => {
  if (!(await takeHit(c.env, `auth:${clientIp(c.req.raw)}`, 60, 60))) {
    return c.json({ error: "too many requests" }, 429);
  }
  return authHandler(c.req.raw, c.env);
});

export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(guardTick(env, "sweep", () => sweepStuckRuns(env)));
    ctx.waitUntil(guardTick(env, "tickGoals", () => tickGoals(env)));
    ctx.waitUntil(guardTick(env, "tickStalled", () => tickStalled(env)));
    ctx.waitUntil(guardTick(env, "tickProposals", () => tickProposals(env)));
    ctx.waitUntil(guardTick(env, "promoteQueued", () => promoteQueued(env)));
    ctx.waitUntil(guardTick(env, "weeklyDigest", () => maybePostWeeklyDigest(env)));
    ctx.waitUntil(guardTick(env, "distill", () => distillLearning(env)));
    ctx.waitUntil(guardTick(env, "ticketThemes", () => tickTicketThemes(env)));
    ctx.waitUntil(guardTick(env, "errorWatch", () => tickErrorWatch(env)));
  },
};
