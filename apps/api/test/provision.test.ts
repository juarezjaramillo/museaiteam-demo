import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import {
  askForSeats,
  decideSeatRequest,
  grantSeats,
  keystoneVerified,
  normalizeTools,
  requestSeats,
  seatAskLines,
  seatMapFor,
  setSeatMap,
  strategyFor,
  tickProvisions,
  verifySeatTool,
} from "../src/provision.js";
import { toolForServer } from "@museaiteam/shared";
import { setSeatCredential } from "../src/seat-creds.js";
import { FakeDB, blankTables } from "./fake-db.js";

const KEY = "ab".repeat(32);

function env(subscribed = 1) {
  const tables = blankTables();
  tables.orgs.push({ id: "org1", box_max_concurrent: 3, subscribed });
  tables.teams.push({ id: "t1", org_id: "org1" });
  tables.seats.push({ id: "s1", team_id: "t1", role: "engineer", email: "e@hires" });
  return { env: { DB: new FakeDB(tables), TOKEN_ENC_KEY: KEY } as unknown as Env, tables };
}

describe("provisioning", () => {
  it("maps roles, dedupes requests, approves into provisions", async () => {
    const { env: e, tables } = env();
    expect((await seatMapFor(e, "org1", "engineer")).tools).toContain("github");
    await setSeatMap(e, "org1", "engineer", ["github", "linear"]);
    const over = await seatMapFor(e, "org1", "engineer");
    expect(over).toEqual({ tools: ["github", "linear"], overridden: true });
    await expect(setSeatMap(e, "org1", "janitor", ["x"])).rejects.toThrow("unknown role");
    const r1 = await requestSeats(e, "org1", "s1");
    expect(r1.tools).toEqual(["github", "linear"]);
    expect((await requestSeats(e, "org1", "s1")).id).toBe(r1.id);
    expect(await decideSeatRequest(e, "org1", r1.id, "u1", true)).toBe("ok");
    expect(await decideSeatRequest(e, "org1", r1.id, "u1", true)).toBe("decided");
    expect(tables.seat_provisions.map((r) => r.tool).sort()).toEqual(["github", "linear"]);
  });

  it("strategies: github API waits honestly, others queue for the browser", async () => {
    const { env: e, tables } = env();
    expect(strategyFor("github")).toBe("api");
    expect(strategyFor("linear")).toBe("browser");
    tables.seat_provisions.push(
      { seat_id: "s1", tool: "github", step: "invite", status: "pending", detail: "" },
      { seat_id: "s1", tool: "linear", step: "invite", status: "pending", detail: "" },
    );
    expect(await tickProvisions(e)).toBe(2);
    const by = (t: string) => tables.seat_provisions.find((r) => r.tool === t);
    expect(by("github")?.status).toBe("waiting");
    expect(by("linear")?.status).toBe("waiting");
    expect(by("linear")?.detail).toMatch(/browser/);
    expect(await tickProvisions(e)).toBe(0);
  });

  it("browser provisions open the invite link, never waking without mail", async () => {
    const calls: string[] = [];
    const ns = {
      getByName: (_n: string) => ({
        fetch: async (req: Request) => {
          const path = new URL(req.url).pathname;
          calls.push(path);
          if (path === "/ping") return Response.json({ ok: true });
          return Response.json({ ok: true, snapshots: [{ title: "Accept invite" }] });
        },
      }),
    };
    const { env: e, tables } = env();
    (e as unknown as Record<string, unknown>).HIRE_BOX = ns;
    tables.orgs.push({ id: "org1", box_max_concurrent: 3 });
    tables.seat_provisions.push({ seat_id: "s1", tool: "linear", step: "invite", status: "pending", detail: "", attempts: 0 });
    expect(await tickProvisions(e)).toBe(1);
    // No mail: stays pending, box untouched.
    expect(tables.seat_provisions[0].status).toBe("pending");
    expect(tables.seat_provisions[0].detail).toMatch(/invite email/);
    expect(calls).toEqual([]);
    // Invite arrives: wake, browse, wait on the account.
    tables.seat_mail.push({
      id: "m1", seat_id: "s1", message_id: "mm1", from_addr: "n@linear",
      subject: "invited", body: "join https://linear.test/invite/abc ok",
      read_at: null, created_at: "",
    });
    expect(await tickProvisions(e)).toBe(1);
    expect(tables.seat_provisions[0].status).toBe("waiting");
    expect(tables.seat_provisions[0].detail).toMatch(/Accept invite/);
    expect(calls).toEqual(["/ping", "/browse"]);
  });

  it("browser failures retry twice, then task the founder", async () => {
    const ns = {
      getByName: (_n: string) => ({
        fetch: async (req: Request) => {
          if (new URL(req.url).pathname === "/ping") return Response.json({ ok: true });
          return Response.json({ ok: false, error: "chromium melted" });
        },
      }),
    };
    const { env: e, tables } = env();
    (e as unknown as Record<string, unknown>).HIRE_BOX = ns;
    tables.orgs.push({ id: "org1", box_max_concurrent: 3 });
    tables.seat_mail.push({
      id: "m1", seat_id: "s1", message_id: "mm1", from_addr: "n@x",
      subject: "invited", body: "join https://x.test/i ok",
      read_at: null, created_at: "",
    });
    tables.seat_provisions.push({ seat_id: "s1", tool: "linear", step: "invite", status: "pending", detail: "", attempts: 0 });
    // First wake leaves the box running; drop it so each tick re-wakes honestly.
    await tickProvisions(e);
    tables.box_state.length = 0;
    await tickProvisions(e);
    tables.box_state.length = 0;
    await tickProvisions(e);
    const row = tables.seat_provisions[0];
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(tables.notifications.some((n) => n.kind === "provision.failed")).toBe(true);
  });

  it("verifies token-backed tools and keystones", async () => {
    const { env: e } = env();
    await setSeatCredential(e, "org1", "s1", { tool: "github", kind: "token", secret: "x" });
    expect(await verifySeatTool(e, "org1", "s1", "github")).toBe(true);
    expect(await verifySeatTool(e, "org1", "s1", "linear")).toBe(false);
    expect(await keystoneVerified(e, "s1", "engineer")).toBe(true);
    expect(await keystoneVerified(e, "s1", "pm")).toBe(false);
  });

  it("maps servers to provisionable tools", () => {
    expect(toolForServer({ id: "x", name: "Linear", url: "https://mcp.linear.app" })).toBe("linear");
    expect(toolForServer({ id: "x", name: "GitHub MCP", url: "https://x/mcp" })).toBe("github");
    expect(toolForServer({ id: "abc", name: "Weird", url: "https://weird.example/mcp" })).toBe("mcp:abc");
    expect(normalizeTools([" Figma ", "FIGMA", 7, "", "x".repeat(200)] as unknown[])).toEqual(["figma", "x".repeat(120)]);
  });

  it("hire asks file once, merge, and never re-ask live tools", async () => {
    const { env: e, tables } = env();
    const first = await askForSeats(e, "org1", "s1", ["figma"], "need it");
    expect(first.filed).toEqual(["figma"]);
    expect(first.requestId).toBeTruthy();
    expect(tables.notifications.some((n) => String(n.title).includes("asked for Figma"))).toBe(true);
    // Repeat asks nothing; merge adds the new tool to the same card.
    const repeat = await askForSeats(e, "org1", "s1", ["figma"], "need it");
    expect(repeat).toEqual({ requestId: first.requestId, filed: [] });
    const merged = await askForSeats(e, "org1", "s1", ["figma", "notion"], "more");
    expect(merged).toEqual({ requestId: first.requestId, filed: ["notion"] });
    expect(tables.seat_requests).toHaveLength(1);
    // Provisioning coverage also dedupes.
    tables.seat_provisions.push({ seat_id: "s1", tool: "slack", step: "invite", status: "pending", detail: "", attempts: 0 });
    expect((await askForSeats(e, "org1", "s1", ["slack"], "x")).filed).toEqual([]);
    // Brief lines show the open ask and the provisioning seat.
    const lines = await seatAskLines(e, "s1");
    expect(lines.some((l) => l.includes("Figma") && l.includes("Notion"))).toBe(true);
    expect(lines.some((l) => l.startsWith("slack:"))).toBe(true);
  });

  it("approvals exclude per tool; excluding all denies", async () => {
    const { env: e, tables } = env();
    await setSeatMap(e, "org1", "engineer", ["github", "linear"]);
    const req = await requestSeats(e, "org1", "s1");
    expect(await decideSeatRequest(e, "org1", req.id, "u1", true, ["linear"])).toBe("ok");
    expect(tables.seat_provisions.map((r) => r.tool)).toEqual(["github"]);
    expect(tables.seat_requests[0].tools_json).toBe(JSON.stringify(["github"]));
    const req2 = await askForSeats(e, "org1", "s1", ["figma"], "x");
    expect(await decideSeatRequest(e, "org1", req2.requestId as string, "u1", true, ["figma"])).toBe("ok");
    expect(tables.seat_requests.find((r) => r.id === req2.requestId)?.status).toBe("denied");
    expect(tables.seat_provisions.some((r) => r.tool === "figma")).toBe(false);
  });

  it("founder grants go straight to provisions, trial still blocks paid", async () => {
    const { env: e, tables } = env();
    expect(await grantSeats(e, "org1", "s1", "u1", ["figma"])).toEqual({ granted: ["figma"] });
    expect(tables.seat_provisions.some((r) => r.tool === "figma")).toBe(true);
    expect(tables.seat_requests[0].status).toBe("approved");
    expect(await grantSeats(e, "org1", "s1", "u1", ["figma"])).toEqual({ granted: [] });
    const trial = env(0);
    expect(await grantSeats(trial.env, "org1", "s1", "u1", ["github"])).toEqual({ trial: ["github"] });
  });

  it("blocks paid asks on trial, and denied asks close with a note", async () => {
    const { env: e, tables } = env(0);
    const req = await requestSeats(e, "org1", "s1");
    expect(req.tools).toContain("github");
    expect(await decideSeatRequest(e, "org1", req.id, "u1", true)).toBe("trial");
    expect(tables.seat_provisions).toHaveLength(0);
    expect(await decideSeatRequest(e, "org1", req.id, "u1", false)).toBe("ok");
    const note = tables.notifications.find((n) => n.kind === "seat.requested" && String(n.title).includes("denied"));
    expect(note).toBeTruthy();
    expect(String(note?.body)).toMatch(/GitHub/);
  });
});
