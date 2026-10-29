import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ORDER,
  LIVE_PROVIDERS,
  PLAYBOOKS,
  PLAYBOOK_BY_VERTICAL,
  PROVIDERS,
  VERTICALS,
  providerLive,
  providerName,
} from "../src/playbooks.ts";

const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

test("every vertical has exactly one playbook", () => {
  assert.deepEqual(
    Object.keys(PLAYBOOK_BY_VERTICAL).sort(),
    VERTICALS.map((v) => v.id).sort(),
  );
  for (const v of VERTICALS) {
    assert.equal(PLAYBOOK_BY_VERTICAL[v.id].vertical, v.id);
  }
});

test("playbook goals satisfy the API contract (min 8 chars)", () => {
  for (const p of PLAYBOOKS) {
    assert.ok(
      p.goal.trim().length >= 8,
      `${p.id}: goal too short for POST /api/runs`,
    );
  }
});

test("metric fields are well-formed", () => {
  for (const p of PLAYBOOKS) {
    assert.match(p.metricName, /^[a-z][a-z0-9_]*$/);
    assert.ok(Number.isInteger(p.timeboxDays) && p.timeboxDays > 0);
    for (const m of [p.metricBaseline, p.metricTarget]) {
      if (m !== undefined) assert.ok(Number.isFinite(m));
    }
  }
});

test("integration order is flagship first plus every live provider once", () => {
  for (const p of PLAYBOOKS) {
    assert.equal(p.integrationOrder[0], p.flagship);
    assert.ok(
      PROVIDER_IDS.includes(p.flagship),
      `${p.id}: unknown flagship ${p.flagship}`,
    );
    const rest = p.integrationOrder.slice(1);
    const liveRest = LIVE_PROVIDERS.filter((id) => id !== p.flagship);
    assert.deepEqual([...rest].sort(), [...liveRest].sort());
  }
});

test("default order covers every provider, live ones first", () => {
  assert.deepEqual([...DEFAULT_ORDER].sort(), [...PROVIDER_IDS].sort());
  const firstSoon = DEFAULT_ORDER.findIndex((id) => !providerLive(id));
  if (firstSoon >= 0) {
    assert.deepEqual(DEFAULT_ORDER.slice(0, firstSoon), LIVE_PROVIDERS);
  } else {
    assert.deepEqual(DEFAULT_ORDER, LIVE_PROVIDERS);
  }
});

test("provider helpers resolve names and live flags", () => {
  assert.equal(providerName("github"), "GitHub");
  assert.equal(providerName("nope"), "nope");
  assert.equal(providerLive("slack"), true);
  assert.equal(providerLive("shopify"), true);
  assert.equal(providerLive("hubspot"), true);
  assert.equal(providerLive("notion"), true);
});
