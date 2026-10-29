// Metric pull catalog: the fixed set of provider queries a goal metric
// can auto-pull. Playbook presets guess the entry from the metric name;
// the founder can always override per goal or fall back to manual entry.

export const PULL_CATALOG = {
  "shopify.orders": {
    provider: "shopify",
    label: "Shopify orders (30d)",
    unit: "orders",
  },
  "shopify.revenue": {
    provider: "shopify",
    label: "Shopify revenue (30d)",
    unit: "revenue",
  },
  "shopify.checkouts": {
    provider: "shopify",
    label: "Shopify abandoned checkouts (30d)",
    unit: "checkouts",
  },
  "hubspot.open_tickets": {
    provider: "hubspot",
    label: "HubSpot open tickets",
    unit: "tickets",
  },
  "github.open_prs": {
    provider: "github",
    label: "GitHub open PRs",
    unit: "prs",
  },
  "github.merged_7d": {
    provider: "github",
    label: "GitHub PRs merged (7d)",
    unit: "prs",
  },
  "linear.open_issues": {
    provider: "linear",
    label: "Linear open issues",
    unit: "issues",
  },
  "slack.messages_7d": {
    provider: "slack",
    label: "Slack messages (7d)",
    unit: "messages",
  },
  "notion.pages_7d": {
    provider: "notion",
    label: "Notion pages created (7d)",
    unit: "pages",
  },
} as const;

export type PullId = keyof typeof PULL_CATALOG;

export function isPullId(s: string): s is PullId {
  return Object.prototype.hasOwnProperty.call(PULL_CATALOG, s);
}

/** Stored goal.metric_source values: a catalog entry or manual entry. */
export function isMetricSource(s: string): boolean {
  return s === "manual" || isPullId(s);
}

const PRESET_RULES: Array<[RegExp, PullId]> = [
  [/reven|sales|\bgmv\b|\bmrr\b/i, "shopify.revenue"],
  [/\border|purchase|checkout/i, "shopify.orders"],
  [/ticket|support/i, "hubspot.open_tickets"],
  [/\bprs?\b|pull request/i, "github.open_prs"],
  [/issue|bug|task/i, "linear.open_issues"],
  [/message|slack|chat/i, "slack.messages_7d"],
  [/page|doc|wiki/i, "notion.pages_7d"],
];

/** Guess the pull for a metric name; unknown metrics stay manual. */
export function metricPreset(
  metricName: string | null | undefined,
): PullId | "manual" {
  if (!metricName) return "manual";
  for (const [re, pull] of PRESET_RULES) {
    if (re.test(metricName)) return pull;
  }
  return "manual";
}
