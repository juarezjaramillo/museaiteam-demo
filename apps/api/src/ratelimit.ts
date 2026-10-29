import type { Env } from "./bindings.js";

/**
 * Fixed-window rate limiter. One global object, in-memory counters:
 * eviction resets windows, which only ever fails open for a moment —
 * acceptable for abuse defense, never for billing (that's D1-metered).
 */
export class RateLimit {
  private hits = new Map<string, { count: number; reset: number }>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/check") {
      return new Response("RateLimit: POST /check", { status: 426 });
    }
    const { key, limit, windowSec } = (await req.json()) as {
      key: string;
      limit: number;
      windowSec: number;
    };
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || cur.reset <= now) {
      this.hits.set(key, { count: 1, reset: now + windowSec * 1000 });
      return Response.json({ allowed: true, remaining: limit - 1 });
    }
    if (cur.count >= limit) {
      return Response.json({ allowed: false, remaining: 0 });
    }
    cur.count += 1;
    return Response.json({ allowed: true, remaining: limit - cur.count });
  }
}

/** True when the hit fits the budget. DO errors fail open (logged). */
export async function takeHit(
  env: Env,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  try {
    const id = env.RATE_LIMIT.idFromName("global");
    const stub = env.RATE_LIMIT.get(id);
    const res = await stub.fetch("https://rate/check", {
      method: "POST",
      body: JSON.stringify({ key, limit, windowSec }),
    });
    const json = (await res.json()) as { allowed?: boolean };
    return json.allowed === true;
  } catch {
    return true;
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}
