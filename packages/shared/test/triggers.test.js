import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTrigger, isTriggerStale } from "../src/triggers.ts";

const day = 24 * 3600 * 1000;
const base = Date.parse("2026-10-01T00:00:00Z");
const pts = (values, stepDays = 1) =>
  values.map((value, i) => ({
    ts: new Date(base + i * stepDays * day).toISOString(),
    value,
  }));

test("fires on a real move off the median", () => {
  const up = evaluateTrigger(pts([100, 102, 98, 101, 120]));
  assert.equal(up.fired, true);
  assert.match(up.reason, /up 19% \(was 101, now 120\)/);
  const down = evaluateTrigger(pts([100, 102, 98, 101, 80]));
  assert.equal(down.fired, true);
  assert.match(down.reason, /down/);
});

test("fires moving off zero", () => {
  const r = evaluateTrigger(pts([0, 0, 0, 0, 3]));
  assert.equal(r.fired, true);
  assert.match(r.reason, /off zero/);
});

test("ignores jitter under 10%", () => {
  assert.equal(evaluateTrigger(pts([100, 102, 98, 101, 105])).fired, false);
  assert.equal(evaluateTrigger(pts([100, 100, 100])).fired, false);
});

test("fires when flat across 5 points and 48h", () => {
  const r = evaluateTrigger(pts([7, 7, 7, 7, 7]));
  assert.equal(r.fired, true);
  assert.match(r.reason, /flat at 7/);
});

test("needs points and quiet feeds flag stale", () => {
  assert.equal(evaluateTrigger(pts([5, 6])).fired, false);
  assert.equal(isTriggerStale([], base), true);
  assert.equal(isTriggerStale(pts([1, 2, 3]), base + 3 * day), false);
  assert.equal(isTriggerStale(pts([1, 2, 3]), base + 30 * day), true);
});
