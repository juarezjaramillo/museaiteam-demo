import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/bindings.js";

const created: Array<Record<string, unknown>> = [];
vi.mock("../src/staffing.js", async (orig) => {
  const mod = await orig<typeof import("../src/staffing.js")>();
  return {
    ...mod,
    createWorkRun: async (_env: Env, input: Record<string, unknown>) => {
      created.push(input);
      return { runId: "run1", status: "open", squad: ["engineer"] };
    },
  };
});

import { maybeStartSessionOne, nudgeSeatRequests, teamSeats } from "../src/enroll.js";
import { FakeDB, blankTables } from "./fake-db.js";

const KEY = "ab".repeat(32);

function env() {
  const tables = blankTables();
  tables.orgs.push({ id: "org1", box_max_concurrent: 3, subscribed: 1 });
  tables.teams.push({ id: "t1", org_id: "org1" });
  tables.seats.push({ id: "s1", team_id: "t1", role: "engineer", email: "e@hires", hired: 1, approved: 1 });
  return { env: { DB: new FakeDB(tables), TOKEN_ENC_KEY: KEY } as unknown as Env, tables };
}

describe("enrollment", () => {
  it("starts session one once, on the keystone only", async () => {
    const { env: e, tables } = env();
    tables.seat_provisions.push(
      { seat_id: "s1", tool: "github", step: "verify", status: "verified", detail: "", attempts: 0 },
      { seat_id: "s1", tool: "linear", step: "invite", status: "pending", detail: "", attempts: 0 },
    );
    expect(await maybeStartSessionOne(e, "org1", "s1", "linear")).toBe("skipped");
    expect(await maybeStartSessionOne(e, "org1", "s1", "github")).toBe("started");
    expect(await maybeStartSessionOne(e, "org1", "s1", "github")).toBe("skipped");
    expect(created).toHaveLength(1);
    expect(String(created[0].goal)).toMatch(/github/);
    expect(String(created[0].goal)).toMatch(/linear/);
    expect(tables.goals).toHaveLength(1);
    expect(tables.notifications.some((n) => String(n.title).includes("working"))).toBe(true);
  });

  it("nudges week-old asks once per week", async () => {
    const { env: e, tables } = env();
    tables.seat_requests.push(
      { id: "r1", org_id: "org1", seat_id: "s1", tools_json: '["a"]', status: "proposed", created_at: "2020-01-01 00:00:00", nudged_at: null },
      { id: "r2", org_id: "org1", seat_id: "s1", tools_json: '["b"]', status: "proposed", created_at: "2999-01-01 00:00:00", nudged_at: null },
    );
    expect(await nudgeSeatRequests(e)).toBe(1);
    expect(await nudgeSeatRequests(e)).toBe(0);
  });

  it("team seats aggregate on/waiting/box/spend/meanwhile", async () => {
    const { env: e, tables } = env();
    tables.seat_provisions.push(
      { seat_id: "s1", tool: "github", step: "verify", status: "verified", detail: "", attempts: 0 },
      { seat_id: "s1", tool: "linear", step: "invite", status: "pending", detail: "waiting", attempts: 0 },
    );
    tables.box_state.push({ seat_id: "s1", org_id: "org1", status: "running", woken_at: 1, last_tick: 1, wake_count: 1 });
    tables.box_runs.push({ id: "br1", seat_id: "s1", org_id: "org1", started_at: Date.now(), stopped_at: 1, seconds: 60, instance_type: "basic", woken_by: "t" });
    tables.seat_milestones.push({ seat_id: "s1", milestone: "session_one", at: "" });
    tables.runs.push({ id: "run9", org_id: "org1", goal_id: "g", kind: "work", goal: "g", status: "acting" });
    tables.actions.push({ id: "a1", run_id: "run9", kind: "mcp.tool", target: "t", status: "skipped", payload: JSON.stringify({ reason: "seatless", note: "waiting on the hire's own X seat" }) });
    const view = await teamSeats(e, "org1");
    expect(view.seats).toHaveLength(1);
    const s = view.seats[0];
    expect(s.keystone).toBe("github");
    expect(s.keystoneReady).toBe(true);
    expect(s.sessionOne).toBe(true);
    expect(s.on).toEqual(["github"]);
    expect(s.waiting.map((w) => w.tool)).toEqual(["linear"]);
    expect(s.box).toBe("running");
    expect(s.spend?.seconds).toBe(60);
    expect(view.meanwhile).toEqual(["waiting on the hire's own X seat"]);
  });
});
