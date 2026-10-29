import {
  McpError,
  decryptFromB64,
  encryptToB64,
  keyFromHex,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import type { McpServerRow } from "./mcp.js";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE pair: the verifier lives in the pending client row, never the state. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge: b64url(digest) };
}

interface OAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new McpError("protocol", `OAuth discovery failed at ${url} (${res.status})`);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * True when the server answers 401/403 while advertising OAuth — a
 * live MCP server the founder must connect before any probe succeeds.
 */
export async function advertisesOAuth(url: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return false;
  }
  if (res.status !== 401 && res.status !== 403) return false;
  const www = res.headers.get("www-authenticate") ?? "";
  if (/resource_metadata=|realm="oauth"/i.test(www)) return true;
  const body = await res.text().catch(() => "");
  return /oauth|authorization|access token|bearer/i.test(body);
}

/**
 * Discover a server's OAuth endpoints: resource metadata first (the
 * well-known URL the MCP spec derives from the server path), falling
 * back to the 401's resource_metadata pointer.
 */
export async function discoverOAuth(serverUrl: string): Promise<OAuthEndpoints> {
  const u = new URL(serverUrl);
  const derived = `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`;
  let resourceMeta: Record<string, unknown> | null = null;
  try {
    resourceMeta = await getJson(derived);
  } catch {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      signal: AbortSignal.timeout(15_000),
    });
    const www = res.headers.get("www-authenticate") ?? "";
    const match = /resource_metadata="([^"]+)"/.exec(www);
    if (!match) throw new McpError("protocol", "server does not advertise OAuth");
    resourceMeta = await getJson(match[1]);
  }
  const issuers = resourceMeta["authorization_servers"];
  const issuer = Array.isArray(issuers) && typeof issuers[0] === "string" ? issuers[0] : null;
  if (!issuer) throw new McpError("protocol", "server names no authorization server");
  const meta = await getJson(
    `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
  );
  const authorizationEndpoint = meta["authorization_endpoint"];
  const tokenEndpoint = meta["token_endpoint"];
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    throw new McpError("protocol", "authorization server metadata incomplete");
  }
  const registrationEndpoint = meta["registration_endpoint"];
  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint:
      typeof registrationEndpoint === "string" ? registrationEndpoint : null,
  };
}

export interface PreparedOAuth extends OAuthEndpoints {
  clientId: string;
  challenge: string;
}

/**
 * Discover + dynamically register + stash the pending handshake. The
 * route signs state and redirects; the callback finishes by server id.
 */
export async function prepareOAuth(
  env: Env,
  orgId: string,
  server: McpServerRow,
  redirectUri: string,
  scope: string,
): Promise<PreparedOAuth> {
  const endpoints = await discoverOAuth(server.url);
  if (!endpoints.registrationEndpoint) {
    throw new McpError(
      "protocol",
      "this server needs its own app registration — paste a key instead",
    );
  }
  const res = await fetch(endpoints.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Muse AI Team",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(scope ? { scope } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    client_id?: string;
    client_secret?: string;
  };
  if (!res.ok || !json.client_id) {
    throw new McpError("protocol", "server refused to register this app");
  }
  const { verifier, challenge } = await pkcePair();
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  await env.DB.prepare(
    `INSERT INTO mcp_oauth_clients (server_id, org_id, client_id, client_secret_enc,
       authorization_endpoint, token_endpoint, scope, code_verifier, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(server_id) DO UPDATE SET
       client_id = excluded.client_id, client_secret_enc = excluded.client_secret_enc,
       authorization_endpoint = excluded.authorization_endpoint,
       token_endpoint = excluded.token_endpoint, scope = excluded.scope,
       code_verifier = excluded.code_verifier, status = 'pending'`,
  )
    .bind(
      server.id,
      orgId,
      json.client_id,
      json.client_secret ? await encryptToB64(key, json.client_secret) : null,
      endpoints.authorizationEndpoint,
      endpoints.tokenEndpoint,
      scope,
      verifier,
    )
    .run();
  await audit(env, null, "human", "mcp.oauth_started", { org: orgId, server: server.id });
  return { ...endpoints, clientId: json.client_id, challenge };
}

export function authorizeUrl(
  prepared: PreparedOAuth,
  redirectUri: string,
  state: string,
  scope: string,
): string {
  const u = new URL(prepared.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", prepared.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", prepared.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (scope) u.searchParams.set("scope", scope);
  return u.toString();
}

interface OAuthClientRow {
  server_id: string;
  org_id: string;
  client_id: string;
  client_secret_enc: string | null;
  token_endpoint: string;
  scope: string;
  code_verifier: string | null;
  status: string;
}

async function clientRow(env: Env, orgId: string, serverId: string): Promise<OAuthClientRow | null> {
  return env.DB.prepare("SELECT * FROM mcp_oauth_clients WHERE org_id = ? AND server_id = ?")
    .bind(orgId, serverId)
    .first<OAuthClientRow>();
}

async function tokenRequest(
  env: Env,
  row: OAuthClientRow,
  params: Record<string, string>,
): Promise<{ access: string; refresh: string | null; expiresAt: string | null }> {
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  const secret = row.client_secret_enc ? await decryptFromB64(key, row.client_secret_enc) : null;
  const body = new URLSearchParams({ ...params, client_id: row.client_id });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (secret) headers["authorization"] = `Basic ${btoa(`${row.client_id}:${secret}`)}`;
  const res = await fetch(row.token_endpoint, {
    method: "POST",
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !json.access_token) {
    throw new McpError("auth", "token exchange failed");
  }
  return {
    access: json.access_token,
    refresh: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresAt:
      typeof json.expires_in === "number"
        ? new Date(Date.now() + json.expires_in * 1000).toISOString()
        : null,
  };
}

/** Callback half: exchange the code, store tokens, mark connected. */
export async function finishOAuth(
  env: Env,
  orgId: string,
  serverId: string,
  code: string,
  redirectUri: string,
): Promise<void> {
  const row = await clientRow(env, orgId, serverId);
  if (!row || !row.code_verifier || row.status !== "pending") {
    throw new McpError("auth", "no pending connect for this server");
  }
  const tokens = await tokenRequest(env, row, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: row.code_verifier,
  });
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  await env.DB.prepare(
    `INSERT INTO mcp_credentials (id, org_id, server_id, label, secret_enc,
       refresh_token_enc, expires_at, updated_at)
     VALUES (?, ?, ?, 'oauth', ?, ?, ?, datetime('now'))
     ON CONFLICT(org_id, server_id) DO UPDATE SET
       label = 'oauth', secret_enc = excluded.secret_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       expires_at = excluded.expires_at, updated_at = datetime('now')`,
  )
    .bind(
      crypto.randomUUID(),
      orgId,
      serverId,
      await encryptToB64(key, tokens.access),
      tokens.refresh ? await encryptToB64(key, tokens.refresh) : null,
      tokens.expiresAt,
    )
    .run();
  await env.DB.prepare(
    "UPDATE mcp_oauth_clients SET status = 'connected', code_verifier = NULL WHERE server_id = ?",
  )
    .bind(serverId)
    .run();
  await audit(env, null, "human", "mcp.oauth_connected", { org: orgId, server: serverId });
}

/** Refresh an OAuth access token; throws McpError auth when impossible. */
export async function refreshOAuth(env: Env, server: McpServerRow): Promise<string> {
  const row = await clientRow(env, server.org_id, server.id);
  if (!row) throw new McpError("auth", "server was never connected");
  const cred = await env.DB.prepare(
    "SELECT secret_enc, refresh_token_enc FROM mcp_credentials WHERE org_id = ? AND server_id = ?",
  )
    .bind(server.org_id, server.id)
    .first<{ secret_enc: string; refresh_token_enc: string | null }>();
  if (!cred?.refresh_token_enc) throw new McpError("auth", "sign in again to reconnect");
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  const refresh = await decryptFromB64(key, cred.refresh_token_enc);
  const tokens = await tokenRequest(env, row, {
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  await env.DB.prepare(
    `UPDATE mcp_credentials SET secret_enc = ?, refresh_token_enc = ?,
       expires_at = ?, updated_at = datetime('now')
     WHERE org_id = ? AND server_id = ?`,
  )
    .bind(
      await encryptToB64(key, tokens.access),
      tokens.refresh ? await encryptToB64(key, tokens.refresh) : cred.refresh_token_enc,
      tokens.expiresAt,
      server.org_id,
      server.id,
    )
    .run();
  return tokens.access;
}

/**
 * A usable OAuth access token: refreshes proactively inside the last
 * minute so calls rarely see an expired token at all.
 */
export async function oauthAccess(env: Env, server: McpServerRow): Promise<string> {
  const cred = await env.DB.prepare(
    "SELECT secret_enc, refresh_token_enc, expires_at FROM mcp_credentials WHERE org_id = ? AND server_id = ?",
  )
    .bind(server.org_id, server.id)
    .first<{ secret_enc: string; refresh_token_enc: string | null; expires_at: string | null }>();
  if (!cred) throw new McpError("auth", "server is not connected yet");
  const stale = !!cred.expires_at && Date.now() > Date.parse(cred.expires_at) - 60_000;
  if (stale && cred.refresh_token_enc) {
    try {
      return await refreshOAuth(env, server);
    } catch {
      // Fall through to the stored token: it may still work, and a
      // failed refresh must never strand a call that could succeed.
    }
  }
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  try {
    return await decryptFromB64(key, cred.secret_enc);
  } catch {
    if (!env.TOKEN_ENC_KEY_PREV) throw new McpError("auth", "saved sign-in cannot be read");
    const prev = keyFromHex(env.TOKEN_ENC_KEY_PREV);
    const text = await decryptFromB64(prev, cred.secret_enc);
    await env.DB.prepare(
      "UPDATE mcp_credentials SET secret_enc = ?, updated_at = datetime('now') WHERE org_id = ? AND server_id = ?",
    )
      .bind(await encryptToB64(key, text), server.org_id, server.id)
      .run();
    return text;
  }
}
