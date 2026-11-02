import { afterEach, describe, expect, it, vi } from "vitest";
import { getProduct, listProducts } from "../src/integrations/shopify.js";

function gql(data: unknown) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ data }),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("product photos", () => {
  it("listProducts returns the featured image and first variant id and price", async () => {
    const stub = gql({
      products: {
        nodes: [
          {
            id: "gid://shopify/Product/1",
            title: "Chiapas Altura",
            featuredImage: { url: "https://cdn.shopify.com/chiapas.png" },
            variants: { nodes: [{ id: "gid://shopify/ProductVariant/42", price: "19.00" }] },
          },
          {
            id: "gid://shopify/Product/2",
            title: "No Photo",
            featuredImage: null,
            variants: { nodes: [] },
          },
        ],
      },
    });
    vi.stubGlobal("fetch", stub);
    const out = await listProducts("shop.example", "tok");
    expect(out).toEqual([
      {
        id: "gid://shopify/Product/1",
        title: "Chiapas Altura",
        imageUrl: "https://cdn.shopify.com/chiapas.png",
        variantId: 42,
        variantPrice: 19,
      },
      { id: "gid://shopify/Product/2", title: "No Photo" },
    ]);
    const sent = JSON.parse(
      (stub.mock.calls[0][1] as { body: string }).body,
    ) as { query: string };
    expect(sent.query).toContain("featuredImage");
  });

  it("getProduct keeps its old fields and adds the photo fields", async () => {
    vi.stubGlobal(
      "fetch",
      gql({
        product: {
          id: "gid://shopify/Product/1",
          title: "Chiapas Altura",
          description: "A washed coffee.",
          handle: "chiapas-altura",
          featuredImage: { url: "https://cdn.shopify.com/chiapas.png" },
          variants: { nodes: [{ id: "gid://shopify/ProductVariant/7", price: "21.50" }] },
        },
      }),
    );
    expect(await getProduct("shop.example", "tok", "gid://shopify/Product/1")).toEqual({
      id: "gid://shopify/Product/1",
      title: "Chiapas Altura",
      description: "A washed coffee.",
      handle: "chiapas-altura",
      imageUrl: "https://cdn.shopify.com/chiapas.png",
      variantId: 7,
      variantPrice: 21.5,
    });
  });
});
