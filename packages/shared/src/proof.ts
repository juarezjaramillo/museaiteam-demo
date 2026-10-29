/**
 * Attached proof for finished results: a one-line summary plus the
 * external link and before/after values where the act recorded them.
 * Pure and import-free so the wording is unit-tested; recordAction
 * calls it centrally with actionLabel so no finished act can slip
 * through without proof.
 */

export interface Proof {
  summary: string;
  url?: string;
  before?: string;
  after?: string;
}

function clip(v: unknown, n = 140): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s ? s.slice(0, n) : undefined;
}

export function buildProof(
  kind: string,
  target: string,
  status: string,
  label: string,
  revertPayload?: Record<string, unknown>,
  payload: Record<string, unknown> = {},
): Proof | null {
  if (status !== "done") return null;
  const rp = revertPayload ?? {};
  const url = /^https?:\/\//.test(target) ? target : clip(payload.url);
  const base: Proof = { summary: `${label}: ${target}` };
  if (url) base.url = url;

  switch (kind) {
    case "github.open_pr":
    case "github.code_pr": {
      const pr = clip(rp.pr ?? payload.pr);
      const repo = clip(rp.repo ?? payload.repo);
      base.summary =
        pr && repo
          ? `Opened pull request #${pr} in ${repo}`
          : `Opened a pull request${repo ? ` in ${repo}` : ""}`;
      return base;
    }
    case "linear.create_issue":
      return { ...base, summary: `Filed task ${clip(payload.title) ?? target}` };
    case "linear.manage_issue": {
      const subs = Array.isArray(rp.subIds) ? rp.subIds.length : 0;
      base.summary =
        subs > 0 ? `Added ${subs} subtask${subs === 1 ? "" : "s"} to a task` : `Updated a task`;
      return base;
    }
    case "slack.post_message":
      return { ...base, summary: `Posted in ${clip(payload.channel) ?? target}` };
    case "slack.thread_update": {
      const replies = Array.isArray(rp.replies) ? rp.replies.length : 0;
      base.summary =
        replies > 0 ? `Replied ${replies} time${replies === 1 ? "" : "s"} in a thread` : "Replied in a thread";
      return base;
    }
    case "shopify.create_discount":
    case "shopify.targeted_discount": {
      const code = clip(rp.code ?? payload.code ?? target);
      base.summary = code ? `Created discount code ${code}` : "Created a discount";
      return base;
    }
    case "shopify.product_copy":
      return {
        ...base,
        summary: "Rewrote the product description",
        before: clip(rp.priorDescription),
        after: clip(payload.description),
      };
    case "hubspot.create_note":
    case "hubspot.followup_note":
      return { ...base, summary: `Left a note on ticket ${clip(payload.ticketId) ?? target}` };
    case "hubspot.triage_ticket":
      return {
        ...base,
        summary: "Sorted a support ticket",
        before: clip(rp.priorContent),
        after: clip(payload.content),
      };
    case "hubspot.update_ticket":
      return {
        ...base,
        summary: "Updated a support ticket",
        before: clip(rp.priorStage ?? rp.priorPriority),
        after: clip(payload.stage ?? payload.priority),
      };
    case "notion.create_page":
    case "notion.run_page":
      return { ...base, summary: `Wrote ${clip(payload.title) ?? "a log page"}` };
    default:
      return base;
  }
}
