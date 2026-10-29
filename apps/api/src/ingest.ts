import { chunkText, vectorId, type TextChunk } from "@museaiteam/shared";
import type { Env } from "./bindings.js";

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

interface GitHubTreeEntry {
  path?: string;
  type?: string;
}

const DOC_PATTERN = /(^|\/)(README|CONTRIBUTING|ARCHITECTURE|CHANGELOG|docs\/.*)(\.|$)/i;
const MAX_DOC_FILES = 12;
const MAX_FILE_BYTES = 20000;

export async function ingestGitHub(
  env: Env,
  orgId: string,
  token: string,
  repo: string,
): Promise<{ files: number; chunks: number }> {
  const headers = {
    authorization: `Bearer ${token}`,
    "user-agent": "museaiteam-ingest",
    accept: "application/vnd.github+json",
  };
  const treeRes = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
    { headers },
  );
  if (!treeRes.ok) {
    throw new Error(`GitHub tree fetch failed: ${treeRes.status}`);
  }
  const tree = ((await treeRes.json()) as { tree?: GitHubTreeEntry[] }).tree ?? [];
  const docPaths = tree
    .filter((e) => e.type === "blob" && e.path && DOC_PATTERN.test(e.path))
    .map((e) => e.path!)
    .slice(0, MAX_DOC_FILES);
  let chunks = 0;
  for (const path of docPaths) {
    const fileRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      { headers },
    );
    if (!fileRes.ok) continue;
    const file = (await fileRes.json()) as { content?: string };
    if (!file.content) continue;
    const text = atob(file.content.replace(/\n/g, "")).slice(0, MAX_FILE_BYTES);
    chunks += await embedAndStore(
      env,
      orgId,
      chunkText(`github:${repo}:${path}`, text),
    );
  }
  // The repo tree itself is context worth keeping.
  const listing = tree
    .filter((e) => e.path)
    .map((e) => e.path)
    .join("\n");
  chunks += await embedAndStore(
    env,
    orgId,
    chunkText(`github:${repo}:tree`, listing),
  );
  return { files: docPaths.length, chunks };
}
