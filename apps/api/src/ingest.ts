import { chunkText, vectorId, type TextChunk } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { assertPublicHttpUrl, providerFetch } from "./integrations/http.js";
import { readFile as ghReadFile, readTree } from "./integrations/github.js";
import { recentClosedTickets } from "./integrations/hubspot.js";
import { listRecentIssues } from "./integrations/linear.js";
import { readPageText, searchPages } from "./integrations/notion.js";
import { getProduct, listProducts } from "./integrations/shopify.js";
import { channelHistory, listChannels } from "./integrations/slack.js";

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const res = (await env.AI.run(EMBED_MODEL, { text: texts })) as {
    data?: number[][];
  };
  if (!res.data || res.data.length !== texts.length) {
    throw new Error("Workers AI returned no embeddings");
  }
  return res.data;
}

export async function embedAndStore(
  env: Env,
  orgId: string,
  chunks: TextChunk[],
): Promise<number> {
  if (!chunks.length) return 0;
  const vectors = await embed(
    env,
    chunks.map((c) => c.text),
  );
  await env.ORG_MEMORY.upsert(
    chunks.map((c, i) => ({
      id: vectorId(orgId, c.source, c.ordinal),
      values: vectors[i],
      metadata: { org_id: orgId, source: c.source, text: c.text.slice(0, 2000) },
    })),
  );
  return chunks.length;
}

export async function ingestUpload(
  env: Env,
  orgId: string,
  filename: string,
  body: ArrayBuffer,
): Promise<{ chunks: number; bytes: number }> {
  const key = `${orgId}/uploads/${Date.now()}-${filename}`;
  await env.ARTIFACTS.put(key, body);
  const text = new TextDecoder().decode(body);
  const chunks = chunkText(`upload:${filename}`, text);
  const stored = await embedAndStore(env, orgId, chunks);
  return { chunks: stored, bytes: body.byteLength };
}

const DOC_PATTERN = /(^|\/)(README|CONTRIBUTING|ARCHITECTURE|CHANGELOG|docs\/.*)(\.|$)/i;
const MAX_DOC_FILES = 12;
const MAX_FILE_BYTES = 20000;

async function sha16(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export async function ingestGitHub(
  env: Env,
  orgId: string,
  token: string,
  repo: string,
  sinceSha = "",
): Promise<{ files: number; chunks: number; cursor: string }> {
  const paths = await readTree(token, repo);
  const cursor = await sha16([...paths].sort().join("\n"));
  if (sinceSha && cursor === sinceSha) return { files: 0, chunks: 0, cursor };
  const docPaths = paths.filter((p) => DOC_PATTERN.test(p)).slice(0, MAX_DOC_FILES);
  let chunks = 0;
  for (const path of docPaths) {
    const text = await ghReadFile(token, repo, path).catch(() => null);
    if (!text) continue;
    chunks += await embedAndStore(
      env,
      orgId,
      chunkText(`github:${repo}:${path}`, text.slice(0, MAX_FILE_BYTES)),
    );
  }
  // The repo tree itself is context worth keeping.
  chunks += await embedAndStore(
    env,
    orgId,
    chunkText(`github:${repo}:tree`, paths.join("\n")),
  );
  return { files: docPaths.length, chunks, cursor };
}

export interface GatherResult {
  chunks: number;
  cursor: string;
}

/** Closed tickets are resolved knowledge: subject + resolution trail. */
export async function ingestHubSpot(
  env: Env,
  orgId: string,
  token: string,
  since = "",
): Promise<GatherResult> {
  const tickets = await recentClosedTickets(token, 30);
  let chunks = 0;
  let cursor = since;
  for (const t of tickets) {
    if (since && t.closedate <= since) continue;
    if (!t.subject && !t.content) continue;
    chunks += await embedAndStore(
      env,
      orgId,
      chunkText(`hubspot:ticket:${t.subject.slice(0, 60)}`, `${t.subject}\n${t.content}`),
    );
    if (t.closedate > cursor) cursor = t.closedate;
  }
  return { chunks, cursor };
}

/** Recent issues carry product direction and known pain. */
export async function ingestLinear(
  env: Env,
  orgId: string,
  token: string,
  since = "",
): Promise<GatherResult> {
  const issues = await listRecentIssues(token, 50);
  let chunks = 0;
  let cursor = since;
  for (const i of issues) {
    if (since && i.updatedAt <= since) continue;
    if (!i.title && !i.description) continue;
    chunks += await embedAndStore(
      env,
      orgId,
      chunkText(`linear:issue:${i.id}`, `${i.title}\n${i.description}`),
    );
    if (i.updatedAt > cursor) cursor = i.updatedAt;
  }
  return { chunks, cursor };
}

/** Company docs, newest-edited first. */
export async function ingestNotion(
  env: Env,
  orgId: string,
  token: string,
  since = "",
): Promise<GatherResult> {
  const pages = await searchPages(token, 20);
  let chunks = 0;
  let cursor = since;
  for (const p of pages) {
    if (!p.id) continue;
    if (since && p.lastEdited <= since) continue;
    const text = await readPageText(token, p.id).catch(() => "");
    if (!text.trim()) {
      if (p.lastEdited > cursor) cursor = p.lastEdited;
      continue;
    }
    chunks += await embedAndStore(env, orgId, chunkText(`notion:${p.title.slice(0, 60)}`, text));
    if (p.lastEdited > cursor) cursor = p.lastEdited;
  }
  return { chunks, cursor };
}

/** Public channel chatter: how the company talks and what recurs. */
export async function ingestSlack(
  env: Env,
  orgId: string,
  token: string,
  since = "0",
): Promise<GatherResult> {
  const channels = await listChannels(token);
  let chunks = 0;
  let cursor = since;
  for (const c of channels) {
    const msgs = await channelHistory(token, c.id, since, 30).catch(() => []);
    const fresh = msgs.filter((m) => m.ts > since);
    if (fresh.length === 0) continue;
    chunks += await embedAndStore(
      env,
      orgId,
      chunkText(
        `slack:${c.name}`,
        fresh.map((m) => m.text).join("\n"),
      ),
    );
    for (const m of fresh) if (m.ts > cursor) cursor = m.ts;
  }
  return { chunks, cursor };
}

/** The store catalog: what the company sells and how it talks about it. */
export async function ingestShopify(
  env: Env,
  orgId: string,
  shop: string,
  token: string,
): Promise<GatherResult> {
  const products = await listProducts(shop, token);
  let chunks = 0;
  for (const p of products.slice(0, 10)) {
    const full = await getProduct(shop, token, p.id).catch(() => null);
    const text = `${p.title}\n${full?.description ?? ""}`.trim();
    if (!text) continue;
    chunks += await embedAndStore(
      env,
      orgId,
      chunkText(`shopify:product:${full?.handle || p.id}`, text.slice(0, 4000)),
    );
  }
  return { chunks, cursor: "" };
}

function stripHtml(html: string): { text: string; links: string[] } {
  const links = [...html.matchAll(/href=["']([^"'#]+)["']/gi)]
    .map((m) => m[1])
    .filter((h) => h.startsWith("/"));
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text, links: [...new Set(links)] };
}

/** The company website: homepage plus same-host pages. Public hosts only. */
export async function ingestWebsite(
  env: Env,
  orgId: string,
  url: string,
  since = "",
): Promise<GatherResult> {
  assertPublicHttpUrl(url);
  const root = new URL(url);
  const seen = new Set<string>([root.pathname || "/"]);
  const pages: Array<{ path: string; text: string }> = [];
  const queue = [root.pathname || "/"];
  while (queue.length > 0 && pages.length < 9) {
    const path = queue.shift()!;
    const res = await providerFetch("website", `${root.origin}${path}`, {}).catch(() => null);
    if (!res || !res.ok) continue;
    const html = await res.text().catch(() => "");
    if (!html) continue;
    const { text, links } = stripHtml(html);
    if (text.length < 100) continue;
    pages.push({ path, text: text.slice(0, 8000) });
    for (const link of links.slice(0, 12)) {
      if (seen.size > 24) break;
      if (!seen.has(link)) {
        seen.add(link);
        queue.push(link);
      }
    }
  }
  const cursor = await sha16(pages.map((p) => `${p.path}:${p.text.length}`).join("|"));
  if (since && cursor === since) return { chunks: 0, cursor };
  let chunks = 0;
  for (const p of pages) {
    chunks += await embedAndStore(
      env,
      orgId,
      chunkText(`web:${root.hostname}${p.path}`, p.text),
    );
  }
  return { chunks, cursor };
}
