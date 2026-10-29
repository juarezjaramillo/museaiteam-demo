import type { Env } from "./bindings.js";

/** Founder corrections and thread replies the team learns from. */
export async function addFeedback(
  env: Env,
  orgId: string,
  source: string,
  text: string,
  runId?: string,
): Promise<void> {
  const clean = text.trim().slice(0, 1000);
  if (!clean) return;
  await env.DB.prepare(
    "INSERT INTO feedback (id, org_id, source, text, run_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), orgId, source, clean, runId ?? null)
    .run();
}

export async function recallFeedback(
  env: Env,
  orgId: string,
  limit = 5,
): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT text FROM feedback WHERE org_id = ? ORDER BY rowid DESC LIMIT ?",
  )
    .bind(orgId, limit)
    .all<{ text: string }>();
  return (rows.results ?? []).map((r) => r.text);
}
