import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptToB64, keyFromHex } from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import {
  gatherNewConnection,
  gatherSource,
  getProfile,
  saveProfile,
  synthesizeProfile,
  tickMemoryGather,
} from "../src/gather.js";
import { FakeDB, blankTables, type FakeTables } from "./fake-db.js";

const KEY = "ab".repeat(32);

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakes() {
  const upserted: Array<{ id: string }> = [];
  return {
    upserted,
    AI: {
      run: async (_m: string, args: { text: string[] }) => ({
        data: args.text.map(() => [0.1, 0.2]),
      }),
    },
    ORG_MEMORY: {
      upsert: async (vecs: Array<{ id: string }>) => {
        upserted.push(...vecs);
      },
      query: async () => ({
        matches: [
          { id: "org1:aaa", metadata: { source: "web", text: "Acme sells coffee to offices" } },
          { id: "org1:bbb", metadata: { source: "hubspot", text: "Late delivery refund issued" } },
        ],
      }),
    },
  };
}

async function tokenTables() {
  const tables = blankTables();
  tables.orgs.push({ id: "org1", subscribed: 1 });
  tables.oauth_tokens.push({
    org_id: "org1",
    provider: "hubspot",
    access_token_enc: await encryptToB64(keyFromHex(KEY), "hs-token"),
    refresh_token_enc: null,
    expires_at: null,
  });
  return tables;
}

function env(tables: FakeTables, f: ReturnType<typeof fakes>) {
  return {
    DB: new FakeDB(tables),
    TOKEN_ENC_KEY: KEY,
    META_MODEL_API_KEY: "k",
    SPARK_MODE: "live",
    AI: f.AI,
    ORG_MEMORY: f.ORG_MEMORY,
  } as unknown as Env;
}

function stubHubSpot() {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("api.hubapi.com")) {
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
    }
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify({ offering: "Coffee for offices", icp: "Office managers" }) },
        },
      ],
      usage: { total_tokens: 40 },
    });
  });
}

describe("gatherSource", () => {
  it("gathers, stores the cursor, and counts chunks", async () => {
    const tables = await tokenTables();
    const f = fakes();
    stubHubSpot();
    const n = await gatherSource(env(tables, f), "org1", "hubspot");
    expect(n).toBeGreaterThan(0);
    expect(f.upserted.length).toBeGreaterThan(0);
    const state = tables.memory_gather_state.find((r) => r.source === "hubspot");
    expect(state?.cursor).toBe("2026-10-01");
  });

  it("skips sources with no token", async () => {
    const tables = blankTables();
    tables.orgs.push({ id: "org1", subscribed: 1 });
    const f = fakes();
    const fetchMock = vi.fn(async () => new Response("no", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await gatherSource(env(tables, f), "org1", "hubspot")).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("audits source failures instead of throwing", async () => {
    const tables = await tokenTables();
    const f = fakes();
    vi.stubGlobal("fetch", async () => {
      throw new Error("vendor down");
    });
    expect(await gatherSource(env(tables, f), "org1", "hubspot")).toBe(0);
    expect(tables.audit_log.some((r) => r.event === "gather.failed")).toBe(true);
  });
});

describe("gatherNewConnection", () => {
  it("gathers and refreshes the profile on connect", async () => {
    const tables = await tokenTables();
    const f = fakes();
    stubHubSpot();
    await gatherNewConnection(env(tables, f), "org1", "hubspot");
    const profile = await getProfile(env(tables, f), "org1");
    expect(profile.offering).toContain("Coffee");
    expect(tables.audit_log.some((r) => r.event === "gather.connected")).toBe(true);
  });
});

describe("synthesizeProfile", () => {
  it("never overwrites human edits", async () => {
    const tables = await tokenTables();
    const f = fakes();
    stubHubSpot();
    const e = env(tables, f);
    await saveProfile(e, "org1", { icp: "Founder's words" }, "human");
    const filled = await synthesizeProfile(e, "org1");
    const profile = await getProfile(e, "org1");
    expect(profile.icp).toBe("Founder's words");
    expect(filled).not.toContain("icp");
    expect(profile.offering).toContain("Coffee");
  });
});

describe("tickMemoryGather", () => {
  it("gathers once per week", async () => {
    const tables = await tokenTables();
    const f = fakes();
    stubHubSpot();
    const e = env(tables, f);
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("api.hubapi.com")) {
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
      }
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ offering: "Coffee for offices" }) },
          },
        ],
        usage: { total_tokens: 40 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await tickMemoryGather(e);
    expect(tables.memory_gather_state.length).toBeGreaterThan(0);
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    await tickMemoryGather(e);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});
