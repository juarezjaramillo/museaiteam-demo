import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import {
  BadProviderConfig,
  getProviderConfig,
  getStorePassword,
  prepareProviderConfig,
  publicProviderConfig,
  setProviderConfig,
} from "../src/oauth.js";
import { FakeDB, blankTables } from "./fake-db.js";

const TEST_KEY = "0".repeat(64);

function testEnv() {
  const tables = blankTables();
  const env = { DB: new FakeDB(tables), TOKEN_ENC_KEY: TEST_KEY } as unknown as Env;
  return { env, tables };
}

async function save(env: Env, config: Record<string, unknown>) {
  await setProviderConfig(
    env,
    "org1",
    "shopify",
    await prepareProviderConfig(env, "org1", "shopify", config),
  );
}

describe("storefront password storage", () => {
  it("saves the password encrypted and reads it back", async () => {
    const { env, tables } = testEnv();
    await save(env, { shop: "tres-cumbres.myshopify.com", storePassword: "dev-secret" });
    const raw = JSON.parse(
      tables.provider_config.find((r) => r.provider === "shopify")?.config as string,
    ) as Record<string, unknown>;
    expect(raw.shop).toBe("tres-cumbres.myshopify.com");
    expect(typeof raw.storePasswordEnc).toBe("string");
    expect("storePassword" in raw).toBe(false);
    expect(JSON.stringify(raw)).not.toContain("dev-secret");
    expect(await getStorePassword(env, "org1")).toBe("dev-secret");
  });

  it("partial saves merge instead of wiping", async () => {
    const { env } = testEnv();
    await save(env, { shop: "tres-cumbres.myshopify.com", storePassword: "dev-secret" });
    await save(env, { product_id: "gid://shopify/Product/3" });
    const stored = await getProviderConfig(env, "org1", "shopify");
    expect(stored.shop).toBe("tres-cumbres.myshopify.com");
    expect(stored.product_id).toBe("gid://shopify/Product/3");
    expect(await getStorePassword(env, "org1")).toBe("dev-secret");
    await save(env, { storePassword: "rotated" });
    expect(await getStorePassword(env, "org1")).toBe("rotated");
    expect((await getProviderConfig(env, "org1", "shopify")).shop).toBe(
      "tres-cumbres.myshopify.com",
    );
  });

  it("never returns the secret, only a saved flag", async () => {
    const { env } = testEnv();
    expect(await getStorePassword(env, "org1")).toBeNull();
    expect(publicProviderConfig("shopify", {})).toEqual({ storePasswordSaved: false });
    await save(env, { shop: "tres-cumbres.myshopify.com", storePassword: "dev-secret" });
    const pub = publicProviderConfig("shopify", await getProviderConfig(env, "org1", "shopify"));
    expect(pub.storePasswordSaved).toBe(true);
    expect("storePasswordEnc" in pub).toBe(false);
    expect("storePassword" in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain("dev-secret");
  });

  it("rejects bad passwords", async () => {
    const { env } = testEnv();
    await expect(prepareProviderConfig(env, "org1", "shopify", { storePassword: "" })).rejects.toBeInstanceOf(
      BadProviderConfig,
    );
    await expect(
      prepareProviderConfig(env, "org1", "shopify", { storePassword: "x".repeat(201) }),
    ).rejects.toBeInstanceOf(BadProviderConfig);
    await expect(
      prepareProviderConfig(env, "org1", "slack", { storePassword: "nope" }),
    ).rejects.toBeInstanceOf(BadProviderConfig);
  });
});
