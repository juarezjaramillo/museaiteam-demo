import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { busyRoles, createWorkRun, promoteQueued, recordBorrowing } from "../src/staffing.js";
import { todayDay } from "../src/teams.js";
import { FakeDB, blankTables, type FakeTables } from "./fake-db.js";

function env() {
  const tables = blankTables();
  tables.orgs.push({ id: "org1" });
  tables.teams.push({ id: "t1", org_id: "org1", name: "Support team" });
  tables.teams.push({ id: "t2", org_id: "org1", name: "Bench" });
  tables.seats.push({ id: "s1", team_id: "t1", role: "engineer", hired: 1 });
  tables.seats.push({ id: "s2", team_id: "t2", role: "pm", hired: 1 });
  tables.runs.push({ id: "run1", org_id: "org1", team_id: "t1", goal: "tonight", status: "open", kind: "work", kill_flag: 0, lineup: '["pm"]' });
  return { env: { DB: new FakeDB(tables) } as unknown as Env, tables };
}

describe("cross-team borrowing", () => {
  it("logs the borrow on the run and tells the founder once", async () => {
    const { env: e, tables } = env();
    await recordBorrowing(e, "org1", "run1", "t1", ["pm"], false);
    expect(tables.audit_log.map((r) => r.event)).toEqual(["run.borrowed"]);
    expect(tables.notifications).toHaveLength(1);
    expect(tables.notifications[0]?.kind).toBe("run.borrowed");
    expect(String(tables.notifications[0]?.title)).toContain("Support team borrowed");
    expect(String(tables.notifications[0]?.body)).toContain("Bench");
  });

  it("own-team roles are not borrows", async () => {
    const { env: e, tables } = env();
    await recordBorrowing(e, "org1", "run1", "t1", ["engineer"], false);
    expect(tables.audit_log).toHaveLength(0);
    expect(tables.notifications).toHaveLength(0);
  });

  it("seatless roles are not borrows", async () => {
    const { env: e, tables } = env();
    await recordBorrowing(e, "org1", "run1", "t1", ["marketer"], false);
    expect(tables.audit_log).toHaveLength(0);
    expect(tables.notifications).toHaveLength(0);
  });

  it("a queued run behind another team's hire gets a manager ruling", async () => {
    const { env: e, tables } = env();
    tables.runs.push({ id: "r-block", org_id: "org1", team_id: "t2", goal: "Other work", status: "open", kind: "work", kill_flag: 0, lineup: '["pm"]' });
    await recordBorrowing(e, "org1", "run1", "t1", ["pm"], true);
    expect(tables.rulings).toHaveLength(1);
    expect(tables.rulings[0]).toMatchObject({ run_id: "run1", decision: "wait", decided_by: "manager", attempt: 0 });
    expect(String(tables.rulings[0]?.rationale)).toContain("Bench");
    expect(tables.audit_log.map((r) => r.event)).toContain("run.arbitrated");
  });

  it("no ruling for same-team contention or unqueued runs", async () => {
    const { env: e, tables } = env();
    tables.runs.push({ id: "r-block", org_id: "org1", team_id: "t1", goal: "Own work", status: "open", kind: "work", kill_flag: 0, lineup: '["engineer"]' });
    await recordBorrowing(e, "org1", "run1", "t1", ["engineer"], true);
    expect(tables.rulings).toHaveLength(0);
    await recordBorrowing(e, "org1", "run1", "t1", ["pm"], false);
    expect(tables.rulings).toHaveLength(0);
  });
});

function briefEnv(opts: { goalBrief?: string | null; teamBrief?: string }): {
  env: Env;
  tables: FakeTables;
} {
  const tables = blankTables();
  tables.orgs.push({ id: "org1" });
  tables.teams.push({ id: "t1", org_id: "org1", name: "Support team" });
  tables.seats.push({ id: "s1", team_id: "t1", role: "engineer", hired: 1 });
  tables.goals.push({
    id: "g1",
    org_id: "org1",
    team_id: "t1",
    title: "Ship gift boxes",
    status: "active",
    squad: '["engineer"]',
    brief_note: opts.goalBrief ?? null,
  });
  if (opts.teamBrief !== undefined) {
    tables.team_briefs.push({ team_id: "t1", day: todayDay(), text: opts.teamBrief });
  }
  const e = {
    DB: new FakeDB(tables),
    GOAL_RUN: { create: async () => {} },
  } as unknown as Env;
  return { env: e, tables };
}

async function runBrief(
  e: Env,
  tables: FakeTables,
  input: { goalId?: string; briefNote?: string },
): Promise<string> {
  const created = await createWorkRun(e, {
    orgId: "org1",
    goalId: input.goalId,
    goal: "Ship gift boxes",
    briefNote: input.briefNote,
  });
  return String(tables.runs.find((r) => r.id === created.runId)?.brief_note ?? "");
}

describe("run brief", () => {
  it("the goal brief leads and the team brief follows", async () => {
    const { env: e, tables } = briefEnv({
      goalBrief: "Raise the gift-box attach rate.",
      teamBrief: "Today: Acme tickets.",
    });
    expect(await runBrief(e, tables, { goalId: "g1" })).toBe(
      "Raise the gift-box attach rate.\n\nToday: Acme tickets.",
    );
  });

  it("an explicit note wins over both briefs", async () => {
    const { env: e, tables } = briefEnv({
      goalBrief: "Raise the gift-box attach rate.",
      teamBrief: "Today: Acme tickets.",
    });
    expect(await runBrief(e, tables, { goalId: "g1", briefNote: "Explicit." })).toBe("Explicit.");
  });

  it("either brief alone stands on its own", async () => {
    const goalOnly = briefEnv({ goalBrief: "Goal only." });
    expect(await runBrief(goalOnly.env, goalOnly.tables, { goalId: "g1" })).toBe("Goal only.");
    const teamOnly = briefEnv({ teamBrief: "Team only." });
    expect(await runBrief(teamOnly.env, teamOnly.tables, { goalId: "g1" })).toBe("Team only.");
  });

  it("no briefs means an empty note", async () => {
    const { env: e, tables } = briefEnv({});
    expect(await runBrief(e, tables, { goalId: "g1" })).toBe("");
  });
});

describe("workflow-create failures", () => {
  it("createWorkRun requeues instead of stranding an open run", async () => {
    const { tables } = briefEnv({});
    const e = {
      DB: new FakeDB(tables),
      GOAL_RUN: {
        create: async () => {
          throw new Error("workflow down");
        },
      },
    } as unknown as Env;
    const created = await createWorkRun(e, { orgId: "org1", goalId: "g1", goal: "Ship gift boxes" });
    expect(created.status).toBe("queued");
    expect(tables.runs.find((r) => r.id === created.runId)?.status).toBe("queued");
    expect(tables.audit_log.some((r) => r.event === "run.promote_failed")).toBe(true);
  });

  it("promoteQueued releases the claim when starting fails", async () => {
    const tables = blankTables();
    tables.orgs.push({ id: "org1" });
    tables.teams.push({ id: "t1", org_id: "org1", name: "Support team" });
    tables.seats.push({ id: "s1", team_id: "t1", role: "engineer", hired: 1 });
    tables.runs.push({
      id: "q1",
      org_id: "org1",
      team_id: "t1",
      goal: "Ship gift boxes",
      status: "queued",
      kind: "work",
      kill_flag: 0,
      lineup: '["engineer"]',
      tokens_used: 0,
    });
    const e = {
      DB: new FakeDB(tables),
      GOAL_RUN: {
        create: async () => {
          throw new Error("workflow down");
        },
      },
    } as unknown as Env;
    await promoteQueued(e);
    expect(tables.runs.find((r) => r.id === "q1")?.status).toBe("queued");
  });

  it("promoteQueued starts a queued run when healthy", async () => {
    const tables = blankTables();
    tables.orgs.push({ id: "org1" });
    tables.teams.push({ id: "t1", org_id: "org1", name: "Support team" });
    tables.seats.push({ id: "s1", team_id: "t1", role: "engineer", hired: 1 });
    tables.runs.push({
      id: "q1",
      org_id: "org1",
      team_id: "t1",
      goal: "Ship gift boxes",
      status: "queued",
      kind: "work",
      kill_flag: 0,
      lineup: '["engineer"]',
      tokens_used: 0,
    });
    let started = 0;
    const e = {
      DB: new FakeDB(tables),
      GOAL_RUN: {
        create: async () => {
          started += 1;
        },
      },
    } as unknown as Env;
    await promoteQueued(e);
    expect(started).toBe(1);
    expect(tables.runs.find((r) => r.id === "q1")?.status).toBe("open");
  });
});

describe("busyRoles", () => {
  it("a ruled run still holds its squad", async () => {
    const { env: e, tables } = env();
    tables.runs.push({
      id: "run2", org_id: "org1", team_id: "t1", goal: "tonight",
      status: "ruled", kind: "work", kill_flag: 0, lineup: '["engineer"]',
    });
    expect(await busyRoles(e, "org1")).toEqual(new Set(["pm", "engineer"]));
  });
  it("queued runs wait without holding", async () => {
    const { env: e, tables } = env();
    tables.runs.push({
      id: "run2", org_id: "org1", team_id: "t1", goal: "tonight",
      status: "queued", kind: "work", kill_flag: 0, lineup: '["engineer"]',
    });
    expect(await busyRoles(e, "org1")).toEqual(new Set(["pm"]));
  });
});
