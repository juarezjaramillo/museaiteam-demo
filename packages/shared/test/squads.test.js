import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIC_ROLES,
  MAX_SQUAD,
  SEAT_ROLES,
  cleanRoster,
  isSeatRole,
  sanitizeSquad,
  squadPlan,
} from "../src/squads.ts";

test("ten seat roles plus the manager's judgment, classics first", () => {
  assert.equal(SEAT_ROLES.length, 10);
  assert.ok(!SEAT_ROLES.includes("manager"));
  for (const r of CLASSIC_ROLES) assert.ok(isSeatRole(r));
  assert.equal(isSeatRole("manager"), false);
  assert.equal(isSeatRole("nope"), false);
});

test("roster cleaning drops unknown and duplicate roles", () => {
  assert.deepEqual(cleanRoster(["pm", "nope", "pm", "engineer"]), [
    "engineer",
    "pm",
  ]);
});

test("rosters of seven or fewer field everybody, no pick needed", () => {
  const p = squadPlan(["pm", "marketer", "engineer", "analyst"]);
  assert.equal(p.needsPick, false);
  assert.deepEqual(p.squad, ["analyst", "engineer", "marketer", "pm"]);
  const seven = squadPlan([...SEAT_ROLES].slice(0, 7));
  assert.equal(seven.needsPick, false);
  assert.equal(seven.squad.length, 7);
});

test("eight or more approved seats need the manager's pick", () => {
  const p = squadPlan([...SEAT_ROLES].slice(0, 8));
  assert.equal(p.needsPick, true);
  assert.deepEqual(p.squad, []);
});

test("sanitize keeps approved picks in order, capped at seven", () => {
  const approved = [...SEAT_ROLES];
  assert.deepEqual(sanitizeSquad(["ops", "pm", "pm"], approved), ["ops", "pm"]);
  assert.equal(sanitizeSquad(approved, approved).length, MAX_SQUAD);
});

test("sanitize drops unapproved and unknown roles", () => {
  const out = sanitizeSquad(
    ["pm", "designer", "nope", "manager"],
    ["pm", "engineer"],
  );
  assert.deepEqual(out, ["pm"]);
});

test("empty survival falls back to the first approved roles", () => {
  const out = sanitizeSquad(["nope"], ["qa", "pm", "engineer"]);
  assert.deepEqual(out, ["engineer", "pm", "qa"]);
});
