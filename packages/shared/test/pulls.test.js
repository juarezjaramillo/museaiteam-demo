import test from "node:test";
import assert from "node:assert/strict";
import {
  isMetricSource,
  isPullId,
  metricPreset,
  PULL_CATALOG,
} from "../src/pulls.ts";

test("catalog covers all six providers", () => {
  const providers = new Set(Object.values(PULL_CATALOG).map((e) => e.provider));
  for (const p of ["shopify", "hubspot", "github", "linear", "slack", "notion"]) {
    assert.equal(providers.has(p), true, p);
  }
  assert.equal(isPullId("github.open_prs"), true);
  assert.equal(isPullId("github.stars"), false);
  assert.equal(isMetricSource("manual"), true);
  assert.equal(isMetricSource("slack.messages_7d"), true);
  assert.equal(isMetricSource("bogus"), false);
});

test("presets guess the pull, unknown stays manual", () => {
  assert.equal(metricPreset("Revenue"), "shopify.revenue");
  assert.equal(metricPreset("weekly orders"), "shopify.orders");
  assert.equal(metricPreset("Open support tickets"), "hubspot.open_tickets");
  assert.equal(metricPreset("open PRs"), "github.open_prs");
  assert.equal(metricPreset("open bugs"), "linear.open_issues");
  assert.equal(metricPreset("slack messages"), "slack.messages_7d");
  assert.equal(metricPreset("docs shipped"), "notion.pages_7d");
  assert.equal(metricPreset("activation rate"), "manual");
  assert.equal(metricPreset("NPS"), "manual");
  assert.equal(metricPreset(null), "manual");
  assert.equal(metricPreset(""), "manual");
});
