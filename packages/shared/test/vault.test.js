import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptFromB64,
  encryptToB64,
  keyFromHex,
} from "../src/vault.ts";

const KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("encrypt/decrypt round-trips", async () => {
  const key = keyFromHex(KEY);
  assert.equal(await decryptFromB64(key, await encryptToB64(key, "tok_123")), "tok_123");
});

test("same plaintext encrypts differently each time", async () => {
  const key = keyFromHex(KEY);
  assert.notEqual(
    await encryptToB64(key, "same"),
    await encryptToB64(key, "same"),
  );
});

test("tampered payload fails closed", async () => {
  const key = keyFromHex(KEY);
  const ct = await encryptToB64(key, "secret");
  const tampered = ct.slice(0, -2) + (ct.endsWith("AA") ? "BB" : "AA");
  await assert.rejects(() => decryptFromB64(key, tampered));
});

test("wrong key fails closed", async () => {
  const ct = await encryptToB64(keyFromHex(KEY), "secret");
  const other = keyFromHex(
    "ff23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  await assert.rejects(() => decryptFromB64(other, ct));
});

test("non-hex key rejected", () => {
  assert.throws(() => keyFromHex("not-hex!!"));
});
