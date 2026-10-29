import type { Env } from "./bindings.js";

export interface GuardVerdict {
  allowed: boolean;
  reason: string;
}

/** Unconfigured workers inherit the wide-open demo defaults. */
export async function checkGuard(
  env: Env,
  orgId: string,
  workerRole: string,
  system: string,
  write: string,
): Promise<GuardVerdict> {
  const row = await env.DB.prepare(
    "SELECT systems, write_scope FROM guardrails WHERE org_id = ? AND worker_role = ?",
  )
    .bind(orgId, workerRole)
    .first<{ systems: string; write_scope: string }>();
  if (!row) return { allowed: true, reason: "default-open" };
  const systems = JSON.parse(row.systems) as string[];
  const scope = JSON.parse(row.write_scope) as string[];
  if (!systems.includes(system)) {
    return { allowed: false, reason: `${workerRole} may not touch ${system}` };
  }
  if (!scope.includes(write)) {
    return { allowed: false, reason: `${workerRole} may not write ${write}` };
  }
  return { allowed: true, reason: "guardrail-allow" };
}
