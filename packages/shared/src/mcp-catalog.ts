/**
 * MCP: the long tail of tools. Catalog entries ship pre-approved, but no
 * entry lands here unverified — each URL below answered a live
 * `initialize` + `tools/list` before it was listed.
 */

export const MCP_MAX_STEPS = 10;
export const MCP_MAX_ARGS_BYTES = 32 * 1024;
export const MCP_CALL_TIMEOUT_MS = 30_000;

export type McpErrorCode = "unreachable" | "auth" | "tool" | "timeout" | "protocol";

export class McpError extends Error {
  code: McpErrorCode;
  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type McpAuth = "none" | "header" | "query" | "oauth";

export interface McpCatalogEntry {
  id: string;
  name: string;
  url: string;
  auth: McpAuth;
  authName: string;
  blurb: string;
  /** Plain words for the key field; "" when no key exists. */
  keyHelp: string;
  /** OAuth scope to request; "" lets the server decide. */
  oauthScope: string;
  /** Tool names the hire may never call without asking, on top of hints. */
  sensitiveTools: string[];
}

const noKey = { keyHelp: "", oauthScope: "" };

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "outagedeck",
    name: "OutageDeck",
    url: "https://outagedeck.com/api/mcp",
    auth: "none",
    authName: "",
    blurb: "Live status of cloud and SaaS vendors: outages, incidents, uptime.",
    sensitiveTools: ["watch_provider"],
    ...noKey,
  },
  {
    id: "context7",
    name: "Context7",
    url: "https://mcp.context7.com/mcp",
    auth: "none",
    authName: "",
    blurb: "Fresh docs and code examples for any library.",
    sensitiveTools: [],
    ...noKey,
  },
  {
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    auth: "oauth",
    authName: "",
    blurb: "Issues and projects, straight from Linear.",
    sensitiveTools: [],
    keyHelp: "",
    oauthScope: "read write",
  },
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "oauth",
    authName: "",
    blurb: "Repos, pull requests, and issues.",
    sensitiveTools: [],
    keyHelp: "",
    oauthScope: "",
  },
  {
    id: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    auth: "oauth",
    authName: "",
    blurb: "Pages, wikis, and databases.",
    sensitiveTools: [],
    keyHelp: "",
    oauthScope: "",
  },
  {
    id: "stripe",
    name: "Stripe",
    url: "https://mcp.stripe.com",
    auth: "header",
    authName: "authorization",
    blurb: "Payments, refunds, and customers.",
    sensitiveTools: [],
    keyHelp: "Paste a restricted secret key from the Stripe dashboard.",
    oauthScope: "",
  },
  {
    id: "shopify",
    name: "Shopify",
    url: "https://mcp.shopify.com/mcp",
    auth: "none",
    authName: "",
    blurb: "Products, orders, inventory, and discounts.",
    sensitiveTools: [],
    ...noKey,
  },
  {
    id: "slack",
    name: "Slack",
    url: "https://mcp.slack.com/mcp",
    auth: "header",
    authName: "authorization",
    blurb: "Channels and messages beyond the built-in Slack link.",
    sensitiveTools: [],
    keyHelp: "Paste a bot token (starts with xoxb).",
    oauthScope: "",
  },
  {
    id: "resend",
    name: "Resend",
    url: "https://mcp.resend.com/mcp",
    auth: "header",
    authName: "authorization",
    blurb: "Send email through Resend.",
    sensitiveTools: [],
    keyHelp: "Paste an API key (starts with re_).",
    oauthScope: "",
  },
  {
    id: "posthog",
    name: "PostHog",
    url: "https://mcp.posthog.com/mcp",
    auth: "header",
    authName: "authorization",
    blurb: "Product analytics: what users do.",
    sensitiveTools: [],
    keyHelp: "Paste a personal API key.",
    oauthScope: "",
  },
  {
    id: "zapier",
    name: "Zapier",
    url: "https://mcp.zapier.com/api/mcp/mcp",
    auth: "header",
    authName: "authorization",
    blurb: "Thousands of apps through your Zaps.",
    sensitiveTools: [],
    keyHelp: "Paste your Zapier MCP key.",
    oauthScope: "",
  },
  {
    id: "sentry",
    name: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    auth: "header",
    authName: "authorization",
    blurb: "Errors and crashes from your apps.",
    sensitiveTools: [],
    keyHelp: "Paste a user auth token.",
    oauthScope: "",
  },
  {
    id: "supabase",
    name: "Supabase",
    url: "https://mcp.supabase.com/mcp",
    auth: "header",
    authName: "authorization",
    blurb: "Your Postgres database, tables and rows.",
    sensitiveTools: [],
    keyHelp: "Paste a personal access token.",
    oauthScope: "",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    url: "https://mcp.atlassian.com/v1/mcp",
    auth: "header",
    authName: "authorization",
    blurb: "Jira issues and Confluence pages.",
    sensitiveTools: [],
    keyHelp: "Paste an API token.",
    oauthScope: "",
  },
];

export function catalogEntry(id: string): McpCatalogEntry | null {
  return MCP_CATALOG.find((e) => e.id === id) ?? null;
}

/**
 * Read verbs: a tool that starts with one is a lookup, whatever words
 * follow — `get_post` sails while `post_message` asks.
 */
const READ_PREFIX = /^(get|list|fetch|search|read|describe|check|lookup|find|query|retrieve|show)([_\-.]|$)/i;

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
  /(^|[_\-.])post([_\-.]|$)/i,
];

export function isSensitiveToolName(name: string): boolean {
  if (READ_PREFIX.test(name)) return false;
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
