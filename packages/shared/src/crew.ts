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

const OWNER_FOR_SYSTEM: Record<string, string> = {
  github: "engineer",
  linear: "pm",
  slack: "marketer",
  shopify: "marketer",
  hubspot: "analyst",
  notion: "pm",
};

/** Seat role that owns an action kind, via the system that ran it. */
export function ownerFor(actionKind: string): string {
  const system = actionKind.split(".")[0] ?? "";
  return OWNER_FOR_SYSTEM[system] ?? "manager";
}
