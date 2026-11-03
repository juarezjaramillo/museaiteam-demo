import { describe, expect, it } from "vitest";
import type { VisionCheck as VisionCheckData } from "@museaiteam/shared";
import type { Env } from "../src/bindings.js";
import type { SparkClient } from "../src/spark.js";
import {
  checkCheckout,
  checkCopyAgainstPhoto,
  checkImageFacts,
  checkProductPage,
  imageFactsPass,
  parseMoney,
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

  it("refuses to buffer a giant photo", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(21 * 1024 * 1024))) as typeof fetch;
    try {
      await expect(
        checkCopyAgainstPhoto(
          ENV,
          "https://cdn.shopify.com/huge.png",
          "A light roast.",
          fakeClient({ consistent: true, photoFacts: [], conflicts: [] }),
        ),
      ).rejects.toThrow("Vision photo too large");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("parseMoney", () => {
  it("reads storefront amounts", () => {
    expect(parseMoney("$3.80")).toBe(3.8);
    expect(parseMoney("−$3.80")).toBe(-3.8);
    expect(parseMoney("-$3.80")).toBe(-3.8);
    expect(parseMoney("$1,234.56")).toBe(1234.56);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("Free")).toBeNull();
  });

  it("reads comma-decimal amounts", () => {
    expect(parseMoney("3,80 €")).toBe(3.8);
    expect(parseMoney("−3,80")).toBe(-3.8);
    expect(parseMoney("1.234,56")).toBe(1234.56);
    expect(parseMoney("$1,234")).toBe(1234);
  });
});

const OFFER = { code: "BREW20", percentOff: 20, price: 19 };

function checkoutRead(over: Record<string, unknown> = {}) {
  return {
    codeApplied: true,
    codeRead: "BREW20",
    discountAmountRead: "−$3.80",
    subtotalRead: "$19.00",
    totalRead: "$15.20",
    boxes: [
      { label: "Code applied", box: [1, 2, 3, 4] },
      { label: "−$3.80", box: [5, 6, 7, 8] },
      { label: "Total", box: [9, 10, 11, 12] },
    ],
    pass: true,
    ...over,
  };
}

describe("checkCheckout", () => {
  it("passes when the code, discount math, and total all check out", async () => {
    const out = await checkCheckout(ENV, PNG, OFFER, fakeClient(checkoutRead()));
    expect(out.pass).toBe(true);
    expect(out.boxes.map((b) => b.label)).toEqual(["Code applied", "−$3.80", "Total"]);
  });

  it("fails on a wrong code", async () => {
    const out = await checkCheckout(ENV, PNG, OFFER, fakeClient(checkoutRead({ codeRead: "BREW21" })));
    expect(out.pass).toBe(false);
  });

  it("fails with no discount line", async () => {
    const out = await checkCheckout(
      ENV,
      PNG,
      OFFER,
      fakeClient(
        checkoutRead({
          codeApplied: false,
          codeRead: "",
          discountAmountRead: "",
          subtotalRead: "$19.00",
          totalRead: "$19.00",
          boxes: [],
        }),
      ),
    );
    expect(out.pass).toBe(false);
  });

  it("fails when the discount math is off", async () => {
    const out = await checkCheckout(
      ENV,
      PNG,
      OFFER,
      fakeClient(checkoutRead({ discountAmountRead: "$1.00", totalRead: "$18.00" })),
    );
    expect(out.pass).toBe(false);
  });

  it("computes pass in code, not from the model", async () => {
    const out = await checkCheckout(
      ENV,
      PNG,
      OFFER,
      fakeClient(checkoutRead({ codeRead: "WRONG", pass: true })),
    );
    expect(out.pass).toBe(false);
  });
});

describe("checkProductPage", () => {
  it("finds the new copy by its words", async () => {
    const out = await checkProductPage(
      ENV,
      PNG,
      "A light roast with floral notes.",
      fakeClient({
        found: true,
        read: "A light roast with floral notes. Fresh for Black Friday.",
        box: [1, 2, 3, 4],
      }),
    );
    expect(out.found).toBe(true);
    expect(out.box).toEqual([1, 2, 3, 4]);
  });

  it("rejects a found flag with mismatched words", async () => {
    const out = await checkProductPage(
      ENV,
      PNG,
      "A light roast with floral notes.",
      fakeClient({ found: true, read: "An old dark roast description." }),
    );
    expect(out.found).toBe(false);
  });

  it("never shows the expected words to the model", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await checkProductPage(
      ENV,
      PNG,
      "A light roast with floral notes.",
      fakeClient(
        { found: true, read: "A light roast with floral notes. Fresh for Black Friday." },
        7,
        seen,
      ),
    );
    expect(String(seen[0].user)).not.toContain("floral notes");
  });

  it("matching words count even when the model is unsure", async () => {
    const out = await checkProductPage(
      ENV,
      PNG,
      "A light roast with floral notes.",
      fakeClient({
        found: false,
        read: "A light roast with floral notes. Fresh for Black Friday.",
      }),
    );
    expect(out.found).toBe(true);
  });
});
