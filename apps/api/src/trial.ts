import {
  graceEndsAt,
  trialDecision,
  trialStatus,
  type TrialRow,
  type TrialStatus,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";

export interface TrialGate {
  allowed: boolean;
  status: TrialStatus;
  /** True when this call granted the one-time grace window. */
  granted: boolean;
}

/**
 * Enforcement for run creation and baselines. Config routes never call this,
 * so trials can expire without locking the user out of their settings.
 *
 * Grace is granted by a single conditional UPDATE: only a row with
 * grace_used = 0 flips, so concurrent expired attempts cannot double-grant
 * even if they race through the decision together.
 */
export async function trialGate(env: Env, orgId: string): Promise<TrialGate> {
  const row = await env.DB.prepare(
    `SELECT trial_started_at, trial_ends_at, grace_used, subscribed
     FROM orgs WHERE id = ?`,
  )
    .bind(orgId)
    .first<TrialRow>();
  if (!row) throw new Error(`trial gate: org ${orgId} missing`);
  const now = Date.now();
  const decision = trialDecision(now, row);
  if (decision === "allow") {
    return { allowed: true, status: trialStatus(now, row), granted: false };
  }
  if (decision === "deny") {
    return { allowed: false, status: trialStatus(now, row), granted: false };
  }
  const endsAt = graceEndsAt(now);
  const granted = await env.DB.prepare(
    `UPDATE orgs SET trial_ends_at = ?, grace_used = 1
     WHERE id = ? AND grace_used = 0`,
  )
    .bind(endsAt, orgId)
    .run();
  if ((granted.meta.changes ?? 0) === 1) {
    await audit(env, null, "system", "trial.grace_granted", {
      org: orgId,
      endsAt,
    });
    return {
      allowed: true,
      status: trialStatus(now, { ...row, trial_ends_at: endsAt, grace_used: 1 }),
      granted: true,
    };
  }
  // Lost the race: re-read so the denial reports the true window.
  const fresh = await env.DB.prepare(
    `SELECT trial_started_at, trial_ends_at, grace_used, subscribed
     FROM orgs WHERE id = ?`,
  )
    .bind(orgId)
    .first<TrialRow>();
  if (!fresh) throw new Error(`trial gate: org ${orgId} missing`);
  const retryNow = Date.now();
  return {
    allowed: trialDecision(retryNow, fresh) === "allow",
    status: trialStatus(retryNow, fresh),
    granted: false,
  };
}

export function trialExpiredBody(status: TrialStatus) {
  return {
    error: "trial_expired",
    trial: status,
    subscribe: { pricePerWorker: "$499", checkoutUrl: null as string | null },
    message: "Trial expired — subscribe to keep running ($499/worker).",
  };
}
