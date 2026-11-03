import { providerFetch } from "./http.js";

const API_VERSION = "2026-07";

async function gql<T>(
  shop: string,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await providerFetch(
    "Shopify",
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors || !json.data) {
    throw new Error(
      `Shopify: ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 200)}`,
    );
  }
  return json.data;
}

export interface DiscountCode {
  /** Global ID for deleteDiscountCode. */
  id: string;
  code: string;
}

/**
 * Win-back flagship: a 15%-off code for everything, once per customer,
 * alive 30 days. Safe on a dev store; revert deletes it outright.
 */
export async function createDiscountCode(
  shop: string,
  token: string,
  title: string,
  code: string,
): Promise<DiscountCode> {
  const now = Date.now();
  const data = await gql<{
    discountCodeBasicCreate: {
      codeDiscountNode?: { id: string };
      userErrors: Array<{ message: string }>;
    };
  }>(
    shop,
    token,
    `mutation($d: DiscountCodeBasicInput!) {
       discountCodeBasicCreate(basicCodeDiscount: $d) {
         codeDiscountNode { id }
         userErrors { message } } }`,
    {
      d: {
        title,
        code,
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + 30 * 86_400_000).toISOString(),
        appliesOncePerCustomer: true,
        customerSelection: { all: true },
        customerGets: {
          value: { percentage: 0.15 },
          items: { all: true },
        },
      },
    },
  );
  const node = data.discountCodeBasicCreate.codeDiscountNode;
  const errs = data.discountCodeBasicCreate.userErrors;
  if (!node || errs.length > 0) {
    throw new Error(
      `Shopify discount failed: ${errs.map((e) => e.message).join("; ").slice(0, 200) || "no node"}`,
    );
  }
  return { id: node.id, code };
}

/** Storefront name, so creatives print the real brand. */
export async function shopName(shop: string, token: string): Promise<string | null> {
  const data = await gql<{ shop: { name: string } }>(
    shop,
    token,
    `{ shop { name } }`,
  );
  return data.shop?.name ?? null;
}

export async function deleteDiscountCode(
  shop: string,
  token: string,
  id: string,
): Promise<void> {
  const data = await gql<{
    discountCodeDelete: {
      deletedCodeDiscountId?: string;
      userErrors: Array<{ message: string }>;
    };
  }>(
    shop,
    token,
    `mutation($id: ID!) {
       discountCodeDelete(id: $id) {
         deletedCodeDiscountId
         userErrors { message } } }`,
    { id },
  );
  if (!data.discountCodeDelete.deletedCodeDiscountId) {
    throw new Error(
      `Shopify discount delete failed: ${data.discountCodeDelete.userErrors.map((e) => e.message).join("; ").slice(0, 200)}`,
    );
  }
}

export interface ShopSales {
  orders: number;
  revenue: number;
}

/** Metric pull: order count + revenue since a YYYY-MM-DD (capped). */
export async function salesSince(
  shop: string,
  token: string,
  sinceYmd: string,
): Promise<ShopSales> {
  interface Page {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      nodes: Array<{
        totalPriceSet: { shopMoney: { amount: string } };
      }>;
    };
  }
  let orders = 0;
  let revenue = 0;
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const data: Page = await gql<Page>(
      shop,
      token,
      `query($after: String, $q: String!) {
         orders(first: 100, after: $after, query: $q) {
           pageInfo { hasNextPage endCursor }
           nodes { totalPriceSet { shopMoney { amount } } } } }`,
      { after, q: `created_at:>=${sinceYmd}` },
    );
    orders += data.orders.nodes.length;
    for (const n of data.orders.nodes) {
      revenue += Number(n.totalPriceSet.shopMoney.amount) || 0;
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return { orders, revenue };
}

/**
 * Targeted discount: percent/title/schedule from the ruling, bounded by
 * the caller (saneDiscount). One code, once per customer, 30-day window.
 */
export async function createTargetedDiscount(
  shop: string,
  token: string,
  title: string,
  code: string,
  percent: number,
  startInDays: number,
): Promise<DiscountCode> {
  const now = Date.now();
  const data = await gql<{
    discountCodeBasicCreate: {
      codeDiscountNode?: { id: string };
      userErrors: Array<{ message: string }>;
    };
  }>(
    shop,
    token,
    `mutation($d: DiscountCodeBasicInput!) {
       discountCodeBasicCreate(basicCodeDiscount: $d) {
         codeDiscountNode { id }
         userErrors { message } } }`,
    {
      d: {
        title,
        code,
        startsAt: new Date(now + startInDays * 86_400_000).toISOString(),
        endsAt: new Date(now + (startInDays + 30) * 86_400_000).toISOString(),
        appliesOncePerCustomer: true,
        customerSelection: { all: true },
        customerGets: {
          value: { percentage: percent / 100 },
          items: { all: true },
        },
      },
    },
  );
  const node = data.discountCodeBasicCreate.codeDiscountNode;
  const errs = data.discountCodeBasicCreate.userErrors;
  if (!node || errs.length > 0) {
    throw new Error(
      `Shopify discount failed: ${errs.map((e) => e.message).join("; ").slice(0, 200) || "no node"}`,
    );
  }
  return { id: node.id, code };
}

export interface ShopProduct {
  id: string;
  title: string;
  description: string;
  /** URL handle for the storefront product page. */
  handle?: string;
  /** Featured image URL (public CDN), when the product has one. */
  imageUrl?: string;
  /** First variant's numeric id, parsed from its gid. */
  variantId?: number;
  /** First variant's price. */
  variantPrice?: number;
}

export interface ShopProductSummary {
  id: string;
  title: string;
  imageUrl?: string;
  variantId?: number;
  variantPrice?: number;
}

interface ProductNode {
  id: string;
  title: string;
  description?: string;
  featuredImage?: { url: string } | null;
  variants?: { nodes: Array<{ id: string; price: string }> };
}

function photoFields(
  node: ProductNode,
): Pick<ShopProduct, "imageUrl" | "variantId" | "variantPrice"> {
  const out: Pick<ShopProduct, "imageUrl" | "variantId" | "variantPrice"> = {};
  if (node.featuredImage?.url) out.imageUrl = node.featuredImage.url;
  const variant = node.variants?.nodes[0];
  if (variant) {
    const numeric = Number(variant.id.split("/").pop());
    if (Number.isFinite(numeric)) out.variantId = numeric;
    const price = Number(variant.price);
    if (Number.isFinite(price)) out.variantPrice = price;
  }
  return out;
}

const PRODUCT_PHOTO_FIELDS = `
  featuredImage { url }
  variants(first: 1) { nodes { id price } }`;

export async function listProducts(
  shop: string,
  token: string,
): Promise<ShopProductSummary[]> {
  const data = await gql<{
    products: { nodes: ProductNode[] };
  }>(
    shop,
    token,
    `{ products(first: 10) { nodes { id title ${PRODUCT_PHOTO_FIELDS} } } }`,
  );
  return data.products.nodes.map((n) => ({
    id: n.id,
    title: n.title,
    ...photoFields(n),
  }));
}

export async function getProduct(
  shop: string,
  token: string,
  productId: string,
): Promise<ShopProduct | null> {
  const data = await gql<{
    product?: (ProductNode & { description: string; handle: string }) | null;
  }>(
    shop,
    token,
    `query($id: ID!) { product(id: $id) { id title description handle ${PRODUCT_PHOTO_FIELDS} } }`,
    { id: productId },
  );
  if (!data.product) return null;
  const p = data.product;
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    handle: p.handle,
    ...photoFields(p),
  };
}

/** Product copy update. Callers read the prior description first (both
 *  for the rewrite prompt and the revert payload). */
export async function updateProductDescription(
  shop: string,
  token: string,
  productId: string,
  description: string,
): Promise<void> {
  const data = await gql<{
    productUpdate: {
      product?: { description: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    shop,
    token,
    `mutation($id: ID!, $desc: String!) {
       productUpdate(input: { id: $id, description: $desc }) {
         product { description }
         userErrors { message } } }`,
    { id: productId, desc: description.slice(0, 5000) },
  );
  const errs = data.productUpdate.userErrors;
  if (errs.length > 0 || !data.productUpdate.product) {
    throw new Error(
      `Shopify product update failed: ${errs.map((e) => e.message).join("; ").slice(0, 200) || "no product"}`,
    );
  }
}

/** Metric pull: abandoned checkouts since a YYYY-MM-DD (capped). */
export async function checkoutsSince(
  shop: string,
  token: string,
  sinceYmd: string,
): Promise<number> {
  interface Page {
    abandonedCheckouts: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      nodes: Array<{ id: string }>;
    };
  }
  let count = 0;
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const data: Page = await gql<Page>(
      shop,
      token,
      `query($after: String, $q: String!) {
         abandonedCheckouts(first: 100, after: $after, query: $q) {
           pageInfo { hasNextPage endCursor }
           nodes { id } } }`,
      { after, q: `created_at:>=${sinceYmd}` },
    );
    count += data.abandonedCheckouts.nodes.length;
    if (!data.abandonedCheckouts.pageInfo.hasNextPage) break;
    after = data.abandonedCheckouts.pageInfo.endCursor;
  }
  return count;
}
