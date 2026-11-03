import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionLabel,
  buildProof,
  encryptToB64,
  keyFromHex,
} from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import { executeCreativeAct, servePublicImage } from "../src/creative.js";
import { executeRevert } from "../src/revert.js";
import { FakeDB, blankTables, type FakeTables } from "./fake-db.js";

const TEST_KEY = "0".repeat(64);
const RUN = "run1";
const ORG = "org1";
const IMG_B64 = "iVBORw0KGgo=";

const PASS_CHECK = {
  checks: [
    { fact: "brand", found: true, read: "Tres Cumbres Coffee Co.", box: [1, 2, 3, 4] },
    { fact: "code", found: true, read: "BREW20", box: [5, 6, 7, 8] },
    { fact: "percent", found: true, read: "20% OFF", box: [9, 10, 11, 12] },
  ],
  brandVisible: true,
  textErrors: [],
  pass: true,
};

const WRONG_CODE_CHECK = {
  ...PASS_CHECK,
  checks: [
    PASS_CHECK.checks[0],
    { fact: "code", found: true, read: "BREW2O", box: [5, 6, 7, 8] },
    PASS_CHECK.checks[2],
  ],
};

function chatReply(content: unknown, tokens = 5) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { total_tokens: tokens },
    }),
  };
}

function imageReply() {
  return {
    ok: true,
    json: async () => ({ data: [{ b64_json: IMG_B64 }], output_format: "png" }),
  };
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
    },
  };
}

interface World {
  env: Env;
  tables: FakeTables;
  r2: ReturnType<typeof fakeR2>;
  tokens: { n: number };
  imageCalls: Array<{ url: string; body: Record<string, unknown> }>;
  sparkTexts: string[];
  slackPosts: Array<Record<string, unknown>>;
  slackDeletes: number;
  notionAppends: Array<Record<string, unknown>>;
}

async function seedWorld(opts: {
  discount?: boolean;
  notionPage?: boolean;
  plan?: unknown;
  vision?: unknown[];
  visionTokens?: number;
  images?: Array<{ status: number; body: unknown }>;
}): Promise<World> {
  const tables = blankTables();
  tables.runs.push({ id: RUN, org_id: ORG, team_id: null, goal: "Get the store ready for Black Friday" });
  await seedToken(tables, "shopify");
  await seedToken(tables, "slack");
  await seedToken(tables, "notion");
  tables.provider_config.push({
    org_id: ORG,
    provider: "shopify",
    config: JSON.stringify({ shop: "tres-cumbres.myshopify.com" }),
  });
  if (opts.discount !== false) {
    tables.actions.push({
      id: "d1",
      run_id: RUN,
      kind: "shopify.targeted_discount",
      target: "BREW20",
      status: "done",
      payload: JSON.stringify({ code: "BREW20", percent: 20 }),
      revert_payload: JSON.stringify({ shop: "tres-cumbres.myshopify.com", id: "gid://1" }),
    });
  }
  if (opts.notionPage) {
    tables.actions.push({
      id: "n1",
      run_id: RUN,
      kind: "notion.run_page",
      target: "https://notion.so/run",
      status: "done",
      payload: "{}",
      revert_payload: JSON.stringify({ pageId: "P1", followupId: "P2", dbId: "D" }),
    });
  }
  const r2 = fakeR2();
  const env = {
    DB: new FakeDB(tables),
    ARTIFACTS: r2.bucket,
    APP_URL: "https://api.test",
    DEMO_SLACK_CHANNEL: "general",
    META_MODEL_API_KEY: "k",
    TOKEN_ENC_KEY: TEST_KEY,
  } as unknown as Env;
  const w: World = {
    env,
    tables,
    r2,
    tokens: { n: 0 },
    imageCalls: [],
    sparkTexts: [],
    slackPosts: [],
    slackDeletes: 0,
    notionAppends: [],
  };
  const visionQueue = [...(opts.vision ?? [PASS_CHECK])];
  const imageQueue = opts.images ? [...opts.images] : null;
  const plan = opts.plan ?? { formats: ["feed"], headline: "Black Friday Blowout", visual: "Hero bag on red silk" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string; method?: string }) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (u.includes("myshopify.com")) {
        const query = String(body.query ?? "");
        if (query.includes("products(")) {
          return {
            ok: true,
            json: async () => ({
              data: {
                products: {
                  nodes: [
                    {
                      id: "gid://shopify/Product/1",
                      title: "Chiapas Altura",
                      featuredImage: { url: "https://cdn.shopify.com/chiapas.png" },
                      variants: { nodes: [{ id: "gid://shopify/ProductVariant/9", price: "19.00" }] },
                    },
                  ],
                },
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ data: { shop: { name: "Tres Cumbres Coffee Co." } } }) };
      }
      if (u.includes("api.meta.ai/v1/chat/completions")) {
        const content = (body.messages as Array<{ content: unknown }>)[1].content;
        if (typeof content === "string") {
          w.sparkTexts.push(content);
          return chatReply(plan, 10);
        }
        const user = (content as Array<{ text?: string }>)[0].text ?? "";
        w.sparkTexts.push(user);
        return chatReply(visionQueue.shift() ?? PASS_CHECK, opts.visionTokens ?? 5);
      }
      if (u.includes("api.meta.ai/v1/images/")) {
        w.imageCalls.push({ url: u, body });
        if (imageQueue) {
          const next = imageQueue.length > 1 ? (imageQueue.shift() as { status: number; body: unknown }) : imageQueue[0];
          return {
            ok: next.status >= 200 && next.status < 300,
            status: next.status,
            json: async () => next.body,
            text: async () => JSON.stringify(next.body),
          };
        }
        return imageReply();
      }
      if (u.includes("slack.com/api/conversations.list")) {
        return { ok: true, json: async () => ({ ok: true, channels: [{ id: "C1", name: "general" }] }) };
      }
      if (u.includes("slack.com/api/conversations.join")) {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (u.includes("slack.com/api/chat.postMessage")) {
        w.slackPosts.push(body);
        return { ok: true, json: async () => ({ ok: true, ts: "T1" }) };
      }
      if (u.includes("slack.com/api/chat.delete")) {
        w.slackDeletes += 1;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (u.includes("api.notion.com")) {
        w.notionAppends.push(body);
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  return w;
}

function hooksFor(w: World) {
  return {
    recordAction: async (
      kind: string,
      target: string,
      status: string,
      revertPayload?: Record<string, unknown>,
      payload: Record<string, unknown> = {},
      actionId?: string,
    ): Promise<string> => {
      const id = actionId ?? crypto.randomUUID();
      const proof = buildProof(kind, target, status, actionLabel(kind), revertPayload, payload);
      await w.env.DB.prepare(
        "INSERT INTO actions (id, run_id, kind, target, payload, status, revert_payload, proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          id,
          RUN,
          kind,
          target,
          JSON.stringify(payload),
          status,
          revertPayload ? JSON.stringify(revertPayload) : null,
          proof ? JSON.stringify(proof) : null,
        )
        .run();
      return id;
    },
    updateAction: async (
      actionId: string,
      target: string,
      status: string,
      payload: Record<string, unknown> = {},
      revertPayload?: Record<string, unknown>,
    ): Promise<void> => {
      const row = w.tables.actions.find((a) => a.id === actionId);
      if (!row) return;
      const proof = buildProof(row.kind, target, status, actionLabel(row.kind), revertPayload, payload);
      await w.env.DB.prepare(
        "UPDATE actions SET target = ?, status = ?, payload = ?, revert_payload = ?, proof = ? WHERE id = ?",
      )
        .bind(
          target,
          status,
          JSON.stringify(payload),
          revertPayload ? JSON.stringify(revertPayload) : null,
          proof ? JSON.stringify(proof) : null,
          actionId,
        )
        .run();
    },
    addTokens: async (n: number) => {
      w.tokens.n += n;
    },
  };
}

async function runAct(w: World) {
  await executeCreativeAct(w.env, {
    orgId: ORG,
    runId: RUN,
    goal: "Get the store ready for Black Friday",
    decision: "Run a Black Friday promotion",
    hooks: hooksFor(w) as never,
  });
}

function creativeRow(w: World) {
  return w.tables.actions.find((a) => a.kind === "creative.campaign_image");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("campaign image act", () => {
  it("(a) passes first try with two formats", async () => {
    const w = await seedWorld({
      notionPage: true,
      plan: { formats: ["feed", "story"], headline: "Black Friday Blowout", visual: "Hero bag on red silk" },
      vision: [PASS_CHECK, PASS_CHECK],
    });
    await runAct(w);
    const row = creativeRow(w);
    expect(row?.status).toBe("done");
    expect(row?.target).toBe("Black Friday Blowout");
    const proof = JSON.parse(String(row?.proof)) as {
      summary: string;
      image: { url: string; boxes: Array<{ label: string; ok: boolean }> };
      visionSummary: string;
      beforeImage?: string;
    };
    expect(proof.summary).toBe("Made 2 campaign images");
    expect(proof.image.url).toMatch(/^https:\/\/api\.test\/a\/[A-Za-z0-9_-]{32}$/);
    expect(proof.image.boxes.map((b) => b.label)).toEqual(["brand", "CODE BREW20", "20% OFF"]);
    expect(proof.image.boxes.every((b) => b.ok)).toBe(true);
    expect(proof.visionSummary).toBe("Checked by Muse Spark: CODE BREW20 ✓ · 20% OFF ✓ · brand ✓");
    expect(proof.beforeImage).toBeUndefined();

    expect(w.tables.public_images).toHaveLength(2);
    const keys = [...w.r2.store.keys()].sort();
    expect(keys.filter((k) => k.endsWith(".png"))).toHaveLength(2);
    expect(keys.filter((k) => k.endsWith(".json"))).toHaveLength(2);
    expect(keys[0]).toMatch(/^creative\/org1\/run1\/.+\/1\.json$/);

    expect(w.imageCalls).toHaveLength(2);
    expect(w.imageCalls[0].url).toContain("/images/edits");
    expect(w.imageCalls[0].body.images).toEqual([{ image_url: "https://cdn.shopify.com/chiapas.png" }]);
    expect(w.imageCalls[0].body.size).toBe("1080x1350");
    expect(w.imageCalls[1].body.size).toBe("1080x1920");
    const prompt = String(w.imageCalls[0].body.prompt);
    expect(prompt).toContain('"Tres Cumbres Coffee Co."');
    expect(prompt).toContain('"Black Friday Blowout"');
    expect(prompt).toContain('"20% OFF"');
    expect(prompt).toContain('"CODE BREW20"');

    expect(w.slackPosts).toHaveLength(1);
    const blocks = w.slackPosts[0].blocks as Array<{ type: string; image_url?: string }>;
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
    expect(String(w.slackPosts[0].text)).toContain("CODE BREW20");
    expect(w.notionAppends).toHaveLength(1);

    const payload = JSON.parse(String(row?.payload)) as { imageCount: number; imageCostCents: number };
    expect(payload.imageCount).toBe(2);
    expect(payload.imageCostCents).toBe(2);
    expect(w.tokens.n).toBe(20);
  });

  it("(b) fails once, fixes, then passes", async () => {
    const w = await seedWorld({ vision: [WRONG_CODE_CHECK, PASS_CHECK] });
    await runAct(w);
    const row = creativeRow(w);
    expect(row?.status).toBe("done");
    const proof = JSON.parse(String(row?.proof)) as { visionSummary: string; beforeImage?: string };
    expect(proof.visionSummary).toContain("(fixed 1 typo)");
    expect(proof.beforeImage).toMatch(/^https:\/\/api\.test\/a\//);
    expect(w.imageCalls).toHaveLength(2);
    const fixPrompt = String(w.imageCalls[1].body.prompt);
    expect(fixPrompt).toContain('The code reads "BREW2O". Change it to exactly "BREW20".');
    expect(fixPrompt).toContain("Keep everything else exactly the same.");
    expect(w.imageCalls[1].body.images).toEqual([
      { image_url: expect.stringMatching(/^data:image\/png;base64,/) },
    ]);
    expect(w.tables.public_images).toHaveLength(2);
    expect([...w.r2.store.keys()].filter((k) => k.endsWith(".png"))).toHaveLength(2);
  });

  it("(c) fails 3 times: act failed, run continues, nothing public", async () => {
    const w = await seedWorld({ vision: [WRONG_CODE_CHECK, WRONG_CODE_CHECK, WRONG_CODE_CHECK] });
    await runAct(w);
    const row = creativeRow(w);
    expect(row?.status).toBe("failed");
    const proof = JSON.parse(String(row?.proof)) as { summary: string };
    expect(proof.summary).toBe("Could not print the code correctly in 3 tries; draft kept for you.");
    expect(w.tables.public_images).toHaveLength(0);
    expect([...w.r2.store.keys()].filter((k) => k.endsWith(".png"))).toHaveLength(3);
    expect(w.slackPosts).toHaveLength(0);
  });

  it("(d) content-policy 400: act failed without retry, run continues", async () => {
    const w = await seedWorld({
      images: [{ status: 400, body: { code: "content_policy_violation", message: "no" } }],
    });
    await runAct(w);
    const row = creativeRow(w);
    expect(row?.status).toBe("failed");
    expect(w.imageCalls).toHaveLength(1);
    const proof = JSON.parse(String(row?.proof)) as { summary: string };
    expect(proof.summary).toContain("content policy");
  });

  it("(e) no discount in run: brand-only facts", async () => {
    const w = await seedWorld({
      discount: false,
      vision: [
        {
          checks: [{ fact: "brand", found: true, read: "Tres Cumbres Coffee Co.", box: [1, 2, 3, 4] }],
          brandVisible: true,
          textErrors: [],
          pass: true,
        },
      ],
    });
    await runAct(w);
    const row = creativeRow(w);
    expect(row?.status).toBe("done");
    const prompt = String(w.imageCalls[0].body.prompt);
    expect(prompt).toContain('"Tres Cumbres Coffee Co."');
    expect(prompt).not.toContain("CODE");
    expect(prompt).not.toContain("% OFF");
    const visionPrompt = w.sparkTexts.find((t) => t.includes("proofreader")) ?? "";
    expect(visionPrompt).toContain("Tres Cumbres Coffee Co.");
    expect(visionPrompt).not.toContain("BREW20");
    const proof = JSON.parse(String(row?.proof)) as { visionSummary: string };
    expect(proof.visionSummary).toBe("Checked by Muse Spark: brand ✓");
  });

  it("unconnected shopify: would_do with no API calls", async () => {
    const w = await seedWorld({});
    w.tables.oauth_tokens = w.tables.oauth_tokens.filter((t) => t.provider !== "shopify");
    await runAct(w);
    const row = creativeRow(w);
    expect(row?.status).toBe("would_do");
    expect(w.imageCalls).toHaveLength(0);
  });

  it("(f) resumes a pending row: no duplicate generation or posts", async () => {
    const w = await seedWorld({ notionPage: true });
    const URL = "https://api.test/a/abc123";
    w.tables.actions.push({
      id: "pending1",
      run_id: RUN,
      kind: "creative.campaign_image",
      target: "campaign images",
      status: "pending",
      payload: JSON.stringify({
        started: true,
        plan: { formats: ["feed"], headline: "Black Friday Blowout", visual: "Hero bag" },
        urls: [URL],
        heroIdx: 0,
        publishedTokens: ["tok1"],
        image: { url: URL, boxes: [{ label: "brand", box: [1, 2, 3, 4], ok: true }] },
        visionSummary: "Checked by Muse Spark: brand ✓",
        imageCount: 1,
        imageCostCents: 1,
        code: "BREW20",
        percent: 20,
        slack: { channel: "C1", ts: "T0" },
      }),
      revert_payload: null,
      proof: null,
    });
    await runAct(w);
    // Finished phases stay finished.
    expect(w.imageCalls).toHaveLength(0);
    expect(w.sparkTexts).toHaveLength(0);
    expect(w.slackPosts).toHaveLength(0);
    expect(w.r2.store.size).toBe(0);
    // The unfinished phase completes.
    expect(w.notionAppends).toHaveLength(1);
    // One row, finished in place with the saved urls.
    const rows = w.tables.actions.filter((a) => a.kind === "creative.campaign_image");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("pending1");
    expect(rows[0].status).toBe("done");
    expect(rows[0].target).toBe("Black Friday Blowout");
    const payload = JSON.parse(String(rows[0].payload)) as {
      images: string[];
      imageCount: number;
    };
    expect(payload.images).toEqual([URL]);
    expect(payload.imageCount).toBe(1);
    expect(JSON.parse(String(rows[0].revert_payload))).toEqual({
      tokens: ["tok1"],
      slackChannel: "C1",
      slackTs: "T0",
    });
  });
});

describe("public image route + undo", () => {
  it("serves the PNG, then 404s after undo", async () => {
    const w = await seedWorld({ discount: false });
    await runAct(w);
    const token = String(w.tables.public_images[0].token);
    const r2key = String(w.tables.public_images[0].r2_key);
    expect(r2key).toMatch(/^creative\/org1\/run1\/.+\/1\.png$/);

    const ok = await servePublicImage(w.env, token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await ok.arrayBuffer()).byteLength).toBe(8);
    expect((await servePublicImage(w.env, "bogus")).status).toBe(404);

    const row = creativeRow(w);
    const revert = await executeRevert(w.env, ORG, RUN);
    expect(revert.reverted).toContain(row?.id);
    expect(revert.failed).toEqual([]);
    expect(w.slackDeletes).toBe(1);
    expect(w.r2.store.has(r2key)).toBe(true);
    expect((await servePublicImage(w.env, token)).status).toBe(404);
  });

  it("undo still revokes when Slack disconnected afterwards", async () => {
    const w = await seedWorld({ discount: false });
    await runAct(w);
    const token = String(w.tables.public_images[0].token);
    w.tables.oauth_tokens = w.tables.oauth_tokens.filter((t) => t.provider !== "slack");
    const revert = await executeRevert(w.env, ORG, RUN);
    expect(revert.failed).toEqual([]);
    expect(w.slackDeletes).toBe(0);
    expect((await servePublicImage(w.env, token)).status).toBe(404);
    expect(w.tables.audit_log.some((r) => r.event === "revert.delivery_kept")).toBe(true);
  });
});
