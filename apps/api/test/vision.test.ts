import { describe, expect, it } from "vitest";
import type { VisionCheck as VisionCheckData } from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import type { SparkClient } from "../src/spark.js";
import {
  checkCopyAgainstPhoto,
  checkImageFacts,
  imageFactsPass,
  type ImageFacts,
} from "../src/vision.js";

const FACTS: ImageFacts = {
  brand: "Tres Cumbres Coffee Co.",
  code: "BREW20",
  percentOff: 20,
};

function check(
  parts: Array<{ fact: string; read: string; found?: boolean; box?: [number, number, number, number] }>,
  textErrors: string[] = [],
): VisionCheckData {
  return {
    checks: parts.map((p) => ({ fact: p.fact, found: p.found ?? true, read: p.read, ...(p.box ? { box: p.box } : {}) })),
    brandVisible: true,
    textErrors,
    pass: true,
  };
}

describe("imageFactsPass", () => {
  it("passes on an exact code match", () => {
    expect(
      imageFactsPass(
        check([
          { fact: "brand", read: "Tres Cumbres Coffee Co." },
          { fact: "code", read: "BREW20" },
          { fact: "percent", read: "20% OFF" },
        ]),
        FACTS,
      ),
    ).toBe(true);
  });

  it("accepts the short percent form", () => {
    expect(
      imageFactsPass(
        check([
          { fact: "brand", read: "Tres Cumbres Coffee Co." },
          { fact: "code", read: "BREW20" },
          { fact: "percent", read: "20%" },
        ]),
        FACTS,
      ),
    ).toBe(true);
  });

  it("fails on a wrong percent", () => {
    expect(
      imageFactsPass(
        check([
          { fact: "brand", read: "Tres Cumbres Coffee Co." },
          { fact: "code", read: "BREW20" },
          { fact: "percent", read: "25% OFF" },
        ]),
        FACTS,
      ),
    ).toBe(false);
  });

  it("fails on garbled text", () => {
    expect(
      imageFactsPass(
        check(
          [
            { fact: "brand", read: "Tres Cumbres Coffee Co." },
            { fact: "code", read: "BREW20" },
            { fact: "percent", read: "20% OFF" },
          ],
          ["headline garbled: 'BL4CK FR1DAY'"],
        ),
        FACTS,
      ),
    ).toBe(false);
  });

  it("is case-sensitive on the code", () => {
    expect(
      imageFactsPass(
        check([
          { fact: "brand", read: "Tres Cumbres Coffee Co." },
          { fact: "code", read: "brew20" },
          { fact: "percent", read: "20% OFF" },
        ]),
        FACTS,
      ),
    ).toBe(false);
  });

  it("fails when a required fact is missing", () => {
    expect(
      imageFactsPass(
        check([
          { fact: "brand", read: "Tres Cumbres Coffee Co." },
          { fact: "code", read: "BREW20" },
        ]),
        FACTS,
      ),
    ).toBe(false);
  });

  it("passes brand-only facts without code or percent", () => {
    expect(
      imageFactsPass(check([{ fact: "brand", read: "Tres Cumbres Coffee Co." }]), {
        brand: "Tres Cumbres Coffee Co.",
      }),
    ).toBe(true);
  });

  it("fails when the image prints a forbidden string", () => {
    expect(
      imageFactsPass(
        check([
          { fact: "brand", read: "Tres Cumbres Coffee Co." },
          { fact: "code", read: "BREW20" },
        ]),
        { brand: "Tres Cumbres Coffee Co.", code: "BREW20", mustNotSay: ["50%"] },
      ),
    ).toBe(true);
    expect(
      imageFactsPass(
        check([
          { fact: "brand", read: "Tres Cumbres Coffee Co." },
          { fact: "percent", read: "50% OFF" },
        ]),
        { brand: "Tres Cumbres Coffee Co.", mustNotSay: ["50%"] },
      ),
    ).toBe(false);
  });
});

function fakeClient<T>(data: T, tokensUsed = 7, seen: Array<Record<string, unknown>> = []) {
  return {
    async chatWithImages(_schema: unknown, opts: Record<string, unknown>) {
      seen.push(opts);
      return { data, tokensUsed };
    },
  } as unknown as SparkClient;
}

const ENV = {} as Env;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("checkImageFacts", () => {
  it("sends the facts and computes pass in code, not from the model", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const wrong = check([
      { fact: "brand", read: "Tres Cumbres Coffee Co." },
      { fact: "code", read: "BREW2O" },
      { fact: "percent", read: "20% OFF" },
    ]);
    const out = await checkImageFacts(ENV, PNG, FACTS, fakeClient(wrong, 11, seen));
    expect(out.pass).toBe(false);
    expect(out.tokens).toBe(11);
    expect(seen).toHaveLength(1);
    const user = String(seen[0].user);
    expect(user).toContain("Tres Cumbres Coffee Co.");
    expect(user).toContain("BREW20");
    expect(user).toContain("20% off");
    expect(seen[0].images).toHaveLength(1);
  });
});

describe("checkCopyAgainstPhoto", () => {
  it("returns the photo facts and distrusts an inconsistent model verdict", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const data = {
      consistent: true,
      photoFacts: ["bag says LIGHT"],
      conflicts: ["copy says dark roast but the bag says LIGHT"],
      box: [10, 20, 30, 40] as [number, number, number, number],
    };
    const out = await checkCopyAgainstPhoto(
      ENV,
      "data:image/png;base64,iVBORw0KGgo=",
      "A dark roast for strong mornings.",
      fakeClient(data, 5, seen),
    );
    expect(out.consistent).toBe(false);
    expect(out.conflicts).toEqual(["copy says dark roast but the bag says LIGHT"]);
    expect(out.box).toEqual([10, 20, 30, 40]);
    expect(out.tokens).toBe(5);
    expect(String(seen[0].user)).toContain("dark roast");
  });

  it("passes when the model reports no conflicts", async () => {
    const out = await checkCopyAgainstPhoto(
      ENV,
      "data:image/png;base64,iVBORw0KGgo=",
      "A light roast with floral notes.",
      fakeClient({ consistent: true, photoFacts: ["bag says LIGHT"], conflicts: [] }),
    );
    expect(out.consistent).toBe(true);
    expect(out.box).toBeUndefined();
  });
});
