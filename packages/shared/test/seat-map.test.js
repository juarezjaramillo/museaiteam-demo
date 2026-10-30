import test from "node:test";
import assert from "node:assert/strict";
import { KEYSTONE_SEAT, SEAT_MAP_DEFAULT, SEAT_MAP_ROLES, isSeatMapRole, paidTools, seatPrice } from "../src/seat-map.ts";

test("every role maps tools with a keystone in the map", () => {
  for (const [role, tools] of Object.entries(SEAT_MAP_DEFAULT)) {
    assert.ok(tools.length >= 1, role);
    assert.ok(tools.includes(KEYSTONE_SEAT[role]), `${role} keystone`);
  }
});

test("role list is exactly the map keys, manager included", () => {
  assert.deepEqual([...SEAT_MAP_ROLES].sort(), Object.keys(SEAT_MAP_DEFAULT).sort());
  assert.equal(isSeatMapRole("manager"), true);
  assert.equal(isSeatMapRole("janitor"), false);
});

test("prices flag paid seats, unknown warns", () => {
  assert.equal(seatPrice("github").paid, true);
  assert.equal(seatPrice("mcp:context7").paid, false);
  assert.equal(seatPrice("mystery-tool").paid, true);
  assert.deepEqual(paidTools(["github", "mcp:context7"]), ["github"]);
});
