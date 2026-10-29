// Billing math + Stripe webhook verification. Pure so the fair-use
// boundaries and the signature check are unit-tested; the API only
// supplies sums from D1 and the raw webhook body.

export const PRICE_PER_WORKER_CENTS = 49900;
export const FAIR_USE_TOKENS_PER_WORKER = 25_000_000;
export const THROTTLED_RUNS_PER_DAY = 1;
const WEBHOOK_TOLERANCE_SEC = 300;

/** Monthly token allowance scales with roster size. */
export function allowanceFor(seats: number): number {
  return Math.max(1, seats) * FAIR_USE_TOKENS_PER_WORKER;
}

export function perWorker(totalTokens: number, seats: number): number {
  return Math.floor(totalTokens / Math.max(1, seats));
}

export function isThrottled(totalTokens: number, seats: number): boolean {
  return totalTokens > allowanceFor(seats);
}

export type FairUseBand = "ok" | "watch" | "throttled";

/** Usage band: watch at 80% of allowance, throttled past 100%. */
export function fairUseBand(totalTokens: number, seats: number): FairUseBand {
  if (isThrottled(totalTokens, seats)) return "throttled";
  return totalTokens >= allowanceFor(seats) * 0.8 ? "watch" : "ok";
}

/** Throttled orgs get one run per calendar day; everyone else is unmetered. */
export function runsAllowedToday(throttled: boolean, runsToday: number): boolean {
  if (!throttled) return true;
  return runsToday < THROTTLED_RUNS_PER_DAY;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies a Stripe webhook signature header (`t=...,v1=...`). Fails
 * closed on malformed headers, stale timestamps, and mismatched HMACs.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1 ?? "";
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(nowSec - t) > WEBHOOK_TOLERANCE_SEC) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${t}.${payload}`),
  );
  const expected = hex(new Uint8Array(sig));
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  return diff === 0;
}

export interface UpgradeEmailInput {
  appUrl: string;
  totalTokens: number;
  seats: number;
}

export function buildUpgradeEmail(input: UpgradeEmailInput): {
  subject: string;
  text: string;
} {
  return {
    subject: "[AI Team] Usage cap reached — slowed to 1 session a day",
    text: [
      `Your team used ${input.totalTokens.toLocaleString("en-US")} words this month.`,
      `Split across ${input.seats} workers (${(FAIR_USE_TOKENS_PER_WORKER / 1_000_000).toFixed(0)}M words each).`,
      "",
      "Slowed to 1 session a day until next month.",
      "Add workers to raise the cap:",
      "",
      `Manage billing: ${input.appUrl}`,
    ].join("\n"),
  };
}
