import type { Env } from "./bindings.js";
import { META_MODEL_BASE_URL } from "./spark.js";

export const IMAGE_MODEL = "muse-image-1.0";
export const IMAGE_COST_CENTS = 1;

/** The model refused the prompt. Never retried; the act fails honestly. */
export class ImageContentPolicyError extends Error {
  constructor(prompt: string) {
    super(`Muse Image refused the prompt (content policy): ${prompt.slice(0, 120)}`);
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type ImageSize = "1080x1350" | "1080x1920";

export interface GeneratedImage {
  png: Uint8Array;
}

/**
 * Muse Image, one PNG. References (public URLs or data URLs) go to
 * /images/edits; no references go to /images/generations. 503s retry
 * with backoff (3 tries total); a content-policy 400 throws
 * ImageContentPolicyError without retrying.
 */
export async function generateImage(
  env: Env,
  opts: { prompt: string; references?: string[]; size: ImageSize },
): Promise<GeneratedImage> {
  const refs = opts.references ?? [];
  const path = refs.length > 0 ? "/images/edits" : "/images/generations";
  const body: Record<string, unknown> = {
    model: IMAGE_MODEL,
    prompt: opts.prompt,
    n: 1,
    size: opts.size,
    output_format: "png",
    tool_enablement: {
      enable_image_search: false,
      enable_web_search: false,
      enable_shell: false,
    },
  };
  if (refs.length > 0) {
    body.images = refs.map((image_url) => ({ image_url }));
  }
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${META_MODEL_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.META_MODEL_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error("Muse Image returned no image");
      return { png: b64ToBytes(b64) };
    }
    const text = await res.text();
    lastErr = `Muse Image ${path}: ${res.status} ${text.slice(0, 200)}`;
    if (res.status === 400) {
      try {
        if ((JSON.parse(text) as { code?: string }).code === "content_policy_violation") {
          throw new ImageContentPolicyError(opts.prompt);
        }
      } catch (err) {
        if (err instanceof ImageContentPolicyError) throw err;
      }
      throw new Error(lastErr);
    }
    if (res.status === 503 && attempt < 2) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 4000));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}
