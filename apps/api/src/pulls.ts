import { isPullId, type PullId } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { addEvent, recordMetricPoint } from "./goals.js";
import { searchPrCount } from "./integrations/github.js";
import { countOpenTickets } from "./integrations/hubspot.js";
import { countOpenIssues, findTeamId } from "./integrations/linear.js";
import { countPagesCreatedSince } from "./integrations/notion.js";
import { checkoutsSince, salesSince } from "./integrations/shopify.js";
import { countHistory, findChannelId } from "./integrations/slack.js";
import { getProviderConfig, loadToken } from "./oauth.js";

/** A pull that failed for a founder-actionable reason. Never thrown past
 *  pullGoalMetric: failures land on the timeline, never fail the check. */
export class PullFailed extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

async function tokenOrFail(
  env: Env,
  orgId: string,
  provider: "github" | "linear" | "slack" | "shopify" | "hubspot" | "notion",
): Promise<string> {
  let token: string | null;
  try {
    token = await loadToken(env, orgId, provider);
  } catch (err) {
    throw new PullFailed(hint(provider, String(err)));
  }
  if (!token) throw new PullFailed(`${provider} is not connected`);
  return token;
}

/** Raw API errors become founder-actionable reasons. Scope-shaped
 *  failures always point at reconnecting. */
function hint(provider: string, raw: string): string {
  const short = raw.slice(0, 180);
  if (/403|401|scope|permission|unauthorized|missing_scope/i.test(raw)) {
    return `${provider} refused the read (${short}) — reconnect ${provider} in Setup to grant it`;
  }
  return short;
}

async function guarded<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PullFailed) throw err;
    throw new PullFailed(hint(provider, String(err)));
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

export interface PullResult {
  value: number;
  detail: string;
}

/**
 * Run one catalog entry. Throws PullFailed with a founder-readable
 * reason; every other error is wrapped on the way out.
 */
export async function runMetricPull(
  env: Env,
  orgId: string,
  pullId: string,
): Promise<PullResult> {
  if (!isPullId(pullId)) throw new PullFailed(`unknown metric source ${pullId}`);
  const id: PullId = pullId;
  switch (id) {
    case "github.open_prs":
    case "github.merged_7d": {
      const token = await tokenOrFail(env, orgId, "github");
      const repo = env.DEMO_GITHUB_REPO;
      if (!repo) throw new PullFailed("github repo is not configured");
      const extra =
        id === "github.open_prs"
          ? "state:open"
          : `merged:>=${daysAgo(7).toISOString().slice(0, 10)}`;
      const value = await guarded("github", () => searchPrCount(token, repo, extra));
      return { value, detail: `${repo} ${extra}` };
    }
    case "linear.open_issues": {
      const token = await tokenOrFail(env, orgId, "linear");
      const team = await guarded("linear", () =>
        findTeamId(token, env.DEMO_LINEAR_TEAM),
      );
      if (!team) throw new PullFailed(`linear team ${env.DEMO_LINEAR_TEAM} not found`);
      const { count, capped } = await guarded("linear", () =>
        countOpenIssues(token, team),
      );
      return { value: count, detail: capped ? "capped at 500" : "exact" };
    }
    case "hubspot.open_tickets": {
      const token = await tokenOrFail(env, orgId, "hubspot");
      const value = await guarded("hubspot", () => countOpenTickets(token));
      return { value, detail: "outside closed stages" };
    }
    case "slack.messages_7d": {
      const token = await tokenOrFail(env, orgId, "slack");
      const channel = await guarded("slack", () =>
        findChannelId(token, env.DEMO_SLACK_CHANNEL),
      );
      if (!channel) {
        throw new PullFailed(`slack channel ${env.DEMO_SLACK_CHANNEL} not found`);
      }
      const oldest = String(Math.floor(daysAgo(7).getTime() / 1000));
      const value = await guarded("slack", () => countHistory(token, channel, oldest));
      return { value, detail: `#${env.DEMO_SLACK_CHANNEL} trailing 7d` };
    }
    case "notion.pages_7d": {
      const token = await tokenOrFail(env, orgId, "notion");
      const value = await guarded("notion", () =>
        countPagesCreatedSince(token, daysAgo(7).toISOString()),
      );
      return { value, detail: "workspace trailing 7d" };
    }
    case "shopify.orders":
    case "shopify.revenue":
    case "shopify.checkouts": {
      const token = await tokenOrFail(env, orgId, "shopify");
      const { shop } = await getProviderConfig(env, orgId, "shopify");
      if (typeof shop !== "string" || !shop) {
        throw new PullFailed("shopify store is not configured");
      }
      const since = daysAgo(30).toISOString().slice(0, 10);
      if (id === "shopify.checkouts") {
        const value = await guarded("shopify", () =>
          checkoutsSince(shop, token, since),
        );
        return { value, detail: `${shop} trailing 30d` };
      }
      const sales = await guarded("shopify", () => salesSince(shop, token, since));
      return id === "shopify.orders"
        ? { value: sales.orders, detail: `${shop} trailing 30d` }
        : { value: Math.round(sales.revenue * 100) / 100, detail: `${shop} trailing 30d` };
    }
  }
}

export type PullOutcome =
  | { status: "pulled"; value: number; detail: string }
  | { status: "failed"; reason: string }
  | { status: "skipped" };

/**
 * Pull a goal's metric into a stored point. Total: manual/empty sources
 * skip, unknown sources and provider failures record metric.pull_failed
 * with the reason, and nothing here throws past the caller.
 */
export async function pullGoalMetric(
  env: Env,
  goal: { id: string; org_id: string; metric_source: string | null },
): Promise<PullOutcome> {
  const source = goal.metric_source ?? "";
  if (!source || source === "manual") return { status: "skipped" };
  try {
    const { value, detail } = await runMetricPull(env, goal.org_id, source);
    await recordMetricPoint(env, goal.id, value, "pull");
    return { status: "pulled", value, detail };
  } catch (err) {
    const reason = err instanceof PullFailed ? err.reason : String(err).slice(0, 180);
    try {
      await addEvent(env, goal.id, "metric.pull_failed", `Pull failed (${source})`, {
        source,
        reason,
      });
    } catch {
      /* timeline itself failed; the outcome below still reports */
    }
    return { status: "failed", reason };
  }
}
