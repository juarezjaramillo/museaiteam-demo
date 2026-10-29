// Goal schedule math. Pure (UTC, timestamps in, booleans out) so the cron
// due-rules are unit-tested; the API only supplies stored timestamps.
//
// Schedules: manual (never), daily, weekdays (Mon–Fri), weekly:<0-6>
// (Sunday=0, matching Date.getUTCDay).

export const GOAL_STATUSES = ["active", "paused", "overdue", "done"] as const;
export const APPROVAL_MODES = ["posthoc", "preapprove"] as const;
export const RUN_KINDS = ["work", "check", "revision"] as const;

export function isSchedule(s: string): boolean {
  if (s === "manual" || s === "daily" || s === "weekdays") return true;
  const m = /^weekly:([0-6])$/.exec(s);
  return m !== null;
}

export function isApprovalMode(s: string): boolean {
  return (APPROVAL_MODES as readonly string[]).includes(s);
}

export function isGoalStatus(s: string): boolean {
  return (GOAL_STATUSES as readonly string[]).includes(s);
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Most recent scheduled tick strictly before `now` (null when manual). */
export function lastTickBefore(schedule: string, nowMs: number): number | null {
  const day = 86_400_000;
  const today = startOfUtcDay(nowMs);
  if (schedule === "daily") return today;
  if (schedule === "weekdays") {
    const dow = new Date(nowMs).getUTCDay();
    if (dow === 0) return today - 2 * day; // Sunday -> Friday
    if (dow === 6) return today - day; // Saturday -> Friday
    return today;
  }
  const m = /^weekly:([0-6])$/.exec(schedule);
  if (m) {
    const want = Number(m[1]);
    const dow = new Date(nowMs).getUTCDay();
    return today - (((dow - want + 7) % 7) * day);
  }
  return null;
}

/**
 * A goal is due when its latest tick is newer than its last check.
 * Never-checked goals are due immediately (except manual ones).
 */
export function isGoalDue(
  schedule: string,
  lastCheckAtMs: number | null,
  nowMs: number,
): boolean {
  const tick = lastTickBefore(schedule, nowMs);
  if (tick === null) return false;
  if (lastCheckAtMs === null) return true;
  return lastCheckAtMs < tick;
}

/** Deadline is YYYY-MM-DD; overdue starts the day after, UTC. */
export function isOverdue(deadline: string | null, nowMs: number): boolean {
  if (!deadline || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return false;
  return deadline < new Date(nowMs).toISOString().slice(0, 10);
}
