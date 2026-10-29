import type { Env } from "./bindings.js";
import { audit } from "./db.js";

const OPEN_GRACE_MS = 5 * 60 * 1000;
const WINDOW_SLACK_MS = 5 * 60 * 1000;

interface CandidateRow {
  id: string;
  status: string;
  vote_window_ms: number;
  updated_at: string;
}

/**
 * Workflow starts can silently never arrive (observed once remotely: a run
 * sat `open` with no workflow-side rows). Instead of trusting every start,
 * a cron sweeper fails runs that never left `open`, or never left
 * `debating` past their window, with an audit trail. Visible failure beats
 * silent stuck-forever; auto-retrigger is deliberately out (a slow original
 * plus a retrigger would double-run).
 */
export async function sweepStuckRuns(env: Env): Promise<string[]> {
  const now = Date.now();
  const res = await env.DB.prepare(
    `SELECT id, status, vote_window_ms, updated_at FROM runs
     WHERE status IN ('open', 'debating')`,
  ).all<CandidateRow>();
  const failed: string[] = [];
  for (const row of res.results ?? []) {
    const ageMs = now - Date.parse(`${row.updated_at}Z`);
    const grace =
      row.status === "open" ? OPEN_GRACE_MS : row.vote_window_ms + WINDOW_SLACK_MS;
    if (ageMs < grace) continue;
    await env.DB.prepare(
      "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status = ?",
    )
      .bind(row.id, row.status)
      .run();
    await audit(env, row.id, "sweeper", "run.orphaned", {
      stuckIn: row.status,
      ageMs,
    });
    failed.push(row.id);
  }
  return failed;
}
