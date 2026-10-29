const API_VERSION = "2026-07";

async function gql<T>(
  shop: string,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(
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
}

export async function listProducts(
  shop: string,
  token: string,
): Promise<Array<{ id: string; title: string }>> {
  const data = await gql<{
    products: { nodes: Array<{ id: string; title: string }> };
  }>(
    shop,
    token,
    `{ products(first: 10) { nodes { id title } } }`,
  );
  return data.products.nodes;
}

export async function getProduct(
  shop: string,
  token: string,
  productId: string,
): Promise<ShopProduct | null> {
  const data = await gql<{
    product?: { id: string; title: string; description: string } | null;
  }>(
    shop,
    token,
    `query($id: ID!) { product(id: $id) { id title description } }`,
    { id: productId },
  );
  return data.product ?? null;
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
