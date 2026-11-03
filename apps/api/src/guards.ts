import type { Env } from "./bindings.js";

export interface GuardVerdict {
  allowed: boolean;
  reason: string;
}

/** A guardrail list column: string array, or null when corrupt. */
export function parseStringList(json: string): string[] | null {
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) && arr.every((t): t is string => typeof t === "string")
      ? [...arr]
      : null;
  } catch {
    return null;
  }
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
  const systems = parseStringList(row.systems);
  const scope = parseStringList(row.write_scope);
  if (!systems || !scope) {
    return { allowed: false, reason: "guardrail misconfigured — fix it in Setup" };
  }
  if (!systems.includes(system)) {
    return { allowed: false, reason: `${workerRole} may not touch ${system}` };
  }
  if (!scope.includes(write)) {
    return { allowed: false, reason: `${workerRole} may not write ${write}` };
  }
  return { allowed: true, reason: "guardrail-allow" };
}
