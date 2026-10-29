import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../src/chunks.ts";

test("short text yields one chunk with source and ordinal", () => {
  const out = chunkText("s", "hello\nworld");
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "s");
  assert.equal(out[0].ordinal, 0);
  assert.ok(out[0].text.includes("hello"));
});

test("long text splits into sequential ordinals", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const out = chunkText("s", text, 200, 20);
  assert.ok(out.length > 1);
  assert.deepEqual(
    out.map((c) => c.ordinal),
    out.map((_, i) => i),
  );
});

test("every line appears in at least one chunk", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `unique-line-${i}`);
  const out = chunkText("s", lines.join("\n"), 200, 40);
  const joined = out.map((c) => c.text).join("\n");
  for (const line of lines) {
    assert.ok(joined.includes(line), `missing ${line}`);
  }
});

test("chunks stay near the size budget", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const out = chunkText("s", text, 200, 20);
  for (const c of out) {
    assert.ok(c.text.length < 400, `oversized chunk: ${c.text.length}`);
  }
});
