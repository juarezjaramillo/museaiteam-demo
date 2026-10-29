// Trial clock: pure decision logic shared by the API gate and the banner.
// Timestamps are epoch millis (INTEGER in D1) so there is no date parsing
// anywhere — the timezone/format class of error cannot occur.

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;
export const DAY_MS = 86_400_000;
const TRIAL_MS = TRIAL_DAYS * DAY_MS;
const GRACE_MS = GRACE_DAYS * DAY_MS;

export interface TrialRow {
  trial_started_at: number;
  trial_ends_at: number;
  /** 0 | 1 in D1 */
  grace_used: number;
  /** 0 | 1 in D1 */
  subscribed: number;
}

export type TrialState = "active" | "trial" | "grace" | "expired";

export interface TrialStatus {
  state: TrialState;
  /** Whole days left, rounded up; null while subscribed. */
  daysLeft: number | null;
  endsAt: number;
  graceUsed: boolean;
  subscribed: boolean;
}

export function trialStatus(now: number, row: TrialRow): TrialStatus {
  const status = {
    endsAt: row.trial_ends_at,
    graceUsed: row.grace_used === 1,
    subscribed: row.subscribed === 1,
  };
  if (row.subscribed === 1) return { ...status, state: "active", daysLeft: null };
  if (now < row.trial_ends_at) {
    return {
      ...status,
      state: row.grace_used === 1 ? "grace" : "trial",
      daysLeft: Math.ceil((row.trial_ends_at - now) / DAY_MS),
    };
  }
  return { ...status, state: "expired", daysLeft: 0 };
}

export type TrialDecision = "allow" | "grant_grace" | "deny";

/** Single enforcement rule: subscribed and in-window pass; the first
 *  expired attempt earns grace; everything after denies. */
export function trialDecision(now: number, row: TrialRow): TrialDecision {
  if (row.subscribed === 1 || now < row.trial_ends_at) return "allow";
  return row.grace_used === 1 ? "deny" : "grant_grace";
}

/** Fresh trial window starting now (for inserts that set it explicitly). */
export function trialWindow(now: number): { startedAt: number; endsAt: number } {
  return { startedAt: now, endsAt: now + TRIAL_MS };
}

/** Grace always extends from the granting attempt, never the old expiry. */
export function graceEndsAt(now: number): number {
  return now + GRACE_MS;
}
