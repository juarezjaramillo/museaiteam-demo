import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CATALOG,
  catalogEntry,
  decryptFromB64,
  encryptToB64,
  keyFromHex,
  type McpAuth,
  type McpCatalogEntry,
  type McpToolAnnotations,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";

export interface McpServerRow {
  id: string;
  org_id: string;
  name: string;
  url: string;
  auth: McpAuth;
  auth_name: string;
  source: string;
  status: string;
  spend_cap_cents: number;
}

export interface McpTool {
  name: string;
  description: string;
  annotations?: McpToolAnnotations;
}

export type McpErrorCode = "unreachable" | "auth" | "tool" | "timeout" | "protocol";

export class McpError extends Error {
  code: McpErrorCode;
  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface JsonRpc {
  result?: unknown;
  error?: { message?: string };
}

/**
 * One JSON-RPC round trip over Streamable HTTP. Servers answer either
 * plain JSON or an SSE stream — both shapes parse to the same object.
 */
async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
  init?: { secret?: string | null; auth?: McpAuth; authName?: string },
): Promise<JsonRpc> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  let target = url;
  if (init?.secret && init.auth === "header") {
    const name = init.authName?.trim() || "authorization";
    headers[name] =
      name.toLowerCase() === "authorization" && !/^bearer /i.test(init.secret)
        ? `Bearer ${init.secret}`
        : init.secret;
  } else if (init?.secret && init.auth === "query") {
    const u = new URL(url);
    u.searchParams.set(init.authName || "key", init.secret);
    target = u.toString();
  }
  let res: Response;
  try {
    res = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(MCP_CALL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new McpError(
      "unreachable",
      err instanceof Error && err.name === "TimeoutError"
        ? "server took too long to answer"
        : `server unreachable: ${err}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new McpError("auth", `server refused the request (${res.status})`);
  }
  if (!res.ok) {
    throw new McpError("unreachable", `server answered ${res.status}`);
  }
  const text = await res.text();
  const payload = text.includes("data:")
    ? (text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter((d) => d && d !== "[DONE]")
        .at(-1) ?? "")
    : text;
  let json: JsonRpc;
  try {
    json = JSON.parse(payload || "{}") as JsonRpc;
  } catch {
    throw new McpError("protocol", "server answered with garbled data");
  }
  if (json.error) {
    throw new McpError("tool", String(json.error.message ?? "tool call failed").slice(0, 300));
  }
  return json;
}

export interface ProbeResult {
  name: string;
  version: string;
  tools: McpTool[];
}

/** Initialize + tools/list against any URL: the add-server probe. */
export async function probeServer(
  url: string,
  secret?: string | null,
  auth?: McpAuth,
  authName?: string,
): Promise<ProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpError("protocol", "that is not a valid http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new McpError("protocol", "only http(s) servers are allowed");
  }
  const init = (await rpc(url, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "museaiteam", version: "1.0" },
  }, { secret: secret ?? null, auth, authName })) as {
    result?: { serverInfo?: { name?: string; version?: string } };
  };
  const listed = (await rpc(url, "tools/list", {}, { secret: secret ?? null, auth, authName })) as {
    result?: { tools?: Array<{ name?: string; description?: string; annotations?: McpToolAnnotations }> };
  };
  const tools = (listed.result?.tools ?? [])
    .filter((t) => typeof t.name === "string")
    .map((t) => ({
      name: t.name as string,
      description: typeof t.description === "string" ? t.description : "",
      annotations: t.annotations,
    }));
  return {
    name: init.result?.serverInfo?.name ?? parsed.hostname,
    version: init.result?.serverInfo?.version ?? "",
    tools,
  };
}

/**
 * Call one tool. Reads come back as text; failures are typed McpErrors,
 * never throws past the loop — the caller records them as honest proof.
 */
export async function callTool(
  env: Env,
  server: McpServerRow,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const secret = server.auth === "none" ? null : await loadSecret(env, server);
  const json = (await rpc(
    server.url,
    "tools/call",
    { name: tool, arguments: args },
    { secret, auth: server.auth, authName: server.auth_name },
  )) as {
    result?: {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
  };
  const result = json.result;
  if (result?.isError) {
    const msg =
      result.content?.find((c) => typeof c.text === "string")?.text ?? "tool reported an error";
    throw new McpError("tool", msg.slice(0, 500));
  }
  const text = (result?.content ?? [])
    .filter((c) => typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  return text.slice(0, 8000);
}

// --- registry ---

export async function listServers(env: Env, orgId: string): Promise<McpServerRow[]> {
  const rows = await env.DB.prepare("SELECT * FROM mcp_servers WHERE org_id = ? ORDER BY added_at")
    .bind(orgId)
    .all<McpServerRow>();
  return rows.results ?? [];
}

export async function getServer(env: Env, orgId: string, id: string): Promise<McpServerRow | null> {
  return env.DB.prepare("SELECT * FROM mcp_servers WHERE org_id = ? AND id = ?")
    .bind(orgId, id)
    .first<McpServerRow>();
}

export interface AddServerInput {
  url?: string;
  catalogId?: string;
  name?: string;
  auth?: McpAuth;
  authName?: string;
  secret?: string;
}

/**
 * Add a server: probe first so a dead URL never lands in the registry.
 * Catalog entries arrive trusted (pre-approved); founder URLs arrive
 * pending and ask on first use.
 */
export async function addServer(
  env: Env,
  orgId: string,
  input: AddServerInput,
): Promise<{ server: McpServerRow; tools: McpTool[] }> {
  let entry: McpCatalogEntry | null = null;
  let url = input.url?.trim() ?? "";
  if (input.catalogId) {
    entry = catalogEntry(input.catalogId);
    if (!entry) throw new McpError("protocol", "unknown catalog entry");
    url = entry.url;
  }
  const auth: McpAuth = entry?.auth ?? input.auth ?? "none";
  const authName = entry?.authName ?? input.authName ?? "";
  const probe = await probeServer(url, input.secret ?? null, auth, authName);
  const existing = await env.DB.prepare("SELECT id FROM mcp_servers WHERE org_id = ? AND url = ?")
    .bind(orgId, url)
    .first<{ id: string }>();
  if (existing) throw new McpError("protocol", "that server is already added");
  const id = crypto.randomUUID();
  const status = entry ? "trusted" : "pending";
  await env.DB.prepare(
    `INSERT INTO mcp_servers (id, org_id, name, url, auth, auth_name, source, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      orgId,
      input.name?.trim() || entry?.name || probe.name,
      url,
      auth,
      authName,
      entry ? "catalog" : "founder",
      status,
    )
    .run();
  if (input.secret) {
    await setSecret(env, orgId, id, input.secret, "founder key");
  }
  const server = (await getServer(env, orgId, id)) as McpServerRow;
  await audit(env, null, "human", "mcp.server_added", { org: orgId, server: id, status });
  return { server, tools: probe.tools };
}

export async function removeServer(env: Env, orgId: string, id: string): Promise<boolean> {
  await env.DB.prepare("DELETE FROM mcp_credentials WHERE org_id = ? AND server_id = ?")
    .bind(orgId, id)
    .run();
  const res = await env.DB.prepare("DELETE FROM mcp_servers WHERE org_id = ? AND id = ?")
    .bind(orgId, id)
    .run();
  const gone = (res.meta.changes ?? 0) === 1;
  if (gone) await audit(env, null, "human", "mcp.server_removed", { org: orgId, server: id });
  return gone;
}

export async function setTrust(
  env: Env,
  orgId: string,
  id: string,
  status: "trusted" | "rejected",
): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE mcp_servers SET status = ? WHERE org_id = ? AND id = ?")
    .bind(status, orgId, id)
    .run();
  const ok = (res.meta.changes ?? 0) === 1;
  if (ok) await audit(env, null, "human", "mcp.trust_set", { org: orgId, server: id, status });
  return ok;
}

export async function setCap(env: Env, orgId: string, id: string, cents: number): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE mcp_servers SET spend_cap_cents = ? WHERE org_id = ? AND id = ?",
  )
    .bind(Math.max(0, Math.floor(cents)), orgId, id)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

// --- vault (same key + rotation path as OAuth tokens) ---

export async function setSecret(
  env: Env,
  orgId: string,
  serverId: string,
  secret: string,
  label: string,
): Promise<void> {
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  await env.DB.prepare(
    `INSERT INTO mcp_credentials (id, org_id, server_id, label, secret_enc, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(org_id, server_id) DO UPDATE SET
       label = excluded.label, secret_enc = excluded.secret_enc,
       updated_at = datetime('now')`,
  )
    .bind(crypto.randomUUID(), orgId, serverId, label.slice(0, 60), await encryptToB64(key, secret))
    .run();
  await audit(env, null, "human", "mcp.secret_saved", { org: orgId, server: serverId });
}

export async function hasSecret(env: Env, orgId: string, serverId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM mcp_credentials WHERE org_id = ? AND server_id = ?",
  )
    .bind(orgId, serverId)
    .first<{ id: string }>();
  return !!row;
}

export async function loadSecret(env: Env, server: McpServerRow): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT secret_enc FROM mcp_credentials WHERE org_id = ? AND server_id = ?",
  )
    .bind(server.org_id, server.id)
    .first<{ secret_enc: string }>();
  if (!row) return null;
  const key = keyFromHex(env.TOKEN_ENC_KEY);
  try {
    return await decryptFromB64(key, row.secret_enc);
  } catch {
    if (!env.TOKEN_ENC_KEY_PREV) throw new McpError("auth", "saved key cannot be read");
    const prev = keyFromHex(env.TOKEN_ENC_KEY_PREV);
    const text = await decryptFromB64(prev, row.secret_enc);
    await env.DB.prepare(
      "UPDATE mcp_credentials SET secret_enc = ?, updated_at = datetime('now') WHERE org_id = ? AND server_id = ?",
    )
      .bind(await encryptToB64(key, text), server.org_id, server.id)
      .run();
    return text;
  }
}

/** Catalog tags for a server URL, so founder re-adds keep their tags. */
export function tagsForUrl(url: string): string[] {
  const entry = MCP_CATALOG.find((e) => e.url === url);
  return entry?.sensitiveTools ?? [];
}
