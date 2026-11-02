import test from "node:test";
import assert from "node:assert/strict";
import { encodeWav } from "../src/wav.ts";

async function bytes(blob) {
  return new DataView(await blob.arrayBuffer());
}

function ascii(v, off, len) {
  return String.fromCharCode(...new Uint8Array(v.buffer, off, len));
}

test("encodeWav writes a mono 16-bit PCM header", async () => {
  const v = await bytes(encodeWav(new Float32Array([0, 0.5, -0.5]), 24000));
  assert.equal(ascii(v, 0, 4), "RIFF");
  assert.equal(v.getUint32(4, true), 36 + 6);
  assert.equal(ascii(v, 8, 4), "WAVE");
  assert.equal(ascii(v, 12, 4), "fmt ");
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 24000);
  assert.equal(v.getUint32(28, true), 48000);
  assert.equal(v.getUint16(32, true), 2);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(ascii(v, 36, 4), "data");
  assert.equal(v.getUint32(40, true), 6);
  assert.equal(v.byteLength, 44 + 6);
  assert.equal(v.getInt16(44, true), 0);
  assert.equal(v.getInt16(46, true), 16384);
  assert.equal(v.getInt16(48, true), -16384);
});

test("encodeWav clamps out-of-range samples", async () => {
  const v = await bytes(encodeWav(new Float32Array([2, -2]), 24000));
  assert.equal(v.getInt16(44, true), 32767);
  assert.equal(v.getInt16(46, true), -32768);
});
