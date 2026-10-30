// Run digest email: what the team decided, what it would have done with
// connections, and the CTA back to the dashboard. Pure builder so the
// content contract is unit-tested; sending lives in the API.

export interface SkippedAction {
  kind: string;
  reason: string;
}

export interface DigestInput {
  appUrl: string;
  goal: string;
  decision?: string;
  decidedBy?: string;
  skipped: SkippedAction[];
}

export interface Digest {
  subject: string;
  text: string;
}

export function buildDigest(input: DigestInput): Digest {
  const headline = input.decision ?? input.goal;
  const lines = [
    `Your AI team finished a work session: ${input.goal}`,
    "",
  ];
  if (input.decision) {
    lines.push(
      `Decision${input.decidedBy ? ` (${input.decidedBy})` : ""}: ${input.decision}`,
      "",
    );
  }
  if (input.skipped.length > 0) {
    lines.push("Would-have-done — connect these and the team acts for real:");
    for (const s of input.skipped) {
      lines.push(`- ${s.kind} (${s.reason})`);
    }
    lines.push("");
  } else {
    lines.push("Everything done — no pending actions.", "");
  }
  lines.push(`See it here: ${input.appUrl}`);
  return { subject: `[AI Team] ${headline.slice(0, 80)}`, text: lines.join("\n") };
}
