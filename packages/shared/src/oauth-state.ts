/** Self-contained signed OAuth state: org + expiry, HMAC'd. No storage. */

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signState(
  secret: string,
  org: string,
  ttlSec = 600,
  shop?: string,
  seat?: string,
): Promise<string> {
  const nonce = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const payload = b64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        org,
        nonce,
        exp: Date.now() + ttlSec * 1000,
        ...(shop ? { shop } : {}),
        ...(seat ? { seat } : {}),
      }),
    ),
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

export interface VerifiedState {
  org: string;
  /** Shopify store domain, bound at connect time; null otherwise. */
  shop: string | null;
  /** Hire seat id for per-hire OAuth; null for org connects. */
  seat: string | null;
}

export async function verifyState(
  secret: string,
  state: string,
): Promise<VerifiedState> {
  const dot = state.indexOf(".");
  if (dot < 0) throw new Error("malformed state");
  const payload = state.slice(0, dot);
  const sig = b64urlDecode(state.slice(dot + 1));
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    sig,
    new TextEncoder().encode(payload),
  );
  if (!valid) throw new Error("bad state signature");
  const { org, exp, shop, seat } = JSON.parse(
    new TextDecoder().decode(b64urlDecode(payload)),
  ) as { org: string; exp: number; shop?: unknown; seat?: unknown };
  if (typeof org !== "string" || Date.now() > exp) {
    throw new Error("state expired or invalid");
  }
  if (shop !== undefined && typeof shop !== "string") {
    throw new Error("state shop invalid");
  }
  if (seat !== undefined && typeof seat !== "string") {
    throw new Error("state seat invalid");
  }
  return { org, shop: shop ?? null, seat: seat ?? null };
}
