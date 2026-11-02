import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import {
  BadRole,
  DuplicateSeat,
  SeatFrozen,
  UnknownMember,
  getBrief,
  listTeams,
  markReviewed,
  moveSeat,
  putBrief,
  reviewPayload,
  setTeamOwner,
  teamReviewState,
} from "../src/teams.js";
import { FakeDB, blankTables } from "./fake-db.js";

function env() {
  const tables = blankTables();
  tables.orgs.push({ id: "org1" });
  tables.org_members.push({ org_id: "org1", user_id: "u-owner" });
  tables.org_members.push({ org_id: "org1", user_id: "u-sam" });
  tables.teams.push({ id: "t1", org_id: "org1", name: "Team 1", owner_user_id: null });
  tables.teams.push({ id: "t2", org_id: "org1", name: "Team 2", owner_user_id: null });
  tables.seats.push({ id: "s1", team_id: "t1", role: "engineer", hired: 1, approved: 1, frozen_at: null });
  tables.seats.push({ id: "s2", team_id: "t2", role: "engineer", hired: 1, approved: 1, frozen_at: null });
  tables.seats.push({ id: "s4", team_id: "t2", role: "qa", hired: 1, approved: 1, frozen_at: null });
  tables.seats.push({ id: "s3", team_id: "t1", role: "pm", hired: 1, approved: 1, frozen_at: "2026-01-01" });
  return { env: { DB: new FakeDB(tables) } as unknown as Env, tables };
}

describe("team ownership", () => {
  it("assigns a team to a member and back to the bench", async () => {
    const { env: e, tables } = env();
    await setTeamOwner(e, "org1", "t1", "u-sam");
    expect(tables.teams.find((t) => t.id === "t1")?.owner_user_id).toBe("u-sam");
    await setTeamOwner(e, "org1", "t1", null);
    expect(tables.teams.find((t) => t.id === "t1")?.owner_user_id).toBe(null);
  });

  it("refuses strangers and unknown teams", async () => {
    const { env: e } = env();
    await expect(setTeamOwner(e, "org1", "t1", "u-stranger")).rejects.toBeInstanceOf(UnknownMember);
    await expect(setTeamOwner(e, "org1", "nope", "u-sam")).rejects.toBeInstanceOf(BadRole);
  });

  it("moves hires between teams, never duplicating a role", async () => {
    const { env: e, tables } = env();
    await expect(moveSeat(e, "org1", "s1", "t2")).rejects.toBeInstanceOf(DuplicateSeat);
    await moveSeat(e, "org1", "s4", "t1");
    expect(tables.seats.find((s) => s.id === "s4")?.team_id).toBe("t1");
  });

  it("frozen hires stay put; same-team moves are no-ops", async () => {
    const { env: e, tables } = env();
    await expect(moveSeat(e, "org1", "s3", "t2")).rejects.toBeInstanceOf(SeatFrozen);
    await moveSeat(e, "org1", "s1", "t1");
    expect(tables.seats.find((s) => s.id === "s1")?.team_id).toBe("t1");
  });
});

describe("brief + review ritual", () => {
  it("round-trips the daily brief", async () => {
    const { env: e } = env();
    expect(await getBrief(e, "org1", "t1")).toEqual({ text: "", reviewedAt: null });
    await putBrief(e, "org1", "t1", "today matters: the Acme tickets");
    expect(await getBrief(e, "org1", "t1")).toEqual({
      text: "today matters: the Acme tickets",
      reviewedAt: null,
    });
    await putBrief(e, "org1", "t1", "updated");
    expect((await getBrief(e, "org1", "t1")).text).toBe("updated");
    await expect(getBrief(e, "org1", "nope")).rejects.toBeInstanceOf(BadRole);
  });

  it("review states: never, waiting, reviewed", async () => {
    const { env: e, tables } = env();
    expect(await teamReviewState(e, "t1")).toBe("never");
    tables.runs.push({ id: "r1", team_id: "t1", goal: "g", status: "done", kind: "work", created_at: "2026-01-01T00:00:00Z" });
    expect(await teamReviewState(e, "t1")).toBe("waiting");
    await markReviewed(e, "org1", "t1");
    expect(await teamReviewState(e, "t1")).toBe("reviewed");
    await expect(markReviewed(e, "org1", "nope")).rejects.toBeInstanceOf(BadRole);
  });

  it("a brief alone waits for review", async () => {
    const { env: e } = env();
    await putBrief(e, "org1", "t2", "hello");
    expect(await teamReviewState(e, "t2")).toBe("waiting");
  });

  it("overnight shows only runs since the last review, plus pending", async () => {
    const { env: e, tables } = env();
    tables.team_briefs.push({ team_id: "t1", day: "2026-01-01", text: "x", reviewed_at: "2026-01-02T00:00:00Z" });
    tables.runs.push({ id: "r-old", team_id: "t1", goal: "old", status: "done", kind: "work", created_at: "2026-01-01T12:00:00Z" });
    tables.runs.push({ id: "r-new", team_id: "t1", goal: "new", status: "done", kind: "work", created_at: "2026-01-03T12:00:00Z" });
    tables.actions.push({ id: "a1", run_id: "r-new", kind: "linear.create_issue", target: "ENG-1", status: "pending" });
    const p = await reviewPayload(e, "org1", "t1");
    expect(p.team.name).toBe("Team 1");
    expect(p.overnight.map((r) => r.id)).toEqual(["r-new"]);
    expect(p.pending.map((a) => a.id)).toEqual(["a1"]);
    expect(p.pending[0]?.runGoal).toBe("new");
    await expect(reviewPayload(e, "org1", "nope")).rejects.toBeInstanceOf(BadRole);
  });

  it("listTeams carries the review state", async () => {
    const { env: e, tables } = env();
    tables.runs.push({ id: "r1", team_id: "t1", goal: "g", status: "done", kind: "work", created_at: "2026-01-01T00:00:00Z" });
    const teams = await listTeams(e, "org1");
    expect(teams.find((t) => t.id === "t1")?.review).toBe("waiting");
    expect(teams.find((t) => t.id === "t2")?.review).toBe("never");
  });
});

describe("member scoping", () => {
  it("unscoped reads see every team", async () => {
    const { env: e } = env();
    await setTeamOwner(e, "org1", "t1", "u-sam");
    expect((await listTeams(e, "org1")).map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("scoped reads see only owned teams", async () => {
    const { env: e } = env();
    await setTeamOwner(e, "org1", "t1", "u-sam");
    expect((await listTeams(e, "org1", "u-sam")).map((t) => t.id)).toEqual(["t1"]);
    expect(await listTeams(e, "org1", "u-owner")).toEqual([]);
  });

  it("foreign teams 404 on brief and review reads and writes", async () => {
    const { env: e } = env();
    await setTeamOwner(e, "org1", "t1", "u-sam");
    await putBrief(e, "org1", "t1", "sam's brief", undefined, "u-sam");
    expect((await getBrief(e, "org1", "t1", undefined, "u-sam")).text).toBe("sam's brief");
    await expect(getBrief(e, "org1", "t1", undefined, "u-owner")).rejects.toBeInstanceOf(BadRole);
    await expect(putBrief(e, "org1", "t1", "x", undefined, "u-owner")).rejects.toBeInstanceOf(BadRole);
    await expect(markReviewed(e, "org1", "t1", undefined, "u-owner")).rejects.toBeInstanceOf(BadRole);
    await expect(reviewPayload(e, "org1", "t1", "u-owner")).rejects.toBeInstanceOf(BadRole);
    expect((await reviewPayload(e, "org1", "t1", "u-sam")).team.name).toBe("Team 1");
  });
});
