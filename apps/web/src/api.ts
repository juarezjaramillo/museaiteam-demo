export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export interface RunRow {
  id: string;
  goal: string;
  status: string;
  kill_flag: number;
  rounds_used: number;
  tokens_used: number;
  team_id: string | null;
  lineup: string;
}

export interface SeatRow {
  id: string;
  role: string;
  email: string | null;
  hired: number;
  approved: number;
}

export interface TeamRow {
  id: string;
  name: string;
  seats: SeatRow[];
}

export interface GuardrailRow {
  worker_role: string;
  systems: string[];
  write_scope: string[];
  spend_cap_cents: number;
  escalate_on: string[];
  configured: boolean;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      /* non-JSON error; keep the status */
    }
    throw new Error(`${init?.method ?? "GET"} ${path}: ${detail}`);
  }
  return (await res.json()) as T;
}

export function wsUrl(path: string): string {
  if (API_BASE) return `${API_BASE.replace(/^http/, "ws")}${path}`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

export interface CreateRunInput {
  orgId: string;
  teamId?: string;
  goal: string;
  metricName?: string;
  metricBaseline?: number;
  metricTarget?: number;
  timeboxDays?: number;
  voteWindowMs?: number;
}

export interface GoalRow {
  id: string;
  team_id: string | null;
  title: string;
  metric_name: string | null;
  metric_source: string | null;
  metric_baseline: number | null;
  metric_target: number | null;
  deadline: string | null;
  schedule: string;
  approval_mode: string;
  squad: string[];
  status: string;
  last_check_at: string | null;
  created_at: string;
}

export interface TimelineEntry {
  kind: string;
  title: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface MetricPoint {
  ts: string;
  value: number;
  source: string;
}

export interface RunListRow {
  id: string;
  goal_id: string | null;
  kind: string;
  goal: string;
  status: string;
  lineup: string;
  tokens_used: number;
  created_at: string;
  outcome: string | null;
  top_suggestion: string | null;
  ships: number;
}

export interface ApprovalRow {
  id: string;
  runId: string;
  goalId: string | null;
  kind: string;
  actionId: string | null;
  attempt: number;
  status: string;
  resubmits: number;
  note: string;
  revisionRunId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  runGoal: string | null;
  actionKind: string | null;
  actionTarget: string | null;
  mcpServerId: string | null;
  mcpServerName: string | null;
  mcpTool: string | null;
  mcpArgs: string | null;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: string;
  authName: string;
  source: string;
  status: string;
  spendCapCents: number;
  hasSecret: boolean;
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  url: string;
  blurb: string;
  auth: string;
  keyHelp: string;
}

export interface ActionRow {
  id: string;
  kind: string;
  target: string;
  status: string;
  payload: string;
  proof: string | null;
}

export interface ProposalRow {
  id: string;
  kind: string;
  goal_id: string | null;
  title: string;
  body: string;
  status: string;
  remind_at: string;
  start_at: string;
  run_id: string | null;
  created_at: string;
}

export interface ActivityItem {
  id: string;
  kind: string;
  target: string;
  status: string;
  createdAt: string;
  runId: string;
  runKind: string;
  runStatus: string;
  goalId: string | null;
  goal: string;
}

export interface RatingRow {
  id: string;
  actionId: string;
  actionKind: string;
  thumb: string;
  note: string;
  createdAt: string;
}

export interface PlaybookRow {
  id: string;
  system: string;
  tactic: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemberRow {
  id: string;
  email: string | null;
  role: string;
  createdAt: string;
}

export interface InviteRow {
  id: string;
  email: string;
  role: string;
  accepted: boolean;
  expiresAt: string;
  createdAt: string;
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  read: number;
  createdAt: string;
}

export interface HireRow {
  role: string;
  runs: number;
  proposals: number;
  votes: number;
  shipped: number;
  up: number;
  down: number;
  tokens: number;
  tokensEstimated: boolean;
}

export interface RunDetail {
  run: RunRow & {
    org_id: string;
    goal_id: string | null;
    kind: string;
    parent_run_id: string | null;
    brief_note: string;
    self_critique: string | null;
  };
  proposals: Array<{ id: string; agent_role: string; title: string; body: string }>;
  votes: Array<{ agent_role: string; proposal_id: string; choice: string; reason: string }>;
  ruling: { decision: string; rationale: string; decided_by: string; attempt: number } | null;
  actions: ActionRow[];
  ratings: RatingRow[];
  children: Array<{ id: string; kind: string; status: string; goal: string }>;
  reviews: Array<{ reviewer: string; verdict: string; note: string; decision: string }>;
}

export const api = {
  createRun: (body: CreateRunInput) =>
    req<{ runId: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getRun: (id: string) => req<RunRow>(`/api/runs/${id}`),
  killRun: (id: string) =>
    req<{ ok: boolean }>(`/api/runs/${id}/kill`, { method: "POST" }),
  revertRun: (id: string) =>
    req<{ ok: boolean }>(`/api/runs/${id}/revert`, { method: "POST" }),
  runBaseline: (id: string) =>
    req<
      import("@museaiteam/shared").Baseline & { fresh: boolean }
    >(`/api/runs/${id}/baseline`, { method: "POST" }),
  getGuardrails: (org: string) =>
    req<GuardrailRow[]>(`/api/orgs/${org}/guardrails`),
  getOrg: (org: string) =>
    req<{
      id: string;
      name: string;
      trial: import("@museaiteam/shared").TrialStatus;
      ideas: { cap: number; spent: number; left: number; graceHours: number };
    }>(`/api/orgs/${org}`),
  putSettings: (org: string, body: { idea_allowance_words?: number; proposal_grace_hours?: number }) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/settings`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  getProposals: (org: string) =>
    req<{ proposals: ProposalRow[] }>(`/api/orgs/${org}/proposals`),
  decideProposal: (org: string, id: string, decision: "approve" | "reject", note?: string) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/proposals/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, note }),
    }),
  getConnections: (org: string) =>
    req<{
      status: Record<string, "connected" | "expired" | "missing">;
      cutOver: boolean;
      retiring: Record<string, string>;
    }>(`/api/orgs/${org}/connections`).then((r) => ({
      status: r.status,
      cutOver: r.cutOver,
      retiring: r.retiring ?? {},
    })),
  me: () =>
    req<{ user: { id: string; email?: string }; orgId: string }>(`/api/me`),
  signInUrl: () => `${API_BASE}/api/auth/signin`,
  signOutUrl: () => `${API_BASE}/api/auth/signout`,
  connectUrl: (org: string, provider: string, query = "") =>
    `${API_BASE}/api/auth/${provider}/connect?org=${encodeURIComponent(org)}${query}`,
  getProviderConfig: (org: string, provider: string) =>
    req<{ config: Record<string, unknown> }>(
      `/api/orgs/${org}/config/${provider}`,
    ),
  putProviderConfig: (org: string, provider: string, config: Record<string, unknown>) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/config/${provider}`, {
      method: "PUT",
      body: JSON.stringify({ config }),
    }),
  getTeams: (org: string) => req<{ teams: TeamRow[] }>(`/api/orgs/${org}/teams`),
  hireSeat: (org: string, teamId: string, role: string) =>
    req<{ id: string; teamId: string; overflow: boolean }>(
      `/api/orgs/${org}/teams/${teamId}/seats`,
      { method: "POST", body: JSON.stringify({ role }) },
    ),
  approveSeat: (org: string, seatId: string) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/seats/${seatId}/approve`, {
      method: "POST",
    }),
  getTeamSeats: (org: string) =>
    req<{
      seats: Array<{
        id: string;
        role: string;
        email: string | null;
        approved: boolean;
        keystone: string | null;
        keystoneReady: boolean;
        sessionOne: boolean;
        on: string[];
        waiting: Array<{ tool: string; step: string; status: string; detail: string }>;
        box: string;
        spend: { seconds: number; cents: number } | null;
      }>;
      meanwhile: string[];
    }>(`/api/orgs/${org}/team/seats`),
  wakeBox: (org: string, seatId: string) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/seats/${seatId}/box/wake`, {
      method: "POST",
    }),
  saveSeatSession: (org: string, seatId: string, tool: string, secret: string, daysValid: number) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/seats/${seatId}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        tool,
        kind: "session",
        secret,
        expiresAtMs: Date.now() + daysValid * 86_400_000,
      }),
    }),
  fireSeat: (org: string, seatId: string) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/seats/${seatId}`, {
      method: "DELETE",
    }),
  getCutover: (org: string) =>
    req<{ cutOver: boolean; providers: string[]; servers: string[]; kept: string[] }>(
      `/api/orgs/${org}/cutover`,
    ),
  migrateCutover: (org: string) =>
    req<{
      checklist: Array<{ seatId: string; requestId?: string; tools?: string[]; error?: string }>;
      retired: string[];
      status: { cutOver: boolean; providers: string[]; servers: string[]; kept: string[] };
    }>(`/api/orgs/${org}/cutover/migrate`, { method: "POST" }),
  flipCutover: (org: string) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/cutover/flip`, { method: "POST" }),
  getBilling: (org: string) =>
    req<{
      subscribed: boolean;
      subStatus: string;
      seats: number;
      meter: {
        month: string;
        totalTokens: number;
        seats: number;
        allowance: number;
        perWorker: number;
        throttled: boolean;
      };
      pricePerWorker: string;
      checkoutReady: boolean;
    }>(`/api/orgs/${org}/billing`),
  createCheckout: (org: string) =>
    req<{ url: string }>(`/api/orgs/${org}/checkout`, { method: "POST" }),
  putGuardrails: (
    org: string,
    row: Omit<GuardrailRow, "configured">,
  ) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/guardrails`, {
      method: "PUT",
      body: JSON.stringify(row),
    }),
  ingestUpload: async (org: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/api/orgs/${org}/ingest/upload`, {
      method: "POST",
      body: form,
      credentials: "include",
    });
    if (!res.ok) throw new Error(`upload: ${res.status}`);
    return (await res.json()) as { chunks: number; bytes: number };
  },
  ingestGithub: (org: string, token: string, repo: string) =>
    req<{ files: number; chunks: number }>(`/api/orgs/${org}/ingest/github`, {
      method: "POST",
      body: JSON.stringify({ token, repo }),
    }),
  getGoals: (org: string) => req<{ goals: GoalRow[] }>(`/api/orgs/${org}/goals`),
  createGoal: (org: string, body: Record<string, unknown>) =>
    req<{ id: string }>(`/api/orgs/${org}/goals`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getGoal: (org: string, goalId: string) =>
    req<{ goal: GoalRow; timeline: TimelineEntry[]; series: MetricPoint[] }>(
      `/api/orgs/${org}/goals/${goalId}`,
    ),
  patchGoal: (org: string, goalId: string, body: Record<string, unknown>) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/goals/${goalId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  restaffGoal: (org: string, goalId: string) =>
    req<{ squad: string[] }>(`/api/orgs/${org}/goals/${goalId}/restaff`, {
      method: "POST",
    }),
  addMetricPoint: (org: string, goalId: string, value: number) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/goals/${goalId}/metrics`, {
      method: "POST",
      body: JSON.stringify({ value }),
    }),
  pullMetric: (org: string, goalId: string) =>
    req<{ ok: boolean; value?: number; detail?: string; reason?: string }>(
      `/api/orgs/${org}/goals/${goalId}/pull`,
      { method: "POST" },
    ),
  getOrgRuns: (org: string, query = "") =>
    req<{ runs: RunListRow[] }>(`/api/orgs/${org}/runs${query}`),
  getRunDetail: (id: string) => req<RunDetail>(`/api/runs/${id}/detail`),
  getApprovals: (org: string, status = "") =>
    req<{ approvals: ApprovalRow[] }>(
      `/api/orgs/${org}/approvals${status ? `?status=${status}` : ""}`,
    ),
  decideApproval: (runId: string, decision: "approve" | "reject", note?: string) =>
    req<{ ok: boolean; outcome: string; resubmits?: number; reason?: string }>(
      `/api/runs/${runId}/approve`,
      { method: "POST", body: JSON.stringify({ decision, note }) },
    ),
  approveAction: (runId: string, actionId: string, note?: string) =>
    req<{ ok: boolean }>(`/api/runs/${runId}/actions/${actionId}/approve`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),
  requestChanges: (runId: string, actionId: string, note: string) =>
    req<{ ok: boolean; runId: string; status: string }>(
      `/api/runs/${runId}/actions/${actionId}/request-changes`,
      { method: "POST", body: JSON.stringify({ note }) },
    ),
  approveAll: (org: string) =>
    req<{ ok: boolean; approved: number; failed: string[] }>(
      `/api/orgs/${org}/approvals/approve-all`,
      { method: "POST" },
    ),
  getActivity: (org: string) =>
    req<{ activity: ActivityItem[] }>(`/api/orgs/${org}/activity`),
  rateAction: (runId: string, actionId: string, thumb: "up" | "down", note?: string) =>
    req<{ ok: boolean }>(`/api/runs/${runId}/actions/${actionId}/rate`, {
      method: "POST",
      body: JSON.stringify({ thumb, note }),
    }),
  getPlaybook: (org: string) =>
    req<{ entries: PlaybookRow[] }>(`/api/orgs/${org}/playbook`),
  patchPlaybook: (org: string, entryId: string, body: Record<string, unknown>) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/playbook/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  getMembers: (org: string) =>
    req<{ members: MemberRow[] }>(`/api/orgs/${org}/members`),
  getInvites: (org: string) =>
    req<{ invites: InviteRow[] }>(`/api/orgs/${org}/invites`),
  createInvite: (org: string, email: string, role: string) =>
    req<{ ok: boolean; id: string; emailed: boolean }>(
      `/api/orgs/${org}/invites`,
      { method: "POST", body: JSON.stringify({ email, role }) },
    ),
  revokeInvite: (org: string, inviteId: string) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/invites/${inviteId}`, {
      method: "DELETE",
    }),
  getNotifications: (org: string, unread = false) =>
    req<{ notifications: NotificationRow[] }>(
      `/api/orgs/${org}/notifications${unread ? "?unread=1" : ""}`,
    ),
  readNotification: (org: string, id: string) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/notifications/${id}/read`, {
      method: "POST",
    }),
  getHires: (org: string) => req<{ hires: HireRow[] }>(`/api/orgs/${org}/hires`),
  getProducts: (org: string) =>
    req<{ products: Array<{ id: string; title: string }> }>(
      `/api/orgs/${org}/shopify/products`,
    ),
  myOrgs: () =>
    req<{ orgs: Array<{ id: string; name: string; role: string }> }>(`/api/me/orgs`),
  auditCsvUrl: (org: string) => `${API_BASE}/api/orgs/${org}/audit.csv`,
  getMcp: (org: string) =>
    req<{ servers: McpServer[]; catalog: McpCatalogEntry[] }>(`/api/orgs/${org}/mcp`),
  addMcp: (org: string, body: Record<string, unknown>) =>
    req<{ server: McpServer; tools: string[] }>(`/api/orgs/${org}/mcp`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteMcp: (org: string, id: string) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/mcp/${id}`, { method: "DELETE" }),
  putMcpSecret: (org: string, id: string, secret: string) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/mcp/${id}/secret`, {
      method: "PUT",
      body: JSON.stringify({ secret }),
    }),
  putMcpCap: (org: string, id: string, cents: number) =>
    req<{ ok: boolean }>(`/api/orgs/${org}/mcp/${id}/cap`, {
      method: "PUT",
      body: JSON.stringify({ cents }),
    }),
  trustMcp: (org: string, id: string, status: "trusted" | "rejected") =>
    req<{ ok: boolean }>(`/api/orgs/${org}/mcp/${id}/trust`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  decideTool: (org: string, id: string, decision: "approve" | "reject") =>
    req<{ ok: boolean }>(`/api/orgs/${org}/approvals/${id}/tool`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
  mcpConnectUrl: (org: string, id: string) =>
    `${API_BASE}/api/orgs/${org}/mcp/${id}/connect`,
};
