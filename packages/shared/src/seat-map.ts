import type { AgentRole } from "./protocol.ts";

/**
 * Default seat map: which tools each role gets. Tools are provider ids
 * (`github`), `mcp:<catalogId>` refs, or browser-only ids (`figma`,
 * `intercom`) with no bespoke client. Owners override per org.
 */
export const SEAT_MAP_DEFAULT: Record<AgentRole, string[]> = {
  manager: ["linear", "slack"],
  engineer: ["github", "mcp:context7"],
  pm: ["linear", "github"],
  marketer: ["hubspot", "slack"],
  analyst: ["notion", "mcp:posthog"],
  designer: ["figma"],
  qa: ["linear", "github"],
  researcher: ["notion", "mcp:context7"],
  writer: ["notion", "mcp:context7"],
  support: ["intercom", "slack"],
  ops: ["stripe", "mcp:supabase"],
};

/** The one seat that unlocks session one for each role. */
/** Roles the seat map knows: exactly the default map's keys, never a second list. */
export const SEAT_MAP_ROLES = Object.keys(SEAT_MAP_DEFAULT) as AgentRole[];

export function isSeatMapRole(s: string): s is AgentRole {
  return (SEAT_MAP_ROLES as readonly string[]).includes(s);
}

export const KEYSTONE_SEAT: Record<AgentRole, string> = {
  manager: "linear",
  engineer: "github",
  pm: "linear",
  marketer: "hubspot",
  analyst: "notion",
  designer: "figma",
  qa: "linear",
  researcher: "notion",
  writer: "notion",
  support: "intercom",
  ops: "stripe",
};

export interface SeatPrice {
  /** True when a seat typically costs vendor money. */
  paid: boolean;
  pricingUrl: string | null;
}

/**
 * Seat cost knowledge. Deliberately coarse (paid flag + vendor page):
 * exact prices decay, the flag doesn't.
 */
export const SEAT_PRICES: Record<string, SeatPrice> = {
  github: { paid: true, pricingUrl: "https://github.com/pricing" },
  linear: { paid: true, pricingUrl: "https://linear.app/pricing" },
  slack: { paid: true, pricingUrl: "https://slack.com/pricing" },
  shopify: { paid: true, pricingUrl: "https://www.shopify.com/pricing" },
  hubspot: { paid: false, pricingUrl: "https://www.hubspot.com/pricing" },
  notion: { paid: true, pricingUrl: "https://www.notion.so/pricing" },
  figma: { paid: true, pricingUrl: "https://www.figma.com/pricing" },
  intercom: { paid: true, pricingUrl: "https://www.intercom.com/pricing" },
  stripe: { paid: false, pricingUrl: "https://stripe.com/pricing" },
  paypal: { paid: false, pricingUrl: null },
  atlassian: { paid: true, pricingUrl: "https://www.atlassian.com/software/jira/pricing" },
  "mcp:outagedeck": { paid: false, pricingUrl: null },
  "mcp:context7": { paid: false, pricingUrl: null },
  "mcp:linear": { paid: true, pricingUrl: "https://linear.app/pricing" },
  "mcp:github": { paid: true, pricingUrl: "https://github.com/pricing" },
  "mcp:notion": { paid: true, pricingUrl: "https://www.notion.so/pricing" },
  "mcp:stripe": { paid: false, pricingUrl: "https://stripe.com/pricing" },
  "mcp:shopify": { paid: true, pricingUrl: "https://www.shopify.com/pricing" },
  "mcp:slack": { paid: true, pricingUrl: "https://slack.com/pricing" },
  "mcp:resend": { paid: false, pricingUrl: "https://resend.com/pricing" },
  "mcp:posthog": { paid: false, pricingUrl: "https://posthog.com/pricing" },
  "mcp:zapier": { paid: false, pricingUrl: "https://zapier.com/pricing" },
  "mcp:sentry": { paid: false, pricingUrl: "https://sentry.io/pricing" },
  "mcp:supabase": { paid: false, pricingUrl: "https://supabase.com/pricing" },
  "mcp:atlassian": { paid: true, pricingUrl: "https://www.atlassian.com/software/jira/pricing" },
};

export function seatPrice(tool: string): SeatPrice {
  return SEAT_PRICES[tool] ?? { paid: true, pricingUrl: null };
}

/** Paid tools in a list — unknown tools count as paid (warn, not bill). */
export function paidTools(tools: string[]): string[] {
  return tools.filter((t) => seatPrice(t).paid);
}
