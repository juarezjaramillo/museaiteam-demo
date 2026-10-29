import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { notify } from "./notify.js";

/**
 * In-house error capture: every report audits; owner email fires at
 * most once per kind per hour so a loop can't spam the inbox.
 */
export async function reportError(
  env: Env,
  input: { org?: string; run?: string; kind: string; error: unknown },
): Promise<void> {
  const message = String(input.error ?? "unknown").slice(0, 300);
  await audit(env, input.run ?? null, "system", `error.${input.kind}`, {
    org: input.org ?? null,
    error: message,
  }).catch(() => {});
  const hour = new Date().toISOString().slice(0, 13);
  const job = `err:${input.kind}`;
  try {
    const mark = await env.DB.prepare("SELECT value FROM job_markers WHERE job = ?")
      .bind(job)
      .first<{ value: string }>();
    if (mark?.value === hour) return;
    await env.DB.prepare(
      "INSERT INTO job_markers (job, value) VALUES (?, ?) ON CONFLICT(job) DO UPDATE SET value = excluded.value",
    )
      .bind(job, hour)
      .run();
  } catch {
    return;
  }
  if (input.org) {
    await notify(env, input.org, {
      kind: "error.spike",
      title: `Something broke (${input.kind})`,
      body: `${message}\nThe team logged it and kept going where it could.`,
    }).catch(() => {});
  }
}

/** Cron wrapper: a throwing tick reports instead of dying silently. */
export function guardTick(env: Env, kind: string, fn: () => Promise<unknown>): Promise<void> {
  return fn()
    .then(() => {})
    .catch((err) => reportError(env, { kind, error: err }));
}

/** Fail-rate watch: too many failed runs in an hour pages the owner. */
export async function tickErrorWatch(env: Env): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE event = 'run.failed'
     AND datetime(created_at) > datetime('now', '-1 hour')`,
  ).first<{ n: number }>();
  if ((row?.n ?? 0) > 5) {
    await reportError(env, { kind: "run_fail_rate", error: `${row?.n} failed runs in the last hour` });
  }
}
