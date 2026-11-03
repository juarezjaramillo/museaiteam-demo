import type { Action, ProofBox } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { getStorePassword } from "./oauth.js";
import { getProviderConfig } from "./oauth.js";
import { SparkClient } from "./spark.js";
import {
  checkCheckout,
  checkProductPage,
  parseMoney,
  type CheckoutResult,
} from "./vision.js";
import { getProduct } from "./integrations/shopify.js";
import { publishPublicImage } from "./artifacts.js";
import {
  CloudflareStoreBrowser,
  type StoreBrowser,
  type StoreShot,
} from "./store-browser.js";

export interface StorefrontHooks {
  recordAction(
    kind: Action["kind"],
    target: string,
    status: Action["status"],
    revertPayload?: Record<string, unknown>,
    payload?: Record<string, unknown>,
    actionId?: string,
  ): Promise<string>;
  addTokens(n: number): Promise<void>;
}

const MAX_ATTEMPTS = 2;

function firstSentence(description: string): string {
  return description.split(". ")[0]?.trim().slice(0, 200) || description.trim().slice(0, 200);
}

function checkoutBoxes(
  result: CheckoutResult,
  code: string,
  expectedDiscount: number,
): ProofBox[] {
  const discount = parseMoney(result.discountAmountRead);
  const subtotal = parseMoney(result.subtotalRead);
  const total = parseMoney(result.totalRead);
  // The model may return stray boxes; only the code, total, and first
  // other box (the discount line) render, so a passed check never shows red.
  let keptDiscount = false;
  const kept = result.boxes.filter((b) => {
    if (b.label === "Code applied" || b.label === "Total") return true;
    if (keptDiscount) return false;
    keptDiscount = true;
    return true;
  });
  return kept.map((b) => {
    let ok = false;
    if (b.label === "Code applied") {
      ok = result.codeRead === code;
    } else if (b.label === "Total") {
      ok = subtotal !== null && total !== null && total < subtotal;
    } else {
      ok =
        discount !== null && Math.abs(Math.abs(discount) - expectedDiscount) <= 0.02;
    }
    return { label: b.label, box: b.box, ok };
  });
}

/**
 * The marketer's storefront check: open the real store in a real
 * browser, screenshot the product page and a checkout with the new
 * code applied, and have Spark read the proof. Read-only: no revert
 * payload, nothing to undo. Never throws: failures become honest
 * failed actions and the run continues.
 */
export async function executeStorefrontCheckAct(
  env: Env,
  args: {
    orgId: string;
    runId: string;
    shop: string;
    token: string;
    hooks: StorefrontHooks;
    browser?: StoreBrowser;
    spark?: SparkClient;
  },
): Promise<void> {
  const { orgId, runId, shop, token, hooks } = args;
  const browser = args.browser ?? new CloudflareStoreBrowser(env);
  const spark = args.spark ?? new SparkClient(env);
  // Shots published before a later phase fails: revoked with the failure
  // so no proof floats around unattached to a finished check.
  const publishedTokens: string[] = [];
  const fail = async (
    target: string,
    message: string,
    systemError?: string,
  ): Promise<void> => {
    if (publishedTokens.length > 0) {
      const now = new Date().toISOString();
      for (const t of publishedTokens) {
        await env.DB.prepare("UPDATE public_images SET revoked_at = ? WHERE token = ?")
          .bind(now, t)
          .run()
          .catch(() => {});
      }
    }
    await hooks.recordAction("shopify.storefront_check", target, "failed", undefined, {
      failReason: message,
      reason: message,
    });
    await audit(env, runId, "marketer", "action.failed", {
      system: "shopify",
      error: systemError ?? message,
    });
  };

  const doneRows = await env.DB.prepare(
    "SELECT kind FROM actions WHERE run_id = ? AND status = 'done'",
  )
    .bind(runId)
    .all<{ kind: string }>();
  if ((doneRows.results ?? []).some((r) => r.kind === "shopify.storefront_check")) {
    return;
  }
  const discountRow = await env.DB.prepare(
    `SELECT target, payload FROM actions WHERE run_id = ? AND kind IN ('shopify.targeted_discount', 'shopify.create_discount') AND status = 'done' ORDER BY rowid DESC LIMIT 1`,
  )
    .bind(runId)
    .first<{ target: string; payload: string }>();
  const copyRow = await env.DB.prepare(
    `SELECT payload, revert_payload FROM actions WHERE run_id = ? AND kind = 'shopify.product_copy' AND status = 'done' ORDER BY rowid DESC LIMIT 1`,
  )
    .bind(runId)
    .first<{ payload: string; revert_payload: string | null }>();
  let code: string | undefined;
  let percent: number | undefined;
  if (discountRow && discountRow.target && discountRow.target !== "discount") {
    code = discountRow.target;
    try {
      const p = JSON.parse(discountRow.payload ?? "{}") as { percent?: unknown };
      if (typeof p.percent === "number" && Number.isFinite(p.percent)) percent = p.percent;
    } catch {
      /* legacy row without a payload */
    }
  }
  let newCopy: string | undefined;
  let productId: string | undefined;
  if (copyRow) {
    try {
      const p = JSON.parse(copyRow.payload ?? "{}") as { description?: unknown };
      if (typeof p.description === "string" && p.description) newCopy = p.description;
      const rp = JSON.parse(copyRow.revert_payload ?? "{}") as { productId?: unknown };
      if (typeof rp.productId === "string" && rp.productId) productId = rp.productId;
    } catch {
      /* legacy row without a payload */
    }
  }
  const wantCheckout = code !== undefined && percent !== undefined;
  const wantProduct = newCopy !== undefined && productId !== undefined;
  if (!wantCheckout && !wantProduct) return;

  let password: string | null;
  try {
    password = await getStorePassword(env, orgId);
  } catch (err) {
    await fail(
      "live store",
      "The saved store password could not be read; re-save it in Setup.",
      String(err).slice(0, 200),
    );
    return;
  }
  if (!password) {
    await hooks.recordAction(
      "shopify.storefront_check",
      "live store",
      "skipped",
      undefined,
      {
        skipReason: "Add your store password in Setup so the team can check the live store.",
        reason: "store password not saved",
      },
    );
    await audit(env, runId, "marketer", "action.skipped", {
      system: "shopify",
      reason: "store password not saved",
    });
    return;
  }

  try {
    const { product_id: showcaseId } = await getProviderConfig(env, orgId, "shopify");
    const lookupId = productId ?? (typeof showcaseId === "string" ? showcaseId : undefined);
    if (!lookupId) {
      await fail("live store", "No showcase product to check the store with.");
      return;
    }
    const product = await getProduct(shop, token, lookupId);
    if (!product) {
      await fail("live store", "The showcase product is gone; could not check the store.");
      return;
    }
    const actionId = crypto.randomUUID();
    let sparkTokens = 0;
    const store = async (name: string, png: Uint8Array): Promise<string> => {
      const key = `storecheck/${orgId}/${runId}/${actionId}/${name}.png`;
      await env.ARTIFACTS.put(key, png);
      return key;
    };

    interface PassedShot {
      url: string;
      boxes: ProofBox[];
    }
    let checkoutShot: (PassedShot & { code: string; percent: number }) | undefined;
    let productShot: PassedShot | undefined;

    if (wantProduct) {
      if (!newCopy || !product.handle) {
        await fail("live store", "The changed product has no storefront page to check.");
        return;
      }
      const sentence = firstSentence(newCopy);
      let png: Uint8Array | undefined;
      let found = false;
      let box: [number, number, number, number] | undefined;
      let browserReason = "";
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !found; attempt++) {
        const shot: StoreShot = await browser.productPage(shop, password, product.handle);
        if (!shot.ok) {
          browserReason = shot.reason;
          continue;
        }
        png = shot.png;
        const check = await checkProductPage(env, shot.png, sentence, spark);
        sparkTokens += check.tokens;
        found = check.found;
        box = check.box;
      }
      await hooks.addTokens(sparkTokens);
      sparkTokens = 0;
      if (!png) {
        await fail("live store", `Could not open the product page (${browserReason || "browser error"}).`);
        return;
      }
      const key = await store("product", png);
      if (!found) {
        await fail("live store", "The new copy is not on the product page yet.");
        return;
      }
      const published = await publishPublicImage(env, { orgId, actionId, r2key: key });
      publishedTokens.push(published.token);
      productShot = {
        url: published.url,
        boxes: box ? [{ label: "New copy", box, ok: true }] : [],
      };
    }

    if (wantCheckout) {
      if (code === undefined || percent === undefined) {
        await fail("live store", "The discount has nothing verifiable to check.");
        return;
      }
      if (product.variantId === undefined || product.variantPrice === undefined) {
        await fail(code, "The showcase product has no variant to check out with.");
        return;
      }
      const expectedDiscount = (product.variantPrice * percent) / 100;
      let png: Uint8Array | undefined;
      let result: CheckoutResult | undefined;
      let browserReason = "";
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !result?.pass; attempt++) {
        const shot: StoreShot = await browser.checkoutWithCode(
          shop,
          password,
          product.variantId,
          code,
        );
        if (!shot.ok) {
          browserReason = shot.reason;
          continue;
        }
        png = shot.png;
        result = await checkCheckout(env, shot.png, { code, percentOff: percent, price: product.variantPrice }, spark);
        sparkTokens += result.tokens;
      }
      await hooks.addTokens(sparkTokens);
      sparkTokens = 0;
      if (!png || !result) {
        await fail(code, `Could not open checkout (${browserReason || "browser error"}).`);
        return;
      }
      const key = await store("checkout", png);
      if (!result.pass) {
        const msg =
          result.codeRead !== code
            ? `Code ${code} was not accepted at checkout`
            : `Code ${code} did not take ${percent}% off at checkout`;
        await fail(code, msg);
        return;
      }
      const published = await publishPublicImage(env, { orgId, actionId, r2key: key });
      publishedTokens.push(published.token);
      checkoutShot = {
        url: published.url,
        boxes: checkoutBoxes(result, code, expectedDiscount),
        code,
        percent,
      };
    }

    const images: Array<{ url: string; boxes: ProofBox[] }> = [];
    if (checkoutShot) images.push({ url: checkoutShot.url, boxes: checkoutShot.boxes });
    if (productShot) images.push({ url: productShot.url, boxes: productShot.boxes });
    await hooks.recordAction(
      "shopify.storefront_check",
      code ?? "live store",
      "done",
      undefined,
      {
        ...(checkoutShot
          ? { checkout: { code: checkoutShot.code, percent: checkoutShot.percent } }
          : {}),
        ...(productShot ? { copyLive: true } : {}),
        image: images[0],
        images,
        url: images[0]?.url,
      },
      actionId,
    );
  } catch (err) {
    await hooks.recordAction("shopify.storefront_check", "live store", "failed");
    await audit(env, runId, "marketer", "action.failed", {
      system: "shopify",
      error: String(err).slice(0, 600),
    });
  }
}
