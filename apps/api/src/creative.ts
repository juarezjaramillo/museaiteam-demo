import {
  CREATIVE_SCOPE,
  CREATIVE_SYSTEM,
  type Action,
  type CampaignFormat,
  type ProofBox,
  type VisionCheck as VisionCheckData,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit, getRun } from "./db.js";
import { getProviderConfig } from "./oauth.js";
import { hireToken } from "./seat-creds.js";
import { checkGuard } from "./guards.js";
import { runCampaignPlan } from "./agents.js";
import { checkImageFacts, type ImageFacts } from "./vision.js";
import {
  IMAGE_COST_CENTS,
  ImageContentPolicyError,
  generateImage,
  type ImageSize,
} from "./images.js";
import { listProducts, shopName } from "./integrations/shopify.js";
import { findChannelId, postMessage } from "./integrations/slack.js";
import { appendImageBlocks } from "./integrations/notion.js";
import { publishPublicImage } from "./artifacts.js";

export interface CreativeHooks {
  recordAction(
    kind: Action["kind"],
    target: string,
    status: Action["status"],
    revertPayload?: Record<string, unknown>,
    payload?: Record<string, unknown>,
    actionId?: string,
  ): Promise<string>;
  /**
   * Rewrite a pending row in place: status, payload, and rebuilt
   * proof. Retries resume from the saved progress instead of
   * re-posting to Slack and Notion.
   */
  updateAction(
    actionId: string,
    target: string,
    status: Action["status"],
    payload?: Record<string, unknown>,
    revertPayload?: Record<string, unknown>,
  ): Promise<void>;
  addTokens(n: number): Promise<void>;
}

/** What a retried act needs to skip finished phases. */
interface CreativeProgress {
  started: true;
  plan?: { formats: CampaignFormat[]; headline: string; visual: string };
  urls?: string[];
  heroIdx?: number;
  beforeImage?: string;
  publishedTokens?: string[];
  image?: { url: string; boxes: ProofBox[] };
  visionSummary?: string;
  imageCount?: number;
  imageCostCents?: number;
  code?: string;
  percent?: number;
  slack?: { channel: string; ts: string };
  notionDone?: boolean;
}

const FORMAT_SHOT: Record<CampaignFormat, { size: ImageSize; shot: string }> = {
  feed: { size: "1080x1350", shot: "portrait social post" },
  story: { size: "1080x1920", shot: "full-screen vertical story" },
};

const MAX_FIXES = 2;

function pngToDataUrl(png: Uint8Array): string {
  let bin = "";
  for (const b of png) bin += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(bin)}`;
}

/** Last-resort brand: Title Case the shop subdomain. */
function brandFallback(shop: string): string {
  const words = (shop.split(".")[0] ?? shop)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1));
  return words.length > 0 ? words.join(" ") : shop;
}

async function loadOffer(
  env: Env,
  runId: string,
): Promise<{ code?: string; percent?: number }> {
  const row = await env.DB.prepare(
    `SELECT target, payload FROM actions WHERE run_id = ? AND kind IN ('shopify.targeted_discount', 'shopify.create_discount') AND status = 'done' ORDER BY rowid DESC LIMIT 1`,
  )
    .bind(runId)
    .first<{ target: string; payload: string }>();
  if (!row || !row.target || row.target === "discount") return {};
  let percent: number | undefined;
  try {
    const p = JSON.parse(row.payload ?? "{}") as { percent?: unknown };
    if (typeof p.percent === "number" && Number.isFinite(p.percent)) {
      percent = p.percent;
    }
  } catch {
    /* legacy row without a payload */
  }
  return { code: row.target, ...(percent !== undefined ? { percent } : {}) };
}

async function runNotionPage(env: Env, runId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT revert_payload FROM actions WHERE run_id = ? AND kind IN ('notion.run_page', 'notion.create_page') AND status = 'done' ORDER BY rowid DESC LIMIT 1`,
  )
    .bind(runId)
    .first<{ revert_payload: string | null }>();
  if (!row?.revert_payload) return null;
  try {
    const p = JSON.parse(row.revert_payload) as { pageId?: unknown };
    return typeof p.pageId === "string" ? p.pageId : null;
  } catch {
    return null;
  }
}

function imagePrompt(args: {
  brand: string;
  headline: string;
  visual: string;
  shot: string;
  code?: string;
  percent?: number;
}): string {
  const offer =
    args.percent !== undefined && args.code
      ? `, "${args.percent}% OFF", "CODE ${args.code}"`
      : "";
  return (
    `Black Friday campaign image, ${args.shot}: ${args.visual}. ` +
    `Print exactly this text and nothing else: the brand name "${args.brand}", ` +
    `the headline "${args.headline}"${offer}.`
  );
}

function expectedFor(
  id: "brand" | "code" | "percent",
  facts: ImageFacts,
): string | undefined {
  if (id === "brand") return facts.brand;
  if (id === "code") return facts.code;
  return facts.percentOff !== undefined ? `${facts.percentOff}% OFF` : undefined;
}

function fixPromptFor(check: VisionCheckData, facts: ImageFacts): string {
  const sentences: string[] = [];
  for (const id of ["brand", "code", "percent"] as const) {
    const expected = expectedFor(id, facts);
    if (expected === undefined) continue;
    const c = check.checks.find((x) => x.fact === id);
    const label = id === "brand" ? "brand name" : id === "code" ? "code" : "percent off";
    if (!c || !c.found) {
      sentences.push(`The ${label} is missing. Add exactly "${expected}".`);
    } else if (
      c.read.trim() !== expected &&
      !(id === "percent" && c.read.trim() === `${facts.percentOff}%`)
    ) {
      sentences.push(
        `The ${label} reads "${c.read}". Change it to exactly "${expected}".`,
      );
    }
  }
  for (const t of check.textErrors) {
    sentences.push(`Fix the garbled text: "${t}".`);
  }
  for (const s of facts.mustNotSay ?? []) {
    if (s && check.checks.some((c) => c.read.includes(s))) {
      sentences.push(`Remove "${s}" from the image.`);
    }
  }
  sentences.push("Keep everything else exactly the same.");
  return sentences.join(" ");
}

function failedLabels(check: VisionCheckData, facts: ImageFacts): string {
  const labels: string[] = [];
  for (const id of ["brand", "code", "percent"] as const) {
    const expected = expectedFor(id, facts);
    if (expected === undefined) continue;
    const c = check.checks.find((x) => x.fact === id);
    const ok =
      !!c &&
      c.found &&
      (c.read.trim() === expected ||
        (id === "percent" && c.read.trim() === `${facts.percentOff}%`));
    if (!ok) {
      labels.push(
        id === "brand" ? "the brand name" : id === "code" ? "the code" : "the percent off",
      );
    }
  }
  if (check.textErrors.length > 0) labels.push("the garbled text");
  if (labels.length === 0) return "the offer";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function boxesFor(check: VisionCheckData, facts: ImageFacts): ProofBox[] {
  const out: ProofBox[] = [];
  for (const id of ["brand", "code", "percent"] as const) {
    const expected = expectedFor(id, facts);
    if (expected === undefined) continue;
    const c = check.checks.find((x) => x.fact === id);
    if (!c?.box) continue;
    const ok =
      c.found &&
      (c.read.trim() === expected ||
        (id === "percent" && c.read.trim() === `${facts.percentOff}%`));
    const label =
      id === "brand"
        ? "brand"
        : id === "code"
          ? `CODE ${facts.code}`
          : `${facts.percentOff}% OFF`;
    out.push({ label, box: c.box, ok });
  }
  return out;
}

function mayaLine(code?: string, percent?: number): string {
  return code && percent !== undefined
    ? `Fresh Black Friday creatives, checked and ready — CODE ${code} for ${percent}% off.`
    : "Fresh Black Friday creatives, checked and ready.";
}

/**
 * Maya's campaign image act: plan with Spark, render with Muse Image
 * on the store's real product photos, read every image back with
 * Spark vision against this run's real offer, publish, and deliver
 * to Slack and the run's Notion page. Never throws: failures become
 * honest failed actions and the run continues.
 */
export async function executeCreativeAct(
  env: Env,
  args: {
    orgId: string;
    runId: string;
    goal: string;
    decision: string;
    hooks: CreativeHooks;
  },
): Promise<void> {
  const { orgId, runId, goal, decision, hooks } = args;
  const doneRows = await env.DB.prepare(
    "SELECT kind FROM actions WHERE run_id = ? AND status = 'done'",
  )
    .bind(runId)
    .all<{ kind: string }>();
  if ((doneRows.results ?? []).some((r) => r.kind === "creative.campaign_image")) {
    return;
  }
  const guard = await checkGuard(env, orgId, "marketer", CREATIVE_SYSTEM, CREATIVE_SCOPE);
  if (!guard.allowed) {
    await hooks.recordAction(
      "creative.campaign_image",
      "campaign images",
      "skipped",
      undefined,
      { reason: guard.reason },
    );
    await audit(env, runId, "marketer", "action.skipped", {
      system: "creative",
      reason: guard.reason,
    });
    return;
  }
  const teamId = (await getRun(env, runId))?.team_id ?? null;
  const shopToken = await hireToken(env, orgId, teamId, "shopify");
  const { shop } = await getProviderConfig(env, orgId, "shopify");
  if (!shopToken || typeof shop !== "string" || !shop) {
    await hooks.recordAction(
      "creative.campaign_image",
      "Black Friday campaign images (connect Shopify to generate)",
      "would_do",
      undefined,
      {
        reason: "not_connected",
        goal: goal.slice(0, 200),
        decision: decision.slice(0, 200),
      },
    );
    await audit(env, runId, "marketer", "action.skipped", {
      system: "creative",
      reason: "not_connected",
    });
    return;
  }

  // Intent row: a retried act (step timeout, eviction) finds this and
  // resumes from saved progress instead of delivering twice. R2 keys
  // derive from the action id, so regenerated bytes overwrite in place.
  const pendingRow = await env.DB.prepare(
    `SELECT id, payload FROM actions WHERE run_id = ? AND kind = 'creative.campaign_image'
     AND status = 'pending' ORDER BY rowid DESC LIMIT 1`,
  )
    .bind(runId)
    .first<{ id: string; payload: string }>();
  let progress: CreativeProgress = { started: true };
  let actionId: string;
  if (pendingRow) {
    actionId = pendingRow.id;
    try {
      progress = { started: true, ...((JSON.parse(pendingRow.payload ?? "{}") ?? {}) as Partial<CreativeProgress>) };
    } catch {
      /* corrupt progress: redo every phase under the same id */
    }
  } else {
    actionId = crypto.randomUUID();
    await hooks.recordAction(
      "creative.campaign_image",
      "campaign images",
      "pending",
      undefined,
      { ...(progress as unknown as Record<string, unknown>) },
      actionId,
    );
  }
  const saveProgress = async (): Promise<void> => {
    await hooks.updateAction(
      actionId,
      progress.plan?.headline ?? "campaign images",
      "pending",
      { ...(progress as unknown as Record<string, unknown>) },
    );
  };

  try {
    const offer = await loadOffer(env, runId);
    let brand: string | null = null;
    try {
      brand = await shopName(shop, shopToken);
    } catch (err) {
      await audit(env, runId, "marketer", "action.note", {
        system: "creative",
        note: `shop name lookup failed, using domain: ${String(err).slice(0, 120)}`,
      });
    }
    if (!brand) brand = brandFallback(shop);
    const facts: ImageFacts = {
      brand,
      ...(offer.code ? { code: offer.code } : {}),
      ...(offer.percent !== undefined ? { percentOff: offer.percent } : {}),
    };
    let references: string[] = [];
    try {
      const products = await listProducts(shop, shopToken);
      references = products
        .map((p) => p.imageUrl)
        .filter((u): u is string => !!u)
        .slice(0, 3);
    } catch (err) {
      await audit(env, runId, "marketer", "action.note", {
        system: "creative",
        note: `product photos unavailable, generating without references: ${String(err).slice(0, 120)}`,
      });
    }

    if (!progress.plan) {
      const { plan: fresh, tokens: planTokens } = await runCampaignPlan(env, goal, decision);
      await hooks.addTokens(planTokens);
      progress.plan = { formats: fresh.formats, headline: fresh.headline, visual: fresh.visual };
      await saveProgress();
    }
    const plan = progress.plan;
    let sparkTokens = 0;
    let n = 0;
    let imagesMade = 0;
    const storeAttempt = async (png: Uint8Array, checkJson: unknown): Promise<string> => {
      n += 1;
      const key = `creative/${orgId}/${runId}/${actionId}/${n}.png`;
      await env.ARTIFACTS.put(key, png);
      await env.ARTIFACTS.put(
        `creative/${orgId}/${runId}/${actionId}/${n}.json`,
        JSON.stringify(checkJson),
      );
      imagesMade += 1;
      return key;
    };

    interface FormatWork {
      format: CampaignFormat;
      finalKey: string;
      firstKey: string;
      fixes: number;
      check: VisionCheckData;
    }
    const worked: FormatWork[] = [];
    const published = progress.urls && progress.urls.length === plan.formats.length;
    for (const format of published ? [] : plan.formats) {
      const { size, shot } = FORMAT_SHOT[format];
      let png = (
        await generateImage(env, {
          prompt: imagePrompt({
            brand: facts.brand,
            headline: plan.headline,
            visual: plan.visual,
            shot,
            code: offer.code,
            percent: offer.percent,
          }),
          references,
          size,
        })
      ).png;
      let check = await checkImageFacts(env, png, facts);
      sparkTokens += check.tokens;
      const firstKey = await storeAttempt(png, check.check);
      let fixes = 0;
      while (!check.pass && fixes < MAX_FIXES) {
        fixes += 1;
        png = (
          await generateImage(env, {
            prompt: fixPromptFor(check.check, facts),
            references: [pngToDataUrl(png)],
            size,
          })
        ).png;
        check = await checkImageFacts(env, png, facts);
        sparkTokens += check.tokens;
        await storeAttempt(png, check.check);
      }
      if (!check.pass) {
        await hooks.addTokens(sparkTokens);
        await hooks.updateAction(
          actionId,
          "campaign images",
          "failed",
          {
            failReason: `Could not print ${failedLabels(check.check, facts)} correctly in 3 tries; draft kept for you.`,
            imageCount: (progress.imageCount ?? 0) + imagesMade,
            imageCostCents: ((progress.imageCount ?? 0) + imagesMade) * IMAGE_COST_CENTS,
          },
        );
        await audit(env, runId, "marketer", "action.failed", {
          system: "creative",
          error: "vision check failed after 2 fixes",
        });
        return;
      }
      worked.push({
        format,
        finalKey: `creative/${orgId}/${runId}/${actionId}/${n}.png`,
        firstKey,
        fixes,
        check: check.check,
      });
    }
    await hooks.addTokens(sparkTokens);

    const publish = async (r2key: string): Promise<string> => {
      const { token, url } = await publishPublicImage(env, { orgId, actionId, r2key });
      progress.publishedTokens = [...(progress.publishedTokens ?? []), token];
      return url;
    };
    let urls: string[];
    let heroIdx: number;
    let beforeImage: string | undefined;
    let heroImage: { url: string; boxes: ProofBox[] };
    let visionSummary: string;
    if (published && progress.urls && progress.image && progress.visionSummary) {
      urls = progress.urls;
      heroIdx = progress.heroIdx ?? 0;
      beforeImage = progress.beforeImage;
      heroImage = progress.image;
      visionSummary = progress.visionSummary;
      imagesMade += progress.imageCount ?? 0;
    } else {
      urls = [];
      for (const w of worked) {
        urls.push(await publish(w.finalKey));
      }
      heroIdx = Math.max(
        0,
        worked.findIndex((w) => w.fixes > 0),
      );
      const hero = worked[heroIdx];
      if (hero.fixes > 0) {
        beforeImage = await publish(hero.firstKey);
      }
      const totalFixes = worked.reduce((s, w) => s + w.fixes, 0);
      const parts: string[] = [];
      if (offer.code) parts.push(`CODE ${offer.code} ✓`);
      if (offer.percent !== undefined) parts.push(`${offer.percent}% OFF ✓`);
      parts.push("brand ✓");
      visionSummary =
        `Checked by Muse Spark: ${parts.join(" · ")}` +
        (totalFixes > 0 ? ` (fixed ${totalFixes} typo${totalFixes === 1 ? "" : "s"})` : "");
      heroImage = { url: urls[heroIdx], boxes: boxesFor(hero.check, facts) };
      progress.urls = urls;
      progress.heroIdx = heroIdx;
      if (beforeImage) progress.beforeImage = beforeImage;
      progress.image = heroImage;
      progress.visionSummary = visionSummary;
      progress.imageCount = (progress.imageCount ?? 0) + imagesMade;
      progress.imageCostCents = (progress.imageCount ?? 0) * IMAGE_COST_CENTS;
      if (offer.code) progress.code = offer.code;
      if (offer.percent !== undefined) progress.percent = offer.percent;
      await saveProgress();
    }

    if (!progress.slack) {
      try {
        const slackToken = await hireToken(env, orgId, teamId, "slack");
        if (slackToken) {
          const channelId = await findChannelId(slackToken, env.DEMO_SLACK_CHANNEL);
          if (channelId) {
            const line = mayaLine(offer.code, offer.percent);
            const posted = await postMessage(slackToken, channelId, line, [
              { type: "section", text: { type: "mrkdwn", text: line } },
              ...urls.map((image_url, i) => ({
                type: "image",
                image_url,
                alt_text: `${plan.headline} (${plan.formats[i] ?? "feed"})`.slice(0, 2000),
              })),
            ]);
            progress.slack = { channel: posted.channel, ts: posted.ts };
            await saveProgress();
          }
        }
      } catch (err) {
        await audit(env, runId, "marketer", "action.delivery_failed", {
          system: "slack",
          error: String(err).slice(0, 200),
        });
      }
    }
    if (!progress.notionDone) {
      try {
        const pageId = await runNotionPage(env, runId);
        const notionToken = pageId ? await hireToken(env, orgId, teamId, "notion") : null;
        if (pageId && notionToken) {
          await appendImageBlocks(notionToken, pageId, urls);
          progress.notionDone = true;
          await saveProgress();
        } else {
          progress.notionDone = true;
          await saveProgress();
        }
      } catch (err) {
        await audit(env, runId, "marketer", "action.delivery_failed", {
          system: "notion",
          error: String(err).slice(0, 200),
        });
      }
    }

    const slack = progress.slack;
    await hooks.updateAction(
      actionId,
      plan.headline,
      "done",
      {
        images: urls,
        url: urls[heroIdx],
        image: heroImage,
        ...(beforeImage ? { beforeImage } : {}),
        visionSummary,
        imageCount: progress.imageCount ?? imagesMade,
        imageCostCents: (progress.imageCount ?? imagesMade) * IMAGE_COST_CENTS,
        ...(offer.code ? { code: offer.code } : {}),
        ...(offer.percent !== undefined ? { percent: offer.percent } : {}),
      },
      {
        tokens: progress.publishedTokens ?? [],
        ...(slack ? { slackChannel: slack.channel, slackTs: slack.ts } : {}),
      },
    );
  } catch (err) {
    if (err instanceof ImageContentPolicyError) {
      await hooks.updateAction(
        actionId,
        "campaign images",
        "failed",
        {
          failReason: "Muse Image refused the campaign prompt (content policy); no image made.",
        },
      );
    } else {
      await hooks.updateAction(actionId, "campaign images", "failed", {});
    }
    await audit(env, runId, "marketer", "action.failed", {
      system: "creative",
      error: String(err).slice(0, 600),
    });
  }
}

/** Public image route handler: token → R2 PNG, 404 when unknown or revoked. */
export async function servePublicImage(env: Env, token: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT r2_key FROM public_images WHERE token = ? AND revoked_at IS NULL",
  )
    .bind(token)
    .first<{ r2_key: string }>();
  if (!row) return new Response("not found", { status: 404 });
  const obj = await env.ARTIFACTS.get(row.r2_key);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": "image/png",
      // Short cache: undo revokes the token, and revocation should bite soon.
      "cache-control": "public, max-age=300",
    },
  });
}
