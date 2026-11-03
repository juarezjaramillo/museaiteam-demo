import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/bindings.js";
import { fireSeat } from "../src/offboard.js";
import { saveAdminGrant } from "../src/provision.js";
import { FakeDB, blankTables } from "./fake-db.js";

const KEY = "ab".repeat(32);

afterEach(() => {
  vi.unstubAllGlobals();
});

function env() {
  const tables = blankTables();
  tables.orgs.push({ id: "org1", subscribed: 1 });
  tables.teams.push({ id: "t1", org_id: "org1" });
  tables.seats.push({
    id: "s1", team_id: "t1", role: "engineer",
    email: "e@hires", hired: 1, approved: 1,
  });
  return { env: { DB: new FakeDB(tables), TOKEN_ENC_KEY: KEY } as unknown as Env, tables };
}

describe("fireSeat", () => {
  it("audits and tasks the founder when the box destroy fails", async () => {
    const { env: e, tables } = env();
    (e as unknown as Record<string, unknown>).HIRE_BOX = {
      getByName: () => ({
        fetch: async () => {
          throw new Error("box melted");
        },
      }),
    };
    expect(await fireSeat(e, "org1", "s1")).toBe("fired");
    expect(tables.audit_log.some((r) => r.event === "box.destroy_failed")).toBe(true);
    const note = tables.notifications.find((n) => n.kind === "seat.fired");
    expect(note?.body).toMatch(/by hand/);
  });
});

describe("revokeCred", () => {
  it("times out the GitHub revoke instead of hanging the offboard", async () => {
    const { env: e } = env();
    const { tables } = { tables: (e.DB as unknown as FakeDB).tables };
    tables.seat_credentials.push({
      seat_id: "s1", tool: "github", kind: "token", login_user: "hire-oct",
      status: "ok", updated_at: "", expires_at: null,
    });
    tables.provider_config.push({
      org_id: "org1", provider: "github", config: JSON.stringify({ org: "acme" }),
    });
    await saveAdminGrant(e, "org1", "github", ["admin:org"], "grant-secret");
    let sawSignal = false;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response("{}", { status: 204 });
    });
    expect(await fireSeat(e, "org1", "s1")).toBe("fired");
    expect(sawSignal).toBe(true);
  });
});
