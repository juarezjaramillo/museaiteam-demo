import test from "node:test";
import assert from "node:assert/strict";
import { buildDigest } from "../src/digest.ts";

const BASE = {
  appUrl: "https://team.example",
  goal: "Lift onboarding activation by 15%",
};

test("digest carries decision, would-have-done list, and CTA", () => {
  const d = buildDigest({
    ...BASE,
    decision: "Ship the checklist",
    decidedBy: "manager",
    skipped: [
      { kind: "github.open_pr", reason: "not_connected" },
      { kind: "notion.create_page", reason: "not_connected" },
    ],
  });
  assert.equal(d.subject, "[AI Team] Ship the checklist");
  assert.ok(d.text.includes(BASE.goal));
  assert.ok(d.text.includes("Decision (manager): Ship the checklist"));
  assert.ok(d.text.includes("- github.open_pr (not_connected)"));
  assert.ok(d.text.includes("- notion.create_page (not_connected)"));
  assert.ok(d.text.includes("See it here: https://team.example"));
});

test("fully-shipped runs say so instead of listing", () => {
  const d = buildDigest({ ...BASE, decision: "Done", skipped: [] });
  assert.ok(d.text.includes("Everything done"));
  assert.ok(!d.text.includes("Would-have-done"));
});

test("missing ruling falls back to the goal", () => {
  const d = buildDigest({ ...BASE, skipped: [] });
  assert.equal(d.subject, `[AI Team] ${BASE.goal}`);
  assert.ok(!d.text.includes("Decision"));
});
