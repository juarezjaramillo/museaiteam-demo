import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptToB64, keyFromHex } from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import { digestChannelName, maybePostWeeklyDigest } from "../src/weekly.js";
import { FakeDB, blankTables } from "./fake-db.js";

const KEY = "ab".repeat(32);

afterEach(() => {
  vi.unstubAllGlobals();
});

async function digestEnv(cfg: Record<string, unknown>) {
  const tables = blankTables();
  tables.orgs.push({ id: "org1", subscribed: 1 });
  tables.oauth_tokens.push({
    org_id: "org1",
    provider: "slack",
    access_token_enc: await encryptToB64(keyFromHex(KEY), "xoxb-test"),
    refresh_token_enc: null,
    expires_at: null,
  });
  tables.provider_config.push({
    org_id: "org1",
    provider: "slack",
    config: JSON.stringify(cfg),
  });
  const e = {
    DB: new FakeDB(tables),
    TOKEN_ENC_KEY: KEY,
    DEMO_SLACK_CHANNEL: "demo-digest",
  } as unknown as Env;
  return { env: e, tables };
}

function stubSlack(posted: { channel: string }) {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (String(url).endsWith("/conversations.list")) {
      return Response.json({
        ok: true,
        channels: [
          { id: "C1", name: "acme-weekly" },
          { id: "C2", name: "demo-digest" },
        ],
      });
    }
    if (String(url).endsWith("/chat.postMessage")) {
      posted.channel = String(body.channel ?? "");
      return Response.json({ ok: true, ts: "1" });
    }
    return Response.json({ ok: true });
  });
}

describe("digestChannelName", () => {
  it("prefers the org's configured channel", () => {
    expect(digestChannelName({ digest_channel: "#acme-weekly" }, "demo-digest")).toBe(
      "#acme-weekly",
    );
  });
  it("falls back to the demo channel when unconfigured", () => {
    expect(digestChannelName({}, "demo-digest")).toBe("demo-digest");
    expect(digestChannelName({ digest_channel: "  " }, "demo-digest")).toBe("demo-digest");
  });
});

describe("maybePostWeeklyDigest", () => {
  it("posts to the org's configured channel", async () => {
    const { env: e, tables } = await digestEnv({ digest_channel: "#acme-weekly" });
    const posted = { channel: "" };
    stubSlack(posted);
    await maybePostWeeklyDigest(e);
    expect(posted.channel).toBe("C1");
    expect(tables.notifications.some((n) => n.kind === "digest.weekly")).toBe(true);
  });
  it("falls back to the demo channel when unconfigured", async () => {
    const { env: e } = await digestEnv({});
    const posted = { channel: "" };
    stubSlack(posted);
    await maybePostWeeklyDigest(e);
    expect(posted.channel).toBe("C2");
  });
});
