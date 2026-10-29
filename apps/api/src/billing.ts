import {
  PRICE_PER_WORKER_CENTS,
  allowanceFor,
  buildUpgradeEmail,
  fairUseBand,
  isThrottled,
  perWorker,
  runsAllowedToday,
  verifyStripeSignature,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { notify } from "./notify.js";

export interface Meter {
  month: string;
  totalTokens: number;
  seats: number;
  allowance: number;
  perWorker: number;
  throttled: boolean;
}

export async function rosterSeats(env: Env, orgId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM seats s
     JOIN teams t ON t.id = s.team_id
     WHERE t.org_id = ? AND s.hired = 1`,
  )
    .bind(orgId)
    .first<{ n: number }>();
  return Math.max(1, row?.n ?? 0);
}

export async function monthUsage(
  env: Env,
  orgId: string,
): Promise<{ month: string; total: number }> {
  const row = await env.DB.prepare(
    `SELECT strftime('%Y-%m', 'now') AS month,
            COALESCE(SUM(tokens_used), 0) AS total
     FROM runs WHERE org_id = ?
       AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`,
  )
    .bind(orgId)
    .first<{ month: string; total: number }>();
  return { month: row?.month ?? "", total: row?.total ?? 0 };
}

export async function getMeter(env: Env, orgId: string): Promise<Meter> {
  const seats = await rosterSeats(env, orgId);
  const { month, total } = await monthUsage(env, orgId);
  return {
    month,
    totalTokens: total,
    seats,
    allowance: allowanceFor(seats),
    perWorker: perWorker(total, seats),
    throttled: isThrottled(total, seats),
  };
}

export async function checkFairUse(
  env: Env,
  orgId: string,
): Promise<{ allowed: boolean; meter: Meter; runsToday: number }> {
  const meter = await getMeter(env, orgId);
  if (!meter.throttled) return { allowed: true, meter, runsToday: 0 };
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM runs
     WHERE org_id = ? AND date(created_at) = date('now')`,
  )
    .bind(orgId)
    .first<{ n: number }>();
  const runsToday = row?.n ?? 0;
  return { allowed: runsAllowedToday(true, runsToday), meter, runsToday };
}

async function ownerEmail(env: Env, orgId: string): Promise<string | null> {
  const owner = await env.DB.prepare(
    "SELECT u.email FROM orgs o JOIN users u ON u.id = o.owner_user_id WHERE o.id = ?",
  )
    .bind(orgId)
    .first<{ email: string | null }>();
  return owner?.email ?? null;
}

/** Upgrade nudge, at most one per org per day. Failures stay silent: the
 *  403 the founder already got is the signal; email is a courtesy. */
/**
 * One 80%-of-allowance nudge per org per month, email + in-app. Called
 * from every terminal path once tokens are final.
 */
export async function maybeSendFairUseAlert(env: Env, orgId: string): Promise<void> {
  const meter = await getMeter(env, orgId);
  if (fairUseBand(meter.totalTokens, meter.seats) !== "watch") return;
  const month = new Date().toISOString().slice(0, 7);
  const sent = await env.DB.prepare(
    `SELECT 1 AS x FROM audit_log WHERE run_id IS NULL AND actor = 'system'
     AND event = 'fair_use.alert_sent' AND detail LIKE ? AND detail LIKE ? LIMIT 1`,
  )
    .bind(`%"org":"${orgId}"%`, `%${month}%`)
    .first<{ x: number }>();
  if (sent) return;
  await notify(env, orgId, {
    kind: "fair_use.watch",
    title: `Usage at 80%: ${meter.totalTokens.toLocaleString("en-US")} words`,
    body: `${meter.seats} workers share ${allowanceFor(meter.seats).toLocaleString("en-US")} words a month. Past 100%, slowed to 1 session a day.`,
  });
  await audit(env, null, "system", "fair_use.alert_sent", {
    org: orgId,
    month,
    totalTokens: meter.totalTokens,
    seats: meter.seats,
  });
}

export async function maybeSendUpgradeEmail(
  env: Env,
  orgId: string,
  meter: Meter,
): Promise<void> {
  const sent = await env.DB.prepare(
    `SELECT 1 AS x FROM audit_log
     WHERE run_id IS NULL AND actor = 'system' AND event = 'fair_use.email_sent'
       AND detail LIKE '%' || ? || '%' AND date(created_at) = date('now')`,
  )
    .bind(`"org":"${orgId}"`)
    .first<{ x: number }>();
  if (sent) return;
  const to = await ownerEmail(env, orgId);
  if (!to || !env.RESEND_API_KEY || !env.MAIL_FROM) return;
  try {
    const { subject, text } = buildUpgradeEmail({
      appUrl: env.APP_URL,
      totalTokens: meter.totalTokens,
      seats: meter.seats,
    });
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
    });
    if (!res.ok) return;
    await audit(env, null, "system", "fair_use.email_sent", { org: orgId });
  } catch {
    /* courtesy only */
  }
}

export function stripeConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/** One Checkout session per call: $499 × roster seats, monthly. */
export async function createCheckoutSession(
  env: Env,
  orgId: string,
): Promise<string> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("stripe not configured");
  const seats = await rosterSeats(env, orgId);
  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price_data][unit_amount]": String(PRICE_PER_WORKER_CENTS),
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][product_data][name]": "AI Team worker",
    "line_items[0][quantity]": String(seats),
    success_url: `${env.APP_URL}/?billing=success`,
    cancel_url: `${env.APP_URL}/?billing=cancelled`,
    "metadata[org]": orgId,
  });
  const email = await ownerEmail(env, orgId);
  if (email) form.set("customer_email", email);
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    url?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.url) {
    throw new Error(`Stripe checkout failed: ${json.error?.message ?? res.status}`);
  }
  return json.url;
}

interface WebhookResult {
  status: 200 | 400 | 503;
  body: Record<string, unknown>;
}

/**
 * Stripe webhook: signature first, idempotency second, effects last. Retried
 * deliveries hit the stripe_events primary key and return 200 without
 * reapplying, so double-processing is unrepresentable.
 */
export async function handleStripeWebhook(
  env: Env,
  rawBody: string,
  sigHeader: string,
): Promise<WebhookResult> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return { status: 503, body: { error: "stripe not configured" } };
  }
  if (!(await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET))) {
    return { status: 400, body: { error: "bad signature" } };
  }
  let evt: {
    id?: unknown;
    type?: unknown;
    data?: { object?: Record<string, unknown> };
  };
  try {
    evt = JSON.parse(rawBody) as typeof evt;
  } catch {
    return { status: 400, body: { error: "bad payload" } };
  }
  if (typeof evt.id !== "string" || typeof evt.type !== "string") {
    return { status: 400, body: { error: "bad payload" } };
  }
  const seen = await env.DB.prepare(
    "INSERT OR IGNORE INTO stripe_events (event_id, type) VALUES (?, ?)",
  )
    .bind(evt.id, evt.type)
    .run();
  if ((seen.meta.changes ?? 0) === 0) {
    return { status: 200, body: { received: true, duplicate: true } };
  }
  const obj = evt.data?.object ?? {};
  if (evt.type === "checkout.session.completed") {
    const meta = obj.metadata as Record<string, unknown> | undefined;
    const org = meta?.org;
    if (typeof org === "string" && org) {
      await env.DB.prepare(
        "UPDATE orgs SET subscribed = 1, sub_status = 'active', stripe_customer_id = ? WHERE id = ?",
      )
        .bind(
          typeof obj.customer === "string" ? obj.customer : null,
          org,
        )
        .run();
      await audit(env, null, "system", "billing.subscribed", { org });
    }
  } else if (evt.type === "customer.subscription.deleted") {
    if (typeof obj.customer === "string") {
      await env.DB.prepare(
        "UPDATE orgs SET subscribed = 0, sub_status = 'canceled' WHERE stripe_customer_id = ?",
      )
        .bind(obj.customer)
        .run();
      await audit(env, null, "system", "billing.unsubscribed", {
        customer: obj.customer,
      });
    }
  } else if (evt.type === "customer.subscription.updated") {
    if (typeof obj.customer === "string") {
      const status = typeof obj.status === "string" ? obj.status : "";
      const row = await env.DB.prepare(
        "SELECT id, sub_status FROM orgs WHERE stripe_customer_id = ?",
      )
        .bind(obj.customer)
        .first<{ id: string; sub_status: string }>();
      if (row && status && row.sub_status !== status) {
        await env.DB.prepare("UPDATE orgs SET sub_status = ? WHERE id = ?")
          .bind(status, row.id)
          .run();
        await audit(env, null, "system", "billing.status", {
          org: row.id,
          status,
        });
        if (status === "past_due") {
          await notify(env, row.id, {
            kind: "billing.past_due",
            title: "Card payment failed",
            body: "Stripe is retrying. Update your card to avoid a pause — the team keeps working meanwhile.",
          });
        }
        if (obj.cancel_at_period_end === true) {
          await notify(env, row.id, {
            kind: "billing.canceling",
            title: "Subscription ends after this cycle",
            body: "Access continues until the period ends. Resubscribe anytime to keep the team.",
          });
        }
      }
    }
  } else if (evt.type === "invoice.payment_failed") {
    if (typeof obj.customer === "string") {
      const row = await env.DB.prepare(
        "SELECT id FROM orgs WHERE stripe_customer_id = ?",
      )
        .bind(obj.customer)
        .first<{ id: string }>();
      if (row) {
        await audit(env, null, "system", "billing.payment_failed", { org: row.id });
        await notify(env, row.id, {
          kind: "billing.past_due",
          title: "Card payment failed",
          body: "Stripe will retry automatically. Update your card in Billing to be safe.",
        });
      }
    }
  }
  return { status: 200, body: { received: true } };
}
