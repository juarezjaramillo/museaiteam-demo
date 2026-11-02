import { describe, expect, it } from "vitest";
import { cartUrl, productUrl, unlockStore, type UnlockPage } from "../src/store-browser.js";

function fakePage(opts: { hasPassword: boolean; staysLocked?: boolean }) {
  const calls: string[] = [];
  let typed = "";
  const page: UnlockPage = {
    goto: async (url: string) => {
      calls.push(`goto:${url}`);
    },
    $: async (sel: string) => {
      calls.push(`query:${sel}`);
      if (!opts.hasPassword) return null;
      if (opts.staysLocked === false && typed) return null;
      return {
        type: async (t: string) => {
          typed = t;
          calls.push(`type:${t}`);
        },
        press: async (k: string) => {
          calls.push(`press:${k}`);
        },
      };
    },
    waitForNavigation: async () => {
      calls.push("nav");
    },
  };
  return { calls, page };
}

describe("unlockStore", () => {
  it("types through the password gate", async () => {
    const { calls, page } = fakePage({ hasPassword: true, staysLocked: false });
    await unlockStore(page, "tres-cumbres.myshopify.com", "dev-secret");
    expect(calls[0]).toBe("goto:https://tres-cumbres.myshopify.com/password");
    expect(calls).toContain("type:dev-secret");
    expect(calls).toContain("press:Enter");
  });

  it("continues when the store is public", async () => {
    const { calls, page } = fakePage({ hasPassword: false });
    await unlockStore(page, "tres-cumbres.myshopify.com", "dev-secret");
    expect(calls[0]).toBe("goto:https://tres-cumbres.myshopify.com/password");
    expect(calls.some((c) => c.startsWith("type:"))).toBe(false);
  });

  it("reports a rejected password", async () => {
    const { page } = fakePage({ hasPassword: true, staysLocked: true });
    await expect(unlockStore(page, "shop.myshopify.com", "wrong")).rejects.toThrow(
      "store password was rejected",
    );
  });
});

describe("storefront urls", () => {
  it("builds product and cart urls with an encoded code", () => {
    expect(productUrl("tres-cumbres.myshopify.com", "oaxaca-pluma")).toBe(
      "https://tres-cumbres.myshopify.com/products/oaxaca-pluma",
    );
    expect(cartUrl("tres-cumbres.myshopify.com", 42, "BREW20")).toBe(
      "https://tres-cumbres.myshopify.com/cart/42:1?discount=BREW20",
    );
    expect(cartUrl("tres-cumbres.myshopify.com", 42, "SAVE 20%")).toBe(
      "https://tres-cumbres.myshopify.com/cart/42:1?discount=SAVE%2020%25",
    );
  });
});
