import test from "node:test";
import assert from "node:assert/strict";
import {
  actionLabel,
  approvalKindLabel,
  choiceLabel,
  isHiddenAction,
  isMoneyKind,
  kindLabel,
  modeLabel,
  noticeLabel,
  scheduleLabel,
  sessionTitle,
  shipCount,
  statusLabel,
  targetHref,
} from "../src/words.ts";
import { hasInverse, INVERSE } from "../src/undo.ts";

test("labels map internal values to customer words", () => {
  assert.equal(statusLabel("debating"), "organizing");
  assert.equal(statusLabel("acting"), "working");
  assert.equal(kindLabel("work"), "Work session");
  assert.equal(kindLabel("check"), "Check-in");
  assert.equal(choiceLabel("for"), "agree");
  assert.equal(approvalKindLabel("pre"), "Check first");
  assert.equal(modeLabel("posthoc"), "Review after");
  assert.equal(scheduleLabel("weekly:1"), "Mondays");
  assert.equal(actionLabel("github.open_pr"), "Pull request");
  assert.equal(actionLabel("hubspot.triage_ticket"), "Ticket sort");
  assert.equal(noticeLabel("approval.auto"), "Auto-approved");
});

test("unknown values degrade to readable text, never crash", () => {
  assert.equal(statusLabel("awaiting_approval"), "awaiting approval");
  assert.equal(actionLabel("acme.future_kind"), "acme future kind");
  assert.equal(noticeLabel("weird.event"), "weird event");
});

test("session titles lead with the outcome", () => {
  assert.equal(
    sessionTitle({ kind: "work", goal: "g", outcome: null, top_suggestion: "Won the deal" }),
    "Won the deal",
  );
  assert.equal(
    sessionTitle({ kind: "check", goal: "Check: g", outcome: null, top_suggestion: null }),
    "Check-in",
  );
  assert.equal(shipCount(1), "1 result");
  assert.equal(shipCount(6), "6 results");
});

test("system rows hide; only real links open out", () => {
  assert.equal(isHiddenAction({ status: "skipped", target: "x" }), true);
  assert.equal(isHiddenAction({ status: "done", target: "closeout:1" }), true);
  assert.equal(isHiddenAction({ status: "done", target: "https://x" }), false);
  assert.equal(targetHref("https://x/y"), "https://x/y");
  assert.equal(targetHref("linear:123"), null);
});

test("auto-review safety: every money kind is undoable (so the money block is what stops it)", () => {
  assert.equal(isMoneyKind("shopify.create_discount"), true);
  assert.equal(isMoneyKind("shopify.targeted_discount"), true);
  assert.equal(isMoneyKind("shopify.product_copy"), false);
  assert.equal(isMoneyKind("slack.post_message"), false);
  for (const kind of Object.keys(INVERSE)) {
    assert.equal(hasInverse(kind), true);
  }
  assert.equal(hasInverse("shopify.create_discount"), true);
  assert.equal(hasInverse("acme.future_kind"), false);
});
