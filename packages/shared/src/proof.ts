/**
 * Attached proof for finished results: a one-line summary plus the
 * external link and before/after values where the act recorded them.
 * Pure and import-free so the wording is unit-tested; recordAction
 * calls it centrally with actionLabel so no finished act can slip
 * through without proof.
 */

export interface ProofBox {
  label: string;
  box: [number, number, number, number];
  ok: boolean;
}

export interface ProofImage {
  url: string;
  boxes: ProofBox[];
}

export interface Proof {
  summary: string;
  url?: string;
  before?: string;
  after?: string;
  image?: ProofImage;
  images?: ProofImage[];
  beforeImage?: string;
  visionSummary?: string;
}

function clip(v: unknown, n = 140): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s ? s.slice(0, n) : undefined;
}

function validImage(v: unknown): ProofImage | undefined {
  const img = v as { url?: unknown; boxes?: unknown } | null | undefined;
  if (!img || typeof img.url !== "string" || !img.url) return undefined;
  const boxes = Array.isArray(img.boxes)
    ? (img.boxes as Array<Record<string, unknown>>).filter(
        (b) =>
          typeof b.label === "string" &&
          Array.isArray(b.box) &&
          b.box.length === 4 &&
          b.box.every((n) => typeof n === "number") &&
          typeof b.ok === "boolean",
      )
    : [];
  return { url: img.url, boxes: boxes as unknown as ProofBox[] };
}

/** Vision read-back passthrough: image URLs keep their full length. */
function visualFields(payload: Record<string, unknown>): Partial<Proof> {
  const out: Partial<Proof> = {};
  const single = validImage(payload.image);
  if (single) out.image = single;
  if (Array.isArray(payload.images)) {
    const rest = payload.images
      .map(validImage)
      .filter((x): x is ProofImage => !!x);
    if (rest.length > 0) out.images = rest;
  }
  if (typeof payload.beforeImage === "string" && payload.beforeImage) {
    out.beforeImage = payload.beforeImage;
  }
  if (typeof payload.visionSummary === "string" && payload.visionSummary) {
    out.visionSummary = payload.visionSummary;
  }
  return out;
}

export function buildProof(
  kind: string,
  target: string,
  status: string,
  label: string,
  revertPayload?: Record<string, unknown>,
  payload: Record<string, unknown> = {},
): Proof | null {
  if (status !== "done") {
    // Failed acts stay proof-less unless the act left an honest reason.
    if (
      status === "failed" &&
      typeof payload.failReason === "string" &&
      payload.failReason
    ) {
      return { summary: payload.failReason.slice(0, 280) };
    }
    if (
      status === "skipped" &&
      typeof payload.skipReason === "string" &&
      payload.skipReason
    ) {
      return { summary: payload.skipReason.slice(0, 280) };
    }
    return null;
  }
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
        ...visualFields(payload),
        summary: "Rewrote the product description",
        before: clip(rp.priorDescription),
        after: clip(payload.description),
      };
    case "shopify.storefront_check": {
      const parts: string[] = [];
      const co = payload.checkout as { code?: unknown; percent?: unknown } | undefined;
      if (co && typeof co.code === "string" && typeof co.percent === "number") {
        parts.push(`${co.code} takes ${co.percent}% off at checkout ✓`);
      }
      if (payload.copyLive === true) parts.push("new copy live ✓");
      return {
        ...base,
        ...visualFields(payload),
        summary: `Checked the live store: ${parts.join(" · ") || "nothing to verify"}`,
      };
    }
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
    case "creative.campaign_image": {
      const images = Array.isArray(payload.images) ? payload.images : [];
      const count =
        images.length > 0
          ? images.length
          : typeof payload.imageCount === "number" && payload.imageCount > 0
            ? Math.floor(payload.imageCount)
            : 1;
      return {
        ...base,
        ...visualFields(payload),
        summary: `Made ${count} campaign image${count === 1 ? "" : "s"}`,
      };
    }
    case "mcp.tool":
      return {
        ...base,
        summary: `Used ${clip(payload.tool) ?? "a tool"} on ${clip(payload.server) ?? "an outside service"}`,
        after: clip(payload.result, 200),
      };
    default:
      return base;
  }
}
