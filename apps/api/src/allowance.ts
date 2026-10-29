import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { notify } from "./notify.js";
import { tryDMOwner } from "./slack-in.js";

/** Nightly idea budget: unassigned work meters here, assigned work never does. */
export function tonight(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function ideaBudget(
  env: Env,
  orgId: string,
): Promise<{ cap: number; spent: number; left: number }> {
  const org = await env.DB.prepare(
    "SELECT idea_allowance_words FROM orgs WHERE id = ?",
  )
    .bind(orgId)
    .first<{ idea_allowance_words: number | null }>();
  const cap = org?.idea_allowance_words ?? 250000;
  const row = await env.DB.prepare(
    "SELECT words FROM idea_spend WHERE org_id = ? AND night = ?",
  )
    .bind(orgId, tonight())
    .first<{ words: number }>();
  const spent = row?.words ?? 0;
  return { cap, spent, left: Math.max(0, cap - spent) };
}

/**
 * Charge unassigned words. Returns false when the night is spent; the
 * first crossing queues the morning note (dashboard + DM), once.
 */
export async function chargeIdea(
  env: Env,
  orgId: string,
  words: number,
  what: string,
): Promise<boolean> {
  const { cap, spent } = await ideaBudget(env, orgId);
  if (spent >= cap) return false;
  const now = spent + words;
  await env.DB.prepare(
    `INSERT INTO idea_spend (org_id, night, words) VALUES (?, ?, ?)
     ON CONFLICT(org_id, night) DO UPDATE SET words = excluded.words`,
  )
    .bind(orgId, tonight(), now)
    .run();
  if (now >= cap) {
    await audit(env, null, "system", "allowance.exhausted", { org: orgId, what });
    const note =
      `Nightly ideas paused (${cap.toLocaleString()} words spent, last on: ${what}). ` +
      "Assigned work is unaffected. Raise the allowance in Setup, or say go in the morning.";
    await notify(env, orgId, { kind: "allowance.exhausted", title: "Nightly ideas paused", body: note });
    await tryDMOwner(env, orgId, note).catch(() => {});
  }
  return true;
}
