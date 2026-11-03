import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/bindings.js";
import {
  ingestGitHub,
  ingestHubSpot,
  ingestLinear,
  ingestNotion,
  ingestShopify,
  ingestSlack,
  ingestWebsite,
} from "../src/ingest.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Captured {
  id: string;
  text: string;
}

function env(captured: Captured[]) {
  return {
    AI: {
      run: async (_model: string, args: { text: string[] }) => ({
        data: args.text.map(() => [0.1, 0.2]),
      }),
    },
    ORG_MEMORY: {
      upsert: async (vecs: Array<{ id: string; metadata?: { text?: string } }>) => {
        for (const v of vecs) captured.push({ id: v.id, text: String(v.metadata?.text ?? "") });
      },
    },
  } as unknown as Env;
}

describe("ingestHubSpot", () => {
  function stub() {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/pipelines/tickets")) {
        return Response.json({
          results: [{ stages: [{ id: "closed", metadata: { isClosed: true } }] }],
        });
      }
      return Response.json({
        results: [
          {
            properties: {
              subject: "Late delivery",
              content: "Refund issued",
              hs_pipeline_stage: "closed",
              closedate: "2026-10-01",
            },
          },
        ],
      });
    });
  }
  it("stores closed tickets and advances the cursor", async () => {
    const captured: Captured[] = [];
    stub();
    const out = await ingestHubSpot(env(captured), "org1", "t");
    expect(out.chunks).toBeGreaterThan(0);
    expect(out.cursor).toBe("2026-10-01");
    expect(captured.some((c) => c.text.includes("Late delivery"))).toBe(true);
    expect(captured.every((c) => c.id.startsWith("org1:"))).toBe(true);
  });
  it("skips tickets at or before the cursor", async () => {
    const captured: Captured[] = [];
    stub();
    const out = await ingestHubSpot(env(captured), "org1", "t", "2026-10-01");
    expect(out.chunks).toBe(0);
    expect(out.cursor).toBe("2026-10-01");
  });
});

describe("ingestLinear", () => {
  function stub() {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: {
          issues: {
            nodes: [
              {
                id: "i1",
                title: "Checkout slow",
                description: "Stripe calls take 4s",
                updatedAt: "2026-10-02T00:00:00Z",
              },
            ],
          },
        },
      }),
    );
  }
  it("stores issues and advances the cursor", async () => {
    const captured: Captured[] = [];
    stub();
    const out = await ingestLinear(env(captured), "org1", "t");
    expect(out.chunks).toBeGreaterThan(0);
    expect(out.cursor).toBe("2026-10-02T00:00:00Z");
    expect(captured.some((c) => c.text.includes("Checkout slow"))).toBe(true);
  });
  it("skips issues at or before the cursor", async () => {
    const captured: Captured[] = [];
    stub();
    const out = await ingestLinear(env(captured), "org1", "t", "2026-10-02T00:00:00Z");
    expect(out.chunks).toBe(0);
  });
});

describe("ingestNotion", () => {
  function stub() {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/v1/search")) {
        return Response.json({
          results: [
            {
              id: "p1",
              last_edited_time: "2026-10-03T00:00:00Z",
              properties: { Name: { title: [{ plain_text: "ICP" }] } },
            },
          ],
        });
      }
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json({
        results: [
          { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Mid-market retailers" }] } },
        ],
      });
    });
  }
  it("stores page text and advances the cursor", async () => {
    const captured: Captured[] = [];
    stub();
    const out = await ingestNotion(env(captured), "org1", "t");
    expect(out.chunks).toBeGreaterThan(0);
    expect(out.cursor).toBe("2026-10-03T00:00:00Z");
    expect(captured.some((c) => c.text.includes("Mid-market retailers"))).toBe(true);
  });
  it("skips pages at or before the cursor", async () => {
    const captured: Captured[] = [];
    stub();
    const out = await ingestNotion(env(captured), "org1", "t", "2026-10-03T00:00:00Z");
    expect(out.chunks).toBe(0);
  });
});

describe("ingestSlack", () => {
  function stub() {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/conversations.list")) {
        return Response.json({
          ok: true,
          channels: [{ id: "C1", name: "general" }],
        });
      }
      return Response.json({
        ok: true,
        messages: [{ text: "shipping Friday", ts: "1728000000.0001" }],
      });
    });
  }
  it("stores channel chatter and advances the cursor", async () => {
    const captured: Captured[] = [];
    stub();
    const out = await ingestSlack(env(captured), "org1", "t");
    expect(out.chunks).toBeGreaterThan(0);
    expect(out.cursor).toBe("1728000000.0001");
    expect(captured.some((c) => c.text.includes("shipping Friday"))).toBe(true);
  });
  it("skips messages at or before the cursor", async () => {
    const captured: Captured[] = [];
    stub();
    const out = await ingestSlack(env(captured), "org1", "t", "1728000000.0001");
    expect(out.chunks).toBe(0);
  });
});

describe("ingestShopify", () => {
  it("stores the catalog", async () => {
    const captured: Captured[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (body.includes("products(first: 10)")) {
        return Response.json({
          data: { products: { nodes: [{ id: "gid://shopify/Product/1", title: "Gift Box" }] } },
        });
      }
      return Response.json({
        data: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Gift Box",
            description: "Three coffees",
            handle: "gift-box",
          },
        },
      });
    });
    const out = await ingestShopify(env(captured), "org1", "x.myshopify.com", "t");
    expect(out.chunks).toBeGreaterThan(0);
    expect(captured.some((c) => c.text.includes("Gift Box"))).toBe(true);
  });
});

describe("ingestWebsite", () => {
  const home =
    `<html><head><title>Acme</title></head><body><h1>Acme sells fresh coffee for offices across the country with weekly delivery routes included</h1>` +
    `<a href="/pricing">Pricing</a><a href="https://other.test/x">Out</a></body></html>`;
  const pricing =
    `<html><body><p>Plans start at $49 per seat per month with annual billing and onboarding included for every team on every plan</p></body></html>`;
  function stub() {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url) === "https://acme.test/pricing") return new Response(pricing);
      if (String(url) === "https://acme.test/") return new Response(home);
      return new Response("no", { status: 404 });
    });
  }
  it("stores the homepage plus same-host pages", async () => {
    const captured: Captured[] = [];
    stub();
    const out = await ingestWebsite(env(captured), "org1", "https://acme.test/");
    expect(out.chunks).toBeGreaterThan(0);
    expect(captured.some((c) => c.text.includes("fresh coffee"))).toBe(true);
    expect(captured.some((c) => c.text.includes("$49 per seat"))).toBe(true);
    expect(out.cursor).not.toBe("");
  });
  it("skips embedding when nothing changed", async () => {
    const first: Captured[] = [];
    stub();
    const once = await ingestWebsite(env(first), "org1", "https://acme.test/");
    const captured: Captured[] = [];
    stub();
    const out = await ingestWebsite(env(captured), "org1", "https://acme.test/", once.cursor);
    expect(out.chunks).toBe(0);
    expect(out.cursor).toBe(once.cursor);
  });
  it("refuses non-public hosts", async () => {
    const captured: Captured[] = [];
    await expect(ingestWebsite(env(captured), "org1", "http://169.254.169.254/")).rejects.toThrow();
  });
});

describe("ingestGitHub", () => {
  function stub() {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/repos/o/r")) {
        return Response.json({ default_branch: "main" });
      }
      if (String(url).includes("/git/trees/")) {
        return Response.json({
          tree: [
            { path: "README.md", type: "blob" },
            { path: "src/a.ts", type: "blob" },
          ],
        });
      }
      return new Response("# Acme\nCoffee company", { status: 200 });
    });
  }
  it("stores docs plus the tree, with a stable cursor", async () => {
    const captured: Captured[] = [];
    stub();
    const out = await ingestGitHub(env(captured), "org1", "t", "o/r");
    expect(out.files).toBe(1);
    expect(out.chunks).toBeGreaterThan(0);
    expect(captured.some((c) => c.text.includes("Coffee company"))).toBe(true);
    const again = await ingestGitHub(env([]), "org1", "t", "o/r", out.cursor);
    expect(again.chunks).toBe(0);
    expect(again.cursor).toBe(out.cursor);
  });
});
