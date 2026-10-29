// Approval state machine: pure decisions for pre-approve gates, resubmit
// bounds, and post-hoc artifact calls. The API and workflow are thin
// shells over these; every branch is unit-testable here.

export const ORG_ROLES = ["owner", "approver", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(s: string): s is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(s);
}

/** Owner decides everything; approver decides work; viewer only watches. */
export function mayDecideApproval(role: string | null): boolean {
  return role === "owner" || role === "approver";
}

/** Rejections before the run fails visibly instead of re-ruling. */
export const MAX_RESUBMITS = 3;

export type ResubmitOutcome = "rerule" | "fail";

/** resubmits = re-rules already performed for this run. */
export function resubmitOutcome(resubmits: number): ResubmitOutcome {
  return resubmits >= MAX_RESUBMITS ? "fail" : "rerule";
}

/** Ruling attempt number, derived from rejection count — deterministic
 *  across workflow retries, so a retried rule step reuses its own row. */
export function nextAttempt(rejections: number): number {
  return rejections + 1;
}

export type GateVerdict = "proceed" | "pause";

export interface GateInput {
  approvalMode: string;
  /** Latest ruling attempt, null when the run never ruled. */
  rulingAttempt: number | null;
  /** Attempt the latest approval blessed, null when never approved. */
  approvedAttempt: number | null;
}

/**
 * The pre-approve gate: post-hoc goals always proceed; pre-approve
 * goals proceed only when the current ruling attempt was approved.
 * Stale approvals (older attempt) never open the gate.
 */
export function gateVerdict(input: GateInput): GateVerdict {
  if (input.approvalMode !== "preapprove") return "proceed";
  if (input.rulingAttempt === null) return "proceed";
  return input.approvedAttempt === input.rulingAttempt ? "proceed" : "pause";
}
