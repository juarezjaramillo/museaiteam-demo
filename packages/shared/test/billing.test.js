import test from "node:test";
import assert from "node:assert/strict";
import {
  FAIR_USE_TOKENS_PER_WORKER,
  allowanceFor,
  buildUpgradeEmail,
  fairUseBand,
  isThrottled,
  perWorker,
  runsAllowedToday,
  verifyStripeSignature,
} from "../src/billing.ts";

const NOW = 1_750_000_000;

async function sign(payload, t, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${t}.${payload}`),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

test("allowance scales with roster, minimum one worker", () => {
  assert.equal(allowanceFor(4), 4 * FAIR_USE_TOKENS_PER_WORKER);
  assert.equal(allowanceFor(0), FAIR_USE_TOKENS_PER_WORKER);
  assert.equal(perWorker(100_000_000, 4), 25_000_000);
});

test("throttle trips only above the allowance", () => {
  assert.equal(isThrottled(100_000_000, 4), false);
  assert.equal(isThrottled(100_000_001, 4), true);
});

test("watch band starts at 80 percent", () => {
  assert.equal(fairUseBand(79_999_999, 4), "ok");
  assert.equal(fairUseBand(80_000_000, 4), "watch");
  assert.equal(fairUseBand(100_000_000, 4), "watch");
  assert.equal(fairUseBand(100_000_001, 4), "throttled");
});

test("throttled orgs get exactly one run per day", () => {
  assert.equal(runsAllowedToday(false, 99), true);
  assert.equal(runsAllowedToday(true, 0), true);
  assert.equal(runsAllowedToday(true, 1), false);
});

test("valid Stripe signature passes", async () => {
  const payload = '{"id":"evt_1"}';
  const v1 = await sign(payload, NOW, "whsec_x");
  assert.equal(await verifyStripeSignature(payload, `t=${NOW},v1=${v1}`, "whsec_x", NOW), true);
});

test("tampered payload, wrong secret, and stale timestamps fail", async () => {
  const payload = '{"id":"evt_1"}';
  const v1 = await sign(payload, NOW, "whsec_x");
  const header = `t=${NOW},v1=${v1}`;
  assert.equal(await verifyStripeSignature('{"id":"evt_2"}', header, "whsec_x", NOW), false);
  assert.equal(await verifyStripeSignature(payload, header, "whsec_y", NOW), false);
  assert.equal(await verifyStripeSignature(payload, header, "whsec_x", NOW + 301), false);
  assert.equal(await verifyStripeSignature(payload, "garbage", "whsec_x", NOW), false);
  assert.equal(await verifyStripeSignature(payload, `t=${NOW},v1=${"0".repeat(64)}`, "whsec_x", NOW), false);
});

test("upgrade email names usage, cap, and billing link", () => {
  const e = buildUpgradeEmail({
    appUrl: "https://team.example",
    totalTokens: 100_000_001,
    seats: 4,
  });
  assert.ok(e.subject.includes("slowed"));
  assert.ok(e.text.includes("100,000,001"));
  assert.ok(e.text.includes("25M words each"));
  assert.ok(e.text.includes("Manage billing: https://team.example"));
});
