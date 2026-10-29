import {
  decryptFromB64,
  encryptToB64,
  isKnownProvider,
  keyFromHex,
  normalizeShop,
  providerNeedsShop,
  signState,
  verifyState,
  type ProviderId,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { authTest } from "./integrations/slack.js";

export type Provider = ProviderId;
export const isProvider = isKnownProvider;

export class ProviderNotConfigured extends Error {
  constructor(provider: string) {
    super(`${provider} not configured`);
  }
}

function appCreds(env: Env, provider: Provider): { id: string; secret: string } {
  if (provider === "github") {
    return { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET };
  }
  if (provider === "linear") {
    return { id: env.LINEAR_CLIENT_ID, secret: env.LINEAR_CLIENT_SECRET };
  }
  if (provider === "slack") {
    return { id: env.SLACK_CLIENT_ID, secret: env.SLACK_CLIENT_SECRET };
  }
  if (provider === "shopify") {
    return {
      id: env.SHOPIFY_CLIENT_ID ?? "",
      secret: env.SHOPIFY_CLIENT_SECRET ?? "",
    };
  }
  if (provider === "hubspot") {
    return {
      id: env.HUBSPOT_CLIENT_ID ?? "",
      secret: env.HUBSPOT_CLIENT_SECRET ?? "",
    };
  }
  return {
    id: env.NOTION_CLIENT_ID ?? "",
    secret: env.NOTION_CLIENT_SECRET ?? "",
  };
}

export function callbackUrl(base: string, provider: Provider): string {
  return `${base}/api/auth/${provider}/callback`;
}

export async function connectUrl(
  env: Env,
  provider: Provider,
  org: string,
  base: string,
  shop?: string,
): Promise<string> {
  const { id } = appCreds(env, provider);
  if (!id) throw new ProviderNotConfigured(provider);
  const store =
    provider === "shopify" ? normalizeShop(shop ?? "") : undefined;
  if (provider === "shopify" && !store) {
    throw new Error("shopify connect needs ?shop=your-store.myshopify.com");
  }
  const state = await signState(env.AUTH_SECRET, org, 600, store ?? undefined);
  const redirect = callbackUrl(base, provider);
  if (provider === "github") {
    // Least privilege: public repos only. The demo repo is public, so the
    // token physically cannot touch private repos.
    const q = new URLSearchParams({
      client_id: id,
      redirect_uri: redirect,
      scope: "public_repo read:user",
      state,
    });
    return `https://github.com/login/oauth/authorize?${q}`;
  }
  if (provider === "linear") {
    const q = new URLSearchParams({
      client_id: id,
      redirect_uri: redirect,
      response_type: "code",
      scope: "read write",
      state,
    });
    return `https://linear.app/oauth/authorize?${q}`;
  }
  if (provider === "slack") {
    const q = new URLSearchParams({
      client_id: id,
      // channels:history feeds the message-volume metric pull;
      // app_mentions + im scopes feed inbound replies and owner DMs.
      scope:
        "chat:write,channels:read,channels:join,channels:history,app_mentions:read,im:history,im:write",
      redirect_uri: redirect,
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${q}`;
  }
  if (provider === "shopify") {
    const q = new URLSearchParams({
      client_id: id,
      // read_orders feeds the orders/revenue/checkout metric pulls;
      // read/write_products feeds showcase product copy updates.
      scope: "write_discounts,read_orders,read_products,write_products",
      redirect_uri: redirect,
      state,
    });
    return `https://${store}/admin/oauth/authorize?${q}`;
  }
  if (provider === "hubspot") {
    const q = new URLSearchParams({
      client_id: id,
      scope:
        "crm.objects.tickets.read crm.objects.tickets.write crm.objects.notes.write",
      redirect_uri: redirect,
      state,
    });
    return `https://app.hubspot.com/oauth/authorize?${q}`;
  }
  const q = new URLSearchParams({
    client_id: id,
    response_type: "code",
    owner: "user",
    redirect_uri: redirect,
    state,
  });
  return `https://api.notion.com/v1/oauth/authorize?${q}`;
}

interface TokenSet {
  access: string;
  refresh: string | null;
  expiresAt: string | null;
  grantedScope?: string;
}

function expiresAtFrom(json: { expires_in?: unknown }): string | null {
  return typeof json.expires_in === "number"
    ? new Date(Date.now() + json.expires_in * 1000).toISOString()
    : null;
}

async function exchange(
  env: Env,
  provider: Provider,
  code: string,
  redirectUri: string,
  shop?: string | null,
): Promise<TokenSet> {
  const { id, secret } = appCreds(env, provider);
  if (!id || !secret) throw new ProviderNotConfigured(provider);
  if (provider === "github") {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: id,
        client_secret: secret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const json = (await res.json()) as {
      access_token?: string;
      scope?: string;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new Error(`GitHub exchange failed: ${json.error ?? res.status}`);
    }
    return {
      access: json.access_token,
      refresh: null,
      expiresAt: null,
      grantedScope: json.scope,
    };
  }
  if (provider === "linear") {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: id,
      client_secret: secret,
    });
    const res = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new Error(`Linear exchange failed: ${json.error ?? res.status}`);
    }
    return {
      access: json.access_token,
      refresh: typeof json.refresh_token === "string" ? json.refresh_token : null,
      expiresAt: expiresAtFrom(json),
    };
  }
  if (provider === "slack") {
    const form = new URLSearchParams({
      client_id: id,
      client_secret: secret,
      code,
      redirect_uri: redirectUri,
    });
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      access_token?: string;
      error?: string;
    };
    if (!json.ok || !json.access_token) {
      throw new Error(`Slack exchange failed: ${json.error ?? "unknown"}`);
    }
    return { access: json.access_token, refresh: null, expiresAt: null };
  }
  if (provider === "shopify") {
    if (!shop) throw new Error("shopify exchange needs the store domain");
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: id,
        client_secret: secret,
        code,
      }),
    });
    const json = (await res.json()) as {
      access_token?: string;
      scope?: string;
      expires_in?: number;
      refresh_token?: string;
      errors?: unknown;
    };
    if (!res.ok || !json.access_token) {
      throw new Error(
        `Shopify exchange failed: ${JSON.stringify(json.errors ?? json).slice(0, 120)}`,
      );
    }
    return {
      access: json.access_token,
      refresh: typeof json.refresh_token === "string" ? json.refresh_token : null,
      expiresAt: expiresAtFrom(json),
      grantedScope: json.scope,
    };
  }
  if (provider === "hubspot") {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: id,
      client_secret: secret,
      redirect_uri: redirectUri,
      code,
    });
    const res = await fetch("https://api.hubapi.com/oauth/v1/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      message?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new Error(`HubSpot exchange failed: ${json.message ?? res.status}`);
    }
    return {
      access: json.access_token,
      refresh: json.refresh_token ?? null,
      expiresAt: expiresAtFrom(json),
    };
  }
  const res = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    workspace_name?: string;
    message?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`Notion exchange failed: ${json.message ?? res.status}`);
  }
  return {
    access: json.access_token,
    refresh: null,
    expiresAt: null,
    grantedScope: json.workspace_name,
  };
}

export async function storeToken(
  env: Env,
  orgId: string,
  provider: Provider,
  tokens: TokenSet,
): Promise<void> {
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (org_id, provider, access_token_enc,
      refresh_token_enc, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(org_id, provider) DO UPDATE SET
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       expires_at = excluded.expires_at, updated_at = datetime('now')`,
  )
    .bind(
      orgId,
      provider,
      await encryptToB64(key, tokens.access),
      tokens.refresh ? await encryptToB64(key, tokens.refresh) : null,
      tokens.expiresAt,
    )
    .run();
}

async function refreshAccessToken(
  env: Env,
  provider: Provider,
  refresh: string,
): Promise<TokenSet> {
  const { id, secret } = appCreds(env, provider);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: id,
    client_secret: secret,
  });
  const url =
    provider === "hubspot"
      ? "https://api.hubapi.com/oauth/v1/token"
      : "https://api.linear.app/oauth/token";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`${provider} refresh failed: ${res.status}`);
  }
  return {
    access: json.access_token,
    refresh: typeof json.refresh_token === "string" ? json.refresh_token : refresh,
    expiresAt: expiresAtFrom(json),
  };
}

const REFRESHABLE: readonly Provider[] = ["hubspot", "linear"];

/**
 * Decrypt with the current key, falling back to the previous key during
 * rotation. Returns whether the previous key was used so callers can
 * rewrap the row to the current key on read.
 */
async function decryptToken(
  env: Env,
  b64: string,
): Promise<{ text: string; rewrapped: boolean }> {
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  try {
    return { text: await decryptFromB64(key, b64), rewrapped: false };
  } catch {
    if (!env.TOKEN_ENC_KEY_PREV) throw new Error("token decrypt failed");
    const prev = keyFromHex(env.TOKEN_ENC_KEY_PREV);
    return { text: await decryptFromB64(prev, b64), rewrapped: true };
  }
}

export async function loadToken(
  env: Env,
  orgId: string,
  provider: Provider,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT access_token_enc, refresh_token_enc, expires_at FROM oauth_tokens WHERE org_id = ? AND provider = ?",
  )
    .bind(orgId, provider)
    .first<{
      access_token_enc: string;
      refresh_token_enc: string | null;
      expires_at: string | null;
    }>();
  if (!row) return null;
  const rewrap = async (text: string): Promise<string> => {
    const key = keyFromHex(env.TOKEN_ENC_KEY);
    return encryptToB64(key, text);
  };
  const expired =
    !!row.expires_at &&
    Date.now() > Date.parse(row.expires_at) - 60_000;
  if (!expired) {
    const { text, rewrapped } = await decryptToken(env, row.access_token_enc);
    if (rewrapped) {
      await env.DB.prepare(
        "UPDATE oauth_tokens SET access_token_enc = ?, updated_at = datetime('now') WHERE org_id = ? AND provider = ?",
      )
        .bind(await rewrap(text), orgId, provider)
        .run();
    }
    return text;
  }
  // Expired: rotate inline so scheduled checks and long goals never see
  // a dead token. Unrefreshable providers fail loudly into reconnect.
  if (!REFRESHABLE.includes(provider) || !row.refresh_token_enc) {
    throw new Error(`${provider} token expired — reconnect ${provider}`);
  }
  try {
    const { text: refresh } = await decryptToken(env, row.refresh_token_enc);
    const tokens = await refreshAccessToken(env, provider, refresh);
    await storeToken(env, orgId, provider, tokens);
    return tokens.access;
  } catch (err) {
    throw new Error(
      `${provider} token refresh failed — reconnect ${provider} (${String(err).slice(0, 100)})`,
    );
  }
}

export async function getProviderConfig(
  env: Env,
  orgId: string,
  provider: Provider,
): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    "SELECT config FROM provider_config WHERE org_id = ? AND provider = ?",
  )
    .bind(orgId, provider)
    .first<{ config: string }>();
  if (!row) return {};
  try {
    return JSON.parse(row.config) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function setProviderConfig(
  env: Env,
  orgId: string,
  provider: Provider,
  config: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO provider_config (org_id, provider, config, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(org_id, provider) DO UPDATE SET
       config = excluded.config, updated_at = datetime('now')`,
  )
    .bind(orgId, provider, JSON.stringify(config))
    .run();
}

export async function finishConnect(
  env: Env,
  provider: Provider,
  code: string,
  state: string,
  base: string,
): Promise<{ org: string; grantedScope?: string }> {
  const { org, shop } = await verifyState(env.AUTH_SECRET, state);
  if (providerNeedsShop(provider) && !shop) {
    throw new Error(`${provider} connect is missing its store domain`);
  }
  const tokens = await exchange(
    env,
    provider,
    code,
    callbackUrl(base, provider),
    shop,
  );
  await storeToken(env, org, provider, tokens);
  if (provider === "slack") {
    // Inbound events carry only a team id: bind it (and the installer's
    // user id, the only DM commander) at connect time.
    try {
      const { teamId, userId } = await authTest(tokens.access);
      const prev = await getProviderConfig(env, org, provider);
      await setProviderConfig(env, org, provider, {
        ...prev,
        teamId,
        installerUserId: userId,
      });
    } catch {
      /* inbound stays off until a clean reconnect */
    }
  }
  if (shop) {
    // The token came from this shop's own token endpoint, so the binding
    // is structural: a token can never be stored against the wrong store.
    await setProviderConfig(env, org, provider, { shop });
  }
  return { org, grantedScope: tokens.grantedScope };
}
