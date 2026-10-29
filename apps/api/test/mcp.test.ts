import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/bindings.js";
import {
  decideToolApproval,
  requestToolApproval,
  autoReviewRun,
} from "../src/approvals.js";
import {
  addServer,
  callTool,
  McpError,
  probeServer,
  setTrust,
  type McpServerRow,
} from "../src/mcp.js";
import { requestSignup } from "../src/proposals.js";
import { FakeDB, blankTables, type FakeTables } from "./fake-db.js";

const KEY = "ab".repeat(32);

function env(tables?: FakeTables) {
  return { DB: new FakeDB(tables ?? blankTables()), TOKEN_ENC_KEY: KEY } as unknown as Env;
}

function jsonRpc(result: unknown, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseRpc(result: unknown) {
  return new Response(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const INIT = { serverInfo: { name: "probe-me", version: "1.0" } };
const TOOLS = {
  tools: [
    { name: "get_status", description: "read it", annotations: { readOnlyHint: true } },
    { name: "delete_all", description: "burn it", annotations: { destructiveHint: true } },
  ],
};

/** Route stubbed fetch by JSON-RPC method; records calls. */
function stubRpc(handlers: Record<string, (body: Record<string, unknown>) => Response>) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const stub = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body, headers: (init.headers ?? {}) as Record<string, string> });
    const h = handlers[String(body.method)];
    if (!h) return new Response("nope", { status: 500 });
    return h(body);
  });
  vi.stubGlobal("fetch", stub);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeServer", () => {
  it("parses plain JSON answers", async () => {
    stubRpc({ initialize: () => jsonRpc(INIT), "tools/list": () => jsonRpc(TOOLS) });
    const probe = await probeServer("https://x.example/mcp");
    expect(probe.name).toBe("probe-me");
    expect(probe.tools.map((t) => t.name)).toEqual(["get_status", "delete_all"]);
  });

  it("parses SSE answers", async () => {
    stubRpc({ initialize: () => sseRpc(INIT), "tools/list": () => sseRpc(TOOLS) });
    const probe = await probeServer("https://x.example/mcp");
    expect(probe.tools).toHaveLength(2);
  });

  it("rejects non-http URLs and auth failures", async () => {
    await expect(probeServer("npx foo")).rejects.toThrow(McpError);
    stubRpc({
      initialize: () => new Response("denied", { status: 401 }),
      "tools/list": () => jsonRpc(TOOLS),
    });
    const err = await probeServer("https://x.example/mcp").catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe("auth");
  });
});

describe("callTool", () => {
  const server = (over: Partial<McpServerRow> = {}): McpServerRow => ({
    id: "s1",
    org_id: "org1",
    name: "S",
    url: "https://x.example/mcp",
    auth: "none",
    auth_name: "",
    source: "catalog",
    status: "trusted",
    spend_cap_cents: 0,
    ...over,
  });

  it("returns joined text and reports tool errors typed", async () => {
    const e = env();
    stubRpc({
      "tools/call": () =>
        jsonRpc({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    });
    expect(await callTool(e, server(), "get_status", {})).toBe("a\nb");
    stubRpc({ "tools/call": () => jsonRpc({ content: [{ text: "boom" }], isError: true }) });
    const err = await callTool(e, server(), "get_status", {}).catch((x) => x);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe("tool");
  });
});

describe("addServer", () => {
  it("trusts catalog entries, pends founder URLs, blocks duplicates", async () => {
    const tables = blankTables();
    const e = env(tables);
    stubRpc({ initialize: () => jsonRpc(INIT), "tools/list": () => jsonRpc(TOOLS) });
    const cat = await addServer(e, "org1", { catalogId: "outagedeck" });
    expect(cat.server.status).toBe("trusted");
    expect(cat.server.source).toBe("catalog");
    expect(cat.tools).toHaveLength(2);
    const own = await addServer(e, "org1", { url: "https://mine.example/mcp" });
    expect(own.server.status).toBe("pending");
    await expect(addServer(e, "org1", { url: "https://mine.example/mcp" })).rejects.toThrow(
      /already added/,
    );
    await expect(addServer(e, "org1", { catalogId: "nope" })).rejects.toThrow(McpError);
  });
});

describe("tool approvals", () => {
  function seed() {
    const tables = blankTables();
    tables.runs.push({ id: "run1", org_id: "org1", goal_id: "goal1", kind: "work", goal: "g", status: "acting" });
    tables.mcp_servers.push({
      id: "s1", org_id: "org1", name: "S", url: "https://x.example/mcp",
      auth: "none", auth_name: "", source: "founder", status: "pending", spend_cap_cents: 0,
    });
    return { env: env(tables), tables };
  }

  it("first-use approve trusts the server without running anything", async () => {
    const { env: e, tables } = seed();
    const server = tables.mcp_servers[0] as unknown as McpServerRow;
    const id = await requestToolApproval(e, {
      orgId: "org1", runId: "run1", goalId: "goal1", actionId: null, server, tool: null, args: null,
    });
    expect(tables.approvals).toHaveLength(1);
    const calls = stubRpc({ "tools/call": () => jsonRpc({ content: [{ text: "x" }] }) });
    expect(
      await decideToolApproval(e, { approvalId: id, orgId: "org1", userId: "u1", decision: "approve" }),
    ).toBe("ok");
    expect(tables.mcp_servers[0].status).toBe("trusted");
    expect(calls).toHaveLength(0);
    expect(
      await decideToolApproval(e, { approvalId: id, orgId: "org1", userId: "u1", decision: "approve" }),
    ).toBe("decided");
  });

  it("sensitive approve runs the call; reject skips the action", async () => {
    const { env: e, tables } = seed();
    await setTrust(e, "org1", "s1", "trusted");
    const server = tables.mcp_servers[0] as unknown as McpServerRow;
    tables.actions.push({ id: "a1", run_id: "run1", kind: "mcp.tool", target: "S: delete all", status: "pending", payload: "{}" });
    const id = await requestToolApproval(e, {
      orgId: "org1", runId: "run1", goalId: "goal1", actionId: "a1",
      server, tool: "delete_all", args: { confirm: true },
    });
    stubRpc({ "tools/call": () => jsonRpc({ content: [{ text: "gone" }] }) });
    expect(
      await decideToolApproval(e, { approvalId: id, orgId: "org1", userId: "u1", decision: "approve" }),
    ).toBe("ok");
    const done = tables.actions.find((a) => a.id === "a1");
    expect(done?.status).toBe("done");
    expect(String(done?.proof)).toContain("delete_all");
    tables.actions.push({ id: "a2", run_id: "run1", kind: "mcp.tool", target: "t", status: "pending", payload: "{}" });
    const id2 = await requestToolApproval(e, {
      orgId: "org1", runId: "run1", goalId: "goal1", actionId: "a2",
      server, tool: "delete_all", args: {},
    });
    expect(
      await decideToolApproval(e, { approvalId: id2, orgId: "org1", userId: "u1", decision: "reject" }),
    ).toBe("ok");
    expect(tables.actions.find((a) => a.id === "a2")?.status).toBe("skipped");
    expect(
      await decideToolApproval(e, { approvalId: "nope", orgId: "org1", userId: "u1", decision: "approve" }),
    ).toBe("notfound");
  });
});

describe("requestSignup", () => {
  it("proposes once per server while the founder thinks", async () => {
    const tables = blankTables();
    const e = env(tables);
    const server = {
      id: "s1", org_id: "org1", name: "Keyed", url: "https://k.example/mcp",
      auth: "header", auth_name: "", source: "founder", status: "trusted", spend_cap_cents: 0,
    } as McpServerRow;
    const first = await requestSignup(e, "org1", server, "401 Unauthorized");
    expect(first).toBeTruthy();
    expect(tables.proposals_out).toHaveLength(1);
    expect(tables.proposals_out[0].kind).toBe("signup");
    expect(await requestSignup(e, "org1", server, "401 again")).toBeNull();
    expect(tables.proposals_out).toHaveLength(1);
  });
});

describe("autoReviewRun with tool calls", () => {
  it("auto-approves reads, holds writes", async () => {
    const tables = blankTables();
    tables.runs.push({ id: "run1", org_id: "org1", goal_id: "goal1", kind: "work", goal: "g", status: "done" });
    tables.goals.push({ id: "goal1", org_id: "org1", title: "goal", approval_mode: "posthoc" });
    tables.actions.push(
      { id: "r1", run_id: "run1", kind: "mcp.tool", target: "S: get status", status: "done", payload: JSON.stringify({ readOnly: true }) },
      { id: "w1", run_id: "run1", kind: "mcp.tool", target: "S: delete all", status: "done", payload: JSON.stringify({ readOnly: false }) },
    );
    const e = env(tables);
    expect(await autoReviewRun(e, "run1")).toEqual({ auto: 1, pending: 1 });
    const by = (id: string) => tables.approvals.find((r) => r.action_id === id)?.status;
    expect(by("r1")).toBe("approved");
    expect(by("w1")).toBe("pending");
  });
});
