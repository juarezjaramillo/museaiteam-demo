import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { listSeatMail, markMailRead, receiveSeatMail } from "../src/seat-mail.js";
import { FakeDB, blankTables } from "./fake-db.js";

function env() {
  const tables = blankTables();
  tables.teams.push({ id: "t1", org_id: "org1" });
  tables.seats.push({ id: "s1", team_id: "t1", role: "analyst", email: "analyst-abc123@hires.museaiteam.com" });
  return { env: { DB: new FakeDB(tables) } as unknown as Env, tables };
}

describe("seat mail", () => {
  it("routes to the hire inbox, dedupes, drops strangers", async () => {
    const { env: e, tables } = env();
    expect(
      await receiveSeatMail(e, {
        to: ["Priya <analyst-abc123@hires.museaiteam.com>"],
        from: "linear@example.com",
        subject: "Invite",
        body: "join here",
        messageId: "m1",
      }),
    ).toBe("stored");
    expect(tables.seat_mail).toHaveLength(1);
    await receiveSeatMail(e, {
      to: ["analyst-abc123@hires.museaiteam.com"],
      from: "x",
      subject: "dup",
      body: "dup",
      messageId: "m1",
    });
    expect(tables.seat_mail).toHaveLength(1);
    expect(
      await receiveSeatMail(e, { to: ["nobody@example.com"], from: "x", subject: "s", body: "b" }),
    ).toBe("dropped");
    expect(
      await receiveSeatMail(e, {
        to: ["ghost-zzz@hires.museaiteam.com"],
        from: "x",
        subject: "s",
        body: "b",
      }),
    ).toBe("dropped");
  });

  it("lists unread and marks read, scoped to the seat", async () => {
    const { env: e, tables } = env();
    tables.seat_mail.push(
      { id: "a", org_id: "org1", seat_id: "s1", from_addr: "f", subject: "one", body: "1", read_at: null },
      { id: "b", org_id: "org1", seat_id: "s1", from_addr: "f", subject: "two", body: "2", read_at: "read" },
      { id: "c", org_id: "org1", seat_id: "s9", from_addr: "f", subject: "x", body: "x", read_at: null },
    );
    expect((await listSeatMail(e, "org1", "s1", true)).map((m) => m.id)).toEqual(["a"]);
    expect(await markMailRead(e, "org1", "s1", "a")).toBe(true);
    expect(await markMailRead(e, "org1", "s1", "a")).toBe(false);
    expect(await listSeatMail(e, "org1", "s1", true)).toEqual([]);
    expect(await listSeatMail(e, "nope", "s1", false)).toEqual([]);
  });
});
