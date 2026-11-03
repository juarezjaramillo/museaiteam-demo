import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { deriveOwner, runCheck, tickStalled, triggerCoolingDown } from "../src/checks.js";
import { todayDay } from "../src/teams.js";
import { FakeDB, blankTables } from "./fake-db.js";

function env(tables = blankTables()) {
  return { env: { DB: new FakeDB(tables) } as unknown as Env, tables };
}

describe("deriveOwner", () => {
  it("picks the role that worked the goal most, manager when new", async () => {
    const { env: e, tables } = env();
    expect(await deriveOwner(e, "g1")).toBe("manager");
    tables.runs.push(
      { id: "r1", goal_id: "g1", status: "done", lineup: '["analyst","qa"]' },
      { id: "r2", goal_id: "g1", status: "done", lineup: '["analyst","engineer"]' },
      { id: "r3", goal_id: "g1", status: "failed", lineup: '["qa","qa"]' },
      { id: "r4", goal_id: "g1", status: "done", lineup: "bogus" },
    );
    expect(await deriveOwner(e, "g1")).toBe("analyst");
  });
});

describe("triggerCoolingDown", () => {
  it("rests after a recent trigger session", async () => {
    const { env: e, tables } = env();
    expect(await triggerCoolingDown(e, "g1")).toBe(false);
    tables.runs.push({
      id: "r1", goal_id: "g1", kind: "trigger", status: "done",
      created_at: new Date().toISOString(),
    });
    expect(await triggerCoolingDown(e, "g1")).toBe(true);
    expect(await triggerCoolingDown(e, "g2")).toBe(false);
  });
  it("fires again once the trigger session is a day old", async () => {
    const { env: e, tables } = env();
    tables.runs.push({
      id: "r1", goal_id: "g1", kind: "trigger", status: "done",
      created_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
    });
    expect(await triggerCoolingDown(e, "g1")).toBe(false);
  });
});

describe("tickStalled", () => {
  const OLD = new Date(Date.now() - 20 * 86400_000).toISOString();
  const NEW = new Date(Date.now() - 86400_000).toISOString();
  function stalledEnv() {
    const tables = blankTables();
    tables.goals.push({
      id: "g1", org_id: "org1", title: "Grow revenue",
      status: "active", created_at: OLD,
    });
    return { env: { DB: new FakeDB(tables) } as unknown as Env, tables };
  }
  it("flags a goal whose number moved long ago but not in 14 days", async () => {
    const { env: e, tables } = stalledEnv();
    tables.metric_points.push(
      { goal_id: "g1", ts: OLD, value: 1 },
      { goal_id: "g1", ts: OLD, value: 5 },
    );
    await tickStalled(e);
    expect(tables.goal_events.some((r) => r.kind === "goal.stalled")).toBe(true);
    expect(tables.notifications.some((n) => n.kind === "goal.stalled")).toBe(true);
  });
  it("leaves a goal that moved this week alone", async () => {
    const { env: e, tables } = stalledEnv();
    tables.metric_points.push(
      { goal_id: "g1", ts: OLD, value: 1 },
      { goal_id: "g1", ts: NEW, value: 5 },
    );
    await tickStalled(e);
    expect(tables.goal_events.length).toBe(0);
  });
  it("flags a goal re-recorded flat this week", async () => {
    const { env: e, tables } = stalledEnv();
    tables.metric_points.push(
      { goal_id: "g1", ts: OLD, value: 5 },
      { goal_id: "g1", ts: NEW, value: 5 },
    );
    await tickStalled(e);
    expect(tables.goal_events.some((r) => r.kind === "goal.stalled")).toBe(true);
  });
  it("flags at most once a week", async () => {
    const { env: e, tables } = stalledEnv();
    tables.goal_events.push({ goal_id: "g1", kind: "goal.stalled", created_at: NEW });
    await tickStalled(e);
    expect(tables.goal_events.length).toBe(1);
  });
});

describe("runCheck cooldown", () => {
  it("rests instead of refiring while cooling down", async () => {
    const tables = blankTables();
    const goal = {
      id: "g1", org_id: "org1", team_id: "t1", title: "Grow revenue",
      metric_name: "revenue", metric_source: null, metric_baseline: null,
      metric_target: null, approval_mode: "posthoc", deadline: null,
      schedule: "daily", status: "active", last_check_at: null,
      brief_note: null,
    };
    tables.orgs.push({ id: "org1", subscribed: 1 });
    tables.teams.push({ id: "t1", org_id: "org1" });
    tables.goals.push({ ...goal });
    const now = Date.now();
    const day = 86400_000;
    tables.metric_points.push(
      { goal_id: "g1", ts: new Date(now - 3 * day).toISOString(), value: 10, source: "entry" },
      { goal_id: "g1", ts: new Date(now - 2 * day).toISOString(), value: 10, source: "entry" },
      { goal_id: "g1", ts: new Date(now - day).toISOString(), value: 20, source: "entry" },
    );
    tables.runs.push({ id: "trig1", org_id: "org1", goal_id: "g1", kind: "trigger", status: "done", tokens_used: 0, created_at: new Date().toISOString() });
    const { env: e } = env(tables);
    await runCheck(e, goal);
    expect(tables.runs.filter((r) => r.kind !== "check" && r.id !== "trig1")).toEqual([]);
    expect(tables.goal_events.some((r) => r.kind === "check.monitoring")).toBe(true);
  });
});

describe("runCheck trigger brief", () => {
  it("carries the goal and team briefs into the trigger run", async () => {
    const tables = blankTables();
    const goal = {
      id: "g1", org_id: "org1", team_id: "t1", title: "Grow revenue",
      metric_name: "revenue", metric_source: null, metric_baseline: null,
      metric_target: null, approval_mode: "posthoc", deadline: null,
      schedule: "daily", status: "active", last_check_at: null,
      brief_note: "Raise the gift-box attach rate.",
    };
    tables.orgs.push({ id: "org1", subscribed: 1 });
    tables.teams.push({ id: "t1", org_id: "org1" });
    tables.seats.push({ id: "s1", team_id: "t1", role: "engineer", hired: 1 });
    tables.goals.push({ ...goal, squad: '["engineer"]' });
    tables.team_briefs.push({ team_id: "t1", day: todayDay(), text: "Today: Acme tickets." });
    const now = Date.now();
    const day = 86400_000;
    tables.metric_points.push(
      { goal_id: "g1", ts: new Date(now - 3 * day).toISOString(), value: 10, source: "entry" },
      { goal_id: "g1", ts: new Date(now - 2 * day).toISOString(), value: 10, source: "entry" },
      { goal_id: "g1", ts: new Date(now - day).toISOString(), value: 20, source: "entry" },
    );
    const e = {
      DB: new FakeDB(tables),
      GOAL_RUN: { create: async () => {} },
    } as unknown as Env;
    await runCheck(e, goal);
    const trigger = tables.runs.find((r) => r.kind === "trigger");
    expect(trigger).toBeTruthy();
    expect(String(trigger?.brief_note)).toContain("Metric trigger:");
    expect(String(trigger?.brief_note)).toContain("Raise the gift-box attach rate.");
  });
});
