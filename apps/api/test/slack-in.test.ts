import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptToB64, keyFromHex } from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import { handleSlackEvent, verifySlack } from "../src/slack-in.js";
import { FakeDB, blankTables, type FakeTables } from "./fake-db.js";

const KEY = "ab".repeat(32);

interface SlackWorld {
  env: Env;
  tables: FakeTables;
  posted: Array<Record<string, unknown>>;
  metaCalls: number;
}

async function seedWorld(allowed: boolean): Promise<SlackWorld> {
  const tables = blankTables();
  tables.provider_config.push({
    org_id: "org1",
    provider: "slack",
    config: JSON.stringify({ teamId: "T1" }),
  });
  const w: SlackWorld = {
    env: {} as Env,
    tables,
    posted: [],
    metaCalls: 0,
  };
  w.env = {
    DB: new FakeDB(tables),
    TOKEN_ENC_KEY: KEY,
    META_MODEL_API_KEY: "k",
    SLACK_SIGNING_SECRET: "secret",
    RATE_LIMIT: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async () => Response.json({ allowed }),
      }),
    },
  } as unknown as Env;
  tables.oauth_tokens.push({
    org_id: "org1",
    provider: "slack",
    access_token_enc: await encryptToB64(keyFromHex(KEY), "xoxb-test"),
    refresh_token_enc: null,
    expires_at: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes("slack.com/api/conversations.replies")) {
        return { ok: true, json: async () => ({ ok: true, messages: [] }) };
      }
      if (u.includes("slack.com/api/chat.postMessage")) {
        w.posted.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return { ok: true, json: async () => ({ ok: true, ts: "T-posted" }) };
      }
      if (u.includes("/chat/completions")) {
        w.metaCalls += 1;
        return {
          ok: true,
          json: async () => ({
            choices: [{ finish_reason: "stop", message: { content: '{"text":"hi"}' } }],
            usage: { total_tokens: 5 },
          }),
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  return w;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slack answer throttle", () => {
  const mention = {
    type: "app_mention",
    channel: "C1",
    ts: "T1",
    text: "<@Ubot> what shipped today?",
    user: "U9",
  };

  it("a throttled mention replies without spending a model call", async () => {
    const w = await seedWorld(false);
    await handleSlackEvent(w.env, "T1", "evt1", mention as never);
    expect(w.metaCalls).toBe(0);
    expect(w.posted).toHaveLength(1);
    expect(String(w.posted[0].text)).toContain("answering a lot");
    expect(w.posted[0].thread_ts).toBe("T1");
  });

  it("an allowed mention answers through the model", async () => {
    const w = await seedWorld(true);
    await handleSlackEvent(w.env, "T1", "evt1", mention as never);
    expect(w.metaCalls).toBe(1);
    expect(w.posted).toHaveLength(1);
    expect(String(w.posted[0].text)).toContain("hi");
  });

  it("retried events never double-answer", async () => {
    const w = await seedWorld(true);
    await handleSlackEvent(w.env, "T1", "evt1", mention as never);
    await handleSlackEvent(w.env, "T1", "evt1", mention as never);
    expect(w.metaCalls).toBe(1);
    expect(w.posted).toHaveLength(1);
  });
});

describe("verifySlack", () => {
  async function sign(secret: string, ts: string, raw: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${ts}:${raw}`),
    );
    return (
      "v0=" +
      [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")
    );
  }

  const env = { SLACK_SIGNING_SECRET: "secret" } as unknown as Env;

  it("accepts a fresh valid signature", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const raw = '{"type":"x"}';
    expect(await verifySlack(env, raw, ts, await sign("secret", ts, raw))).toBe(true);
  });

  it("rejects forgeries and stale replays", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const raw = '{"type":"x"}';
    expect(await verifySlack(env, raw, ts, await sign("wrong", ts, raw))).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(await verifySlack(env, raw, old, await sign("secret", old, raw))).toBe(false);
  });
});
