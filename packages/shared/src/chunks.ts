export interface TextChunk {
  text: string;
  source: string;
  ordinal: number;
}

/** Greedy paragraph-aware chunker: packs lines to ~size chars with overlap. */
export function chunkText(
  source: string,
  text: string,
  size = 1500,
  overlap = 200,
): TextChunk[] {
  const lines = text.split("\n");
  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let currentLen = 0;
  const flush = () => {
    if (!currentLen) return;
    chunks.push({
      text: current.join("\n"),
      source,
      ordinal: chunks.length,
    });
  };
  for (const line of lines) {
    if (currentLen + line.length + 1 > size && currentLen > 0) {
      flush();
      const tail = current.join("\n").slice(-overlap);
      current = tail ? [tail] : [];
      currentLen = current.join("\n").length;
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  flush();
  return chunks;
}
