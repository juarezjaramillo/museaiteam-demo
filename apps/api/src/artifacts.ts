import type { Env } from "./bindings.js";

/** 32 url-safe random chars from 24 random bytes (no padding). */
export function newPublicToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Publish an R2 object through the public token table. Returns its /a/ URL. */
export async function publishPublicImage(
  env: Env,
  args: { orgId: string; actionId: string; r2key: string },
): Promise<{ token: string; url: string }> {
  const token = newPublicToken();
  await env.DB.prepare(
    "INSERT INTO public_images (token, r2_key, org_id, action_id) VALUES (?, ?, ?, ?)",
  )
    .bind(token, args.r2key, args.orgId, args.actionId)
    .run();
  return { token, url: `${env.API_URL}/a/${token}` };
}
