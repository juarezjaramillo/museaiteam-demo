import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptToB64, keyFromHex } from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import { requireSession } from "../src/auth.js";
import {
  _resetVoiceCaches,
  isWav,
  serveVoiceAudio,
  shapeVoiceNote,
  transcribeUpload,
  voiceKeywords,
  wavSeconds,
} from "../src/voice.js";
import type { SparkClient } from "../src/spark.js";
import { createGoal, getGoal } from "../src/goals.js";
import { getBrief, putBrief } from "../src/teams.js";
import { FakeDB, blankTables, type FakeTables } from "./fake-db.js";

const TEST_KEY = "0".repeat(64);
const ORG = "org1";

function makeWav(dataLen = 480000): Uint8Array {
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true);
  v.setUint32(28, 48000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, dataLen, true);
  return new Uint8Array(buf);
}

async function seedToken(tables: FakeTables, provider: string) {
  const enc = await encryptToB64(keyFromHex(TEST_KEY), "fake-token");
  tables.oauth_tokens.push({
    org_id: ORG,
    provider,
    access_token_enc: enc,
    refresh_token_enc: null,
    expires_at: null,
  });
}

function fakeR2() {
  const store = new Map<string, unknown>();
  return {
    store,
    bucket: {
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      get: async (key: string) => (store.has(key) ? { body: store.get(key) } : null),
      delete: async (key: string) => {
        store.delete(key);
      },
    },
  };
}

interface World {
  env: Env;
  tables: FakeTables;
  r2: ReturnType<typeof fakeR2>;
  metaCalls: Array<{ url: string; init: { body: unknown; headers: Record<string, string> } }>;
}

async function seedWorld(opts: {
  goals?: Array<{ title: string; status: string }>;
  shopifyOk?: boolean;
}): Promise<World> {
  const tables = blankTables();
  tables.orgs.push({ id: ORG, name: "Tres Cumbres" });
  tables.teams.push({ id: "t1", org_id: ORG, name: "Store Crew" });
  tables.seats.push(
    { id: "s1", team_id: "t1", role: "marketer", approved: 1 },
    { id: "s2", team_id: "t1", role: "manager", approved: 1 },
    { id: "s3", team_id: "t1", role: "qa", approved: 0 },
  );
  await seedToken(tables, "shopify");
  await seedToken(tables, "slack");
  tables.provider_config.push({
    org_id: ORG,
    provider: "shopify",
    config: JSON.stringify({ shop: "tres-cumbres.myshopify.com" }),
  });
  for (const [i, g] of (opts.goals ?? [
    { title: "Get the store ready for Black Friday", status: "active" },
    { title: "Old archived goal", status: "archived" },
  ]).entries()) {
    tables.goals.push({ id: `g${i}`, org_id: ORG, title: g.title, status: g.status });
  }
  const r2 = fakeR2();
  const env = {
    DB: new FakeDB(tables),
    ARTIFACTS: r2.bucket,
    META_MODEL_API_KEY: "k",
    TOKEN_ENC_KEY: TEST_KEY,
  } as unknown as Env;
  const w: World = { env, tables, r2, metaCalls: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: unknown; headers?: Record<string, string> }) => {
      const u = String(url);
      if (u.includes("myshopify.com")) {
        if (opts.shopifyOk === false) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              products: {
                nodes: [
                  {
                    id: "gid://shopify/Product/1",
                    title: "Chiapas Altura",
                    featuredImage: { url: "https://cdn.shopify.com/1.png" },
                    variants: { nodes: [{ id: "gid://shopify/ProductVariant/9", price: "19.00" }] },
                  },
                ],
              },
            },
          }),
        };
      }
      if (u.includes("api.meta.ai/v1/asr/transcribe")) {
        w.metaCalls.push({ url: u, init: init as World["metaCalls"][number]["init"] });
        const handler = (w as unknown as { metaImpl?: () => Response }).metaImpl;
        if (handler) return handler();
        throw new Error("no meta impl set");
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  return w;
}

function setMeta(w: World, impl: () => Response) {
  (w as unknown as { metaImpl?: () => Response }).metaImpl = impl;
}

function sseResponse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

async function metaRequest(w: World, i = 0) {
  const form = w.metaCalls[i].init.body as FormData;
  const req = JSON.parse(String(await (form.get("request") as Blob).text())) as Record<string, unknown>;
  return { req, audio: form.get("audio") as Blob };
}

function eventsOf(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  _resetVoiceCaches();
});

describe("wav sniffing", () => {
  it("checks the RIFF header and reads seconds", () => {
    expect(isWav(makeWav())).toBe(true);
    expect(isWav(new Uint8Array(20))).toBe(false);
    expect(wavSeconds(makeWav(480000))).toBe(10);
    expect(wavSeconds(new Uint8Array(20))).toBeNull();
  });
});

describe("voiceKeywords", () => {
  it("collects org words and product titles", async () => {
    const w = await seedWorld({});
    const kw = await voiceKeywords(w.env, ORG);
    for (const word of [
      "Tres Cumbres",
      "Store Crew",
      "Maya",
      "Morgan",
      "Shopify",
      "Slack",
      "Get the store ready for Black Friday",
      "Chiapas Altura",
    ]) {
      expect(kw).toContain(word);
    }
    expect(kw).not.toContain("Old archived goal");
    expect(kw).not.toContain("Kim");
    expect(kw.length).toBeLessThanOrEqual(50);
  });

  it("dedupes, trims, caps, and survives Shopify failure", async () => {
    const goals = Array.from({ length: 60 }, (_, i) => ({
      title: `Goal number ${i} with a very long trailing description padding it out`,
      status: "active",
    }));
    goals[0] = { title: "tres cumbres", status: "active" };
    const w = await seedWorld({ goals, shopifyOk: false });
    const kw = await voiceKeywords(w.env, ORG);
    expect(kw).toHaveLength(50);
    expect(kw.every((k) => k.length <= 40)).toBe(true);
    expect(kw.filter((k) => k.toLowerCase() === "tres cumbres")).toHaveLength(1);
  });
});

describe("transcribeUpload", () => {
  const FLOW = [
    { type: "speechStart", turnId: "t1" },
    { type: "someFutureType", x: 1 },
    { type: "transcript", transcript: "Black Friday", final: false },
    { type: "transcript", transcript: "Black Friday is soon", final: false },
    { type: "speechComplete", turnId: "t1", transcript: "Black Friday is soon." },
  ];

  it("forwards events in order, ends with done, stores and meters", async () => {
    const w = await seedWorld({});
    setMeta(w, () => sseResponse(FLOW));
    const wav = makeWav();
    const res = await transcribeUpload(w.env, ORG, new Blob([wav as BlobPart]), "goal");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events = eventsOf(await res.text());
    expect(events.map((e) => e.type)).toEqual([
      "speechStart",
      "transcript",
      "transcript",
      "speechComplete",
      "done",
    ]);
    const done = events[events.length - 1] as { audioKey: string; seconds: number };
    expect(done.audioKey).toMatch(/^voice\/org1\/.+\.wav$/);
    expect(done.seconds).toBe(10);
    expect(w.r2.store.get(done.audioKey)).toBeDefined();
    const metered = w.tables.audit_log.find((r) => r.event === "voice.metered") as
      | { detail: string }
      | undefined;
    expect(metered).toBeDefined();
    expect(JSON.parse(String(metered?.detail))).toMatchObject({ seconds: 10, cents: 0.05 });
    expect(w.tables.voice_spend).toHaveLength(1);
    expect(w.tables.voice_spend[0]).toMatchObject({ org_id: ORG, tokens: 25 });

    expect(w.metaCalls).toHaveLength(1);
    expect(w.metaCalls[0].url).toContain("sessionId=");
    expect(w.metaCalls[0].init.headers.authorization).toBe("Bearer k");
    expect(w.metaCalls[0].init.headers.accept).toBe("text/event-stream");
    const { req, audio } = await metaRequest(w);
    expect(req).toMatchObject({
      mode: "ENDPOINTING",
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      partialMode: "CUMULATIVE",
      languageBias: ["English", "Spanish"],
    });
    expect(req.keywords).toContain("Chiapas Altura");
    expect(audio.size).toBe(wav.length);
  });

  it("maps 413, 400, 429 to plain error events", async () => {
    for (const [status, message] of [
      [413, "That recording is too big."],
      [400, "That doesn't look like audio we can read. Try again."],
      [429, "Busy right now, try again in a minute."],
    ] as Array<[number, string]>) {
      const w = await seedWorld({});
      setMeta(w, () => new Response("{}", { status }));
      const res = await transcribeUpload(w.env, ORG, new Blob([makeWav() as BlobPart]), "brief");
      const events = eventsOf(await res.text());
      expect(events).toEqual([{ type: "error", message }]);
      expect(w.r2.store.size).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("retries a 500, then fails plain", async () => {
    const w = await seedWorld({});
    let calls = 0;
    setMeta(w, () => {
      calls += 1;
      return calls === 1 ? new Response("{}", { status: 500 }) : sseResponse(FLOW);
    });
    const res = await transcribeUpload(w.env, ORG, new Blob([makeWav() as BlobPart]), "goal");
    expect(eventsOf(await res.text()).map((e) => e.type)).toContain("done");
    expect(w.metaCalls).toHaveLength(2);

    const w2 = await seedWorld({});
    setMeta(w2, () => new Response("{}", { status: 500 }));
    const res2 = await transcribeUpload(w2.env, ORG, new Blob([makeWav() as BlobPart]), "goal");
    expect(eventsOf(await res2.text())).toEqual([
      { type: "error", message: "Couldn't hear that one. Try again." },
    ]);
    expect(w2.metaCalls).toHaveLength(3);
    expect(w2.tables.voice_spend).toHaveLength(0);
  });

  it("a 429 then a 200 transcribes without failing", async () => {
    const w = await seedWorld({});
    let calls = 0;
    setMeta(w, () => {
      calls += 1;
      return calls === 1 ? new Response("{}", { status: 429 }) : sseResponse(FLOW);
    });
    const res = await transcribeUpload(w.env, ORG, new Blob([makeWav() as BlobPart]), "goal");
    expect(eventsOf(await res.text()).map((e) => e.type)).toContain("done");
    expect(w.metaCalls).toHaveLength(2);
  });

  it("rejects bad uploads with plain 400s", async () => {
    const w = await seedWorld({});
    const big = await transcribeUpload(w.env, ORG, new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]), "goal");
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: string }).error).toBe("That recording is too big.");
    const notWav = await transcribeUpload(w.env, ORG, new Blob([new Uint8Array(100)]), "goal");
    expect(notWav.status).toBe(400);
    const badCtx = await transcribeUpload(w.env, ORG, new Blob([makeWav() as BlobPart]), "nope");
    expect(badCtx.status).toBe(400);
    const noAudio = await transcribeUpload(w.env, ORG, null, "goal");
    expect(noAudio.status).toBe(400);
    expect(w.metaCalls).toHaveLength(0);
  });
});

describe("shapeVoiceNote", () => {
  function fakeClient(data: unknown, seen: Array<Record<string, unknown>> = []) {
    return {
      async chat(_schema: unknown, opts: Record<string, unknown>) {
        seen.push(opts);
        return { data, tokensUsed: 3 };
      },
    } as unknown as SparkClient;
  }
  const ENV = {} as Env;

  it("shapes an English goal note", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const out = await shapeVoiceNote(
      ENV,
      "Black Friday is in three weeks. Get the store ready with a discount for returning customers.",
      "goal",
      fakeClient(
        {
          language: "English",
          title: "Get the store ready for Black Friday",
          metric: "returning-customer orders",
          briefNote: "Black Friday is in three weeks; ready the store with a returning-customer discount.",
          english: "Black Friday is in three weeks. Get the store ready with a discount for returning customers.",
        },
        seen,
      ),
    );
    expect(out).toMatchObject({
      language: "English",
      title: "Get the store ready for Black Friday",
      metric: "returning-customer orders",
    });
    expect(String(seen[0].user)).toContain("do not add facts");
  });

  it("shapes a Spanish goal note with an English version", async () => {
    const out = await shapeVoiceNote(
      ENV,
      "El Buen Fin ya viene. Prepara la tienda con un descuento para clientes frecuentes.",
      "goal",
      fakeClient({
        language: "Spanish",
        title: "Prepara la tienda para El Buen Fin",
        metric: "pedidos de clientes frecuentes",
        briefNote: "El Buen Fin ya viene; prepara la tienda con un descuento para clientes frecuentes.",
        english: "El Buen Fin is coming. Get the store ready with a discount for returning customers.",
      }),
    );
    expect(out).toMatchObject({ language: "Spanish" });
    expect((out as { english: string }).english).toContain("returning customers");
  });

  it("shapes a brief and clamps wild replies", async () => {
    const out = await shapeVoiceNote(
      ENV,
      "Oigan, también contesten los tickets en español.",
      "brief",
      fakeClient({
        language: "Spanish",
        original: "Oigan, también contesten los tickets en español.",
        english: "Also answer the tickets in Spanish.",
      }),
    );
    expect(out).toEqual({
      language: "Spanish",
      original: "Oigan, también contesten los tickets en español.",
      english: "Also answer the tickets in Spanish.",
    });
    const long = await shapeVoiceNote(
      ENV,
      "Get the store ready for Black Friday with a discount and fresh images",
      "goal",
      fakeClient({
        language: "English",
        title: "x".repeat(200),
        metric: "y".repeat(500),
        briefNote: "ok",
        english: "",
      }),
    );
    expect((long as { title: string }).title).toHaveLength(80);
    expect((long as { metric: string }).metric).toHaveLength(120);
    expect((long as { english: string }).english).toContain("Black Friday");
  });
});

describe("voice fields on goals and briefs", () => {
  it("createGoal stores and returns voice fields", async () => {
    const tables = blankTables();
    const env = { DB: new FakeDB(tables) } as unknown as Env;
    const id = await createGoal(env, ORG, {
      title: "Get the store ready for Black Friday",
      voiceKey: "voice/org1/a.wav",
      originalText: "spoken words here",
      originalLanguage: "Spanish",
      briefNote: "Ready the store with a returning-customer discount.",
    });
    expect(await getGoal(env, ORG, id)).toMatchObject({
      voice_key: "voice/org1/a.wav",
      original_text: "spoken words here",
      original_language: "Spanish",
      brief_note: "Ready the store with a returning-customer discount.",
    });
  });

  it("putBrief stores and returns voice fields", async () => {
    const tables = blankTables();
    tables.teams.push({ id: "t1", org_id: ORG, name: "Store Crew" });
    const env = { DB: new FakeDB(tables) } as unknown as Env;
    await putBrief(env, ORG, "t1", "Also answer the tickets in Spanish.", "2026-11-02", undefined, {
      key: "voice/org1/b.wav",
      text: "Oigan, también contesten los tickets en español.",
      language: "Spanish",
    });
    expect(await getBrief(env, ORG, "t1", "2026-11-02")).toEqual({
      text: "Also answer the tickets in Spanish.",
      reviewedAt: null,
      voiceKey: "voice/org1/b.wav",
      originalText: "Oigan, también contesten los tickets en español.",
      originalLanguage: "Spanish",
    });
  });

  it("re-recording a brief deletes the old audio", async () => {
    const tables = blankTables();
    tables.teams.push({ id: "t1", org_id: ORG, name: "Store Crew" });
    const r2 = fakeR2();
    r2.store.set("voice/org1/old.wav", new Uint8Array([1]));
    const env = { DB: new FakeDB(tables), ARTIFACTS: r2.bucket } as unknown as Env;
    await putBrief(env, ORG, "t1", "First.", "2026-11-02", undefined, { key: "voice/org1/old.wav" });
    await putBrief(env, ORG, "t1", "Second.", "2026-11-02", undefined, { key: "voice/org1/new.wav" });
    expect(r2.store.has("voice/org1/old.wav")).toBe(false);
    expect(await getBrief(env, ORG, "t1", "2026-11-02")).toMatchObject({
      voiceKey: "voice/org1/new.wav",
    });
  });

  it("goals and briefs reject another org's voice key", async () => {
    const tables = blankTables();
    tables.teams.push({ id: "t1", org_id: ORG, name: "Store Crew" });
    const env = { DB: new FakeDB(tables) } as unknown as Env;
    await expect(
      createGoal(env, ORG, { title: "Get the store ready for Black Friday", voiceKey: "voice/org2/x.wav" }),
    ).rejects.toThrow("foreign voice key");
    await expect(
      putBrief(env, ORG, "t1", "Today matters.", "2026-11-02", undefined, { key: "voice/org2/x.wav" }),
    ).rejects.toThrow("foreign voice key");
  });
});

describe("serveVoiceAudio", () => {
  it("serves org keys, 404s anything else", async () => {
    const tables = blankTables();
    const r2 = fakeR2();
    const key = "voice/org1/note.wav";
    const bytes = new Uint8Array([1, 2, 3, 4]);
    r2.store.set(key, bytes);
    const env = { DB: new FakeDB(tables), ARTIFACTS: r2.bucket } as unknown as Env;
    const ok = await serveVoiceAudio(env, ORG, key);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/wav");
    expect((await ok.arrayBuffer()).byteLength).toBe(4);
    expect((await serveVoiceAudio(env, ORG, "voice/org1/missing.wav")).status).toBe(404);
    expect((await serveVoiceAudio(env, ORG, "voice/other/note.wav")).status).toBe(404);
    expect((await serveVoiceAudio(env, ORG, "creative/org1/1.png")).status).toBe(404);
  });
});

describe("voice route auth", () => {
  it("401s without a session", async () => {
    const env = { DB: new FakeDB(blankTables()) } as unknown as Env;
    const c = {
      env,
      req: { raw: new Request("https://api.test/api/orgs/o/voice/transcribe") },
      json: (o: unknown, s: number) => new Response(JSON.stringify(o), { status: s }),
      set: () => {},
    };
    const res = (await (requireSession as unknown as (c: unknown, n: () => Promise<void>) => Promise<Response>)(
      c,
      async () => {},
    )) as Response;
    expect(res.status).toBe(401);
  });
});
