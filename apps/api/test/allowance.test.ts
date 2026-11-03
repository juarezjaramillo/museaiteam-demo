import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { chargeIdea, ideaBudget, tonight } from "../src/allowance.js";
import { FakeDB, blankTables, type FakeTables } from "./fake-db.js";

function envWith(cap = 1000): { env: Env; tables: FakeTables } {
  const tables = blankTables();
  tables.orgs.push({ id: "org1", idea_allowance_words: cap });
  return { env: { DB: new FakeDB(tables) } as unknown as Env, tables };
}

async function spent(tables: FakeTables): Promise<number> {
  return tables.idea_spend.find((r) => r.org_id === "org1" && r.night === tonight())?.words ?? 0;
}

describe("chargeIdea", () => {
  it("settles once per charge id across retries", async () => {
    const { env, tables } = envWith();
    expect(await chargeIdea(env, "org1", 100, "run", "idea-charge:run1")).toBe(true);
    expect(await chargeIdea(env, "org1", 100, "run", "idea-charge:run1")).toBe(true);
    expect(await spent(tables)).toBe(100);
  });

  it("distinct charges accumulate", async () => {
    const { env, tables } = envWith();
    await chargeIdea(env, "org1", 100, "a", "idea-charge:a");
    await chargeIdea(env, "org1", 50, "b", "idea-charge:b");
    expect(await spent(tables)).toBe(150);
  });

  it("a spent night refuses and notifies once on the crossing", async () => {
    const { env, tables } = envWith(100);
    expect(await chargeIdea(env, "org1", 100, "run")).toBe(true);
    expect(await chargeIdea(env, "org1", 10, "run")).toBe(false);
    expect(await spent(tables)).toBe(100);
    const notes = tables.notifications.filter((n) => n.kind === "allowance.exhausted");
    expect(notes).toHaveLength(1);
    expect(String(notes[0].body)).toContain("tokens spent");
  });

  it("ideaBudget reports cap, spent, and left", async () => {
    const { env } = envWith(100);
    await chargeIdea(env, "org1", 30, "run");
    expect(await ideaBudget(env, "org1")).toEqual({ cap: 100, spent: 30, left: 70 });
  });
});
