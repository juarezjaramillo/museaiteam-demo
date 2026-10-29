import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { decideProposal } from "../src/proposals.js";
import { FakeDB, blankTables } from "./fake-db.js";

function seed(approvalMode: string) {
  const tables = blankTables();
  tables.orgs.push({ id: "org1", idea_allowance_words: 250000 });
  tables.goals.push({
    id: "goal1",
    org_id: "org1",
    title: "goal one two",
    status: "active",
    approval_mode: approvalMode,
  });
  tables.proposals_out.push({
    id: "p1",
    org_id: "org1",
    kind: "next-work",
    goal_id: "goal1",
    title: "do the thing now",
    body: "why",
    status: "proposed",
    remind_at: "2026-01-01 00:00:00",
    start_at: "2026-01-01 00:00:00",
  });
  const env = { DB: new FakeDB(tables) } as unknown as Env;
  return { env, tables };
}

describe("decideProposal", () => {
  it("reject holds the idea with no run", async () => {
    const { env, tables } = seed("posthoc");
    expect(await decideProposal(env, "org1", "p1", "reject", "not now")).toBe("ok");
    expect(tables.proposals_out[0].status).toBe("rejected");
    expect(tables.runs).toHaveLength(0);
  });

  it("approve on a check-first goal holds instead of starting", async () => {
    const { env, tables } = seed("preapprove");
    expect(await decideProposal(env, "org1", "p1", "approve")).toBe("ok");
    expect(tables.proposals_out[0].status).toBe("held");
    expect(tables.runs).toHaveLength(0);
    expect(tables.notifications.some((n) => n.kind === "proposal.started")).toBe(true);
  });

  it("unknown and decided ideas report honestly", async () => {
    const { env } = seed("posthoc");
    expect(await decideProposal(env, "org1", "nope", "approve")).toBe("notfound");
    await decideProposal(env, "org1", "p1", "reject");
    expect(await decideProposal(env, "org1", "p1", "approve")).toBe("decided");
  });
});
