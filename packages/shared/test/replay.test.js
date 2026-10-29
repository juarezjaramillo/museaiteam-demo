import test from "node:test";
import assert from "node:assert/strict";
import { replayKeyFor } from "../src/replay.ts";

const base = {
  model: "muse-spark-1.3",
  temperature: 0.5,
  max_tokens: 2000,
  system: "s",
  user: "u",
};

test("same request always yields the same key", async () => {
  assert.equal(await replayKeyFor(base), await replayKeyFor({ ...base }));
});

test("key lives under the replays prefix", async () => {
  assert.ok((await replayKeyFor(base)).startsWith("replays/"));
});

test("any field change yields a different key", async () => {
  const key = await replayKeyFor(base);
  for (const variant of [
    { ...base, temperature: 0.6 },
    { ...base, user: "other" },
    { ...base, max_tokens: 4000 },
    { ...base, model: "other" },
  ]) {
    assert.notEqual(await replayKeyFor(variant), key);
  }
});
