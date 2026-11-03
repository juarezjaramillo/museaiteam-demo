import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile as ghReadFile } from "../src/integrations/github.js";
import { ticketStages } from "../src/integrations/hubspot.js";
import {
  ProviderRateLimited,
  providerFetch,
  retryAfterSec,
} from "../src/integrations/http.js";
import { findTeamId } from "../src/integrations/linear.js";
import { archivePage } from "../src/integrations/notion.js";
import { shopName } from "../src/integrations/shopify.js";
import { authTest } from "../src/integrations/slack.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub429(retryAfter = "45") {
  vi.stubGlobal(
    "fetch",
    async () => new Response("slow down", { status: 429, headers: { "retry-after": retryAfter } }),
  );
}

describe("providerFetch", () => {
  it("passes normal answers through", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ ok: true }));
    const res = await providerFetch("Test", "https://x.example/");
    expect(res.ok).toBe(true);
  });

  it("raises a typed error carrying retry-after on 429", async () => {
    stub429("45");
    const err = await providerFetch("Test", "https://x.example/").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRateLimited);
    expect(err.retryAfterSec).toBe(45);
    expect(String(err)).toContain("retry in 45s");
  });

  it("defaults an absent retry-after to a minute", () => {
    expect(retryAfterSec(new Headers())).toBe(60);
  });

  it("times out a hanging vendor", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(providerFetch("Test", "https://x.example/", {}, 10)).rejects.toThrow();
  });
});

describe("provider 429 wiring", () => {
  it("github", async () => {
    stub429();
    await expect(ghReadFile("t", "o/r", "f")).rejects.toBeInstanceOf(ProviderRateLimited);
  });
  it("hubspot", async () => {
    stub429();
    await expect(ticketStages("t")).rejects.toBeInstanceOf(ProviderRateLimited);
  });
  it("linear", async () => {
    stub429();
    await expect(findTeamId("t", "Eng")).rejects.toBeInstanceOf(ProviderRateLimited);
  });
  it("notion", async () => {
    stub429();
    await expect(archivePage("t", "p1")).rejects.toBeInstanceOf(ProviderRateLimited);
  });
  it("shopify", async () => {
    stub429();
    await expect(shopName("x.myshopify.com", "t")).rejects.toBeInstanceOf(ProviderRateLimited);
  });
  it("slack", async () => {
    stub429();
    await expect(authTest("t")).rejects.toBeInstanceOf(ProviderRateLimited);
  });
  it("slack maps a 200 ratelimited body too", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ ok: false, error: "ratelimited" }));
    const err = await authTest("t").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRateLimited);
  });
});
