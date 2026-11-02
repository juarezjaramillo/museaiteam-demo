import test from "node:test";
import assert from "node:assert/strict";
import { SUPPORT_BRIEF_TEMPLATE, SUPPORT_METRIC } from "../src/briefs.ts";

test("support template covers queue, VIPs, and holds", () => {
  assert.ok(SUPPORT_BRIEF_TEMPLATE.includes("queue"));
  assert.ok(SUPPORT_BRIEF_TEMPLATE.includes("VIP"));
  assert.ok(SUPPORT_BRIEF_TEMPLATE.includes("Hold"));
});

test("support metric is first-reply time, manual for now", () => {
  assert.equal(SUPPORT_METRIC.name, "first reply (minutes)");
  assert.equal(SUPPORT_METRIC.source, "manual");
});
