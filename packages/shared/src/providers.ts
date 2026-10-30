// Provider registry and connection-input validation. The API consumes
// this for OAuth + config routes; unit tests pin the acceptance rules so
// a mistyped shop domain or page ID fails at the dashboard, not mid-run.

export const PROVIDER_IDS = [
  "github",
  "linear",
  "slack",
  "shopify",
  "hubspot",
  "notion",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isKnownProvider(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

/** Display names for the provider pickers — one map, every surface. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  github: "GitHub",
  linear: "Linear",
  slack: "Slack",
  shopify: "Shopify",
  hubspot: "HubSpot",
  notion: "Notion",
};

/**
 * What a hire may change inside each system. The ids are the exact
 * strings the API's guard checks compare — add a new write in the API
 * and add its label here, or no dashboard can offer it. Labels stay in
 * plain words for the Limits pickers.
 */
export const WRITE_SCOPES: Record<ProviderId, Array<{ id: string; label: string }>> = {
  github: [
    { id: "code", label: "Code" },
    { id: "pr", label: "Pull requests" },
  ],
  linear: [
    { id: "ticket", label: "Tickets" },
    { id: "subtask", label: "Subtasks" },
    { id: "transition", label: "Status changes" },
    { id: "comment", label: "Comments" },
  ],
  slack: [
    { id: "message", label: "Messages" },
    { id: "thread", label: "Threads" },
    { id: "digest", label: "Digests" },
  ],
  shopify: [
    { id: "discount", label: "Discounts" },
    { id: "product", label: "Products" },
  ],
  hubspot: [
    { id: "triage", label: "Ticket sorting" },
    { id: "note", label: "Notes" },
    { id: "followup", label: "Follow-ups" },
  ],
  notion: [{ id: "db", label: "Database entries" }],
};

const SCOPE_LABELS: Record<string, string> = Object.fromEntries(
  PROVIDER_IDS.flatMap((p) => WRITE_SCOPES[p].map((s) => [s.id, s.label])),
);

/** Plain-words label for a write-scope id; unknown ids pass through. */
export function scopeLabel(id: string): string {
  return SCOPE_LABELS[id] ?? id;
}

/** Plain-words label for a provider id; unknown ids capitalize (they are product names). */
export function providerLabel(id: string): string {
  if (isKnownProvider(id)) return PROVIDER_LABELS[id];
  if (id.startsWith("mcp:")) return "Custom tool";
  return id.slice(0, 1).toUpperCase() + id.slice(1);
}

/**
 * Tool id an MCP server provisions as: known providers by name, anything
 * else as its own box tool. Shared so the dashboard picker and the API
 * can never disagree on what a server grants. Pure, unit-pinned.
 */
export function toolForServer(server: { id: string; name: string; url: string }): string {
  const hay = `${server.name} ${server.url}`.toLowerCase();
  for (const p of PROVIDER_IDS) {
    if (hay.includes(p)) return p;
  }
  return `mcp:${server.id}`;
}

/** Only Shopify's OAuth dance needs extra input (the store domain). */
export function providerNeedsShop(provider: string): boolean {
  return provider === "shopify";
}

/**
 * Accepts `store`, `store.myshopify.com`, or a pasted admin URL; returns
 * the canonical domain or null. Nothing else can reach Shopify's OAuth.
 */
export function normalizeShop(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split("?")[0];
  const full =
    host === "" || host.includes(".")
      ? host
      : `${host}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(full) ? full : null;
}

export interface ProviderConfigCheck {
  ok: boolean;
  error?: string;
}

/** Validates dashboard-saved provider config before it is stored. */
export function validateProviderConfig(
  provider: string,
  config: Record<string, unknown>,
): ProviderConfigCheck {
  if (!isKnownProvider(provider)) {
    return { ok: false, error: `unknown provider ${provider}` };
  }
  if (provider === "shopify") {
    if (typeof config.shop !== "string" || !normalizeShop(config.shop)) {
      return {
        ok: false,
        error: "config.shop must be a *.myshopify.com domain",
      };
    }
    if (
      config.product_id !== undefined &&
      (typeof config.product_id !== "string" ||
        !config.product_id.startsWith("gid://shopify/Product/"))
    ) {
      return {
        ok: false,
        error: "config.product_id must be a gid://shopify/Product/... ID",
      };
    }
    return { ok: true };
  }
  if (provider === "notion") {
    const id = config.parentPageId;
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{32}$/i.test(id.replace(/-/g, ""))
    ) {
      return {
        ok: false,
        error: "config.parentPageId must be a Notion page ID",
      };
    }
    return { ok: true };
  }
  return { ok: true };
}
