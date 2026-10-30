import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { BoxOffline, BoxQuota, boxSpend, cfBox, reconcileBoxes } from "../src/box.js";
import { FakeDB, blankTables, type Tables } from "./fake-db.js";

const KEY = "ab".repeat(32);

function stubNs(handler: (req: Request) => Response | Promise<Response>) {
  return { getByName: (_name: string) => ({ fetch: handler }) };
}

function env(ns?: unknown, tables?: Tables) {
  const t = tables ?? blankTables();
  if (!tables) {
    t.orgs.push({ id: "org1", box_max_concurrent: 3 });
    t.teams.push({ id: "t1", org_id: "org1" });
    t.seats.push({ id: "s1", team_id: "t1", role: "engineer", email: "e@hires" });
    t.seats.push({ id: "s2", team_id: "t1", role: "pm", email: "p@hires" });
  }
  const e = { DB: new FakeDB(t), TOKEN_ENC_KEY: KEY } as unknown as Env & { HIRE_BOX?: unknown };
  if (ns) e.HIRE_BOX = ns;
  return { env: e as Env, tables: t };
}

describe("box provider", () => {
  it("reports none/offline without a binding", async () => {
    const { env: e } = env();
    expect(await cfBox.state(e, "s1")).toBe("none");
    await expect(cfBox.wake(e, "org1", "s1", "test")).rejects.toBeInstanceOf(BoxOffline);
    await expect(cfBox.call(e, "s1", "/ping", {})).rejects.toBeInstanceOf(BoxOffline);
  });

  it("wakes once, re-wake only touches the meter", async () => {
    const seen: string[] = [];
    const { env: e, tables } = env(stubNs((req) => {
      seen.push(new URL(req.url).pathname);
      return Response.json({ ok: true });
    }));
    expect(await cfBox.state(e, "s1")).toBe("none");
    await cfBox.wake(e, "org1", "s1", "test");
    expect(await cfBox.state(e, "s1")).toBe("running");
    expect(tables.box_runs).toHaveLength(1);
    await cfBox.wake(e, "org1", "s1", "test");
    expect(tables.box_runs).toHaveLength(1);
    expect(seen).toEqual(["/ping"]);
  });

  it("enforces the per-org wake quota", async () => {
    const { env: e, tables } = env(stubNs(() => Response.json({ ok: true })));
    tables.orgs[0].box_max_concurrent = 1;
    await cfBox.wake(e, "org1", "s1", "test");
    await expect(cfBox.wake(e, "org1", "s2", "test")).rejects.toBeInstanceOf(BoxQuota);
  });

  it("refuses to mark a box awake that would not ping", async () => {
    const { env: e, tables } = env(stubNs(() => new Response("nope", { status: 500 })));
    await expect(cfBox.wake(e, "org1", "s1", "test")).rejects.toThrow("would not wake");
    expect(tables.box_state).toHaveLength(0);
  });

  it("calls through and surfaces driver errors", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const { env: e, tables } = env(
      stubNs(async (req) => {
        const path = new URL(req.url).pathname;
        calls.push({ path, body: req.method === "POST" ? await req.json() : null });
        if (path === "/ping") return Response.json({ ok: true });
        if (path === "/run") return Response.json({ ok: true, code: 0, stdout: "hi" });
        return Response.json({ ok: false, error: "bad op" });
      }),
    );
    await cfBox.wake(e, "org1", "s1", "test");
    const before = tables.box_state[0].last_tick as number;
    const res = (await cfBox.call(e, "s1", "/run", { bin: "node", args: [] })) as { stdout: string };
    expect(res.stdout).toBe("hi");
    expect((tables.box_state[0].last_tick as number) >= before).toBe(true);
    await expect(cfBox.call(e, "s1", "/browse", {})).rejects.toThrow("bad op");
    expect(calls.map((c) => c.path)).toEqual(["/ping", "/run", "/browse"]);
  });

  it("destroys state even as the box goes away", async () => {
    const { env: e, tables } = env(stubNs(() => Response.json({ ok: true })));
    await cfBox.wake(e, "org1", "s1", "test");
    await cfBox.destroy(e, "org1", "s1");
    expect(tables.box_state).toHaveLength(0);
    expect(await cfBox.state(e, "s1")).toBe("none");
  });

  it("meters spend per seat and reconciles stale runs", async () => {
    const { env: e, tables } = env();
    const now = Date.now();
    tables.box_runs.push(
      { id: "r1", seat_id: "s1", org_id: "org1", started_at: now - 1000, stopped_at: now, seconds: 60, instance_type: "basic", woken_by: "t" },
      { id: "r2", seat_id: "s1", org_id: "org1", started_at: now - 4 * 3600_000, stopped_at: 0, seconds: 0, instance_type: "basic", woken_by: "t" },
    );
    tables.box_state.push({ seat_id: "s1", org_id: "org1", status: "running", woken_at: now - 4 * 3600_000, last_tick: 0, wake_count: 2 });
    const spend = await boxSpend(e, "org1", 0);
    expect(spend[0].seatId).toBe("s1");
    expect(spend[0].seconds).toBe(60);
    expect(spend[0].cents).toBeGreaterThan(0);
    expect(await reconcileBoxes(e)).toBe(1);
    const stale = tables.box_runs.find((r) => r.id === "r2");
    expect(stale?.stopped_at).toBeGreaterThan(0);
    expect(stale?.seconds).toBeLessThanOrEqual(3 * 3600);
    expect(tables.box_state[0].status).toBe("sleeping");
    expect(await reconcileBoxes(e)).toBe(0);
  });
});
