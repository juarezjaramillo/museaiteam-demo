// Depth guardrails: pure shaping for the six-system work package.
// LLM outputs pass through these before touching any API, so a wild
// model response degrades to sane bounds instead of a wild write.

export interface SaneDiscount {
  percent: number;
  title: string;
  startInDays: number;
}

/** Discounts stay in the playbook: 5–30% off, starts within 30 days. */
export function saneDiscount(raw: {
  percent?: unknown;
  title?: unknown;
  startInDays?: unknown;
}): SaneDiscount {
  const percent =
    typeof raw.percent === "number" && Number.isFinite(raw.percent)
      ? Math.min(30, Math.max(5, Math.round(raw.percent)))
      : 15;
  const title =
    typeof raw.title === "string" && raw.title.trim().length > 0
      ? raw.title.trim().slice(0, 60)
      : "AI team offer";
  const startInDays =
    typeof raw.startInDays === "number" && Number.isFinite(raw.startInDays)
      ? Math.min(30, Math.max(0, Math.floor(raw.startInDays)))
      : 0;
  return { percent, title, startInDays };
}

export type TicketPriority = "HIGH" | "MEDIUM" | "LOW";

/** HubSpot priority enum; anything unrecognized lands in the middle. */
export function triagePriority(raw: unknown): TicketPriority {
  if (typeof raw === "string") {
    const up = raw.trim().toUpperCase();
    if (up === "HIGH" || up === "MEDIUM" || up === "LOW") return up;
  }
  return "MEDIUM";
}

/** Code diffs stay reviewable: at most 3 files, 200 lines each. */
export function saneFiles(
  raw: unknown,
): Array<{ path: string; content: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ path: string; content: string }> = [];
  for (const f of raw) {
    if (out.length >= 3) break;
    if (
      typeof f !== "object" ||
      f === null ||
      typeof (f as { path?: unknown }).path !== "string" ||
      typeof (f as { content?: unknown }).content !== "string"
    ) {
      continue;
    }
    const path = (f as { path: string }).path.trim().replace(/^\/+/, "");
    if (!path || path.includes("..")) continue;
    const content = (f as { content: string }).content
      .split("\n")
      .slice(0, 200)
      .join("\n");
    if (!content.trim()) continue;
    out.push({ path, content });
  }
  return out;
}

/** Sub-task lists stay short and non-empty. */
export function saneSubtasks(raw: unknown, cap = 5): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (out.length >= cap) break;
    if (typeof t !== "string" || t.trim().length < 3) continue;
    out.push(t.trim().slice(0, 120));
  }
  return out;
}

/**
 * Vector IDs stay inside the 64-byte limit by construction: the org
 * prefix (for recall filtering) plus 16 hex chars of FNV-1a over the
 * rest. Deterministic, so re-ingesting overwrites instead of duping.
 */
export function vectorId(orgId: string, source: string, ordinal: number): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  const s = `${source}:${ordinal}`;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + 0x9e3779b9), 0x01000193);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${orgId}:${hex(h1)}${hex(h2)}`;
}

/** ISO week key for the weekly-digest marker: 2026-W43. */
export function digestWeek(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((d.getTime() - first.getTime()) / 604_800_000);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
