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
