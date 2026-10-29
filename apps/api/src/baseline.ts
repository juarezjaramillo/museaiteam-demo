import type { Baseline } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { ProposalDraft, metricLineFor } from "./agents.js";
import { audit, getRun } from "./db.js";
import { publishEvent } from "./events.js";
import { DEFAULT_MODEL, SparkClient } from "./spark.js";

/**
 * The fair comparison: same model, same goal + metric context, one shot,
 * no debate, no memory, no tools. Costs one call; stored per run so
 * repeat clicks never re-burn. Baseline tokens stay out of the run meter.
 */
export async function runBaseline(
  env: Env,
  runId: string,
): Promise<Baseline & { fresh: boolean }> {
  const run = await getRun(env, runId);
  if (!run) throw new Error("run not found");
  const existing = await env.DB.prepare(
    "SELECT title, meta FROM artifacts WHERE run_id = ? AND kind = 'baseline'",
  )
    .bind(runId)
    .first<{ title: string; meta: string }>();
  if (existing) {
    const meta = JSON.parse(existing.meta) as {
      body: string;
      model: string;
      tokens: number;
    };
    return {
      title: existing.title,
      body: meta.body,
      model: meta.model,
      tokens: meta.tokens,
      fresh: false,
    };
  }
  const metric = metricLineFor({
    metric_name: run.metric_name,
    metric_baseline: run.metric_baseline,
    metric_target: run.metric_target,
    timebox_days: run.timebox_days,
  });
  const client = new SparkClient(env);
  const res = await client.chat(ProposalDraft, {
    system:
      "You are a senior generalist. Give your single best plan. No tools, no discussion, one shot.",
    user: [
      `Goal: ${run.goal}`,
      metric,
      "",
      "Propose the highest-leverage initiative.",
      'Reply JSON: {"title": "...", "body": "..."}. Body is a short Markdown plan.',
    ].join("\n"),
    temperature: 0.5,
  });
  const baseline: Baseline = {
    title: res.data.title,
    body: res.data.body,
    model: DEFAULT_MODEL,
    tokens: res.tokensUsed,
  };
  await env.DB.prepare(
    "INSERT INTO artifacts (id, run_id, kind, title, meta) VALUES (?, ?, 'baseline', ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      runId,
      baseline.title,
      JSON.stringify({
        body: baseline.body,
        model: baseline.model,
        tokens: baseline.tokens,
      }),
    )
    .run();
  await audit(env, runId, "workflow", "baseline.done", {
    tokens: baseline.tokens,
  });
  await publishEvent(env, runId, { type: "baseline", baseline });
  return { ...baseline, fresh: true };
}
