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
          if (q.startsWith("SELECT id FROM proposals_out WHERE org_id = ? AND kind = 'signup'")) {
            const r = t.proposals_out.find(
              (x) => x.org_id === p[0] && x.kind === "signup" && x.title === p[1] && (x.status === "proposed" || x.status === "reminded"),
            );
            return ((r ? { id: r.id } : null) as T) ?? null;
          }
          throw new Error(`FakeDB.first: unhandled: ${q.slice(0, 90)}`);
        },
        all: async <T>(): Promise<{ results: T[] }> => {
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
            const [id, org_id, name, url, auth, auth_name, source, status] = p as string[];
            t.mcp_servers.push({ id, org_id, name, url, auth, auth_name, source, status, spend_cap_cents: 0 });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM mcp_credentials")) {
            t.mcp_credentials = t.mcp_credentials.filter(
              (x) => !(x.org_id === p[0] && x.server_id === p[1]),
            );
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
            const [id, org_id, server_id, label, secret_enc] = p as string[];
            t.mcp_credentials = t.mcp_credentials.filter(
              (x) => !(x.org_id === org_id && x.server_id === server_id),
            );
            t.mcp_credentials.push({ id, org_id, server_id, label, secret_enc });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith("UPDATE mcp_credentials SET secret_enc = ?")) {
            const r = t.mcp_credentials.find((x) => x.org_id === p[1] && x.server_id === p[2]);
            if (r) r.secret_enc = p[0];
            return { meta: { changes: 1 } };
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
