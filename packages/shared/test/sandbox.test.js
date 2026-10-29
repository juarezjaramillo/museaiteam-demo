import test from "node:test";
import assert from "node:assert/strict";
import {
  SANDBOX_DAILY_LIMIT,
  SANDBOX_PRESETS,
  SANDBOX_SEATS,
  sandboxPreset,
} from "../src/sandbox.ts";
import { SEAT_ROLES } from "../src/squads.ts";

test("sandbox seats track SEAT_ROLES", () => {
  assert.deepEqual([...SANDBOX_SEATS].sort(), [...SEAT_ROLES].sort());
});

test("three vertical presets with valid squads", () => {
  assert.equal(SANDBOX_PRESETS.length, 3);
  for (const p of ["saas", "ecom", "smb"]) {
    const preset = sandboxPreset(p);
    assert.equal(preset?.id, p);
    assert.equal(preset.squad.includes("manager"), false);
    assert.equal(preset.squad.length >= 2, true);
    assert.equal(preset.goal.length > 20, true);
  }
  assert.equal(sandboxPreset("bogus"), undefined);
  assert.equal(SANDBOX_DAILY_LIMIT > 0, true);
});
