/** Shared fetch for vendor APIs: every call times out, and a 429
 * surfaces as a typed error carrying the vendor's retry-after so
 * callers can back off instead of hammering. */

export const PROVIDER_TIMEOUT_MS = 15_000;

export class ProviderRateLimited extends Error {
  readonly retryAfterSec: number;

  constructor(provider: string, retryAfterSec: number) {
    super(`${provider} is rate-limiting us — retry in ${retryAfterSec}s`);
    this.name = "ProviderRateLimited";
    this.retryAfterSec = retryAfterSec;
  }
}

function isPrivateV4(a: number, b: number): boolean {
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * URLs fetched from our own edge must be public http(s): no
 * localhost, LAN, link-local, or single-number IPs hiding one.
 * Throws a plain Error naming the problem.
 */
export function assertPublicHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("that is not a URL we can reach (http or https)");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("server URLs must be http or https");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    host === "[::1]" ||
    /^\[?fe[89ab][0-9a-f]*:/.test(host) ||
    /^\[?(fc|fd)[0-9a-f]*:/.test(host)
  ) {
    throw new Error("server URLs must be public, not local addresses");
  }
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (
      Number.isSafeInteger(n) &&
      n >= 0 &&
      n <= 0xffffffff &&
      isPrivateV4((n >>> 24) & 255, (n >>> 16) & 255)
    ) {
      throw new Error("server URLs must be public, not private addresses");
    }
    return;
  }
  const quad = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    if ([a, b, c, d].every((o) => o >= 0 && o <= 255) && isPrivateV4(a, b)) {
      throw new Error("server URLs must be public, not private addresses");
    }
  }
}

export function retryAfterSec(headers: Headers): number {
  const raw = Number(headers.get("retry-after"));
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.ceil(raw), 300);
  return 60;
}

export async function providerFetch(
  provider: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 429) {
    throw new ProviderRateLimited(provider, retryAfterSec(res.headers));
  }
  return res;
}
