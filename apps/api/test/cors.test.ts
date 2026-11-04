import { describe, expect, it, vi } from "vitest";

// The app re-exports worker-only classes; stub them so it loads in node.
vi.mock("../src/workflow.js", () => ({ GoalRunWorkflow: class {} }));
vi.mock("../src/hire-box.js", () => ({ HireBox: class {} }));

import type { Env } from "../src/bindings.js";
import worker from "../src/index.js";
import { FakeDB, blankTables } from "./fake-db.js";

const APP = "https://museaiteam.pages.dev";

function env(): Env {
  return {
    DB: new FakeDB(blankTables()),
    APP_URL: APP,
    API_URL: "https://api.test",
    AUTH_SECRET: "test-secret",
    TOKEN_ENC_KEY: "ab".repeat(32),
  } as unknown as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

async function call(path: string, origin: string): Promise<Response> {
  const fetch = (worker as unknown as { fetch: (req: Request, env: Env, ctx: unknown) => Promise<Response> }).fetch;
  return fetch(new Request(`https://api.test${path}`, { headers: { origin } }), env(), ctx);
}

describe("cors on own-Response routes", () => {
  it("adds CORS headers when the handler returns its own Response", async () => {
    // No auth providers configured, so /api/auth/csrf returns
    // authHandler's own 503 Response instead of going through c.json.
    const res = await call("/api/auth/csrf", APP);
    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("still serves c.json routes with CORS headers", async () => {
    const res = await call("/api/health", APP);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
  });

  it("sends no CORS headers to stranger origins", async () => {
    const res = await call("/api/auth/csrf", "https://evil.example");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
