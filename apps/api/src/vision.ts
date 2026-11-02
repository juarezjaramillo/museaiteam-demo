import { z } from "zod";
import {
  VisionBox,
  VisionCheck,
  type VisionCheck as VisionCheckData,
} from "@museaiteam/shared";
import { SparkClient } from "./spark.js";
import type { Env } from "./bindings.js";

export interface ImageFacts {
  brand: string;
  code?: string;
  percentOff?: number;
  mustNotSay?: string[];
}

function imageFactsPrompt(facts: ImageFacts): string {
  const lines = [
    "You are a careful proofreader and object grounding expert. Read every piece of text in this image.",
    "For each required fact below, say if it is printed in the image, what you actually read (exact characters), and its bounding box [x_min, y_min, x_max, y_max] on a 0–1000 grid with (0,0) top-left.",
    "Required facts:",
    `- brand name '${facts.brand}' (fact id "brand")`,
  ];
  if (facts.code) {
    lines.push(`- discount code '${facts.code}' (fact id "code", case-sensitive)`);
  }
  if (facts.percentOff !== undefined) {
    lines.push(
      `- '${facts.percentOff}% off' (fact id "percent"; the image may print '${facts.percentOff}%' or '${facts.percentOff}% OFF')`,
    );
  }
  if (facts.mustNotSay && facts.mustNotSay.length > 0) {
    lines.push(
      `The image must NOT print any of: ${facts.mustNotSay.map((s) => `'${s}'`).join(", ")}.`,
    );
  }
  lines.push(
    "Also list any misspelled or garbled text in textErrors.",
    'Return JSON only: {"checks": [{"fact": "<fact id>", "found": true, "read": "<exact characters>", "box": [x_min, y_min, x_max, y_max]}], "brandVisible": true, "textErrors": [], "pass": true}.',
    "Omit the box when the fact is not found.",
  );
  return lines.join("\n");
}

/**
 * Pass rule, in code: every required fact found AND read exactly
 * (code case-sensitive; percent as "20%" or "20% OFF") AND no text
 * errors AND nothing printed that must not be said. The model's own
 * pass flag is never trusted.
 */
export function imageFactsPass(check: VisionCheckData, facts: ImageFacts): boolean {
  if (check.textErrors.length > 0) return false;
  const forbidden = facts.mustNotSay ?? [];
  for (const c of check.checks) {
    if (forbidden.some((s) => s && c.read.includes(s))) return false;
  }
  const byId = new Map(check.checks.map((c) => [c.fact, c]));
  const required: Array<{ id: string; ok: string[] }> = [
    { id: "brand", ok: [facts.brand] },
  ];
  if (facts.code) required.push({ id: "code", ok: [facts.code] });
  if (facts.percentOff !== undefined) {
    required.push({
      id: "percent",
      ok: [`${facts.percentOff}%`, `${facts.percentOff}% OFF`],
    });
  }
  return required.every(({ id, ok }) => {
    const c = byId.get(id);
    return !!c && c.found && ok.includes(c.read.trim());
  });
}

export interface ImageFactsResult {
  pass: boolean;
  check: VisionCheckData;
  tokens: number;
}

/** Read a rendered campaign image back and check it against the run's facts. */
export async function checkImageFacts(
  env: Env,
  imagePng: Uint8Array,
  facts: ImageFacts,
  client?: SparkClient,
): Promise<ImageFactsResult> {
  const c = client ?? new SparkClient(env);
  const res = await c.chatWithImages(VisionCheck, {
    system:
      "You are a careful proofreader and object grounding expert. You read text in images exactly and ground each fact with a bounding box. Reply JSON only.",
    user: imageFactsPrompt(facts),
    images: [imagePng],
    temperature: 0.1,
  });
  return {
    pass: imageFactsPass(res.data, facts),
    check: res.data,
    tokens: res.tokensUsed,
  };
}

export const CopyPhotoCheck = z.object({
  consistent: z.boolean(),
  photoFacts: z.array(z.string()),
  conflicts: z.array(z.string()),
  box: VisionBox.optional(),
});
export type CopyPhotoCheck = z.infer<typeof CopyPhotoCheck>;

export interface CopyPhotoResult {
  consistent: boolean;
  photoFacts: string[];
  conflicts: string[];
  box?: [number, number, number, number];
  tokens: number;
}

export const PageCopyCheck = z.object({
  found: z.boolean(),
  read: z.string(),
  box: VisionBox.optional(),
});
export type PageCopyCheck = z.infer<typeof PageCopyCheck>;

export interface PageCopyResult {
  found: boolean;
  read: string;
  box?: [number, number, number, number];
  tokens: number;
}

function includesNormalized(haystack: string, needle: string): boolean {
  const h = haystack.replace(/\s+/g, " ").trim().toLowerCase();
  const n = needle.replace(/\s+/g, " ").trim().toLowerCase();
  if (!n) return false;
  return h.includes(n) || (h.length >= 20 && n.includes(h));
}

/** Is the new copy live on the product page? Found only when the model points at it AND the words match. */
export async function checkProductPage(
  env: Env,
  png: Uint8Array,
  expectedCopyStart: string,
  client?: SparkClient,
): Promise<PageCopyResult> {
  const c = client ?? new SparkClient(env);
  const out = await c.chatWithImages(PageCopyCheck, {
    system:
      "You are a careful proofreader and object grounding expert. You read product pages exactly and ground what you find with a bounding box. Reply JSON only.",
    user: [
      "Product page screenshot above. Is the product description starting with (or clearly containing) this sentence?",
      `"""${expectedCopyStart}"""`,
      "",
      "Read the description text you actually see and give its bounding box [x_min, y_min, x_max, y_max] on a 0–1000 grid with (0,0) top-left.",
      'Return JSON only: {"found": true, "read": "<description text as seen>", "box": [...]}.',
    ].join("\n"),
    images: [png],
    temperature: 0.1,
  });
  const d = out.data;
  return {
    found: d.found && includesNormalized(d.read, expectedCopyStart),
    read: d.read,
    ...(d.box ? { box: d.box } : {}),
    tokens: out.tokensUsed,
  };
}

/** Parse storefront money ("$3.80", "−$3.80", "$1,234.56") or null. */
export function parseMoney(s: string): number | null {
  const cleaned = s
    .replace(/[−–—]/g, "-")
    .replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export const CheckoutCheck = z.object({
  codeApplied: z.boolean(),
  codeRead: z.string(),
  discountAmountRead: z.string(),
  subtotalRead: z.string(),
  totalRead: z.string(),
  boxes: z.array(z.object({ label: z.string(), box: VisionBox })),
  pass: z.boolean(),
});
export type CheckoutCheck = z.infer<typeof CheckoutCheck>;

export interface CheckoutResult {
  codeApplied: boolean;
  codeRead: string;
  discountAmountRead: string;
  subtotalRead: string;
  totalRead: string;
  boxes: Array<{ label: string; box: [number, number, number, number] }>;
  pass: boolean;
  tokens: number;
}

export interface CheckoutOffer {
  code: string;
  percentOff: number;
  price: number;
}

/**
 * Read the checkout order summary. Pass rule, in code: the code read
 * equals the code exactly AND the discount is within $0.02 of
 * price × percent / 100 AND total < subtotal.
 */
export async function checkCheckout(
  env: Env,
  png: Uint8Array,
  offer: CheckoutOffer,
  client?: SparkClient,
): Promise<CheckoutResult> {
  const c = client ?? new SparkClient(env);
  const out = await c.chatWithImages(CheckoutCheck, {
    system:
      "You are a careful auditor and object grounding expert. You read checkout order summaries exactly and ground each line with a bounding box. Reply JSON only.",
    user: [
      "Checkout screenshot above. Read the order summary: the discount code line, the discount amount, the subtotal, and the total.",
      "Give one bounding box [x_min, y_min, x_max, y_max] on a 0–1000 grid with (0,0) top-left per line you found.",
      'Label the boxes exactly: "Code applied" for the code line, the discount amount as read (for example "−$3.80") for the discount line, "Total" for the total.',
      'Return JSON only: {"codeApplied": true, "codeRead": "<code as read>", "discountAmountRead": "<amount as read>", "subtotalRead": "<subtotal as read>", "totalRead": "<total as read>", "boxes": [{"label": "...", "box": [...]}], "pass": true}.',
    ].join("\n"),
    images: [png],
    temperature: 0.1,
  });
  const d = out.data;
  const discount = parseMoney(d.discountAmountRead);
  const subtotal = parseMoney(d.subtotalRead);
  const total = parseMoney(d.totalRead);
  const expected = (offer.price * offer.percentOff) / 100;
  const pass =
    d.codeRead === offer.code &&
    discount !== null &&
    Math.abs(Math.abs(discount) - expected) <= 0.02 &&
    subtotal !== null &&
    total !== null &&
    total < subtotal;
  return {
    codeApplied: d.codeApplied,
    codeRead: d.codeRead,
    discountAmountRead: d.discountAmountRead,
    subtotalRead: d.subtotalRead,
    totalRead: d.totalRead,
    boxes: d.boxes,
    pass,
    tokens: out.tokensUsed,
  };
}

/** Compare proposed product copy against the product's photo. */
export async function checkCopyAgainstPhoto(
  env: Env,
  photoUrl: string,
  copy: string,
  client?: SparkClient,
): Promise<CopyPhotoResult> {
  const c = client ?? new SparkClient(env);
  let image: Uint8Array | string;
  if (photoUrl.startsWith("data:")) {
    image = photoUrl;
  } else {
    const res = await fetch(photoUrl);
    if (!res.ok) {
      throw new Error(`Vision photo fetch failed: ${res.status}`);
    }
    image = new Uint8Array(await res.arrayBuffer());
  }
  const out = await c.chatWithImages(CopyPhotoCheck, {
    system:
      "You are a careful fact-checker. You compare product copy against a product photo and report only what you can see. Reply JSON only.",
    user: [
      "Product photo above. Proposed description:",
      '"""',
      copy,
      '"""',
      "",
      "Read the label text visible in the photo (roast, origin, weight, decaf, anything printed) and list those facts in photoFacts.",
      'List every place the description contradicts the photo in conflicts (for example the copy says "dark roast" but the bag says "LIGHT").',
      "Give the bounding box [x_min, y_min, x_max, y_max] on a 0–1000 grid with (0,0) top-left of where the roast/label text is on the photo.",
      'Return JSON only: {"consistent": true, "photoFacts": [...], "conflicts": [], "box": [...]}. consistent is true only when conflicts is empty.',
    ].join("\n"),
    images: [image],
    temperature: 0.1,
  });
  const d = out.data;
  return {
    consistent: d.consistent && d.conflicts.length === 0,
    photoFacts: d.photoFacts,
    conflicts: d.conflicts,
    ...(d.box ? { box: d.box } : {}),
    tokens: out.tokensUsed,
  };
}
