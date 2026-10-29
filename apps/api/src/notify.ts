import type { Env } from "./bindings.js";
import { audit } from "./db.js";

export interface Notice {
  kind: string;
  title: string;
  body?: string;
  link?: string;
  /** Null = org-wide (visible to every seat); §8 adds per-user targeting. */
  userId?: string | null;
}

/**
 * Every notifiable event lands in two places: a dashboard row and an
 * owner email. Either half may fail silently — the audit row records
 * what happened, and callers never throw on notifications.
 */
export async function notify(
  env: Env,
  orgId: string,
  notice: Notice,
): Promise<void> {
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO notifications (id, org_id, user_id, kind, title, body, link)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        orgId,
        notice.userId ?? null,
        notice.kind,
        notice.title,
        notice.body ?? "",
        notice.link ?? "",
      )
      .run();
  } catch (err) {
    await audit(env, null, "system", "notify.row_failed", {
      org: orgId,
      kind: notice.kind,
      error: String(err).slice(0, 200),
    });
    return;
  }
  const owner = await env.DB.prepare(
    "SELECT u.email FROM orgs o JOIN users u ON u.id = o.owner_user_id WHERE o.id = ?",
  )
    .bind(orgId)
    .first<{ email: string | null }>();
  if (!owner?.email || !env.RESEND_API_KEY || !env.MAIL_FROM) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [owner.email],
        subject: `[AI Team] ${notice.title}`.slice(0, 120),
        text: [notice.title, "", notice.body ?? "", "", env.APP_URL]
          .join("\n")
          .slice(0, 4000),
      }),
    });
    await audit(env, null, "system", res.ok ? "notify.sent" : "notify.failed", {
      org: orgId,
      kind: notice.kind,
      id,
    });
  } catch (err) {
    await audit(env, null, "system", "notify.failed", {
      org: orgId,
      kind: notice.kind,
      error: String(err).slice(0, 200),
    });
  }
}
