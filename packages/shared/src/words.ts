/**
 * Customer words for internal model values. The API speaks runs, debates,
 * and votes; customers see sessions, organizing, and agreement. Unknown
 * values degrade to prettified raw text, never crash.
 */

function pretty(raw: string): string {
  return raw.replace(/[_.]/g, " ");
}

const STATUS_WORDS: Record<string, string> = {
  debating: "organizing",
  acting: "working",
  open: "new",
  queued: "waiting",
  pending: "waiting",
  halted: "stopped",
  vetoed: "rejected",
  would_do: "sample",
};

export function statusLabel(status: string): string {
  return STATUS_WORDS[status] ?? pretty(status);
}

const KIND_WORDS: Record<string, string> = {
  work: "Work session",
  check: "Check-in",
  revision: "Revision",
  propose: "Proposal",
  sandbox: "Sample",
};

export function kindLabel(kind: string): string {
  return KIND_WORDS[kind] ?? pretty(kind);
}

const CHOICE_WORDS: Record<string, string> = {
  for: "agree",
  against: "disagree",
  abstain: "pass",
};

export function choiceLabel(choice: string): string {
  return CHOICE_WORDS[choice] ?? pretty(choice);
}

const APPROVAL_WORDS: Record<string, string> = {
  pre: "Check first",
  post: "Review after",
};

export function approvalKindLabel(kind: string): string {
  return APPROVAL_WORDS[kind] ?? pretty(kind);
}

const MODE_WORDS: Record<string, string> = {
  preapprove: "Check first",
  posthoc: "Review after",
};

export function modeLabel(mode: string): string {
  return MODE_WORDS[mode] ?? pretty(mode);
}

const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

export function scheduleLabel(schedule: string): string {
  if (schedule === "manual") return "Manual";
  if (schedule === "daily") return "Daily";
  if (schedule === "weekdays") return "Weekdays";
  const weekly = schedule.match(/^weekly:(\d)$/);
  if (weekly) return WEEKDAYS[Number(weekly[1])] ?? pretty(schedule);
  return pretty(schedule);
}

const ACTION_WORDS: Record<string, string> = {
  "github.open_pr": "Pull request",
  "github.close_pr": "Close pull request",
  "github.code_pr": "Code changes",
  "linear.create_issue": "Task",
  "linear.delete_issue": "Remove task",
  "linear.manage_issue": "Task update",
  "slack.post_message": "Message",
  "slack.delete_message": "Remove message",
  "slack.thread_update": "Reply",
  "shopify.create_discount": "Discount",
  "shopify.delete_discount": "Remove discount",
  "shopify.targeted_discount": "Targeted discount",
  "shopify.product_copy": "Product words",
  "shopify.restore_product": "Restore product",
  "hubspot.create_note": "Note",
  "hubspot.delete_note": "Remove note",
  "hubspot.triage_ticket": "Ticket sort",
  "hubspot.restore_ticket": "Restore ticket",
  "hubspot.update_ticket": "Ticket update",
  "hubspot.restore_fields": "Restore ticket",
  "hubspot.followup_note": "Follow-up note",
  "notion.create_page": "Page",
  "notion.archive_page": "Archive page",
  "notion.run_page": "Log page",
};

export function actionLabel(kind: string): string {
  return ACTION_WORDS[kind] ?? pretty(kind);
}

/** System rows customers never need: skips and closeout markers. */
export function isHiddenAction(a: { status: string; target: string }): boolean {
  return a.status === "skipped" || a.target.startsWith("closeout:");
}

export function targetHref(target: string): string | null {
  return /^https?:\/\//.test(target) ? target : null;
}

const EVENT_WORDS: Record<string, string> = {
  "run.started": "Session started",
  "run.done": "Session finished",
  "run.failed": "Session failed",
  "run.halted": "Session stopped",
  "run.approved": "Session approved",
  "run.awaiting_approval": "Waiting approval",
  "run.resubmitted": "Retried",
  "run.revision": "Revision started",
  "check.monitoring": "Check-in",
  "check.triggered": "Check-in",
  "check.blocked": "Check-in blocked",
  "check.failed": "Check-in failed",
  "goal.created": "Goal created",
  "goal.overdue": "Overdue",
  "goal.stalled": "Goal stalled",
  "proposal.started": "Proposal started",
  "metric.point": "Number entry",
  "metric.pull_failed": "Fetch failed",
  "squad.staffed": "Team picked",
  "squad.restaffed": "Team re-picked",
  "tick.skipped": "Skipped",
};

export function eventLabel(kind: string): string {
  return EVENT_WORDS[kind] ?? pretty(kind);
}

const NOTICE_WORDS: Record<string, string> = {
  "run.completed": "Done",
  "run.failed": "Session failed",
  "run.halted": "Session stopped",
  "approval.requested": "Approval needed",
  "approval.decided": "Approval decided",
  "approval.resubmitted": "Retried",
  "approval.revision": "Revision",
  "approval.auto": "Auto-approved",
  "approval.capped": "Retries exhausted",
  "fair_use.watch": "Usage",
  "goal.overdue": "Overdue",
  "goal.stalled": "Goal stalled",
  "proposal.proposed": "New idea",
  "proposal.reminded": "Idea reminder",
  "proposal.started": "Idea started",
  "allowance.exhausted": "Nightly ideas paused",
  "slack.command_failed": "Slack request failed",
  "digest.weekly": "Weekly retro",
  "slack.dm_fallback": "Team message",
  "error.spike": "Something broke",
};

export function noticeLabel(kind: string): string {
  return NOTICE_WORDS[kind] ?? pretty(kind);
}

/** Customer title for a session row: best outcome first, goal last. */
export function sessionTitle(r: {
  kind: string;
  goal: string;
  outcome: string | null;
  top_suggestion: string | null;
}): string {
  if (r.top_suggestion) return r.top_suggestion;
  if (r.outcome) return r.outcome;
  if (r.kind === "check") return "Check-in";
  return r.goal.replace(/^Check:\s*/, "");
}

export function shipCount(n: number): string {
  return n === 1 ? "1 result" : `${n} results`;
}

/**
 * Kinds that move money. Auto-review never approves these: a human always
 * decides. Everything undoable and non-money is safe to approve on sight.
 */
const MONEY_KINDS = new Set([
  "shopify.create_discount",
  "shopify.targeted_discount",
]);

export function isMoneyKind(kind: string): boolean {
  return MONEY_KINDS.has(kind);
}
