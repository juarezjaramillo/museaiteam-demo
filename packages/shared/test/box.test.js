import test from "node:test";
import assert from "node:assert/strict";
import { boxCostCents, firstUrl } from "../src/box.ts";

test("box cost rounds up to the started hour, unknown type falls back", () => {
  assert.equal(boxCostCents(60, "basic"), 6);
  assert.equal(boxCostCents(3600, "basic"), 6);
  assert.equal(boxCostCents(3601, "basic"), 12);
  assert.equal(boxCostCents(60, "mystery"), boxCostCents(60, "basic"));
});

test("firstUrl finds the accept link and trims trailing punctuation", () => {
  assert.equal(firstUrl("hi https://x.test/a?b=1, bye"), "https://x.test/a?b=1");
  assert.equal(firstUrl("no link"), null);
});
