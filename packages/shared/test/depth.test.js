import test from "node:test";
import assert from "node:assert/strict";
import {
  digestWeek,
  saneDiscount,
  saneFiles,
  saneSubtasks,
  triagePriority,
  vectorId,
} from "../src/depth.ts";

test("discounts clamp to the playbook", () => {
  assert.deepEqual(saneDiscount({ percent: 50, title: "  Winback  ", startInDays: 99 }), {
    percent: 30,
    title: "Winback",
    startInDays: 30,
  });
  assert.deepEqual(saneDiscount({ percent: 1, startInDays: -2 }), {
    percent: 5,
    title: "AI team offer",
    startInDays: 0,
  });
  assert.deepEqual(saneDiscount({}), { percent: 15, title: "AI team offer", startInDays: 0 });
  assert.deepEqual(saneDiscount({ percent: "huge", title: "", startInDays: NaN }), {
    percent: 15,
    title: "AI team offer",
    startInDays: 0,
  });
});

test("priorities map garbage to medium", () => {
  assert.equal(triagePriority("high"), "HIGH");
  assert.equal(triagePriority("LOW"), "LOW");
  assert.equal(triagePriority("whenever"), "MEDIUM");
  assert.equal(triagePriority(null), "MEDIUM");
});

test("diffs cap files, lines, and traversal", () => {
  const big = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
  const files = saneFiles([
    { path: "src/a.ts", content: "ok" },
    { path: "/src/b.ts", content: big },
    { path: "../evil.ts", content: "x" },
    { path: "empty.ts", content: "  \n " },
    { path: "src/c.ts", content: "ok" },
    { path: "src/d.ts", content: "ok" },
  ]);
  assert.deepEqual(
    files.map((f) => f.path),
    ["src/a.ts", "src/b.ts", "src/c.ts"],
  );
  assert.equal(files[1].content.split("\n").length, 200);
  assert.deepEqual(saneFiles("nope"), []);
});

test("subtasks cap and clean", () => {
  assert.deepEqual(saneSubtasks(["  Ship it  ", "x", "", 42, "Second", "Third", "Fourth", "Fifth", "Sixth"]), [
    "Ship it",
    "Second",
    "Third",
    "Fourth",
    "Fifth",
  ]);
  assert.deepEqual(saneSubtasks(null), []);
});

test("vector ids fit the 64-byte cap and stay stable", () => {
  const org = "966f6f92-f69c-4834-8f1a-e2f868fe8724";
  const id = vectorId(org, `run:${"a".repeat(36)}`, 0);
  assert.equal(id.length <= 64, true, id);
  assert.equal(id.startsWith(`${org}:`), true);
  assert.equal(vectorId(org, "run:x", 3), vectorId(org, "run:x", 3));
  assert.notEqual(vectorId(org, "run:x", 3), vectorId(org, "run:x", 4));
  assert.notEqual(vectorId(org, "run:x", 3), vectorId(org, "run:y", 3));
});

test("digest weeks key Mondays", () => {
  assert.equal(digestWeek(new Date("2026-10-26T12:00:00Z")), "2026-W44");
  assert.equal(digestWeek(new Date("2026-11-01T23:59:59Z")), "2026-W44");
  assert.equal(digestWeek(new Date("2026-11-02T00:00:01Z")), "2026-W45");
});
