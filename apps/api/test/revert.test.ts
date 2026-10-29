import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptToB64, keyFromHex } from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import { executeRevert } from "../src/revert.js";
import { FakeDB, blankTables } from "./fake-db.js";

const TEST_KEY = "0".repeat(64);

async function seed(withCreator: boolean) {
  const tables = blankTables();
  tables.runs.push({ id: "run1", org_id: "org1", goal: "g", status: "done" });
  const enc = await encryptToB64(keyFromHex(TEST_KEY), "fake-token");
  tables.oauth_tokens.push({
    org_id: "org1",
    provider: "linear",
    access_token_enc: enc,
    refresh_token_enc: null,
    expires_at: null,
  });
  if (withCreator) {
    tables.actions.push({
      id: "c1",
      run_id: "run1",
      kind: "linear.create_issue",
      target: "t",
      status: "done",
      revert_payload: JSON.stringify({ issueId: "ISSUE-1", subIds: [] }),
    });
  }
  tables.actions.push({
    id: "m1",
    run_id: "run1",
    kind: "linear.manage_issue",
    target: "t",
    status: "done",
    revert_payload: JSON.stringify({ issueId: "ISSUE-1", subIds: ["SUB-1", "SUB-2"] }),
  });
  const env = { DB: new FakeDB(tables), TOKEN_ENC_KEY: TEST_KEY } as unknown as Env;
  return { env, tables };
}

const deleted: string[] = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { id?: string } };
    if (body.variables?.id) deleted.push(body.variables.id);
    return {
      ok: true,
      json: async () => ({ data: { issueDelete: { success: true } } }),
    };
  }),
);

afterEach(() => {
  deleted.length = 0;
});

describe("executeRevert kept-parent guard", () => {
  it("deletes subtasks but keeps a pre-existing parent", async () => {
    const { env, tables } = await seed(false);
    const res = await executeRevert(env, "org1", "run1");
    expect(res.failed).toHaveLength(0);
    expect(deleted.sort()).toEqual(["SUB-1", "SUB-2"]);
    expect(tables.audit_log.some((r) => r.event === "revert.kept_parent")).toBe(true);
  });

  it("deletes the parent when the same run created it", async () => {
    const { env } = await seed(true);
    const res = await executeRevert(env, "org1", "run1");
    expect(res.failed).toHaveLength(0);
    expect(deleted).toContain("ISSUE-1");
  });
});
