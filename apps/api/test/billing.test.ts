import { describe, expect, it } from "vitest";
import type { Env } from "../src/bindings.js";
import { handleStripeWebhook } from "../src/billing.js";
import { FakeDB, blankTables } from "./fake-db.js";

const SECRET = "whsec_test";

function seed() {
  const tables = blankTables();
  tables.orgs.push({ id: "org1", subscribed: 1, sub_status: "active", stripe_customer_id: "cus_1" });
  const env = { DB: new FakeDB(tables), STRIPE_WEBHOOK_SECRET: SECRET } as unknown as Env;
  return { env, tables };
}

async function signed(env: Env, payload: string): Promise<{ header: string }> {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const v1 = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { header: `t=${t},v1=${v1}` };
}

async function fire(env: Env, id: string, type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id, type, data: { object } });
  const { header } = await signed(env, payload);
  return handleStripeWebhook(env, payload, header);
}

describe("handleStripeWebhook", () => {
  it("duns on payment failure without unsubscribing", async () => {
    const { env, tables } = seed();
    const res = await fire(env, "evt_1", "invoice.payment_failed", { customer: "cus_1" });
    expect(res.status).toBe(200);
    expect(tables.orgs[0].subscribed).toBe(1);
    expect(tables.notifications.some((n) => n.kind === "billing.past_due")).toBe(true);
  });

  it("tracks status flips and cancel-at-period-end once", async () => {
    const { env, tables } = seed();
    await fire(env, "evt_2", "customer.subscription.updated", {
      customer: "cus_1",
      status: "past_due",
      cancel_at_period_end: true,
    });
    expect(tables.orgs[0].sub_status).toBe("past_due");
    expect(tables.notifications.filter((n) => n.kind === "billing.canceling")).toHaveLength(1);
    const again = await fire(env, "evt_2", "customer.subscription.updated", {
      customer: "cus_1",
      status: "past_due",
      cancel_at_period_end: true,
    });
    expect(again.body).toEqual(expect.objectContaining({ duplicate: true }));
    expect(tables.notifications.filter((n) => n.kind === "billing.canceling")).toHaveLength(1);
  });

  it("unsubscribes on delete, resubscribes on checkout", async () => {
    const { env, tables } = seed();
    await fire(env, "evt_3", "customer.subscription.deleted", { customer: "cus_1" });
    expect(tables.orgs[0].subscribed).toBe(0);
    expect(tables.orgs[0].sub_status).toBe("canceled");
    await fire(env, "evt_4", "checkout.session.completed", {
      customer: "cus_1",
      metadata: { org: "org1" },
    });
    expect(tables.orgs[0].subscribed).toBe(1);
    expect(tables.orgs[0].sub_status).toBe("active");
  });

  it("rejects bad signatures", async () => {
    const { env } = seed();
    const res = await handleStripeWebhook(env, '{"id":"evt_x"}', "t=1,v1=dead");
    expect(res.status).toBe(400);
  });
});
