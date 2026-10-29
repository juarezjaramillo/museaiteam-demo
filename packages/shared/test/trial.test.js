import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY_MS,
  graceEndsAt,
  trialDecision,
  trialStatus,
  trialWindow,
  TRIAL_DAYS,
  GRACE_DAYS,
} from "../src/trial.ts";

const NOW = 1_750_000_000_000;

function row(over) {
  return {
    trial_started_at: NOW - 3 * DAY_MS,
    trial_ends_at: NOW + TRIAL_DAYS * DAY_MS,
    grace_used: 0,
    subscribed: 0,
    ...over,
  };
}

test("fresh org: allow, trial state, 14 days left", () => {
  const w = trialWindow(NOW);
  assert.equal(w.endsAt - w.startedAt, TRIAL_DAYS * DAY_MS);
  const r = row({ trial_started_at: w.startedAt, trial_ends_at: w.endsAt });
  assert.equal(trialDecision(NOW, r), "allow");
  assert.deepEqual(trialStatus(NOW, r), {
    state: "trial",
    daysLeft: 14,
    endsAt: w.endsAt,
    graceUsed: false,
    subscribed: false,
  });
});

test("partial days round up", () => {
  const r = row({ trial_ends_at: NOW + 3.2 * DAY_MS });
  assert.equal(trialStatus(NOW, r).daysLeft, 4);
  const lastHour = row({ trial_ends_at: NOW + 3_600_000 });
  assert.equal(trialStatus(NOW, lastHour).daysLeft, 1);
});

test("exact expiry boundary denies the window but earns grace", () => {
  const r = row({ trial_ends_at: NOW });
  assert.equal(trialDecision(NOW, r), "grant_grace");
  assert.equal(trialStatus(NOW, r).state, "expired");
  assert.equal(trialStatus(NOW, r).daysLeft, 0);
});

test("expired without grace: grant_grace once", () => {
  const r = row({ trial_ends_at: NOW - 1000, grace_used: 0 });
  assert.equal(trialDecision(NOW, r), "grant_grace");
});

test("expired with grace used: deny", () => {
  const r = row({ trial_ends_at: NOW - 1000, grace_used: 1 });
  assert.equal(trialDecision(NOW, r), "deny");
  assert.deepEqual(trialStatus(NOW, r).state, "expired");
});

test("grace extends 7 days from the granting attempt", () => {
  assert.equal(graceEndsAt(NOW), NOW + GRACE_DAYS * DAY_MS);
  const r = row({ trial_ends_at: graceEndsAt(NOW), grace_used: 1 });
  assert.equal(trialDecision(NOW, r), "allow");
  const s = trialStatus(NOW, r);
  assert.equal(s.state, "grace");
  assert.equal(s.daysLeft, 7);
  assert.equal(s.graceUsed, true);
});

test("subscribed bypasses even a long-expired trial", () => {
  const r = row({
    trial_ends_at: NOW - 365 * DAY_MS,
    grace_used: 1,
    subscribed: 1,
  });
  assert.equal(trialDecision(NOW, r), "allow");
  assert.deepEqual(trialStatus(NOW, r), {
    state: "active",
    daysLeft: null,
    endsAt: r.trial_ends_at,
    graceUsed: true,
    subscribed: true,
  });
});

test("in-window subscribed org also reports active", () => {
  const r = row({ subscribed: 1 });
  assert.equal(trialStatus(NOW, r).state, "active");
});
