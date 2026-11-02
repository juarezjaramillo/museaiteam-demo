import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./bindings.js";

export type StoreShot = { ok: true; png: Uint8Array } | { ok: false; reason: string };

/**
 * The storefront seam: everything the act needs, mockable without a
 * browser. `password` is the dev-store password; screenshots are
 * 1280x1600 PNGs, never full page.
 */
export interface StoreBrowser {
  productPage(shop: string, password: string, handle: string): Promise<StoreShot>;
  checkoutWithCode(
    shop: string,
    password: string,
    variantNumericId: number,
    code: string,
  ): Promise<StoreShot>;
}

export function productUrl(shop: string, handle: string): string {
  return `https://${shop}/products/${handle}`;
}

export function cartUrl(shop: string, variantNumericId: number, code: string): string {
  return `https://${shop}/cart/${variantNumericId}:1?discount=${encodeURIComponent(code)}`;
}

/** The slice of a Puppeteer page unlock needs: fakeable in tests. */
export interface UnlockPage {
  goto(url: string, opts?: unknown): Promise<unknown>;
  $(
    selector: string,
  ): Promise<{ type(text: string): Promise<void>; press(key: string): Promise<void> } | null>;
  waitForNavigation?(opts?: unknown): Promise<unknown>;
}

const PASSWORD_SELECTOR = 'input[name="password"], input[type="password"]';

/**
 * Open the dev-store password gate and type through it. No password
 * page means a public (or already unlocked) store: continue.
 */
export async function unlockStore(
  page: UnlockPage,
  shop: string,
  password: string,
): Promise<void> {
  await page.goto(`https://${shop}/password`, { waitUntil: "networkidle0", timeout: 30000 });
  const input = await page.$(PASSWORD_SELECTOR);
  if (!input) return;
  await input.type(password);
  await Promise.all([
    page.waitForNavigation?.({ waitUntil: "networkidle0", timeout: 30000 }).catch(() => null),
    input.press("Enter"),
  ]);
  if (await page.$(PASSWORD_SELECTOR)) {
    throw new Error("store password was rejected");
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** The Puppeteer page surface the checks use. */
export interface BrowserPage {
  goto(url: string, opts: { waitUntil: "networkidle0"; timeout: number }): Promise<unknown>;
  $(
    selector: string,
  ): Promise<{
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
    click(): Promise<void>;
  } | null>;
  waitForNavigation(opts: { waitUntil: "networkidle0"; timeout: number }): Promise<unknown>;
  setViewport(opts: { width: number; height: number }): Promise<void>;
  screenshot(opts: { type: "png" }): Promise<Uint8Array>;
  close(): Promise<void>;
}

async function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("browser check timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** StoreBrowser on Cloudflare Browser Rendering. Never throws. */
export class CloudflareStoreBrowser implements StoreBrowser {
  constructor(private env: Env) {}

  async productPage(shop: string, password: string, handle: string): Promise<StoreShot> {
    return this.run(async (page) => {
      await unlockStore(page, shop, password);
      await page.goto(productUrl(shop, handle), { waitUntil: "networkidle0", timeout: 30000 });
      return new Uint8Array(await page.screenshot({ type: "png" }));
    });
  }

  async checkoutWithCode(
    shop: string,
    password: string,
    variantNumericId: number,
    code: string,
  ): Promise<StoreShot> {
    return this.run(async (page) => {
      await unlockStore(page, shop, password);
      await page.goto(cartUrl(shop, variantNumericId, code), {
        waitUntil: "networkidle0",
        timeout: 30000,
      });
      await sleep(2000);
      const toggle = await page.$(".order-summary-toggle, [data-order-summary-toggle]").catch(() => null);
      if (toggle) {
        await toggle.click().catch(() => {});
        await sleep(1000);
      }
      return new Uint8Array(await page.screenshot({ type: "png" }));
    });
  }

  private async run(fn: (page: BrowserPage) => Promise<Uint8Array>): Promise<StoreShot> {
    const browser = await puppeteer.launch(this.env.BROWSER);
    try {
      return await withTimeout(
        90000,
        (async () => {
          const page = await browser.newPage();
          try {
            await page.setViewport({ width: 1280, height: 1600 });
            const png = await fn(page as unknown as BrowserPage);
            return { ok: true as const, png };
          } finally {
            await page.close().catch(() => {});
          }
        })(),
      );
    } catch (err) {
      return {
        ok: false,
        reason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }
}
