import type { Action } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { getProviderConfig } from "./oauth.js";
import { checkGuard } from "./guards.js";
import { runProductCopy } from "./agents.js";
import { checkCopyAgainstPhoto } from "./vision.js";
import {
  getProduct,
  updateProductDescription,
} from "./integrations/shopify.js";

export interface ProductCopyHooks {
  recordAction(
    kind: Action["kind"],
    target: string,
    status: Action["status"],
    revertPayload?: Record<string, unknown>,
    payload?: Record<string, unknown>,
  ): Promise<string>;
  addTokens(n: number): Promise<void>;
}

/**
 * Maya's product-copy act: rewrite with Spark, read the rewrite back
 * against the product's photo, fix once from the photo's facts, and
 * only then write to Shopify. A copy that still contradicts the
 * photo is never published.
 */
export async function executeProductCopyAct(
  env: Env,
  args: {
    orgId: string;
    runId: string;
    decision: string;
    shop: string;
    token: string;
    hooks: ProductCopyHooks;
  },
): Promise<void> {
  const { orgId, runId, decision, shop, token, hooks } = args;
  const productGuard = await checkGuard(env, orgId, "marketer", "shopify", "product");
  if (!productGuard.allowed) {
    await hooks.recordAction("shopify.product_copy", "product", "skipped", undefined, {
      reason: productGuard.reason,
    });
    return;
  }
  const { product_id: productId } = await getProviderConfig(env, orgId, "shopify");
  if (typeof productId !== "string" || !productId) {
    await hooks.recordAction("shopify.product_copy", "product", "skipped", undefined, {
      reason: "no showcase product picked (save one in Setup)",
    });
    await audit(env, runId, "marketer", "action.skipped", {
      system: "shopify",
      reason: "showcase product not configured",
    });
    return;
  }
  try {
    const product = await getProduct(shop, token, productId);
    if (!product) {
      await hooks.recordAction("shopify.product_copy", "product", "skipped", undefined, {
        reason: "showcase product not found",
      });
      return;
    }
    const copy = await runProductCopy(env, decision, product.title, product.description);
    await hooks.addTokens(copy.tokens);
    let description = copy.description;
    let photoUrl: string | undefined;
    let photoFacts: string[] = [];
    let photoBox: [number, number, number, number] | undefined;
    if (product.imageUrl) {
      let vision = await checkCopyAgainstPhoto(env, product.imageUrl, description);
      await hooks.addTokens(vision.tokens);
      if (!vision.consistent) {
        const retry = await runProductCopy(
          env,
          decision,
          product.title,
          description,
          `the photo shows: ${vision.photoFacts.join("; ") || "unknown"}; fix these conflicts: ${vision.conflicts.join("; ")}`,
        );
        await hooks.addTokens(retry.tokens);
        description = retry.description;
        vision = await checkCopyAgainstPhoto(env, product.imageUrl, description);
        await hooks.addTokens(vision.tokens);
      }
      if (!vision.consistent) {
        const first =
          vision.conflicts[0] ?? "the copy does not match the product photo";
        await hooks.recordAction("shopify.product_copy", product.title, "failed", undefined, {
          failReason: `${first}; not published.`,
        });
        await audit(env, runId, "marketer", "action.failed", {
          system: "shopify",
          error: "copy-photo mismatch",
        });
        return;
      }
      photoUrl = product.imageUrl;
      photoFacts = vision.photoFacts;
      photoBox = vision.box;
    }
    await updateProductDescription(shop, token, product.id, description);
    await hooks.recordAction(
      "shopify.product_copy",
      product.title,
      "done",
      {
        shop,
        productId: product.id,
        priorDescription: product.description,
      },
      photoUrl
        ? {
            description,
            image: {
              url: photoUrl,
              boxes: photoBox ? [{ label: "label", box: photoBox, ok: true }] : [],
            },
            visionSummary: `Checked against the product photo: ${photoFacts.join("; ") || "label"} ✓`,
          }
        : { description },
    );
  } catch (err) {
    await hooks.recordAction("shopify.product_copy", "product", "failed");
    await audit(env, runId, "marketer", "action.failed", {
      system: "shopify",
      error: String(err).slice(0, 600),
    });
  }
}
