import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_IDS,
  isKnownProvider,
  normalizeShop,
  providerNeedsShop,
  validateProviderConfig,
} from "../src/providers.ts";
import { PROVIDERS } from "../src/playbooks.ts";

test("registry holds all six providers", () => {
  assert.deepEqual([...PROVIDER_IDS].sort(), [
    "github",
    "hubspot",
    "linear",
    "notion",
    "shopify",
    "slack",
  ]);
  assert.equal(isKnownProvider("notion"), true);
  assert.equal(isKnownProvider("nope"), false);
});

test("playbook display meta covers exactly the registry", () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.id).sort(),
    [...PROVIDER_IDS].sort(),
  );
});

test("only shopify needs a shop at connect time", () => {
  assert.equal(providerNeedsShop("shopify"), true);
  for (const p of ["github", "linear", "slack", "hubspot", "notion"]) {
    assert.equal(providerNeedsShop(p), false);
  }
});

test("normalizeShop accepts bare names, domains, and pasted URLs", () => {
  assert.equal(normalizeShop("mystore"), "mystore.myshopify.com");
  assert.equal(
    normalizeShop("mystore.myshopify.com"),
    "mystore.myshopify.com",
  );
  assert.equal(
    normalizeShop("https://mystore.myshopify.com/admin"),
    "mystore.myshopify.com",
  );
  assert.equal(normalizeShop("  My-Store  "), "my-store.myshopify.com");
});

test("normalizeShop rejects anything that is not a store domain", () => {
  for (const bad of [
    "",
    "evil.com",
    "store.myshopify.com.evil.com",
    "myshopify.com",
    "has space.myshopify.com",
    "-lead.myshopify.com",
  ]) {
    assert.equal(normalizeShop(bad), null, bad || "(empty)");
  }
});

test("validateProviderConfig: shopify needs a valid shop", () => {
  assert.deepEqual(validateProviderConfig("shopify", { shop: "s" }), {
    ok: true,
  });
  assert.equal(
    validateProviderConfig("shopify", { shop: "evil.com" }).ok,
    false,
  );
  assert.equal(validateProviderConfig("shopify", {}).ok, false);
});

test("validateProviderConfig: notion needs a page ID", () => {
  const plain = "a".repeat(32);
  const dashed = `${"b".repeat(8)}-${"b".repeat(4)}-${"b".repeat(4)}-${"b".repeat(4)}-${"b".repeat(12)}`;
  assert.deepEqual(
    validateProviderConfig("notion", { parentPageId: plain }),
    { ok: true },
  );
  assert.deepEqual(
    validateProviderConfig("notion", { parentPageId: dashed }),
    { ok: true },
  );
  assert.equal(
    validateProviderConfig("notion", { parentPageId: "short" }).ok,
    false,
  );
  assert.equal(validateProviderConfig("notion", {}).ok, false);
});

test("validateProviderConfig: token-only providers accept anything", () => {
  for (const p of ["github", "linear", "slack", "hubspot"]) {
    assert.deepEqual(validateProviderConfig(p, {}), { ok: true });
  }
  assert.equal(validateProviderConfig("nope", {}).ok, false);
});
