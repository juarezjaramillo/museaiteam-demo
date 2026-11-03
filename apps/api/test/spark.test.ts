import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Env } from "../src/bindings.js";
import { SparkClient } from "../src/spark.js";

const Schema = z.object({ hello: z.string() });

function client(): SparkClient {
  return new SparkClient({ META_MODEL_API_KEY: "k", SPARK_MODE: "live" } as unknown as Env);
}

function chatOk(hello = "world"): Response {
  return Response.json({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ hello }) } }],
    usage: { total_tokens: 11 },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SparkClient transport", () => {
  it("a 429 then a 200 succeeds without failing the caller", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(chatOk());
    vi.stubGlobal("fetch", fetchMock);
    const res = await client().chat(Schema, { system: "s", user: "u", temperature: 0 });
    expect(res.data).toEqual({ hello: "world" });
    expect(res.tokensUsed).toBe(11);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("three 500s throw", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      client().chat(Schema, { system: "s", user: "u", temperature: 0 }),
    ).rejects.toThrow("Spark call failed: 500");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a 400 throws immediately without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      client().chat(Schema, { system: "s", user: "u", temperature: 0 }),
    ).rejects.toThrow("Spark call failed: 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a dropped connection then a 200 succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(chatOk());
    vi.stubGlobal("fetch", fetchMock);
    const res = await client().chat(Schema, { system: "s", user: "u", temperature: 0 });
    expect(res.data).toEqual({ hello: "world" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a malformed reply retries instead of failing the act", async () => {
    const garbled = Response.json({
      choices: [{ finish_reason: "stop", message: { content: "not json {" } }],
      usage: { total_tokens: 5 },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(garbled).mockResolvedValueOnce(chatOk());
    vi.stubGlobal("fetch", fetchMock);
    const res = await client().chat(Schema, { system: "s", user: "u", temperature: 0 });
    expect(res.data).toEqual({ hello: "world" });
    expect(res.tokensUsed).toBe(16);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("three malformed replies throw bounded", async () => {
    const garbled = async () =>
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "not json {" } }],
        usage: { total_tokens: 5 },
      });
    const fetchMock = vi.fn(garbled);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      client().chat(Schema, { system: "s", user: "u", temperature: 0 }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
