import test from "node:test";
import assert from "node:assert/strict";
import { VisionCheck, scaleBox } from "../src/vision.ts";

test("scaleBox converts the 0-1000 grid to pixels", () => {
  assert.deepEqual(scaleBox([0, 0, 1000, 1000], 520, 640), {
    x: 0,
    y: 0,
    width: 520,
    height: 640,
  });
  assert.deepEqual(scaleBox([250, 0, 750, 1000], 100, 200), {
    x: 25,
    y: 0,
    width: 50,
    height: 200,
  });
  assert.deepEqual(scaleBox([100, 200, 300, 400], 1000, 500), {
    x: 100,
    y: 100,
    width: 200,
    height: 100,
  });
});

test("VisionCheck parses a full read-back, rejects a bad box", () => {
  const ok = VisionCheck.parse({
    checks: [{ fact: "brand", found: true, read: "TRES CUMBRES", box: [1, 2, 3, 4] }],
    brandVisible: true,
    textErrors: [],
    pass: true,
  });
  assert.equal(ok.checks.length, 1);
  assert.throws(() =>
    VisionCheck.parse({
      checks: [{ fact: "brand", found: true, read: "x", box: [1, 2, 3] }],
      brandVisible: true,
      textErrors: [],
      pass: true,
    })
  );
});
