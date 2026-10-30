import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import {
  bindSeatTool,
  deleteSeatCredential,
  hireToken,
  listSeatCredentials,
  seatForRole,
  seatReadyForServer,
  seatSession,
  setSeatCredential,
  unbindSeatTool,
  wipeSeatCredentials,
} from "../src/seat-creds.js";
import { listServersForSeat, serverSecretForSeat } from "../src/mcp.js";
import { FakeDB, blankTables } from "./fake-db.js";

const KEY = "ab".repeat(32);

function env() {
  const tables = blankTables();
  tables.teams.push({ id: "t1", org_id: "org1" });
  tables.seats.push({ id: "s-eng", team_id: "t1", role: "engineer", approved: 1 });
  tables.seats.push({ id: "s-pm", team_id: "t1", role: "pm", approved: 0 });
  return { env: { DB: new FakeDB(tables), TOKEN_ENC_KEY: KEY } as unknown as Env, tables };
}

describe("seat credentials", () => {
  it("saves, lists without secrets, and deletes", async () => {
    const { env: e, tables } = env();
    await setSeatCredential(e, "org1", "s-eng", {
      tool: "github",
      kind: "token",
      secret: "ghp-seat",
      loginUser: "raj@x.com",
    });
    const listed = await listSeatCredentials(e, "org1", "s-eng");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tool: "github", kind: "token", login_user: "raj@x.com" });
    expect(JSON.stringify(listed)).not.toContain("ghp-seat");
    expect(tables.seat_credentials[0].secret_enc).not.toBe("ghp-seat");
    expect(await deleteSeatCredential(e, "org1", "s-eng", "github")).toBe(true);
    expect(await deleteSeatCredential(e, "org1", "s-eng", "github")).toBe(false);
  });

  it("hireToken prefers the seat login, falls back to the org link", async () => {
    const { env: e } = env();
    expect(await seatForRole(e, "t1", "engineer")).toBe("s-eng");
    expect(await seatForRole(e, "t1", "pm")).toBeNull();
    // No seat cred, no org token: null (honest, not throw).
    expect(await hireToken(e, "org1", "t1", "github")).toBeNull();
    await setSeatCredential(e, "org1", "s-eng", {
      tool: "github",
      kind: "token",
      secret: "ghp-seat",
    });
    expect(await hireToken(e, "org1", "t1", "github")).toBe("ghp-seat");
    // Password kinds are not API-usable: reads as absent.
    await setSeatCredential(e, "org1", "s-eng", {
      tool: "github",
      kind: "password",
      secret: "hunter2",
    });
    expect(await hireToken(e, "org1", "t1", "github")).toBeNull();
  });

  it("wipes all seat logins and tool bindings", async () => {
    const { env: e, tables } = env();
    tables.mcp_servers.push({
      id: "srv", org_id: "org1", name: "S", url: "https://x/mcp",
      auth: "none", auth_name: "", source: "catalog", status: "trusted", spend_cap_cents: 0,
    });
    await setSeatCredential(e, "org1", "s-eng", { tool: "github", kind: "token", secret: "x" });
    await bindSeatTool(e, "org1", "s-eng", "srv");
    expect(await wipeSeatCredentials(e, "org1", "s-eng")).toBe(1);
    expect(tables.seat_credentials).toHaveLength(0);
    expect(tables.seat_tools).toHaveLength(0);
    expect(await unbindSeatTool(e, "org1", "s-eng", "srv")).toBe(false);
  });

  it("scopes MCP servers and secrets to the seat", async () => {
    const { env: e, tables } = env();
    tables.mcp_servers.push(
      { id: "a", org_id: "org1", name: "A", url: "https://a/mcp", auth: "header", auth_name: "", source: "catalog", status: "trusted", spend_cap_cents: 0 },
      { id: "b", org_id: "org1", name: "B", url: "https://b/mcp", auth: "none", auth_name: "", source: "catalog", status: "trusted", spend_cap_cents: 0 },
    );
    // No bindings: legacy org shelf.
    expect((await listServersForSeat(e, "org1", "s-eng")).map((s) => s.id)).toEqual(["a", "b"]);
    await bindSeatTool(e, "org1", "s-eng", "a");
    expect((await listServersForSeat(e, "org1", "s-eng")).map((s) => s.id)).toEqual(["a"]);
    const server = tables.mcp_servers[0] as unknown as Parameters<typeof serverSecretForSeat>[1];
    // No seat secret and no org secret: null.
    expect(await serverSecretForSeat(e, server, "s-eng")).toBeNull();
    await setSeatCredential(e, "org1", "s-eng", { tool: "mcp:a", kind: "token", secret: "seat-key" });
    expect(await serverSecretForSeat(e, server, "s-eng")).toBe("seat-key");
  });

  it("vaults expiring sessions and rejects past expiry", async () => {
    const { env: e } = env();
    await expect(
      setSeatCredential(e, "org1", "s-eng", { tool: "figma", kind: "session", secret: "s", expiresAtMs: Date.now() - 1000 }),
    ).rejects.toThrow(/future/);
    await setSeatCredential(e, "org1", "s-eng", { tool: "figma", kind: "session", secret: "s", expiresAtMs: Date.now() + 3600_000 });
    expect(await seatSession(e, "org1", "s-eng", "figma")).toBe("s");
    expect(await seatSession(e, "org1", "s-eng", "missing")).toBeNull();
    const listed = await listSeatCredentials(e, "org1", "s-eng");
    expect(listed.find((c) => c.tool === "figma")?.expires_at).toBeTruthy();
  });

  it("reroutes bound-but-seatless servers, leaves org path alone", async () => {
    const { env: e, tables } = env();
    tables.mcp_servers.push({ id: "a", org_id: "org1", name: "A", url: "https://a/mcp", auth: "header", auth_name: "", source: "catalog", status: "trusted", spend_cap_cents: 0 });
    expect(await seatReadyForServer(e, "org1", "s-eng", "a")).toBe(true);
    await bindSeatTool(e, "org1", "s-eng", "a");
    expect(await seatReadyForServer(e, "org1", "s-eng", "a")).toBe(false);
    await setSeatCredential(e, "org1", "s-eng", { tool: "mcp:a", kind: "token", secret: "k" });
    expect(await seatReadyForServer(e, "org1", "s-eng", "a")).toBe(true);
  });
});
