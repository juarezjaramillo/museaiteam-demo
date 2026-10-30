import test from "node:test";
import assert from "node:assert/strict";
import { signState, verifyState } from "../src/oauth-state.ts";

test("sign/verify round-trips the org", async () => {
  const state = await signState("s3cret", "demo");
  assert.deepEqual(await verifyState("s3cret", state), {
    org: "demo",
    shop: null,
    seat: null,
  });
});

test("sign/verify round-trips an optional shop", async () => {
  const state = await signState("s3cret", "demo", 600, "store.myshopify.com");
  assert.deepEqual(await verifyState("s3cret", state), {
    org: "demo",
    shop: "store.myshopify.com",
    seat: null,
  });
});

test("sign/verify round-trips an optional hire seat", async () => {
  const state = await signState("s3cret", "demo", 600, undefined, "seat1");
  assert.deepEqual(await verifyState("s3cret", state), {
    org: "demo",
    shop: null,
    seat: "seat1",
  });
});

test("wrong secret fails closed", async () => {
  const state = await signState("s3cret", "demo");
  await assert.rejects(() => verifyState("other", state));
});

test("tampered state fails closed", async () => {
  const state = await signState("s3cret", "demo");
  const [payload, sig] = state.split(".");
  const bad = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${sig}`;
  await assert.rejects(() => verifyState("s3cret", bad));
});

test("expired state fails closed", async () => {
  const state = await signState("s3cret", "demo", -1);
  await assert.rejects(() => verifyState("s3cret", state));
});

test("malformed state fails closed", async () => {
  await assert.rejects(() => verifyState("s3cret", "no-dot-here"));
});
