import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/bindings.js";
import { runBaseline } from "../src/baseline.js";
import { FakeDB, blankTables } from "./fake-db.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runBaseline", () => {
  it("gives the baseline the same founder brief the squad gets", async () => {
    const tables = blankTables();
    tables.runs.push({
      id: "r1",
      goal: "Ship gift boxes",
      metric_name: null,
      metric_baseline: null,
      metric_target: null,
      timebox_days: null,
      brief_note: "Attach rate first, then volume.",
    });
    const e = {
      DB: new FakeDB(tables),
      META_MODEL_API_KEY: "k",
      SPARK_MODE: "live",
    } as unknown as Env;
    let user = "";
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      user = body.messages.find((m) => m.role === "user")?.content ?? "";
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                title: "Bundle gift boxes at checkout",
                body: "Add a one-click gift-box bundle to the cart page and measure attach rate weekly.",
              }),
            },
          },
        ],
        usage: { total_tokens: 42 },
      });
    });
    const out = await runBaseline(e, "r1");
    expect(out.fresh).toBe(true);
    expect(user).toContain("Attach rate first, then volume.");
  });
});

describe("runBaseline corrupt cache", () => {
  it("re-runs fresh instead of throwing forever", async () => {
    const tables = blankTables();
    tables.runs.push({
      id: "r1",
      goal: "Ship gift boxes",
      metric_name: null,
      metric_baseline: null,
      metric_target: null,
      timebox_days: null,
      brief_note: "",
    });
    tables.artifacts.push({ id: "a1", run_id: "r1", kind: "baseline", title: "Old", meta: "nope{" });
    const e = {
      DB: new FakeDB(tables),
      META_MODEL_API_KEY: "k",
      SPARK_MODE: "live",
    } as unknown as Env;
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                title: "Bundle gift boxes at checkout",
                body: "Add a one-click gift-box bundle to the cart page and measure attach rate weekly.",
              }),
            },
          },
        ],
        usage: { total_tokens: 42 },
      });
    });
    const out = await runBaseline(e, "r1");
    expect(out.fresh).toBe(true);
    expect(calls).toBe(1);
    expect(tables.artifacts.filter((a) => a.meta === "nope{")).toHaveLength(0);
  });
});
