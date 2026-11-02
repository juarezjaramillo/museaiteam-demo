#!/usr/bin/env node
// Generates the Tres Cumbres Coffee Co. product photos with Muse Image.
// Reads products.json in this folder. Skips images that already exist.
// API key: $META_MODEL_API_KEY, else first line of
// ~/.config/museaiteam/meta-model-api-key. The key is never printed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://api.meta.ai/v1";
const MODEL = "muse-image-1.0";
const COST_EACH = 0.01;

function loadKey() {
  if (process.env.META_MODEL_API_KEY) return process.env.META_MODEL_API_KEY;
  const p = join(homedir(), ".config", "museaiteam", "meta-model-api-key");
  return readFileSync(p, "utf8").split("\n")[0].trim();
}

async function callApi(path, body) {
  const key = loadKey();
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(BASE + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      return Buffer.from(json.data[0].b64_json, "base64");
    }
    lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (res.status === 503 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

const BRAND_PROMPT =
  "Matte kraft-paper stand-up coffee bag with a simple flat illustrated logo of " +
  "three mountain peaks and the words \"TRES CUMBRES COFFEE CO.\" in clean " +
  "sans-serif capitals, a colored label band, studio product photo, soft daylight, " +
  "light warm-gray background, no other text.";

const BAND_COLORS = {
  "chiapas-altura": "terracotta orange",
  "veracruz-coatepec": "sage green",
  "oaxaca-pluma": "ochre yellow",
  "volcan-dark": "clay red",
  "sierra-decaf": "olive green",
  "tres-cumbres-gift-box": "walnut brown",
};

const PROPS = {
  "chiapas-altura": "a small pile of coffee beans beside the bag",
  "veracruz-coatepec": "a ceramic cup of coffee beside the bag",
  "oaxaca-pluma": "a small pile of coffee beans beside the bag",
  "volcan-dark": "a ceramic cup of coffee and a few coffee beans beside the bag",
  "sierra-decaf": "a ceramic cup of coffee beside the bag",
  "tres-cumbres-gift-box": "a few scattered coffee beans in front of the box",
};

function productPrompt(p) {
  if (p.handle === "tres-cumbres-gift-box") {
    return (
      "Same brand style as the reference: matte kraft packaging with the flat " +
      "illustrated logo of three mountain peaks and the words \"TRES CUMBRES " +
      "COFFEE CO.\" in clean sans-serif capitals. An open kraft gift box holding " +
      "three small bags with walnut brown label bands labeled \"LIGHT\", " +
      "\"MEDIUM\" and \"DARK\" in large legible capitals. Studio product photo, " +
      "soft daylight, light warm-gray background, " +
      PROPS[p.handle] +
      ", no other text. Square image."
    );
  }
  return (
    "Same bag design as the reference: matte kraft-paper stand-up coffee bag " +
    "with the flat illustrated logo of three mountain peaks and the words " +
    "\"TRES CUMBRES COFFEE CO.\" in clean sans-serif capitals, " +
    BAND_COLORS[p.handle] +
    " label band. Printed on the label: the product name \"" +
    p.title +
    "\" and, large and legible, the roast \"" +
    p.roast +
    "\". Studio product photo, soft daylight, light warm-gray background, " +
    PROPS[p.handle] +
    ", the bag is the clear hero, no other text. Square image."
  );
}

const products = JSON.parse(
  readFileSync(join(HERE, "products.json"), "utf8")
).products;
mkdirSync(join(HERE, "images"), { recursive: true });

let generated = 0;
const t0 = Date.now();

async function ensureFile(relPath, make) {
  const abs = join(HERE, relPath);
  if (existsSync(abs)) {
    console.log(`${relPath} exists, skipped`);
    return;
  }
  const start = Date.now();
  const png = await make();
  writeFileSync(abs, png);
  generated++;
  console.log(
    `${relPath} ${png.length} bytes in ${((Date.now() - start) / 1000).toFixed(1)}s`
  );
}

await ensureFile("images/_brand-reference.png", () =>
  callApi("/images/generations", {
    model: MODEL,
    prompt: BRAND_PROMPT,
    n: 1,
    size: "1024x1024",
    output_format: "png",
    tool_enablement: {
      enable_image_search: false,
      enable_web_search: false,
      enable_shell: false,
    },
  })
);

const refB64 = readFileSync(
  join(HERE, "images/_brand-reference.png")
).toString("base64");

for (const p of products) {
  await ensureFile(p.image_file, () =>
    callApi("/images/edits", {
      model: MODEL,
      prompt: productPrompt(p),
      images: [{ image_url: "data:image/png;base64," + refB64 }],
      n: 1,
    })
  );
}

console.log(
  `Done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${generated} image(s) generated, cost $${(generated * COST_EACH).toFixed(2)}.`
);
