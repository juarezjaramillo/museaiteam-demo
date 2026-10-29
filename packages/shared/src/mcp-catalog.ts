/**
 * MCP: the long tail of tools. Catalog entries ship pre-approved, but no
 * entry lands here unverified — each URL below answered a live
 * `initialize` + `tools/list` before it was listed.
 */

export const MCP_MAX_STEPS = 10;
export const MCP_MAX_ARGS_BYTES = 32 * 1024;
export const MCP_CALL_TIMEOUT_MS = 30_000;

export type McpAuth = "none" | "header" | "query";

export interface McpCatalogEntry {
  id: string;
  name: string;
  url: string;
  auth: McpAuth;
  authName: string;
  blurb: string;
  /** Tool names the hire may never call without asking, on top of hints. */
  sensitiveTools: string[];
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "outagedeck",
    name: "OutageDeck",
    url: "https://outagedeck.com/api/mcp",
    auth: "none",
    authName: "",
    blurb: "Live status of cloud and SaaS vendors: outages, incidents, uptime.",
    sensitiveTools: ["watch_provider"],
  },
];

export function catalogEntry(id: string): McpCatalogEntry | null {
  return MCP_CATALOG.find((e) => e.id === id) ?? null;
}

/**
 * Name patterns that always ask first: spend, subscriptions, identity,
 * sharing, and destruction. Reads never match — a tool named
 * `get_anything` sails through on a trusted server.
 */
const SENSITIVE_TOOL_PATTERNS = [
  /delet|remov|destroy|drop|purge|eras/i,
  /spend|pay|bill|charge|invoice|refund|payout/i,
  /subscri|watch_|_watch|alert|notify/i,
  /admin|grant|revoke|permission|role_/i,
  /share|invite|publish|send_|_send|broadcast/i,
  /signup|sign_up|register_account|create_account/i,
];

export function isSensitiveToolName(name: string): boolean {
  return SENSITIVE_TOOL_PATTERNS.some((p) => p.test(name));
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * The one gate every MCP call passes. Sensitive when the server says so
 * (destructive or open-world hint), the catalog tags it, or the name
 * matches. Unknown founder tools with no hints default sensitive:
 * unknown means ask.
 */
export function isSensitiveTool(
  toolName: string,
  annotations: McpToolAnnotations | undefined,
  catalogTags: string[],
): boolean {
  if (annotations?.destructiveHint === true) return true;
  if (annotations?.openWorldHint === true) return true;
  if (catalogTags.includes(toolName)) return true;
  if (isSensitiveToolName(toolName)) return true;
  if (!annotations) return true;
  return false;
}

/** Plain words for the approvals inbox: server + tool + short args. */
export function mcpCallLabel(server: string, tool: string): string {
  return `${server}: ${tool.replace(/_/g, " ")}`;
}
