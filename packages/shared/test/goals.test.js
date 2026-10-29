import test from "node:test";
import assert from "node:assert/strict";
import {
  isApprovalMode,
  isGoalDue,
  isGoalStatus,
  isOverdue,
  isSchedule,
  lastTickBefore,
} from "../src/goals.ts";

// Wednesday 2026-10-28 12:00 UTC.
const WED = Date.UTC(2026, 9, 28, 12, 0, 0);

test("schedule validation accepts presets, rejects garbage", () => {
  for (const s of ["manual", "daily", "weekdays", "weekly:0", "weekly:6"]) {
    assert.equal(isSchedule(s), true, s);
  }
  for (const s of ["", "hourly", "weekly:7", "weekly:mon", "Weekly:1"]) {
    assert.equal(isSchedule(s), false, s);
  }
  assert.equal(isApprovalMode("preapprove"), true);
  assert.equal(isApprovalMode("auto"), false);
  assert.equal(isGoalStatus("overdue"), true);
  assert.equal(isGoalStatus("archived"), false);
});

test("manual goals never tick", () => {
  assert.equal(lastTickBefore("manual", WED), null);
  assert.equal(isGoalDue("manual", null, WED), false);
});

test("daily goals tick at UTC midnight", () => {
  assert.equal(lastTickBefore("daily", WED), Date.UTC(2026, 9, 28));
  assert.equal(isGoalDue("daily", null, WED), true);
  assert.equal(isGoalDue("daily", Date.UTC(2026, 9, 28, 1), WED), false);
  assert.equal(isGoalDue("daily", Date.UTC(2026, 9, 27, 23), WED), true);
});

test("weekday goals skip weekends", () => {
  const sat = Date.UTC(2026, 9, 31, 12);
  assert.equal(lastTickBefore("weekdays", sat), Date.UTC(2026, 9, 30));
  assert.equal(isGoalDue("weekdays", Date.UTC(2026, 9, 30, 8), sat), false);
  assert.equal(isGoalDue("weekdays", Date.UTC(2026, 9, 29, 8), sat), true);
});

test("weekly goals tick on their weekday", () => {
  assert.equal(lastTickBefore("weekly:3", WED), Date.UTC(2026, 9, 28));
  assert.equal(lastTickBefore("weekly:1", WED), Date.UTC(2026, 9, 26));
  assert.equal(isGoalDue("weekly:1", Date.UTC(2026, 9, 26, 9), WED), false);
  assert.equal(isGoalDue("weekly:1", Date.UTC(2026, 9, 19, 9), WED), true);
});

test("overdue starts the day after the deadline", () => {
  assert.equal(isOverdue("2026-10-28", WED), false);
  assert.equal(isOverdue("2026-10-27", WED), true);
  assert.equal(isOverdue("2026-10-29", WED), false);
  assert.equal(isOverdue(null, WED), false);
  assert.equal(isOverdue("tomorrow", WED), false);
});
