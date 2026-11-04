import { describe, expect, it } from "vitest";
import { verifyState } from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import { connectUrl } from "../src/oauth.js";

function env(): Env {
  return {
    AUTH_SECRET: "test-secret",
    GITHUB_CLIENT_ID: "gh-id",
    GITHUB_CLIENT_SECRET: "gh-secret",
    SHOPIFY_CLIENT_ID: "shop-id",
    SHOPIFY_CLIENT_SECRET: "shop-secret",
  } as unknown as Env;
}

async function stateOf(url: string): Promise<{ org: string; shop: string | null; seat: string | null }> {
  const state = new URL(url).searchParams.get("state") ?? "";
  return verifyState("test-secret", state);
}

describe("per-hire oauth connect", () => {
  it("binds ?seat= into state so the callback stores it in the hire vault", async () => {
    const url = await connectUrl(env(), "github", "org1", "https://api.test", undefined, "s1");
    expect(await stateOf(url)).toMatchObject({ org: "org1", seat: "s1" });
  });

  it("leaves seat null for org-level connects", async () => {
    const url = await connectUrl(env(), "github", "org1", "https://api.test");
    expect(await stateOf(url)).toMatchObject({ org: "org1", seat: null });
  });

  it("carries both shop and seat for shopify", async () => {
    const url = await connectUrl(env(), "shopify", "org1", "https://api.test", "demo.myshopify.com", "s1");
    expect(await stateOf(url)).toMatchObject({
      org: "org1",
      shop: "demo.myshopify.com",
      seat: "s1",
    });
  });

  it("rejects shopify without a store domain", async () => {
    await expect(connectUrl(env(), "shopify", "org1", "https://api.test", undefined, "s1")).rejects.toThrow(
      /shop=your-store/,
    );
  });
});
