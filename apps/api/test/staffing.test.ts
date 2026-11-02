import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { recordBorrowing } from "../src/staffing.js";
import { FakeDB, blankTables } from "./fake-db.js";

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
