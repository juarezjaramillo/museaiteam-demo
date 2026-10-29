import { buildDigest } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit, getRun } from "./db.js";

/**
 * Owner digest for a finished run. Sends at most once: the claim UPDATE
 * flips digest_sent 0→1 only for the first caller, so step retries can
 * never double-send. Failures are audited, never thrown into the run.
 */
export async function sendRunDigest(env: Env, runId: string): Promise<void> {
  const run = await getRun(env, runId);
  if (!run) return;
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    await audit(env, runId, "workflow", "digest.skipped", {
      reason: "email not configured",
    });
    return;
  }
  const owner = await env.DB.prepare(
    "SELECT u.email FROM orgs o JOIN users u ON u.id = o.owner_user_id WHERE o.id = ?",
  )
    .bind(run.org_id)
    .first<{ email: string | null }>();
  if (!owner?.email) {
    await audit(env, runId, "workflow", "digest.skipped", {
      reason: "no owner email",
    });
    return;
  }
  const claimed = await env.DB.prepare(
    "UPDATE runs SET digest_sent = 1 WHERE id = ? AND digest_sent = 0",
  )
    .bind(runId)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return;
  try {
    const ruling = await env.DB.prepare(
      "SELECT decision, decided_by FROM rulings WHERE run_id = ?",
    )
      .bind(runId)
      .first<{ decision: string; decided_by: string }>();
    const skipped = await env.DB.prepare(
      "SELECT kind, payload FROM actions WHERE run_id = ? AND status = 'skipped' ORDER BY rowid",
    )
      .bind(runId)
      .all<{ kind: string; payload: string }>();
    const { subject, text } = buildDigest({
      appUrl: env.APP_URL,
      goal: run.goal,
      decision: ruling?.decision,
      decidedBy: ruling?.decided_by,
      skipped: (skipped.results ?? []).map((r) => {
        let reason = "unknown";
        try {
          const p = JSON.parse(r.payload) as { reason?: unknown };
          if (typeof p.reason === "string") reason = p.reason;
        } catch {
          /* keep unknown */
        }
        return { kind: r.kind, reason };
      }),
    });
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [owner.email],
        subject,
        text,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
    };
    if (!res.ok || !json.id) {
      throw new Error(`Resend: ${res.status} ${(json.message ?? "").slice(0, 150)}`);
    }
    await audit(env, runId, "workflow", "digest.sent", {
      to: owner.email,
      id: json.id,
    });
  } catch (err) {
    await audit(env, runId, "workflow", "digest.failed", {
      error: String(err).slice(0, 300),
    });
  }
}
