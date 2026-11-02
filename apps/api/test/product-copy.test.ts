import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionLabel,
  buildProof,
  encryptToB64,
  keyFromHex,
} from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import { executeProductCopyAct } from "../src/product-copy.js";
import { FakeDB, blankTables, type FakeTables } from "./fake-db.js";

const TEST_KEY = "0".repeat(64);
const RUN = "run1";
const ORG = "org1";
const PHOTO = "https://cdn.shopify.com/oaxaca.png";

function chatReply(content: unknown, tokens = 5) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { total_tokens: tokens },
    }),
  };
}

interface World {
  env: Env;
  tables: FakeTables;
  copyPrompts: string[];
  writes: string[];
  visionCalls: number;
}

async function seedWorld(opts: {
  photo?: boolean;
  copies?: string[];
  visions?: unknown[];
}): Promise<World> {
  const tables = blankTables();
  tables.runs.push({ id: RUN, org_id: ORG, team_id: null, goal: "Get the store ready for Black Friday" });
  const enc = await encryptToB64(keyFromHex(TEST_KEY), "fake-token");
  tables.oauth_tokens.push({
    org_id: ORG,
    provider: "shopify",
    access_token_enc: enc,
    refresh_token_enc: null,
    expires_at: null,
  });
  tables.provider_config.push({
    org_id: ORG,
    provider: "shopify",
    config: JSON.stringify({ shop: "tres-cumbres.myshopify.com", product_id: "gid://shopify/Product/3" }),
  });
  const env = {
    DB: new FakeDB(tables),
    META_MODEL_API_KEY: "k",
    TOKEN_ENC_KEY: TEST_KEY,
  } as unknown as Env;
  const w: World = { env, tables, copyPrompts: [], writes: [], visionCalls: 0 };
  const copies = [...(opts.copies ?? ["A light roast with floral notes, fresh for Black Friday."])];
  const visions = [...(opts.visions ?? [])];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u === PHOTO) {
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (u.includes("myshopify.com")) {
        const query = String(body.query ?? "");
        if (query.includes("productUpdate")) {
          w.writes.push(String((body.variables as { desc?: string }).desc ?? ""));
          return {
            ok: true,
            json: async () => ({
              data: { productUpdate: { product: { description: "ok" }, userErrors: [] } },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              product: {
                id: "gid://shopify/Product/3",
                title: "Oaxaca Pluma",
                description: "An old description.",
                featuredImage: opts.photo === false ? null : { url: PHOTO },
                variants: { nodes: [{ id: "gid://shopify/ProductVariant/3", price: "23.00" }] },
              },
            },
          }),
        };
      }
      if (u.includes("api.meta.ai/v1/chat/completions")) {
        const content = (body.messages as Array<{ content: unknown }>)[1].content;
        if (typeof content === "string") {
          w.copyPrompts.push(content);
          return chatReply({ description: copies.shift() ?? copies[copies.length - 1] });
        }
        w.visionCalls += 1;
        return chatReply(visions.shift() ?? visions[visions.length - 1]);
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  return w;
}

async function runAct(w: World) {
  await executeProductCopyAct(w.env, {
    orgId: ORG,
    runId: RUN,
    decision: "Run a Black Friday promotion",
    shop: "tres-cumbres.myshopify.com",
    token: "fake-token",
    hooks: {
      recordAction: async (kind, target, status, revertPayload, payload = {}) => {
        const id = crypto.randomUUID();
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
      addTokens: async () => {},
    },
  });
}

function copyRow(w: World) {
  return w.tables.actions.find((a) => a.kind === "shopify.product_copy");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("product copy photo check", () => {
  it("consistent copy writes to Shopify with vision proof", async () => {
    const w = await seedWorld({
      visions: [
        { consistent: true, photoFacts: ["bag says LIGHT"], conflicts: [], box: [1, 2, 3, 4] },
      ],
    });
    await runAct(w);
    const row = copyRow(w);
    expect(row?.status).toBe("done");
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]).toContain("light roast");
    const proof = JSON.parse(String(row?.proof)) as {
      summary: string;
      after: string;
      image: { url: string; boxes: Array<{ label: string; ok: boolean }> };
      visionSummary: string;
    };
    expect(proof.summary).toBe("Rewrote the product description");
    expect(proof.after).toContain("light roast");
    expect(proof.image.url).toBe(PHOTO);
    expect(proof.image.boxes).toEqual([{ label: "label", box: [1, 2, 3, 4], ok: true }]);
    expect(proof.visionSummary).toBe("Checked against the product photo: bag says LIGHT ✓");
  });

  it("inconsistent copy is rewritten once from the photo facts", async () => {
    const w = await seedWorld({
      copies: [
        "A dark roast for strong Black Friday mornings.",
        "A light roast with floral notes, fresh for Black Friday.",
      ],
      visions: [
        {
          consistent: false,
          photoFacts: ["bag says LIGHT"],
          conflicts: ["copy says dark roast but the bag says LIGHT"],
        },
        { consistent: true, photoFacts: ["bag says LIGHT"], conflicts: [] },
      ],
    });
    await runAct(w);
    const row = copyRow(w);
    expect(row?.status).toBe("done");
    expect(w.copyPrompts).toHaveLength(2);
    expect(w.copyPrompts[1]).toContain(
      "the photo shows: bag says LIGHT; fix these conflicts: copy says dark roast but the bag says LIGHT",
    );
    expect(w.writes).toEqual(["A light roast with floral notes, fresh for Black Friday."]);
  });

  it("still inconsistent: failed with honest proof, no Shopify write", async () => {
    const w = await seedWorld({
      copies: [
        "A dark roast for strong Black Friday mornings.",
        "A dark roast for strong Black Friday mornings, still.",
      ],
      visions: [
        {
          consistent: false,
          photoFacts: ["bag says LIGHT"],
          conflicts: ["copy says dark roast but the bag says LIGHT"],
        },
        {
          consistent: false,
          photoFacts: ["bag says LIGHT"],
          conflicts: ["copy still says dark roast but the bag says LIGHT"],
        },
      ],
    });
    await runAct(w);
    const row = copyRow(w);
    expect(row?.status).toBe("failed");
    expect(w.writes).toHaveLength(0);
    const proof = JSON.parse(String(row?.proof)) as { summary: string };
    expect(proof.summary).toBe(
      "copy still says dark roast but the bag says LIGHT; not published.",
    );
  });

  it("no product photo: writes without a vision check", async () => {
    const w = await seedWorld({ photo: false });
    await runAct(w);
    expect(copyRow(w)?.status).toBe("done");
    expect(w.visionCalls).toBe(0);
    expect(w.writes).toHaveLength(1);
  });
});
