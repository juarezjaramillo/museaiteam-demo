import test from "node:test";
import assert from "node:assert/strict";
import { Action } from "../src/protocol.ts";

function action(kind) {
  return {
    id: "a1",
    runId: "r1",
    kind,
    target: "t",
    payload: {},
    status: "skipped",
  };
}

test("section-4 action kinds parse on the wire", () => {
  for (const kind of [
    "shopify.create_discount",
    "shopify.delete_discount",
    "hubspot.create_note",
    "hubspot.delete_note",
    "hubspot.triage_ticket",
    "hubspot.restore_ticket",
    "notion.create_page",
    "notion.archive_page",
  ]) {
    assert.equal(Action.parse(action(kind)).kind, kind);
  }
});

test("unknown kinds still fail closed", () => {
  assert.throws(() => Action.parse(action("nope.doit")));
});
