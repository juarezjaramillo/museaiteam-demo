import type { Env } from "./bindings.js";
import { chunkText } from "@museaiteam/shared";
import { EMBED_MODEL, embedAndStore } from "./ingest.js";
import { audit } from "./db.js";

export interface MemoryHit {
  source: string;
  text: string;
}

export async function recall(
  env: Env,
  orgId: string,
  query: string,
  topK = 6,
): Promise<MemoryHit[]> {
  const emb = (await env.AI.run(EMBED_MODEL, { text: [query] })) as {
    data?: number[][];
  };
  const vector = emb.data?.[0];
  if (!vector) return [];
  // Over-fetch and filter in the Worker: org is encoded in the vector id,
  // which always returns, unlike server-side metadata filtering.
  const matches = await env.ORG_MEMORY.query(vector, {
    topK: Math.max(topK * 2, 12),
    returnMetadata: "all",
  });
  const prefix = `${orgId}:`;
  const hits: MemoryHit[] = [];
  for (const m of matches.matches ?? []) {
    if (!m.id?.startsWith(prefix)) continue;
    const text = String(m.metadata?.text ?? "").slice(0, 600);
    if (!text) continue;
    hits.push({
      source: String(m.metadata?.source ?? "unknown"),
      text,
    });
    if (hits.length >= topK) break;
  }
  return hits;
}

/** Write-back: each finished goal becomes retrievable org memory. */
export async function commitRunMemory(
  env: Env,
  orgId: string,
  runId: string,
  summary: string,
): Promise<number> {
  const n = await embedAndStore(
    env,
    orgId,
    chunkText(`run:${runId}`, summary),
  );
  await audit(env, runId, "workflow", "memory.committed", { vectors: n });
  return n;
}
