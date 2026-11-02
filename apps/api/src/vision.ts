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
