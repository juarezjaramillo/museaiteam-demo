import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { deriveOwner, triggerCoolingDown } from "../src/checks.js";
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
    tables.runs.push({ id: "r1", goal_id: "g1", kind: "trigger", status: "done" });
    expect(await triggerCoolingDown(e, "g1")).toBe(true);
    expect(await triggerCoolingDown(e, "g2")).toBe(false);
  });
});
