import { z } from "zod";

/** Bounding box on the normalized 0–1000 grid: [x_min, y_min, x_max, y_max]. */
export const VisionBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type VisionBox = z.infer<typeof VisionBox>;

export const VisionCheckItem = z.object({
  fact: z.string(),
  found: z.boolean(),
  read: z.string(),
  box: VisionBox.optional(),
});
export type VisionCheckItem = z.infer<typeof VisionCheckItem>;

/**
 * Muse Spark's read-back of a rendered image: one row per required
 * fact (what it read, where), plus any garbled text. The pass/fail
 * call stays in code — never trusted from the model.
 */
export const VisionCheck = z.object({
  checks: z.array(VisionCheckItem),
  brandVisible: z.boolean(),
  textErrors: z.array(z.string()),
  pass: z.boolean(),
});
export type VisionCheck = z.infer<typeof VisionCheck>;

export interface ScaledBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Convert a 0–1000 box to pixels in a renderedWidth × renderedHeight image. */
export function scaleBox(
  box: [number, number, number, number],
  renderedWidth: number,
  renderedHeight: number,
): ScaledBox {
  return {
    x: (box[0] / 1000) * renderedWidth,
    y: (box[1] / 1000) * renderedHeight,
    width: ((box[2] - box[0]) / 1000) * renderedWidth,
    height: ((box[3] - box[1]) / 1000) * renderedHeight,
  };
}
