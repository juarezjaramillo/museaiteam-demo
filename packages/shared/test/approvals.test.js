import test from "node:test";
import assert from "node:assert/strict";
import {
  gateVerdict,
  isOrgRole,
  MAX_RESUBMITS,
  mayDecideApproval,
  nextAttempt,
  resubmitOutcome,
} from "../src/approvals.ts";

test("roles: owner and approver decide, viewer watches, stranger nothing", () => {
  assert.equal(isOrgRole("owner"), true);
  assert.equal(isOrgRole("approver"), true);
  assert.equal(isOrgRole("viewer"), true);
  assert.equal(isOrgRole("admin"), false);
  assert.equal(mayDecideApproval("owner"), true);
  assert.equal(mayDecideApproval("approver"), true);
  assert.equal(mayDecideApproval("viewer"), false);
  assert.equal(mayDecideApproval(null), false);
  assert.equal(mayDecideApproval("admin"), false);
});

test("resubmit bound: three re-rules, then the run fails", () => {
  assert.equal(MAX_RESUBMITS, 3);
  assert.equal(resubmitOutcome(0), "rerule");
  assert.equal(resubmitOutcome(1), "rerule");
  assert.equal(resubmitOutcome(2), "rerule");
  assert.equal(resubmitOutcome(3), "fail");
  assert.equal(resubmitOutcome(99), "fail");
});

test("attempts derive from rejection count", () => {
  assert.equal(nextAttempt(0), 1);
  assert.equal(nextAttempt(2), 3);
});

test("gate: post-hoc always proceeds", () => {
  assert.equal(
    gateVerdict({ approvalMode: "posthoc", rulingAttempt: 1, approvedAttempt: null }),
    "proceed",
  );
  assert.equal(
    gateVerdict({ approvalMode: "posthoc", rulingAttempt: null, approvedAttempt: null }),
    "proceed",
  );
});

test("gate: pre-approve pauses until the current attempt is blessed", () => {
  const mode = "preapprove";
  assert.equal(
    gateVerdict({ approvalMode: mode, rulingAttempt: 1, approvedAttempt: null }),
    "pause",
  );
  assert.equal(
    gateVerdict({ approvalMode: mode, rulingAttempt: 2, approvedAttempt: 1 }),
    "pause",
  );
  assert.equal(
    gateVerdict({ approvalMode: mode, rulingAttempt: 2, approvedAttempt: 2 }),
    "proceed",
  );
  assert.equal(
    gateVerdict({ approvalMode: mode, rulingAttempt: null, approvedAttempt: null }),
    "proceed",
  );
});
