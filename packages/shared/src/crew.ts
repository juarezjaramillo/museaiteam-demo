/**
 * The fixed crew: one named roster for every org. Names surface in
 * threads, digests, and session detail so customers know who did what.
 * ownerFor maps an action kind to the seat whose Limits authorized it,
 * which is the honest author of the act.
 */

export const CREW: Record<string, string> = {
  manager: "Morgan",
  pm: "Sam",
  marketer: "Maya",
  engineer: "Raj",
  analyst: "Priya",
  designer: "Leo",
  qa: "Kim",
  researcher: "Noor",
  writer: "Ana",
  support: "Ben",
  ops: "Omar",
};

export function crewName(role: string): string {
  return CREW[role] ?? role;
}

const ROLE_LABELS: Record<string, string> = {
  pm: "PM",
  qa: "QA",
  manager: "Manager",
  marketer: "Marketer",
  engineer: "Engineer",
  analyst: "Analyst",
  designer: "Designer",
  researcher: "Researcher",
  writer: "Writer",
  support: "Support",
  ops: "Ops",
};

/** Plain-words job title for a seat role; unknown roles capitalize. */
export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? (role.slice(0, 1).toUpperCase() + role.slice(1));
}

/**
 * The hire's tagged name, everywhere a customer reads it: sessions,
 * handoffs, offboarding, the Hires page. The (AI) tag is part of the
 * name, not a call-site choice, so it cannot be forgotten.
 */
export function hireDisplayName(role: string): string {
  return `${CREW[role] ?? role} (AI)`;
}

const OWNER_FOR_SYSTEM: Record<string, string> = {
  github: "engineer",
  linear: "pm",
  slack: "marketer",
  shopify: "marketer",
  hubspot: "analyst",
  notion: "pm",
  mcp: "analyst",
};

/** Seat role that owns an action kind, via the system that ran it. */
export function ownerFor(actionKind: string): string {
  const system = actionKind.split(".")[0] ?? "";
  return OWNER_FOR_SYSTEM[system] ?? "manager";
}
