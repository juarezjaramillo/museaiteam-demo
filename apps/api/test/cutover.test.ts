import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/bindings.js";

vi.mock("../src/staffing.js", async (orig) => {
  const mod = await orig<typeof import("../src/staffing.js")>();
  return {
    ...mod,
    createWorkRun: async () => ({ runId: "run1", status: "open", squad: ["engineer"] }),
  };
});

import { cutoverStatus, flipCutover, retireOrgLinkIfDone, retireServerSecret } from "../src/cutover.js";
import { OrgRetired } from "../src/db.js";
import { setSecret, serverSecretForSeat, type McpServerRow } from "../src/mcp.js";
import { fireSeat, sweepFrozenSeats } from "../src/offboard.js";
import { storeToken } from "../src/oauth.js";
import { setSeatCredential } from "../src/seat-creds.js";
import { receiveSeatMail } from "../src/seat-mail.js";
import { FakeDB, blankTables } from "./fake-db.js";

const KEY = "ab".repeat(32);

function env() {
  const tables = blankTables();
  tables.orgs.push({ id: "org1", subscribed: 1, seat_cutover: 0 });
  tables.teams.push({ id: "t1", org_id: "org1" });
  tables.seats.push({ id: "s1", team_id: "t1", role: "engineer", email: "engineer-abc123@hires.museaiteam.com", hired: 1, approved: 1 });
  return { env: { DB: new FakeDB(tables), TOKEN_ENC_KEY: KEY } as unknown as Env, tables };
}

describe("cutover", () => {
  it("retires provider links when every wanter verifies, keeps slack", async () => {
    const { env: e, tables } = env();
    tables.oauth_tokens.push(
      { org_id: "org1", provider: "github", access_token_enc: "x" },
      { org_id: "org1", provider: "slack", access_token_enc: "x" },
    );
    tables.seat_provisions.push({ seat_id: "s1", tool: "github", step: "verify", status: "verified", detail: "", attempts: 0 });
    expect(await retireOrgLinkIfDone(e, "org1", "github")).toBe("retired");
    expect(tables.oauth_tokens.map((r) => r.provider)).toEqual(["slack"]);
    expect(await retireOrgLinkIfDone(e, "org1", "slack")).toBe("kept");
    const status = await cutoverStatus(e, "org1");
    expect(status.providers).toEqual([]);
    expect(status.kept).toEqual(["slack"]);
  });

  it("keeps links with unverified wanters, retires dead ones", async () => {
    const { env: e, tables } = env();
    tables.oauth_tokens.push({ org_id: "org1", provider: "linear", access_token_enc: "x" });
    tables.seat_provisions.push({ seat_id: "s1", tool: "linear", step: "invite", status: "pending", detail: "", attempts: 0 });
    expect(await retireOrgLinkIfDone(e, "org1", "linear")).toBe("kept");
    tables.seat_provisions.length = 0;
    expect(await retireOrgLinkIfDone(e, "org1", "linear")).toBe("retired");
  });

  it("retires server keys once bound seats hold their own", async () => {
    const { env: e, tables } = env();
    tables.mcp_servers.push({ id: "srv", org_id: "org1", name: "S", url: "https://s/mcp", auth: "header", auth_name: "", source: "founder", status: "trusted", spend_cap_cents: 0, box_argv: "" });
    tables.mcp_credentials.push({ org_id: "org1", server_id: "srv", secret_enc: "x" });
    tables.seat_tools.push({ seat_id: "s1", mcp_server_id: "srv" });
    expect(await retireOrgLinkIfDone(e, "org1", "mcp:srv")).toBe("kept");
    await setSeatCredential(e, "org1", "s1", { tool: "mcp:srv", kind: "token", secret: "k" });
    expect(await retireOrgLinkIfDone(e, "org1", "mcp:srv")).toBe("retired");
    expect(tables.mcp_credentials).toHaveLength(0);
  });

  it("flips only when nothing retirable remains, then blocks org writes and fallbacks", async () => {
    const { env: e, tables } = env();
    tables.oauth_tokens.push({ org_id: "org1", provider: "github", access_token_enc: "x" });
    const blocked = await flipCutover(e, "org1");
    expect(blocked.ok).toBe(false);
    tables.oauth_tokens.length = 0;
    expect(await flipCutover(e, "org1")).toEqual({ ok: true });
    await expect(storeToken(e, "org1", "github", { access: "a", refresh: null, expiresAt: null })).rejects.toBeInstanceOf(OrgRetired);
    await expect(setSecret(e, "org1", "srv", "s", "l")).rejects.toBeInstanceOf(OrgRetired);
    const server = { id: "srv", org_id: "org1", name: "S", url: "https://s/mcp", auth: "header", auth_name: "", source: "founder", status: "trusted", spend_cap_cents: 0, box_argv: "" } as McpServerRow;
    expect(await serverSecretForSeat(e, server, "s1")).toBeNull();
    tables.mcp_credentials.push({ org_id: "org1", server_id: "srv", secret_enc: "x" });
    expect(await retireServerSecret(e, "org1", "srv")).toBe(true);
    expect(tables.mcp_credentials).toHaveLength(0);
  });
});

describe("offboarding", () => {
  it("fires: tasks un-revoked, wipes, freezes, handoffs", async () => {
    const { env: e, tables } = env();
    await setSeatCredential(e, "org1", "s1", { tool: "linear", kind: "token", secret: "k" });
    await setSeatCredential(e, "org1", "s1", { tool: "github", kind: "token", secret: "g", loginUser: "hirebot" });
    tables.seat_tools.push({ seat_id: "s1", mcp_server_id: "srv" });
    expect(await fireSeat(e, "org1", "s1")).toBe("fired");
    expect(await fireSeat(e, "org1", "nope")).toBe("notfound");
    const seat = tables.seats.find((s) => s.id === "s1");
    expect(seat?.approved).toBe(0);
    expect(seat?.frozen_at).toBeTruthy();
    expect(tables.seat_credentials).toHaveLength(0);
    expect(tables.seat_tools).toHaveLength(0);
    expect(tables.goals.some((g) => String(g.title).includes("Hand off"))).toBe(true);
    const note = tables.notifications.find((n) => n.kind === "seat.fired");
    expect(note).toBeTruthy();
    expect(String(note?.body)).toMatch(/linear/);
    expect(String(note?.body)).toMatch(/hirebot/);
    // Frozen inbox drops mail.
    expect(
      await receiveSeatMail(e, {
        to: ["engineer-abc123@hires.museaiteam.com"],
        from: "x@y",
        subject: "hi",
        body: "b",
        messageId: "m1",
      }),
    ).toBe("dropped");
  });

  it("sweeps seats frozen past 90 days, keeps the fresh", async () => {
    const { env: e, tables } = env();
    tables.seats.push({ id: "s2", team_id: "t1", role: "pm", email: "pm@h", hired: 0, approved: 0, frozen_at: "2020-01-01 00:00:00" });
    tables.seat_mail.push({ id: "m1", seat_id: "s2", message_id: "x", body: "b" });
    tables.seat_provisions.push({ seat_id: "s2", tool: "linear", step: "invite", status: "pending", detail: "", attempts: 0 });
    expect(await sweepFrozenSeats(e)).toBe(1);
    expect(tables.seats.map((s) => s.id)).toEqual(["s1"]);
    expect(tables.seat_mail).toHaveLength(0);
    expect(tables.seat_provisions).toHaveLength(0);
    expect(await sweepFrozenSeats(e)).toBe(0);
  });
});
