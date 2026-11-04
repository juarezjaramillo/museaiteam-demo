import {
  createIssue,
  findTeamId,
  type LinearIssue,
} from "./integrations/linear.js";

/** Razor-scoped PM keystone: one live Linear issue proving PM skill. */
export const PM_KEYSTONE_TITLE =
  "PM Keystone: Activation 32% -> 37% (razor scope)";

export const PM_KEYSTONE_BASELINE = "32%";
export const PM_KEYSTONE_TARGET = "37%";

/** Build the ready-gated issue body. Single source of truth for PM authorship. */
export function buildPmKeystoneDescription(): string {
  return [
    "## Problem",
    "Trial-to-active activation is stuck at 32%. New workspaces finish signup but do not reach first value in session one, so eval-ready activation cannot be claimed.",
    "",
    "## Baseline / Target",
    `- Baseline: ${PM_KEYSTONE_BASELINE} trial-to-active (Linear-tracked metric, last 14d).`,
    `- Target: ${PM_KEYSTONE_TARGET} trial-to-active in session-one eval.`,
    "- Source: product analytics activation event; verified by re-pull before close.",
    "",
    "## In scope",
    "- One onboarding step fix behind a single flag.",
    "- Instrument activation event if missing.",
    "- Session-one eval script + re-pull of baseline/target.",
    "",
    "## Out of scope",
    "- No Zendesk / HubSpot proxies (live Linear URL or 0).",
    "- No 5-artifact analyst pack.",
    "- No lib/keystone.py guard or other engineer support work.",
    "- No marketing lift claim and no deploy-today promise.",
    "",
    "## Acceptance Criteria",
    "- [ ] AC1: Live Linear issue URL resolves for any reviewer with access.",
    "- [ ] AC2: Baseline 32% and target 37% with metric source stated in issue.",
    "- [ ] AC3: In/out scope and async size recorded; eval re-pull confirms 32% -> 37% or issue stays open.",
    "",
    "## Size (async)",
    "- Size S, async, <4h, shippable in 1 round.",
    "",
    "## Ready",
    "- [ ] Problem + baseline/target present.",
    "- [ ] In/out scope present.",
    "- [ ] 3 acceptance criteria present.",
    "- [ ] Async size present.",
    "- [ ] Live Linear URL attached on create.",
    "",
  ].join("\n");
}

/** Return list of missing ready-gate items; empty means ready. */
export function validatePmKeystoneReady(
  title: string,
  description: string,
): string[] {
  const missing: string[] = [];
  if (!title.includes("Activation") || !title.includes("32%") || !title.includes("37%")) {
    missing.push("title must name Activation 32% -> 37%");
  }
  const needs = [
    "## Problem",
    "## Baseline / Target",
    "32%",
    "37%",
    "## In scope",
    "## Out of scope",
    "## Acceptance Criteria",
    "AC1",
    "AC2",
    "AC3",
    "## Size (async)",
    "## Ready",
  ];
  for (const n of needs) {
    if (!description.includes(n)) missing.push(`description missing ${n}`);
  }
  const acCount = (description.match(/- \[ \] AC\d/g) ?? []).length;
  if (acCount < 3) missing.push("need 3 acceptance criteria");
  return missing;
}

/**
 * Ship the PM keystone as one live Linear issue.
 * Returns the created issue including its live URL (ready proof).
 */
export async function shipPmKeystoneIssue(
  token: string,
  teamName: string,
): Promise<LinearIssue> {
  const cleanToken = token.trim();
  if (!cleanToken) throw new Error("Linear token required");
  const cleanTeam = teamName.trim();
  if (!cleanTeam) throw new Error("Linear team name required");
  const teamId = await findTeamId(cleanToken, cleanTeam);
  if (!teamId) throw new Error(`Linear team not found: ${cleanTeam}`);
  const title = PM_KEYSTONE_TITLE;
  const description = buildPmKeystoneDescription();
  const missing = validatePmKeystoneReady(title, description);
  if (missing.length > 0) {
    throw new Error(`PM keystone not ready: ${missing.join("; ")}`);
  }
  return createIssue(cleanToken, teamId, title, description);
}
