// Squad staffing: which approved seats debate a goal. Pure rules so the
// ≤7 cap and the unapproved-never-debate invariant are unit-tested; the
// manager's judgment call (which 7 of 10) lives in the API as a Spark call.

export const SEAT_ROLES = [
  "pm",
  "marketer",
  "engineer",
  "analyst",
  "designer",
  "qa",
  "researcher",
  "writer",
  "support",
  "ops",
] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];

export const CLASSIC_ROLES: readonly SeatRole[] = [
  "pm",
  "marketer",
  "engineer",
  "analyst",
];

export const MAX_SQUAD = 7;
export const MAX_TEAM_SEATS = 7;

export function isSeatRole(s: string): s is SeatRole {
  return (SEAT_ROLES as readonly string[]).includes(s);
}

/** Approved roster, cleaned: unknown roles dropped, deduped, sorted. */
export function cleanRoster(approved: string[]): SeatRole[] {
  return [...new Set(approved.filter(isSeatRole))].sort();
}

export interface SquadPlan {
  /** Roles eligible to debate. */
  roster: SeatRole[];
  /** True when the roster overflows the squad cap. */
  needsPick: boolean;
  /** The squad when no judgment call is needed. */
  squad: SeatRole[];
}

export function squadPlan(approved: string[]): SquadPlan {
  const roster = cleanRoster(approved);
  if (roster.length <= MAX_SQUAD) {
    return { roster, needsPick: false, squad: roster };
  }
  return { roster, needsPick: true, squad: [] };
}

/**
 * Sanitizes the manager's pick: unknown or unapproved roles dropped,
 * capped at 7, and a deterministic fallback when nothing survives — so
 * no model output can field an illegal squad.
 */
export function sanitizeSquad(
  picked: string[],
  approved: string[],
): SeatRole[] {
  const eligible = new Set(cleanRoster(approved));
  const kept = [...new Set(picked)].filter((r): r is SeatRole =>
    eligible.has(r as SeatRole),
  );
  if (kept.length > 0) return kept.slice(0, MAX_SQUAD);
  return [...eligible].sort().slice(0, MAX_SQUAD);
}
