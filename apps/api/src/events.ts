import type { FeedEvent } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";

/**
 * Best-effort fan-out to the run's feed object. A feed failure must never
 * fail a run step, so failures are audited instead of thrown.
 */
export async function publishEvent(
  env: Env,
  runId: string,
  event: FeedEvent,
): Promise<void> {
  try {
    const id = env.FEED.idFromName(runId);
    await env.FEED.get(id).fetch("https://feed/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (err) {
    await audit(env, runId, "workflow", "feed.publish_failed", {
      message: String(err),
    });
  }
}
