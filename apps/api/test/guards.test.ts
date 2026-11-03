import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { checkGuard } from "../src/guards.js";
import { FakeDB, blankTables } from "./fake-db.js";

function envWith(row?: { systems: string[]; write_scope: string[] }) {
  const tables = blankTables();
  if (row) {
    tables.guardrails.push({
      org_id: "org1",
      worker_role: "marketer",
      systems: JSON.stringify(row.systems),
      write_scope: JSON.stringify(row.write_scope),
    });
  }
  return { DB: new FakeDB(tables) } as unknown as Env;
}

describe("checkGuard", () => {
  it("unconfigured workers stay wide open", async () => {
    const e = envWith();
    expect(await checkGuard(e, "org1", "marketer", "creative", "image")).toEqual({
      allowed: true,
      reason: "default-open",
    });
  });

  it("a saved row with the studio allows campaign images", async () => {
    const e = envWith({ systems: ["shopify", "creative"], write_scope: ["discount", "image"] });
    expect(await checkGuard(e, "org1", "marketer", "creative", "image")).toEqual({
      allowed: true,
      reason: "guardrail-allow",
    });
  });

  it("a saved row without the studio denies with a reason", async () => {
    const e = envWith({ systems: ["shopify"], write_scope: ["discount", "image"] });
    expect(await checkGuard(e, "org1", "marketer", "creative", "image")).toEqual({
      allowed: false,
      reason: "marketer may not touch creative",
    });
  });

  it("a saved row without the scope denies with a reason", async () => {
    const e = envWith({ systems: ["shopify", "creative"], write_scope: ["discount"] });
    expect(await checkGuard(e, "org1", "marketer", "creative", "image")).toEqual({
      allowed: false,
      reason: "marketer may not write image",
    });
  });
});

describe("checkGuard corrupt rows", () => {
  it("fails closed with a reason instead of throwing", async () => {
    const tables = blankTables();
    tables.guardrails.push({
      org_id: "org1",
      worker_role: "marketer",
      systems: "nope{",
      write_scope: "[\"image\"]",
    });
    const e = { DB: new FakeDB(tables) } as unknown as Env;
    expect(await checkGuard(e, "org1", "marketer", "creative", "image")).toEqual({
      allowed: false,
      reason: "guardrail misconfigured — fix it in Setup",
    });
  });
});

describe("parseStringList", () => {
  it("keeps string arrays and rejects anything else", async () => {
    const { parseStringList } = await import("../src/guards.js");
    expect(parseStringList('["a","b"]')).toEqual(["a", "b"]);
    expect(parseStringList("nope{")).toBe(null);
    expect(parseStringList('"str"')).toBe(null);
    expect(parseStringList('["a",7]')).toBe(null);
  });
});
