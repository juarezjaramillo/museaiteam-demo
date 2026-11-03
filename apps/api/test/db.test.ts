import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { addRunTokens, goalWithBrief, touchRun } from "../src/db.js";
import { FakeDB, blankTables } from "./fake-db.js";

function env(tokensUsed = 100) {
  const tables = blankTables();
  tables.runs.push({
    id: "run1",
    org_id: "org1",
    team_id: null,
    goal: "test",
    status: "acting",
    kind: "work",
    kill_flag: 0,
    lineup: "[]",
    rounds_used: 0,
    tokens_used: tokensUsed,
  });
  return { env: { DB: new FakeDB(tables) } as unknown as Env, tables };
}

describe("run token accounting", () => {
  it("touchRun adds to the running total", async () => {
    const { env: e, tables } = env(100);
    await touchRun(e, "run1", { tokens_used: 50 });
    expect(tables.runs[0]?.tokens_used).toBe(150);
  });

  it("addRunTokens adds once, never doubling the total", async () => {
    const { env: e, tables } = env(100);
    await addRunTokens(e, "run1", 50);
    expect(tables.runs[0]?.tokens_used).toBe(150);
  });

  it("addRunTokens(0) writes nothing", async () => {
    const { env: e, tables } = env(100);
    await addRunTokens(e, "run1", 0);
    expect(tables.runs[0]?.tokens_used).toBe(100);
  });
});

describe("goalWithBrief", () => {
  it("appends a brief founder note", () => {
    expect(goalWithBrief("Ship gift boxes", "Push the attach rate.")).toBe(
      "Ship gift boxes\n\nFounder brief: Push the attach rate.",
    );
  });

  it("leaves unbriefed goals alone", () => {
    expect(goalWithBrief("Ship gift boxes", "")).toBe("Ship gift boxes");
  });
});
