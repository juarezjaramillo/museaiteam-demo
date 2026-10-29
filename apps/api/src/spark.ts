import { z } from "zod";
import {
  replayKeyFor,
  type ReplayRequest,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";

export const META_MODEL_BASE_URL = "https://api.meta.ai/v1";
export const DEFAULT_MODEL = "muse-spark-1.3";
/**
 * Reasoning models spend tokens thinking before answering (observed: 223
 * reasoning tokens for a trivial JSON reply), so the default budget is
 * roomy. Callers that truly need less pass maxTokens explicitly.
 */
export const DEFAULT_MAX_TOKENS = 2000;

export type SparkMode = "live" | "record" | "replay";

export type SparkRequest = ReplayRequest;

export interface SparkResult<T> {
  data: T;
  tokensUsed: number;
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
  usage?: { total_tokens?: number };
}

export class LengthCutoff extends Error {
  constructor(public readonly maxTokens: number) {
    super(
      `Spark call hit max_tokens=${maxTokens} (reasoning ate the budget)`,
    );
  }
}

function parseResponse<T>(
  schema: z.ZodType<T>,
  json: ChatResponse,
  maxTokens: number,
): SparkResult<T> {
  const choice = json.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new LengthCutoff(maxTokens);
  }
  const content = choice?.message?.content;
  if (!content) {
    throw new Error(
      `Spark call returned no content (finish_reason: ${choice?.finish_reason ?? "unknown"})`,
    );
  }
  return {
    data: schema.parse(JSON.parse(content)),
    tokensUsed: json.usage?.total_tokens ?? 0,
  };
}

/**
 * Central typed client for the Meta Model API (direct calls, no gateway).
 * Schema-validated JSON, per-role model/temperature, token metering on
 * total_tokens (reasoning included) for the fair-use counter.
 *
 * Modes (SPARK_MODE): live (default) calls the API; record calls it and
 * stores the fixture in R2; replay serves fixtures and throws loudly on a
 * miss so a stale cache can never silently shape a run.
 */
export class SparkClient {
  private mode: SparkMode;

  constructor(private env: Env) {
    const raw = env.SPARK_MODE ?? "live";
    if (raw !== "live" && raw !== "record" && raw !== "replay") {
      throw new Error(`invalid SPARK_MODE: ${raw}`);
    }
    this.mode = raw;
  }

  private async storeFixture(key: string, response: unknown): Promise<void> {
    await this.env.ARTIFACTS.put(key, JSON.stringify(response));
  }

  private async loadFixture(key: string): Promise<ChatResponse> {
    const obj = await this.env.ARTIFACTS.get(key);
    if (!obj) {
      throw new Error(
        `no replay fixture for ${key} — run the same goal in record mode first`,
      );
    }
    return (await obj.json()) as ChatResponse;
  }

  async chat<T>(
    schema: z.ZodType<T>,
    opts: {
      system: string;
      user: string;
      temperature: number;
      model?: string;
      maxTokens?: number;
    },
  ): Promise<SparkResult<T>> {
    const req: SparkRequest = {
      model: opts.model ?? DEFAULT_MODEL,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: opts.system,
      user: opts.user,
    };
    const key = await replayKeyFor(req);

    if (this.mode === "replay") {
      const fixture = await this.loadFixture(key);
      const parsed = parseResponse(schema, fixture, req.max_tokens);
      return { data: parsed.data, tokensUsed: 0 };
    }

    // Reasoning variance can eat any fixed budget, so a length cutoff
    // retries with a doubled budget (bounded). Burned tokens still count.
    let budget = req.max_tokens;
    let burned = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${META_MODEL_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.env.META_MODEL_API_KEY}`,
        },
        // Wire body is explicit: internal keying fields must never leak here.
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
          temperature: req.temperature,
          max_tokens: budget,
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) {
        throw new Error(`Spark call failed: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as ChatResponse;
      try {
        const parsed = parseResponse(schema, json, budget);
        if (this.mode === "record") {
          await this.storeFixture(key, json);
        }
        return { data: parsed.data, tokensUsed: burned + parsed.tokensUsed };
      } catch (err) {
        if (!(err instanceof LengthCutoff) || attempt === 2) throw err;
        burned += json.usage?.total_tokens ?? 0;
        budget *= 2;
      }
    }
    throw new Error("unreachable");
  }
}
