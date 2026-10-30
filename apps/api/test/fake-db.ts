/**
 * FakeDB: in-memory D1 stand-in for API integration tests. Tables are
 * plain arrays; queries dispatch on normalized-SQL prefixes covering
 * exactly what the tested modules issue. Anything unhandled throws, so
 * a test can never silently pass against a query the fake ignores.
 */
export type Row = Record<string, unknown>;

export interface FakeTables {
  runs: Row[];
  goals: Row[];
  actions: Row[];
  approvals: Row[];
  notifications: Row[];
  audit_log: Row[];
  oauth_tokens: Row[];
  proposals_out: Row[];
  stripe_events: Row[];
  orgs: Row[];
  mcp_servers: Row[];
  mcp_credentials: Row[];
  mcp_oauth_clients: Row[];
  teams: Row[];
  seats: Row[];
  seat_mail: Row[];
  seat_credentials: Row[];
  seat_tools: Row[];
  org_seat_map: Row[];
  seat_requests: Row[];
  seat_provisions: Row[];
  tool_admin_grants: Row[];
  box_state: Row[];
  box_runs: Row[];
  seat_milestones: Row[];
}

export function blankTables(): FakeTables {
  return {
    runs: [],
    goals: [],
    actions: [],
    approvals: [],
    notifications: [],
    audit_log: [],
    oauth_tokens: [],
    proposals_out: [],
    stripe_events: [],
    orgs: [],
    mcp_servers: [],
    mcp_credentials: [],
    mcp_oauth_clients: [],
    teams: [],
    seats: [],
    seat_mail: [],
    seat_credentials: [],
    seat_tools: [],
    org_seat_map: [],
    seat_requests: [],
    seat_provisions: [],
    tool_admin_grants: [],
    box_state: [],
    box_runs: [],
    seat_milestones: [],
  };
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export class FakeDB {
  constructor(public tables: FakeTables = blankTables()) {}

  prepare(sql: string) {
    const q = norm(sql);
    const t = this.tables;
    return {
      bind: (...p: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          if (q.startsWith("SELECT * FROM runs WHERE id = ?")) {
            return (t.runs.find((r) => r.id === p[0]) as T) ?? null;
          }
          if (q.startsWith("SELECT id FROM runs WHERE goal_id = ? AND kind = 'trigger'")) {
            // Time is frozen in tests: any trigger run counts as cooling.
            const r = t.runs.find((x) => x.goal_id === p[0] && x.kind === "trigger");
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT org_id FROM runs WHERE id = ?")) {
            const r = t.runs.find((x) => x.id === p[0]);
            return ((r ? { org_id: r.org_id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT * FROM goals WHERE id = ? AND org_id = ?")) {
            return ((t.goals.find((r) => r.id === p[0] && r.org_id === p[1]) as T) ?? null);
          }
          if (q.startsWith("SELECT id, kind FROM actions WHERE id = ? AND run_id = ?")) {
            const r = t.actions.find((x) => x.id === p[0] && x.run_id === p[1]);
            return ((r ? { id: r.id, kind: r.kind } : null) as T) ?? null;
          }
          if (q.includes("FROM approvals") && q.includes("ORDER BY created_at DESC")) {
            const rows = t.approvals.filter(
              (r) => r.run_id === p[0] && r.kind === "post" && r.action_id === p[1],
            );
            const last = rows[rows.length - 1];
            return ((last ? { id: last.id, status: last.status } : null) as T) ?? null;
          }
          if (q.includes("FROM orgs o JOIN users")) return null;
          if (q.startsWith("SELECT access_token_enc, refresh_token_enc, expires_at FROM oauth_tokens")) {
            return ((t.oauth_tokens.find((r) => r.org_id === p[0] && r.provider === p[1]) as T) ?? null);
          }
          if (q.startsWith("SELECT * FROM proposals_out WHERE id = ? AND org_id = ?")) {
            return ((t.proposals_out.find((r) => r.id === p[0] && r.org_id === p[1]) as T) ?? null);
          }
          if (q.startsWith("SELECT event_id FROM stripe_events WHERE event_id = ?")) {
            const r = t.stripe_events.find((x) => x.event_id === p[0]);
            return ((r ? { event_id: r.event_id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id, sub_status FROM orgs WHERE stripe_customer_id = ?")) {
            const r = t.orgs.find((x) => x.stripe_customer_id === p[0]);
            return ((r ? { id: r.id, sub_status: r.sub_status } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id FROM orgs WHERE stripe_customer_id = ?")) {
            const r = t.orgs.find((x) => x.stripe_customer_id === p[0]);
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT owner_user_id FROM orgs WHERE id = ?")) {
            const r = t.orgs.find((x) => x.id === p[0]);
            return ((r ? { owner_user_id: r.owner_user_id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT idea_allowance_words FROM orgs WHERE id = ?")) {
            const r = t.orgs.find((x) => x.id === p[0]);
            return ((r ? { idea_allowance_words: r.idea_allowance_words ?? 250000 } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT words FROM idea_spend WHERE org_id = ? AND night = ?")) {
            return null;
          }
          if (q.startsWith("SELECT * FROM mcp_servers WHERE org_id = ? AND id = ?")) {
            return ((t.mcp_servers.find((r) => r.org_id === p[0] && r.id === p[1]) as T) ?? null);
          }
          if (q.startsWith("SELECT id FROM mcp_servers WHERE org_id = ? AND id = ?")) {
            const r = t.mcp_servers.find((x) => x.org_id === p[0] && x.id === p[1]);
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id FROM mcp_servers WHERE org_id = ? AND url = ?")) {
            const r = t.mcp_servers.find((x) => x.org_id === p[0] && x.url === p[1]);
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT secret_enc FROM mcp_credentials WHERE org_id = ? AND server_id = ?")) {
            const r = t.mcp_credentials.find((x) => x.org_id === p[0] && x.server_id === p[1]);
            return ((r ? { secret_enc: r.secret_enc } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id FROM mcp_credentials WHERE org_id = ? AND server_id = ?")) {
            const r = t.mcp_credentials.find((x) => x.org_id === p[0] && x.server_id === p[1]);
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id, run_id, action_id, status, mcp_server_id, mcp_tool, mcp_args FROM approvals")) {
            const r = t.approvals.find((x) => x.id === p[0] && x.org_id === p[1] && x.mcp_server_id);
            return ((r ?? null) as T) ?? null;
          }
          if (q.startsWith("SELECT * FROM mcp_oauth_clients WHERE org_id = ? AND server_id = ?")) {
            return ((t.mcp_oauth_clients.find((r) => r.org_id === p[0] && r.server_id === p[1]) as T) ?? null);
          }
          if (q.startsWith("SELECT secret_enc, refresh_token_enc, expires_at FROM mcp_credentials")) {
            const r = t.mcp_credentials.find((x) => x.org_id === p[0] && x.server_id === p[1]);
            return ((r ? { secret_enc: r.secret_enc, refresh_token_enc: r.refresh_token_enc ?? null, expires_at: r.expires_at ?? null } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT secret_enc, refresh_token_enc FROM mcp_credentials")) {
            const r = t.mcp_credentials.find((x) => x.org_id === p[0] && x.server_id === p[1]);
            return ((r ? { secret_enc: r.secret_enc, refresh_token_enc: r.refresh_token_enc ?? null } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT s.id, s.team_id, s.role, s.email, s.hired, s.approved FROM seats s")) {
            const s = t.seats.find((x) => x.id === p[0]);
            const team = s ? t.teams.find((x) => x.id === s.team_id && x.org_id === p[1]) : null;
            return ((s && team ? s : null) as T) ?? null;
          }
          if (q.startsWith("SELECT milestone FROM seat_milestones WHERE seat_id = ?")) {
            const r = t.seat_milestones.find((x) => x.seat_id === p[0] && x.milestone === "session_one");
            return ((r ? { milestone: r.milestone } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT s.id, s.frozen_at, t.org_id FROM seats s JOIN teams t")) {
            const s = t.seats.find((x) => x.email === p[0]);
            const team = s ? t.teams.find((x) => x.id === s.team_id) : null;
            return ((s && team ? { id: s.id, frozen_at: s.frozen_at ?? null, org_id: team.org_id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id FROM seats WHERE team_id = ? AND role = ? AND approved = 1")) {
            const r = t.seats.find((x) => x.team_id === p[0] && x.role === p[1] && x.approved === 1);
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT secret_enc, kind, status FROM seat_credentials")) {
            const r = t.seat_credentials.find(
              (x) => x.org_id === p[0] && x.seat_id === p[1] && x.tool === p[2],
            );
            return ((r ? { secret_enc: r.secret_enc, kind: r.kind, status: r.status } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT secret_enc, expires_at, status FROM seat_credentials")) {
            const r = t.seat_credentials.find(
              (x) => x.org_id === p[0] && x.seat_id === p[1] && x.tool === p[2] && x.kind === "session",
            );
            return ((r ? { secret_enc: r.secret_enc, expires_at: r.expires_at ?? null, status: r.status } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id FROM seat_requests WHERE seat_id = ? AND status = 'proposed'")) {
            const r = t.seat_requests.find((x) => x.seat_id === p[0] && x.status === "proposed");
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT tools_json FROM org_seat_map WHERE org_id = ? AND role = ?")) {
            const r = t.org_seat_map.find((x) => x.org_id === p[0] && x.role === p[1]);
            return ((r ? { tools_json: r.tools_json } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id, tools_json, status, created_at FROM seat_requests WHERE seat_id = ?")) {
            const r = t.seat_requests.find((x) => x.seat_id === p[0] && x.status === "proposed");
            return ((r ?? null) as T) ?? null;
          }
          if (q.startsWith("SELECT id, tools_json FROM seat_requests WHERE seat_id = ? AND status = 'proposed' LIMIT 1")) {
            const r = t.seat_requests.find((x) => x.seat_id === p[0] && x.status === "proposed");
            return ((r ? { id: r.id, tools_json: r.tools_json } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id, tools_json, status FROM seat_requests WHERE seat_id = ? ORDER BY created_at DESC LIMIT 1")) {
            const r = t.seat_requests.find((x) => x.seat_id === p[0]);
            return ((r ? { id: r.id, tools_json: r.tools_json, status: r.status } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id, seat_id, tools_json, status FROM seat_requests WHERE id = ? AND org_id = ?")) {
            const r = t.seat_requests.find((x) => x.id === p[0] && x.org_id === p[1]);
            return ((r ?? null) as T) ?? null;
          }
          if (q.startsWith("SELECT tool FROM seat_provisions WHERE seat_id = ? AND tool = ? AND status = 'verified'")) {
            const r = t.seat_provisions.find((x) => x.seat_id === p[0] && x.tool === p[1] && x.status === "verified");
            return ((r ? { tool: r.tool } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT secret_enc FROM tool_admin_grants WHERE org_id = ? AND tool = ?")) {
            const r = t.tool_admin_grants.find((x) => x.org_id === p[0] && x.tool === p[1] && x.status === "granted");
            return ((r ? { secret_enc: r.secret_enc } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT trial_started_at, trial_ends_at, grace_used, subscribed")) {
            const r = t.orgs.find((x) => x.id === p[0]);
            if (!r) return (null as T) ?? null;
            const now = Date.now();
            return {
              trial_started_at: r.trial_started_at ?? now,
              trial_ends_at: r.trial_ends_at ?? now + 14 * 86_400_000,
              grace_used: r.grace_used ?? 0,
              subscribed: r.subscribed ?? 0,
            } as T;
          }
          if (q.startsWith("SELECT provider FROM oauth_tokens WHERE org_id = ? AND provider = ?")) {
            const r = t.oauth_tokens.find((x) => x.org_id === p[0] && x.provider === p[1]);
            return ((r ? { provider: r.provider } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT server_id FROM mcp_credentials WHERE org_id = ? AND server_id = ?")) {
            const r = t.mcp_credentials.find((x) => x.org_id === p[0] && x.server_id === p[1]);
            return ((r ? { server_id: r.server_id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT config FROM provider_config WHERE org_id = ? AND provider = ?")) {
            return (null as T) ?? null;
          }
          if (q.startsWith("SELECT seat_cutover FROM orgs WHERE id = ?")) {
            const r = t.orgs.find((x) => x.id === p[0]);
            return ((r ? { seat_cutover: r.seat_cutover ?? 0 } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id FROM teams WHERE id = ? AND org_id = ?")) {
            const r = t.teams.find((x) => x.id === p[0] && x.org_id === p[1]);
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT box_max_concurrent FROM orgs WHERE id = ?")) {
            const r = t.orgs.find((x) => x.id === p[0]);
            return ((r ? { box_max_concurrent: r.box_max_concurrent ?? 3 } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT COUNT(*) AS n FROM box_state WHERE org_id = ? AND status = 'running'")) {
            const n = t.box_state.filter((x) => x.org_id === p[0] && x.status === "running").length;
            return ({ n } as T) ?? null;
          }
          if (q.startsWith("SELECT status FROM box_state WHERE seat_id = ?")) {
            const r = t.box_state.find((x) => x.seat_id === p[0]);
            return ((r ? { status: r.status } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT kind, status FROM seat_credentials WHERE org_id = ? AND seat_id = ? AND tool = ?")) {
            const r = t.seat_credentials.find((x) => x.org_id === p[0] && x.seat_id === p[1] && x.tool === p[2]);
            return ((r ? { kind: r.kind, status: r.status } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id FROM seat_mail WHERE seat_id = ? AND message_id = ?")) {
            const r = t.seat_mail.find((x) => x.seat_id === p[0] && x.message_id === p[1]);
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          if (q.startsWith("SELECT id FROM proposals_out WHERE org_id = ? AND kind = 'signup'")) {
            const r = t.proposals_out.find(
              (x) => x.org_id === p[0] && x.kind === "signup" && x.title === p[1] && (x.status === "proposed" || x.status === "reminded"),
            );
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          throw new Error(`FakeDB.first: unhandled: ${q.slice(0, 90)}`);
        },
        all: async <T>(): Promise<{ results: T[] }> => {
          if (q.startsWith("SELECT lineup FROM runs WHERE goal_id = ?")) {
            return {
              results: t.runs
                .filter((r) => r.goal_id === p[0] && r.status === "done")
                .slice(-20)
                .map((r) => ({ lineup: r.lineup })) as T[],
            };
          }
          if (q.startsWith("SELECT r.id, r.org_id, r.tools_json, s.role FROM seat_requests r")) {
            const out: Row[] = [];
            for (const r of t.seat_requests) {
              if (r.status !== "proposed" || !(r.created_at < p[0])) continue;
              if (r.nudged_at != null && !(r.nudged_at < p[1])) continue;
              const s = t.seats.find((x) => x.id === r.seat_id);
              if (!s) continue;
              out.push({ id: r.id, org_id: r.org_id, tools_json: r.tools_json, role: s.role });
            }
            return { results: out.slice(0, 50) as T[] };
          }
          if (q.startsWith("SELECT tool, status FROM seat_provisions WHERE seat_id = ? AND status != 'verified'")) {
            return {
              results: t.seat_provisions
                .filter((r) => r.seat_id === p[0] && r.status !== "verified")
                .map((r) => ({ tool: r.tool, status: r.status })) as T[],
            };
          }
          if (q.startsWith("SELECT tool FROM seat_provisions WHERE seat_id = ? AND status IN ('verified', 'pending', 'waiting')")) {
            return {
              results: t.seat_provisions
                .filter((r) => r.seat_id === p[0] && ["verified", "pending", "waiting"].includes(r.status))
                .map((r) => ({ tool: r.tool })) as T[],
            };
          }
          if (q.startsWith("SELECT tools_json FROM seat_requests WHERE seat_id = ? AND status = 'proposed'")) {
            return {
              results: t.seat_requests
                .filter((r) => r.seat_id === p[0] && r.status === "proposed")
                .map((r) => ({ tools_json: r.tools_json })) as T[],
            };
          }
          if (q.startsWith("SELECT tool, detail FROM seat_provisions WHERE seat_id = ? AND status IN ('pending', 'waiting')")) {
            return {
              results: t.seat_provisions
                .filter((r) => r.seat_id === p[0] && (r.status === "pending" || r.status === "waiting"))
                .map((r) => ({ tool: r.tool, detail: r.detail ?? "" })) as T[],
            };
          }
          if (q.startsWith("SELECT tool FROM seat_provisions WHERE seat_id = ? AND status = 'verified'")) {
            return { results: t.seat_provisions.filter((r) => r.seat_id === p[0] && r.status === "verified").map((r) => ({ tool: r.tool })) as T[] };
          }
          if (q.startsWith("SELECT p.seat_id, p.tool, p.step, p.status, p.attempts,")) {
            const out: Row[] = [];
            for (const pr of t.seat_provisions) {
              if (pr.status !== "pending" && pr.status !== "waiting") continue;
              const s = t.seats.find((x) => x.id === pr.seat_id);
              if (!s || s.frozen_at) continue;
              const team = s ? t.teams.find((x) => x.id === s.team_id) : null;
              if (!team) continue;
              out.push({ seat_id: pr.seat_id, tool: pr.tool, step: pr.step, status: pr.status, attempts: pr.attempts ?? 0, org_id: team.org_id, email: s.email ?? null, role: s.role });
            }
            return { results: out.slice(0, 50) as T[] };
          }
          if (q.startsWith("SELECT r.seat_id, s.role, r.seconds, r.instance_type")) {
            const out: Row[] = [];
            for (const r of t.box_runs) {
              if (r.org_id !== p[0] || r.started_at < p[1]) continue;
              const s = t.seats.find((x) => x.id === r.seat_id);
              if (!s) continue;
              out.push({ seat_id: r.seat_id, role: s.role, seconds: r.seconds, instance_type: r.instance_type });
            }
            return { results: out as T[] };
          }
          if (q.startsWith("SELECT r.id, r.seat_id, r.started_at FROM box_runs r")) {
            const out: Row[] = [];
            for (const r of t.box_runs) {
              if (r.stopped_at !== 0 || r.started_at >= p[0]) continue;
              const s = t.box_state.find((x) => x.seat_id === r.seat_id);
              if (!s || s.status !== "running") continue;
              out.push({ id: r.id, seat_id: r.seat_id, started_at: r.started_at });
            }
            return { results: out as T[] };
          }
          if (q.startsWith("SELECT s.id, s.role, s.email, s.approved FROM seats s")) {
            const out: Row[] = [];
            for (const s of t.seats) {
              const team = t.teams.find((x) => x.id === s.team_id);
              if (!team || team.org_id !== p[0]) continue;
              out.push({ id: s.id, role: s.role, email: s.email ?? null, approved: s.approved ?? 0 });
            }
            return { results: out as T[] };
          }
          if (q.startsWith("SELECT tool, step, status, detail FROM seat_provisions WHERE seat_id = ?")) {
            return {
              results: t.seat_provisions.filter((r) => r.seat_id === p[0]).map((r) => ({
                tool: r.tool, step: r.step, status: r.status, detail: r.detail ?? "",
              })) as T[],
            };
          }
          if (q.startsWith("SELECT a.payload FROM actions a JOIN runs r")) {
            const out: Row[] = [];
            for (const a of t.actions) {
              if (a.status !== "skipped" || !String(a.payload ?? "").includes("seatless")) continue;
              const run = t.runs.find((x) => x.id === a.run_id);
              if (!run || run.org_id !== p[0]) continue;
              out.push({ payload: a.payload });
            }
            return { results: out.slice(-5).reverse() as T[] };
          }
          if (q.startsWith("SELECT provider FROM oauth_tokens WHERE org_id = ?")) {
            return { results: t.oauth_tokens.filter((x) => x.org_id === p[0]).map((x) => ({ provider: x.provider })) as T[] };
          }
          if (q.startsWith("SELECT server_id FROM mcp_credentials WHERE org_id = ?")) {
            return { results: t.mcp_credentials.filter((x) => x.org_id === p[0]).map((x) => ({ server_id: x.server_id })) as T[] };
          }
          if (q.startsWith("SELECT seat_id FROM seat_tools WHERE mcp_server_id = ?")) {
            return { results: t.seat_tools.filter((x) => x.mcp_server_id === p[0]).map((x) => ({ seat_id: x.seat_id })) as T[] };
          }
          if (q.startsWith("SELECT p.seat_id, p.status FROM seat_provisions p JOIN seats s")) {
            const out: Row[] = [];
            for (const pr of t.seat_provisions) {
              if (pr.tool !== p[1]) continue;
              const s = t.seats.find((x) => x.id === pr.seat_id);
              const team = s ? t.teams.find((x) => x.id === s.team_id) : null;
              if (!s || !team || team.org_id !== p[0]) continue;
              out.push({ seat_id: pr.seat_id, status: pr.status });
            }
            return { results: out as T[] };
          }
          if (q.startsWith("SELECT id FROM seats WHERE frozen_at IS NOT NULL")) {
            return { results: t.seats.filter((x) => x.frozen_at).map((x) => ({ id: x.id })) as T[] };
          }
          if (q.startsWith("SELECT mcp_server_id FROM seat_tools WHERE seat_id = ?")) {
            return { results: t.seat_tools.filter((r) => r.seat_id === p[0]) as T[] };
          }
          if (q.startsWith("SELECT tool, kind, login_user, status, updated_at, expires_at FROM seat_credentials")) {
            return { results: t.seat_credentials.filter((r) => r.seat_id === p[0]) as T[] };
          }
          if (q.startsWith("SELECT id, from_addr, subject, substr(body, 1, 2000) AS body, read_at, created_at FROM seat_mail")) {
            const unreadOnly = q.includes("AND read_at IS NULL");
            return {
              results: t.seat_mail
                .filter((r) => r.seat_id === p[0] && (!unreadOnly || !r.read_at))
                .slice(-50)
                .reverse() as T[],
            };
          }
          if (q.startsWith("SELECT * FROM mcp_servers WHERE org_id = ?")) {
            return { results: t.mcp_servers.filter((r) => r.org_id === p[0]) as T[] };
          }
          if (q.includes("FROM actions") && q.includes("run_id = ?")) {
            if (q.includes("NOT IN")) {
              const reviewed = new Set(
                t.approvals.filter((r) => r.kind === "post").map((r) => r.action_id),
              );
              return {
                results: t.actions.filter(
                  (a) => a.run_id === p[0] && a.status === "done" && !reviewed.has(a.id),
                ) as T[],
              };
            }
            return { results: t.actions.filter((a) => a.run_id === p[0]) as T[] };
          }
          throw new Error(`FakeDB.all: unhandled: ${q.slice(0, 90)}`);
        },
        run: async (): Promise<{ meta: { changes: number } }> => {
          if (q.startsWith("INSERT INTO approvals")) {
            const status = q.includes("'approved'") ? "approved" : "pending";
            const [id, org_id, run_id, goal_id, action_id] = p as (string | null)[];
            const [mcp_server_id, mcp_tool, mcp_args] = q.includes("mcp_server_id")
              ? (p.slice(5, 8) as (string | null)[])
              : [null, null, null];
            if (
              q.includes("ON CONFLICT") &&
              status === "pending" &&
              t.approvals.some(
                (r) => r.run_id === run_id && r.action_id === action_id && r.status === "pending",
              )
            ) {
              return { meta: { changes: 0 } };
            }
            t.approvals.push({
              id, org_id, run_id, goal_id, kind: "post", action_id, status,
              mcp_server_id: mcp_server_id ?? null,
              mcp_tool: mcp_tool ?? null,
              mcp_args: mcp_args ?? null,
            });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE approvals SET status = ?, decided_by = ?")) {
            const row = t.approvals.find((r) => r.id === p[2] && r.status === "pending");
            if (row) {
              row.status = p[0];
              row.decided_by = p[1];
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (q.startsWith("UPDATE approvals SET status = 'approved'")) {
            const row = t.approvals.find((r) => r.id === p[2] && r.status === "pending");
            if (row) {
              row.status = "approved";
              row.note = p[0];
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (q.startsWith("INSERT INTO audit_log")) {
            t.audit_log.push({ run_id: p[0], org_id: p[1], actor: p[2], event: p[3], detail: p[4] });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO notifications")) {
            t.notifications.push({ id: p[0], org_id: p[1], kind: p[3], title: p[4], body: p[5] });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT OR IGNORE INTO stripe_events")) {
            if (!t.stripe_events.some((x) => x.event_id === p[0])) {
              t.stripe_events.push({ event_id: p[0], type: p[1] });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (q.startsWith("UPDATE orgs SET subscribed = 1")) {
            const r = t.orgs.find((x) => x.id === p[1]);
            if (r) {
              r.subscribed = 1;
              r.sub_status = "active";
              r.stripe_customer_id = p[0];
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE orgs SET subscribed = 0")) {
            const r = t.orgs.find((x) => x.stripe_customer_id === p[0]);
            if (r) {
              r.subscribed = 0;
              r.sub_status = "canceled";
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE orgs SET sub_status = ? WHERE id = ?")) {
            const r = t.orgs.find((x) => x.id === p[1]);
            if (r) r.sub_status = p[0];
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE proposals_out SET status = 'started'")) {
            const r = t.proposals_out.find((x) => x.id === p[2]);
            if (r) {
              r.status = "started";
              r.run_id = p[0];
              r.goal_id = p[1];
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE proposals_out SET status = 'held'")) {
            const r = t.proposals_out.find((x) => x.id === p[0]);
            if (r) r.status = "held";
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE proposals_out SET status = 'rejected'")) {
            const r = t.proposals_out.find((x) => x.id === p[0]);
            if (r) r.status = "rejected";
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE oauth_tokens SET access_token_enc = ?")) {
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO actions (id, run_id, kind, target, payload, status)")) {
            t.actions.push({ id: p[0], run_id: p[1], kind: p[2], target: p[3], payload: p[4], status: "done" });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE actions SET status = 'reverted' WHERE id = ?")) {
            const r = t.actions.find((x) => x.id === p[0]);
            if (r) r.status = "reverted";
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE actions SET status = 'skipped' WHERE id = ?")) {
            const r = t.actions.find((x) => x.id === p[0]);
            if (r) r.status = "skipped";
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE actions SET status = 'done', payload = ?, proof = ? WHERE id = ?")) {
            const r = t.actions.find((x) => x.id === p[2]);
            if (r) {
              r.status = "done";
              r.payload = p[0];
              r.proof = p[1];
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE actions SET status = 'failed', payload = ? WHERE id = ?")) {
            const r = t.actions.find((x) => x.id === p[1]);
            if (r) {
              r.status = "failed";
              r.payload = p[0];
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO mcp_servers")) {
            const [id, org_id, name, url, auth, auth_name, source, status, box_argv] = p as string[];
            t.mcp_servers.push({ id, org_id, name, url, auth, auth_name, source, status, spend_cap_cents: 0, box_argv: box_argv ?? "" });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM mcp_credentials")) {
            t.mcp_credentials = t.mcp_credentials.filter(
              (x) => !(x.org_id === p[0] && x.server_id === p[1]),
            );
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM oauth_tokens WHERE org_id = ? AND provider = ?")) {
            const n = t.oauth_tokens.length;
            t.oauth_tokens = t.oauth_tokens.filter((x) => !(x.org_id === p[0] && x.provider === p[1]));
            return { meta: { changes: n - t.oauth_tokens.length } };
          }
          if (q.startsWith("UPDATE orgs SET seat_cutover = 1")) {
            const r = t.orgs.find((x) => x.id === p[0]);
            if (r) r.seat_cutover = 1;
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE seats SET hired = 0, approved = 0, frozen_at = datetime('now')")) {
            const r = t.seats.find((x) => x.id === p[0]);
            if (r) {
              r.hired = 0;
              r.approved = 0;
              r.frozen_at = "2020-01-01 00:00:00";
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM seat_credentials WHERE seat_id = ?")) {
            t.seat_credentials = t.seat_credentials.filter((x) => x.seat_id !== p[0]);
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM seat_mail WHERE seat_id = ?")) {
            t.seat_mail = t.seat_mail.filter((x) => x.seat_id !== p[0]);
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM seat_provisions WHERE seat_id = ?")) {
            t.seat_provisions = t.seat_provisions.filter((x) => x.seat_id !== p[0]);
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM seat_requests WHERE seat_id = ?")) {
            t.seat_requests = t.seat_requests.filter((x) => x.seat_id !== p[0]);
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM box_runs WHERE seat_id = ?")) {
            t.box_runs = t.box_runs.filter((x) => x.seat_id !== p[0]);
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM seats WHERE id = ?")) {
            t.seats = t.seats.filter((x) => x.id !== p[0]);
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM mcp_servers")) {
            const n = t.mcp_servers.length;
            t.mcp_servers = t.mcp_servers.filter((x) => !(x.org_id === p[0] && x.id === p[1]));
            return { meta: { changes: n - t.mcp_servers.length } };
          }
          if (q.startsWith("UPDATE mcp_servers SET status = ?")) {
            const r = t.mcp_servers.find((x) => x.org_id === p[1] && x.id === p[2]);
            if (r) r.status = p[0];
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (q.startsWith("UPDATE mcp_servers SET spend_cap_cents = ?")) {
            const r = t.mcp_servers.find((x) => x.org_id === p[1] && x.id === p[2]);
            if (r) r.spend_cap_cents = p[0];
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (q.startsWith("INSERT INTO mcp_credentials")) {
            // setSecret binds (id, org, server, label, enc); finishOAuth
            // binds (id, org, server, enc, refreshEnc, expiresAt) with a
            // literal label — same prefix, different shapes.
            const oauth = q.includes("refresh_token_enc");
            const [id, org_id, server_id, b3, b4, b5] = p as (string | null)[];
            t.mcp_credentials = t.mcp_credentials.filter(
              (x) => !(x.org_id === org_id && x.server_id === server_id),
            );
            t.mcp_credentials.push(
              oauth
                ? {
                    id, org_id, server_id, label: "oauth", secret_enc: b3,
                    refresh_token_enc: b4 ?? null, expires_at: b5 ?? null,
                  }
                : {
                    id, org_id, server_id, label: b3, secret_enc: b4,
                    refresh_token_enc: null, expires_at: null,
                  },
            );
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO mcp_oauth_clients")) {
            const [server_id, org_id, client_id, client_secret_enc, authorization_endpoint, token_endpoint, scope, code_verifier] = p as (string | null)[];
            t.mcp_oauth_clients = t.mcp_oauth_clients.filter((x) => x.server_id !== server_id);
            t.mcp_oauth_clients.push({
              server_id, org_id, client_id, client_secret_enc, authorization_endpoint,
              token_endpoint, scope, code_verifier, status: "pending",
            });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE mcp_oauth_clients SET status = 'connected'")) {
            const r = t.mcp_oauth_clients.find((x) => x.server_id === p[0]);
            if (r) {
              r.status = "connected";
              r.code_verifier = null;
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE mcp_credentials SET secret_enc = ?, refresh_token_enc = ?")) {
            const r = t.mcp_credentials.find((x) => x.org_id === p[3] && x.server_id === p[4]);
            if (r) {
              r.secret_enc = p[0];
              r.refresh_token_enc = p[1];
              r.expires_at = p[2];
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE mcp_credentials SET secret_enc = ?")) {
            const r = t.mcp_credentials.find((x) => x.org_id === p[1] && x.server_id === p[2]);
            if (r) r.secret_enc = p[0];
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO seat_credentials")) {
            const [id, org_id, seat_id, tool, kind, login_user, secret_enc, refresh_token_enc, expires_at] = p as (string | null)[];
            t.seat_credentials = t.seat_credentials.filter(
              (x) => !(x.seat_id === seat_id && x.tool === tool),
            );
            t.seat_credentials.push({ id, org_id, seat_id, tool, kind, login_user, secret_enc, refresh_token_enc: refresh_token_enc ?? null, expires_at: expires_at ?? null, status: "ok" });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE seat_credentials SET status = 'lost'")) {
            const r = t.seat_credentials.find(
              (x) => x.org_id === p[0] && x.seat_id === p[1] && x.tool === p[2] && x.status === "ok",
            );
            if (!r) return { meta: { changes: 0 } };
            r.status = "lost";
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM seat_credentials WHERE org_id = ? AND seat_id = ? AND tool = ?")) {
            const n = t.seat_credentials.length;
            t.seat_credentials = t.seat_credentials.filter(
              (x) => !(x.org_id === p[0] && x.seat_id === p[1] && x.tool === p[2]),
            );
            return { meta: { changes: n - t.seat_credentials.length } };
          }
          if (q.startsWith("DELETE FROM seat_credentials WHERE org_id = ? AND seat_id = ?")) {
            const n = t.seat_credentials.length;
            t.seat_credentials = t.seat_credentials.filter(
              (x) => !(x.org_id === p[0] && x.seat_id === p[1]),
            );
            return { meta: { changes: n } };
          }
          if (q.startsWith("DELETE FROM seat_tools WHERE seat_id = ? AND mcp_server_id = ?")) {
            const n = t.seat_tools.length;
            t.seat_tools = t.seat_tools.filter(
              (x) => !(x.seat_id === p[0] && x.mcp_server_id === p[1]),
            );
            return { meta: { changes: n - t.seat_tools.length } };
          }
          if (q.startsWith("DELETE FROM seat_tools WHERE seat_id = ?")) {
            t.seat_tools = t.seat_tools.filter((x) => x.seat_id !== p[0]);
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT OR IGNORE INTO seat_tools")) {
            if (!t.seat_tools.some((x) => x.seat_id === p[0] && x.mcp_server_id === p[1])) {
              t.seat_tools.push({ seat_id: p[0], mcp_server_id: p[1] });
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO org_seat_map")) {
            t.org_seat_map = t.org_seat_map.filter((x) => !(x.org_id === p[0] && x.role === p[1]));
            t.org_seat_map.push({ org_id: p[0], role: p[1], tools_json: p[2] });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO seat_requests")) {
            const [id, org_id, seat_id, tools_json, decided_by] = p as string[];
            const approved = q.includes("'approved'");
            t.seat_requests.push({
              id, org_id, seat_id, tools_json,
              status: approved ? "approved" : "proposed",
              decided_by: approved ? decided_by : null,
              created_at: "",
            });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE seat_requests SET tools_json = ?")) {
            const r = t.seat_requests.find((x) => x.id === p[1]);
            if (r) {
              r.tools_json = p[0] as string;
              r.nudged_at = null;
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE seat_requests SET nudged_at = datetime('now')")) {
            const r = t.seat_requests.find((x) => x.id === p[0]);
            if (r) r.nudged_at = "2999-01-01 00:00:00";
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO goals (id, org_id, team_id, title")) {
            const [id, org_id, team_id, title] = p as string[];
            t.goals.push({ id, org_id, team_id, title, squad: "[]", status: "active" });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO goal_events (goal_id, kind, title, detail)")) {
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO seat_milestones")) {
            const [seat_id, milestone] = p as string[];
            if (t.seat_milestones.some((x) => x.seat_id === seat_id && x.milestone === milestone)) {
              throw new Error("UNIQUE constraint failed: seat_milestones");
            }
            t.seat_milestones.push({ seat_id, milestone, at: "" });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM seat_milestones WHERE seat_id = ?")) {
            t.seat_milestones = t.seat_milestones.filter(
              (x) => !(x.seat_id === p[0] && x.milestone === p[1]),
            );
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE seat_requests SET status = ?")) {
            const r = t.seat_requests.find((x) => x.id === p[3] && x.status === "proposed");
            if (r) {
              r.status = p[0];
              r.decided_by = p[1];
              r.tools_json = p[2] as string;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (q.startsWith("INSERT INTO seat_provisions")) {
            const [seat_id, tool] = p as string[];
            const r = t.seat_provisions.find((x) => x.seat_id === seat_id && x.tool === tool);
            const step = q.includes("'verify'") ? "verify" : "invite";
            const status = q.includes("'verified'") ? "verified" : "pending";
            if (r) {
              r.step = step;
              r.status = status;
              r.detail = "";
            } else {
              t.seat_provisions.push({ seat_id, tool, step, status, detail: "", attempts: 0 });
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE seat_provisions SET attempts = ?")) {
            const r = t.seat_provisions.find((x) => x.seat_id === p[1] && x.tool === p[2]);
            if (r) r.attempts = p[0] as number;
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE seat_provisions SET step = ?")) {
            const r = t.seat_provisions.find((x) => x.seat_id === p[3] && x.tool === p[4]);
            if (r) {
              r.step = p[0];
              r.status = p[1];
              r.detail = p[2];
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO box_state")) {
            const [seat_id, org_id, woken, tick] = p as [string, string, number, number];
            const r = t.box_state.find((x) => x.seat_id === seat_id);
            if (r) {
              r.status = "running";
              r.woken_at = woken;
              r.last_tick = tick;
              r.wake_count = (r.wake_count ?? 0) + 1;
            } else {
              t.box_state.push({ seat_id, org_id, status: "running", woken_at: woken, last_tick: tick, wake_count: 1 });
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO box_runs")) {
            const [id, seat_id, org_id, started_at, instance_type, woken_by] = p as [string, string, string, number, string, string];
            t.box_runs.push({ id, seat_id, org_id, started_at, stopped_at: 0, seconds: 0, instance_type, woken_by });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE box_state SET last_tick = ?")) {
            const r = t.box_state.find((x) => x.seat_id === p[1]);
            if (r) r.last_tick = p[0] as number;
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE box_state SET status = 'sleeping'")) {
            const r = t.box_state.find((x) => x.seat_id === p[1]);
            if (r) {
              r.status = "sleeping";
              r.last_tick = p[0] as number;
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE box_runs SET stopped_at = ?")) {
            const r = t.box_runs.find((x) => x.id === p[2]);
            if (r) {
              r.stopped_at = p[0] as number;
              r.seconds = p[1] as number;
            }
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM box_state WHERE seat_id = ?")) {
            t.box_state = t.box_state.filter((x) => x.seat_id !== p[0]);
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO tool_admin_grants")) {
            t.tool_admin_grants = t.tool_admin_grants.filter((x) => !(x.org_id === p[0] && x.tool === p[1]));
            t.tool_admin_grants.push({ org_id: p[0], tool: p[1], scopes_json: p[2], secret_enc: p[3], status: "granted" });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO seat_mail")) {
            const [id, org_id, seat_id, message_id, from_addr, to_addr, subject, body] = p as string[];
            t.seat_mail.push({ id, org_id, seat_id, message_id, from_addr, to_addr, subject, body, read_at: null });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE seat_mail SET read_at = datetime('now')")) {
            const r = t.seat_mail.find((x) => x.id === p[0] && x.seat_id === p[1] && !x.read_at);
            if (r) r.read_at = "now";
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (q.startsWith("INSERT INTO proposals_out (id, org_id, kind, goal_id, title, body, status, remind_at, start_at)")) {
            t.proposals_out.push({
              id: p[0], org_id: p[1], kind: "signup", goal_id: null,
              title: p[2], body: p[3], status: "proposed",
            });
            return { meta: { changes: 1 } };
          }
          throw new Error(`FakeDB.run: unhandled: ${q.slice(0, 90)}`);
        },
      }),
    };
  }
}
