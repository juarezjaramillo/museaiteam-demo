// Learning loop: ratings become playbook tactics. Approved tactics are
// sorted everywhere they enter a prompt, so identical playbooks give
// identical prompts (replay-safe).

export const THUMBS = ["up", "down"] as const;
export type Thumb = (typeof THUMBS)[number];

export function isThumb(s: string): s is Thumb {
  return s === "up" || s === "down";
}

export const PLAYBOOK_STATUSES = ["draft", "approved", "vetoed"] as const;
export type PlaybookStatus = (typeof PLAYBOOK_STATUSES)[number];

export function isPlaybookStatus(s: string): s is PlaybookStatus {
  return (PLAYBOOK_STATUSES as readonly string[]).includes(s);
}

const TACTIC_SYSTEMS = [
  "github",
  "linear",
  "slack",
  "shopify",
  "hubspot",
  "notion",
  "general",
] as const;

export interface SaneTactic {
  system: string;
  tactic: string;
}

/** Distilled tactics land in the playbook only through here. */
export function saneTactics(raw: unknown, cap = 10): SaneTactic[] {
  if (!Array.isArray(raw)) return [];
  const out: SaneTactic[] = [];
  for (const t of raw) {
    if (out.length >= cap) break;
    if (typeof t !== "object" || t === null) continue;
    const { system, tactic } = t as { system?: unknown; tactic?: unknown };
    if (typeof tactic !== "string" || tactic.trim().length < 10) continue;
    out.push({
      system:
        typeof system === "string" &&
        (TACTIC_SYSTEMS as readonly string[]).includes(system)
          ? system
          : "general",
      tactic: tactic.trim().slice(0, 300),
    });
  }
  return out;
}

/** Prompt block for approved tactics; empty playbooks stay silent-ish. */
export function playbookBlock(entries: string[]): string {
  if (!entries.length) return "Playbook: (none yet)";
  const sorted = [...entries].sort();
  return `Playbook (founder-approved tactics — follow these):\n${sorted.map((t, i) => `[${i + 1}] ${t}`).join("\n")}`;
}
