import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { approveAction, autoReviewRun } from "../src/approvals.js";
import { FakeDB, blankTables } from "./fake-db.js";

function seed() {
  const tables = blankTables();
  tables.runs.push({
    id: "run1",
    org_id: "org1",
    goal_id: "goal1",
    kind: "work",
    goal: "File one Linear issue",
    status: "done",
  });
  tables.goals.push({
    id: "goal1",
    org_id: "org1",
    title: "goal",
    approval_mode: "posthoc",
  });
  tables.actions.push(
    { id: "a1", run_id: "run1", kind: "linear.create_issue", status: "done", revert_payload: '{"id":"L1"}' },
    { id: "a2", run_id: "run1", kind: "slack.post_message", status: "done", revert_payload: '{"ts":"1"}' },
    { id: "a3", run_id: "run1", kind: "shopify.create_discount", status: "done", revert_payload: '{"id":"D1"}' },
    { id: "a4", run_id: "run1", kind: "github.open_pr", status: "done", revert_payload: null },
  );
  const env = { DB: new FakeDB(tables) } as unknown as Env;
  return { env, tables };
}

describe("autoReviewRun", () => {
  it("auto-approves undoable non-money acts, holds the rest", async () => {
    const { env, tables } = seed();
    const res = await autoReviewRun(env, "run1");
    expect(res).toEqual({ auto: 2, pending: 2 });
    const by = (id: string) => tables.approvals.find((r) => r.action_id === id)?.status;
    expect(by("a1")).toBe("approved");
    expect(by("a2")).toBe("approved");
    expect(by("a3")).toBe("pending");
    expect(by("a4")).toBe("pending");
    expect(tables.notifications).toHaveLength(1);
    expect(tables.audit_log.some((r) => r.event === "auto.review")).toBe(true);
  });

  it("is retry-safe", async () => {
    const { env, tables } = seed();
    await autoReviewRun(env, "run1");
    expect(await autoReviewRun(env, "run1")).toEqual({ auto: 0, pending: 0 });
    expect(tables.approvals).toHaveLength(4);
  });

  it("skips sandbox and check-first sessions", async () => {
    const { env, tables } = seed();
    tables.runs[0].kind = "sandbox";
    expect(await autoReviewRun(env, "run1")).toEqual({ auto: 0, pending: 0 });
    tables.runs[0].kind = "work";
    tables.goals[0].approval_mode = "preapprove";
    expect(await autoReviewRun(env, "run1")).toEqual({ auto: 0, pending: 0 });
  });
});

describe("approveAction", () => {
  it("claims pending rows and dedupes decided ones", async () => {
    const { env, tables } = seed();
    await autoReviewRun(env, "run1");
    expect(await approveAction(env, { runId: "run1", actionId: "a3", userId: "u1" })).toBe("ok");
    expect(tables.approvals).toHaveLength(4);
    expect(tables.approvals.find((r) => r.action_id === "a3")?.status).toBe("approved");
    expect(await approveAction(env, { runId: "run1", actionId: "a3", userId: "u1" })).toBe("ok");
    expect(tables.approvals).toHaveLength(4);
    expect(await approveAction(env, { runId: "run1", actionId: "nope", userId: "u1" })).toBe("notfound");
  });
});
