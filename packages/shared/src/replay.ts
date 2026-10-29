export interface ReplayRequest {
  model: string;
  temperature: number;
  max_tokens: number;
  system: string;
  user: string;
}

/** Deterministic fixture key: same request → same key, always. */
export async function replayKeyFor(req: ReplayRequest): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(req));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `replays/${hex}.json`;
}
