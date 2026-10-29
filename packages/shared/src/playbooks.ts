// First-run playbooks: one vertical question routes the founder to a
// prefilled goal plus a provider order with the flagship integration first.
// Lives in shared so the API contract (goal length) and the ordering
// invariant (flagship first, every provider exactly once) are unit-tested.
// NOTE: the id set must equal PROVIDER_IDS (see providers.test.js); a
// direct import is impossible because node --test cannot resolve sibling
// `.js` specifiers to `.ts` sources.

export type VerticalId = "ecommerce" | "support" | "saas";

export interface Vertical {
  id: VerticalId;
  title: string;
  blurb: string;
}

export const VERTICALS: Vertical[] = [
  {
    id: "ecommerce",
    title: "Ecommerce",
    blurb: "You sell online and want more carts to convert.",
  },
  {
    id: "support",
    title: "Customer support",
    blurb: "A queue of tickets and customers waiting on replies.",
  },
  {
    id: "saas",
    title: "Software",
    blurb: "Users sign up but too few stick around.",
  },
];

export interface ProviderMeta {
  id: string;
  name: string;
  /** False only while a provider's OAuth + flagship action is unwired. */
  live: boolean;
}

export const PROVIDERS: ProviderMeta[] = [
  { id: "github", name: "GitHub", live: true },
  { id: "linear", name: "Linear", live: true },
  { id: "slack", name: "Slack", live: true },
  { id: "shopify", name: "Shopify", live: true },
  { id: "hubspot", name: "HubSpot", live: true },
  { id: "notion", name: "Notion", live: true },
];

export const LIVE_PROVIDERS: string[] = PROVIDERS.filter((p) => p.live).map(
  (p) => p.id,
);

export function providerName(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.name ?? id;
}

export function providerLive(id: string): boolean {
  return PROVIDERS.some((p) => p.id === id && p.live);
}

export interface Playbook {
  id: string;
  vertical: VerticalId;
  title: string;
  /** Prefills the goal field; must satisfy the API's min length. */
  goal: string;
  metricName: string;
  metricBaseline?: number;
  metricTarget?: number;
  timeboxDays: number;
  /** Provider id whose flagship action carries this playbook. */
  flagship: string;
  /** Flagship first, then every live provider exactly once. */
  integrationOrder: string[];
  why: string;
}

/** Total by construction: a missing vertical is a type error. */
export const PLAYBOOK_BY_VERTICAL: Record<VerticalId, Playbook> = {
  ecommerce: {
    id: "cart-abandonment",
    vertical: "ecommerce",
    title: "Recover abandoned carts",
    goal: "Lift checkout conversion by 15%",
    metricName: "checkout_conversion",
    metricBaseline: 0.28,
    metricTarget: 0.32,
    timeboxDays: 14,
    flagship: "shopify",
    integrationOrder: [
      "shopify",
      "slack",
      "linear",
      "github",
      "hubspot",
      "notion",
    ],
    why: "Drafts a discount + win-back push for carts that stall at checkout.",
  },
  support: {
    id: "response-time",
    vertical: "support",
    title: "Cut first-response time",
    goal: "Cut support first-response time by 40%",
    metricName: "first_response_hours",
    metricBaseline: 12,
    metricTarget: 7,
    timeboxDays: 14,
    flagship: "hubspot",
    integrationOrder: [
      "hubspot",
      "slack",
      "linear",
      "github",
      "shopify",
      "notion",
    ],
    why: "Triages the queue and drafts replies so nobody waits overnight.",
  },
  saas: {
    id: "onboarding-revamp",
    vertical: "saas",
    title: "Revamp onboarding",
    goal: "Lift onboarding activation by 15%",
    metricName: "activation_rate",
    metricBaseline: 0.32,
    metricTarget: 0.37,
    timeboxDays: 14,
    flagship: "notion",
    integrationOrder: [
      "notion",
      "github",
      "linear",
      "slack",
      "shopify",
      "hubspot",
    ],
    why: "Ships the copy, tickets, and PRs that get new users activated.",
  },
};

export const PLAYBOOKS: Playbook[] = Object.values(PLAYBOOK_BY_VERTICAL);

/** Order for founders who skip the vertical question: live ones first. */
export const DEFAULT_ORDER: string[] = [
  ...LIVE_PROVIDERS,
  ...PROVIDERS.filter((p) => !p.live).map((p) => p.id),
];
