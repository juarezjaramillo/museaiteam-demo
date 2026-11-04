import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionLabel,
  buildProof,
  encryptToB64,
  keyFromHex,
} from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import type { SparkClient } from "../src/spark.js";
import { executeStorefrontCheckAct } from "../src/storefront.js";
import type { StoreBrowser, StoreShot } from "../src/store-browser.js";
import { FakeDB, blankTables, type FakeTables } from "./fake-db.js";

const TEST_KEY = "0".repeat(64);
const RUN = "run1";
const ORG = "org1";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const NEW_COPY = "A light roast with floral notes. Fresh for Black Friday.";

const PRODUCT_PASS = {
  found: true,
  read: "A light roast with floral notes. Fresh for Black Friday.",
  box: [1, 2, 3, 4],
};

const CHECKOUT_PASS = {
  codeApplied: true,
  codeRead: "BREW20",
  discountAmountRead: "−$3.80",
  subtotalRead: "$19.00",
  totalRead: "$15.20",
  boxes: [
    { label: "Code applied", box: [1, 2, 3, 4] },
    { label: "−$3.80", box: [5, 6, 7, 8] },
    { label: "Total", box: [9, 10, 11, 12] },
  ],
  pass: true,
};

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
  browserCalls: { product: number; checkout: number };
}

async function seedWorld(opts: {
  discount?: boolean;
  copy?: boolean;
  password?: boolean;
}): Promise<World> {
  const tables = blankTables();
  tables.runs.push({ id: RUN, org_id: ORG, team_id: null, goal: "Get the store ready for Black Friday" });
  const config: Record<string, unknown> = {
    shop: "tres-cumbres.myshopify.com",
    product_id: "gid://shopify/Product/3",
  };
  if (opts.password !== false) {
    config.storePasswordEnc = await encryptToB64(keyFromHex(TEST_KEY), "dev-secret");
  }
  tables.provider_config.push({ org_id: ORG, provider: "shopify", config: JSON.stringify(config) });
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
  if (opts.copy !== false) {
    tables.actions.push({
      id: "c1",
      run_id: RUN,
      kind: "shopify.product_copy",
      target: "Oaxaca Pluma",
      status: "done",
      payload: JSON.stringify({ description: NEW_COPY }),
      revert_payload: JSON.stringify({
        shop: "tres-cumbres.myshopify.com",
        productId: "gid://shopify/Product/3",
        priorDescription: "An old description.",
      }),
    });
  }
  const r2 = fakeR2();
  const env = {
    DB: new FakeDB(tables),
    ARTIFACTS: r2.bucket,
    APP_URL: "https://api.test",
    API_URL: "https://api.test",
    META_MODEL_API_KEY: "k",
    TOKEN_ENC_KEY: TEST_KEY,
  } as unknown as Env;
  const w: World = { env, tables, r2, tokens: { n: 0 }, browserCalls: { product: 0, checkout: 0 } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("myshopify.com")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              product: {
                id: "gid://shopify/Product/3",
                title: "Oaxaca Pluma",
                description: NEW_COPY,
                handle: "oaxaca-pluma",
                featuredImage: { url: "https://cdn.shopify.com/oaxaca.png" },
                variants: { nodes: [{ id: "gid://shopify/ProductVariant/9", price: "19.00" }] },
              },
            },
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return w;
}

function fakeBrowser(
  w: World,
  impl: { product?: StoreShot[]; checkout?: StoreShot[] },
): StoreBrowser {
  const pq = [...(impl.product ?? [{ ok: true, png: PNG } as StoreShot])];
  const cq = [...(impl.checkout ?? [{ ok: true, png: PNG } as StoreShot])];
  return {
    productPage: async () => {
      w.browserCalls.product += 1;
      return pq.length > 1 ? (pq.shift() as StoreShot) : pq[0];
    },
    checkoutWithCode: async () => {
      w.browserCalls.checkout += 1;
      return cq.length > 1 ? (cq.shift() as StoreShot) : cq[0];
    },
  };
}

function fakeSpark(impl: { product?: unknown[]; checkout?: unknown[] }): SparkClient {
  const pq = [...(impl.product ?? [PRODUCT_PASS])];
  const cq = [...(impl.checkout ?? [CHECKOUT_PASS])];
  return {
    async chatWithImages(_schema: unknown, opts: { user: string }) {
      const q = opts.user.includes("Checkout screenshot") ? cq : pq;
      const data = q.length > 1 ? q.shift() : q[0];
      return { data, tokensUsed: 5 };
    },
  } as unknown as SparkClient;
}

async function runAct(w: World, browser: StoreBrowser, spark: SparkClient) {
  await executeStorefrontCheckAct(w.env, {
    orgId: ORG,
    runId: RUN,
    shop: "tres-cumbres.myshopify.com",
    token: "fake-token",
    hooks: {
      recordAction: async (kind, target, status, revertPayload, payload = {}, actionId) => {
        const id = actionId ?? crypto.randomUUID();
        const proof = buildProof(kind, target, status, actionLabel(kind), revertPayload, payload);
        await w.env.DB.prepare(
          "INSERT INTO actions (id, run_id, kind, target, payload, status, revert_payload, proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(
            id,
            RUN,
            kind as string,
            target,
            JSON.stringify(payload),
            status as string,
            revertPayload ? JSON.stringify(revertPayload) : null,
            proof ? JSON.stringify(proof) : null,
          )
          .run();
        return id;
      },
      addTokens: async (n) => {
        w.tokens.n += n;
      },
    },
    browser,
    spark,
  });
}

function checkRow(w: World) {
  return w.tables.actions.find((a) => a.kind === "shopify.storefront_check");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storefront check act", () => {
  it("both pass: proof with checkout and product screenshots", async () => {
    const w = await seedWorld({});
    await runAct(w, fakeBrowser(w, {}), fakeSpark({}));
    const row = checkRow(w);
    expect(row?.status).toBe("done");
    expect(row?.revert_payload).toBeNull();
    const proof = JSON.parse(String(row?.proof)) as {
      summary: string;
      image: { url: string; boxes: Array<{ label: string; ok: boolean }> };
      images: Array<{ url: string; boxes: Array<{ label: string }> }>;
    };
    expect(proof.summary).toBe(
      "Checked the live store: BREW20 takes 20% off at checkout ✓ · new copy live ✓",
    );
    expect(proof.image.url).toMatch(/^https:\/\/api\.test\/a\//);
    expect(proof.images).toHaveLength(2);
    expect(proof.images[0].url).toBe(proof.image.url);
    expect(proof.images[0].boxes.map((b) => b.label)).toEqual(["Code applied", "−$3.80", "Total"]);
    expect(proof.image.boxes.every((b) => b.ok)).toBe(true);
    expect(proof.images[1].boxes.map((b) => b.label)).toEqual(["New copy"]);
    expect(w.tables.public_images).toHaveLength(2);
    const keys = [...w.r2.store.keys()].sort();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^storecheck\/org1\/run1\/.+\/checkout\.png$/);
    expect(keys[1]).toMatch(/^storecheck\/org1\/run1\/.+\/product\.png$/);
    expect(w.tokens.n).toBe(10);
  });

  it("checkout fails after one retry: honest failure, run continues", async () => {
    const w = await seedWorld({});
    await runAct(
      w,
      fakeBrowser(w, {}),
      fakeSpark({ checkout: [{ ...CHECKOUT_PASS, codeRead: "WRONG" }, { ...CHECKOUT_PASS, codeRead: "WRONG" }] }),
    );
    const row = checkRow(w);
    expect(row?.status).toBe("failed");
    expect(JSON.parse(String(row?.proof)) as { summary: string }).toEqual({
      summary: "Code BREW20 was not accepted at checkout",
    });
    expect(w.browserCalls.checkout).toBe(2);
    // The product screenshot was already published before checkout failed;
    // it is revoked with the failure instead of floating unattached.
    expect(w.tables.public_images).toHaveLength(1);
    expect(w.tables.public_images[0].revoked_at).toBeTruthy();
  });

  it("password missing: skipped with a Setup pointer, no browser calls", async () => {
    const w = await seedWorld({ password: false });
    await runAct(w, fakeBrowser(w, {}), fakeSpark({}));
    const row = checkRow(w);
    expect(row?.status).toBe("skipped");
    expect(JSON.parse(String(row?.proof)) as { summary: string }).toEqual({
      summary: "Add your store password in Setup so the team can check the live store.",
    });
    expect(w.browserCalls).toEqual({ product: 0, checkout: 0 });
  });

  it("browser error: failed with reason, run continues", async () => {
    const w = await seedWorld({});
    await runAct(
      w,
      fakeBrowser(w, { product: [{ ok: false, reason: "boom" }, { ok: false, reason: "boom" }] }),
      fakeSpark({}),
    );
    const row = checkRow(w);
    expect(row?.status).toBe("failed");
    expect(JSON.parse(String(row?.proof)) as { summary: string }).toEqual({
      summary: "Could not open the product page (boom).",
    });
  });

  it("nothing to check: stays silent", async () => {
    const w = await seedWorld({ discount: false, copy: false });
    await runAct(w, fakeBrowser(w, {}), fakeSpark({}));
    expect(checkRow(w)).toBeUndefined();
  });

  it("stray vision boxes never render on a passed check", async () => {
    const w = await seedWorld({});
    await runAct(
      w,
      fakeBrowser(w, {}),
      fakeSpark({
        checkout: [
          {
            ...CHECKOUT_PASS,
            boxes: [
              ...CHECKOUT_PASS.boxes,
              { label: "Something else", box: [50, 60, 70, 80] },
            ],
          },
        ],
      }),
    );
    const proof = JSON.parse(String(checkRow(w)?.proof)) as {
      images: Array<{ boxes: Array<{ label: string; ok: boolean }> }>;
    };
    expect(proof.images[0].boxes.map((b) => b.label)).toEqual([
      "Code applied",
      "−$3.80",
      "Total",
    ]);
    expect(proof.images[0].boxes.every((b) => b.ok)).toBe(true);
  });
});
