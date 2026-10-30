import type { Env } from "./bindings.js";

export class OrgRetired extends Error {}

/**
 * True once the org finished the per-hire cutover: hire paths read
 * seat credentials only, and org credential rows stop being written.
 * Lives here so every reader/writer shares one flag with no cycles.
 */
export async function orgCutOver(env: Env, orgId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT seat_cutover FROM orgs WHERE id = ?")
    .bind(orgId)
    .first<{ seat_cutover: number }>();
  return (row?.seat_cutover ?? 0) === 1;
}

export interface RunRow {
  id: string;
  org_id: string;
  goal_id: string | null;
  kind: string;
  parent_run_id: string | null;
  goal: string;
  metric_name: string | null;
  metric_baseline: number | null;
  metric_target: number | null;
  timebox_days: number | null;
  status: string;
  team_id: string | null;
  kill_flag: number;
  vote_window_ms: number;
  lineup: string;
  rounds_used: number;
  tokens_used: number;
  brief_note: string;
  self_critique: string | null;
}

export async function getRun(env: Env, runId: string): Promise<RunRow | null> {
  return env.DB.prepare("SELECT * FROM runs WHERE id = ?")
    .bind(runId)
    .first<RunRow>();
}

export type Liveness = "alive" | "halted" | "capped" | "missing";

/**
 * Every Workflow step calls this first. Returns a verdict instead of
 * throwing: thrown error identity does not survive step retries (errors
 * are serialized between attempts), so control flow rides on return
 * values and only genuinely unexpected failures throw.
 */
export async function checkLiveness(
  env: Env,
  runId: string,
  maxRounds: number,
): Promise<{ liveness: Liveness; run: RunRow | null }> {
  const run = await getRun(env, runId);
  if (!run) return { liveness: "missing", run };
  if (run.kill_flag === 1 || run.status === "halted") {
    return { liveness: "halted", run };
  }
  if (run.rounds_used >= maxRounds) {
    return { liveness: "capped", run };
  }
  return { liveness: "alive", run };
}

export async function touchRun(
  env: Env,
  runId: string,
  patch: {
    status?: string;
    rounds_used?: number;
    tokens_used?: number;
    lineup?: string[];
  },
): Promise<void> {
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.lineup !== undefined) {
    sets.push("lineup = ?");
    vals.push(JSON.stringify(patch.lineup));
  }
  if (patch.rounds_used !== undefined) {
    sets.push("rounds_used = ?");
    vals.push(patch.rounds_used);
  }
  if (patch.tokens_used !== undefined) {
    sets.push("tokens_used = tokens_used + ?");
    vals.push(patch.tokens_used);
  }
  vals.push(runId);
  await env.DB.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
}

export async function audit(
  env: Env,
  runId: string | null,
  actor: string,
  event: string,
  detail: unknown = {},
): Promise<void> {
  // Org scope without touching 60 call sites: an explicit detail.org wins,
  // otherwise the run's org resolves it. Run-less system rows stay null.
  let orgId: string | null = null;
  if (
    detail &&
    typeof detail === "object" &&
    typeof (detail as { org?: unknown }).org === "string"
  ) {
    orgId = (detail as { org: string }).org;
  } else if (runId) {
    try {
      const row = await env.DB.prepare("SELECT org_id FROM runs WHERE id = ?")
        .bind(runId)
        .first<{ org_id: string }>();
      orgId = row?.org_id ?? null;
    } catch {
      /* org scope is best-effort; the row still lands */
    }
  }
  await env.DB.prepare(
    "INSERT INTO audit_log (run_id, org_id, actor, event, detail) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(runId, orgId, actor, event, JSON.stringify(detail))
    .run();
}
