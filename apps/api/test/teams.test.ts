import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import {
  BadRole,
  DuplicateSeat,
  SeatFrozen,
  UnknownMember,
  moveSeat,
  setTeamOwner,
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
