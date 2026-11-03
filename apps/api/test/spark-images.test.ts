import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Env } from "../src/bindings.js";
import { generateImage } from "../src/images.js";
import { SparkClient } from "../src/spark.js";

const Schema = z.object({ ok: z.boolean() });

function liveEnv() {
  return {
    META_MODEL_API_KEY: "test-key",
    ARTIFACTS: { put: async () => {}, get: async () => null },
  } as unknown as Env;
}

function replayEnv() {
  return {
    SPARK_MODE: "replay",
    META_MODEL_API_KEY: "test-key",
    ARTIFACTS: { put: async () => {}, get: async () => null },
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatWithImages", () => {
  it("sends text plus image_url content parts and meters tokens", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { total_tokens: 42 },
        }),
      })),
    );
    const client = new SparkClient(liveEnv());
    const out = await client.chatWithImages(Schema, {
      system: "sys",
      user: "look",
      images: [new Uint8Array([1, 2, 3]), "data:image/png;base64,AQID"],
      temperature: 0.1,
    });
    expect(out).toEqual({ data: { ok: true }, tokensUsed: 42 });
    body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({ role: "system", content: "sys" });
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
    ]);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("keys replays on the image bytes", async () => {
    const client = new SparkClient(replayEnv());
    async function keyFor(images: Array<Uint8Array | string>): Promise<string> {
      try {
        await client.chatWithImages(Schema, {
          system: "sys",
          user: "look",
          images,
          temperature: 0.1,
        });
      } catch (err) {
        const m = /no replay fixture for (\S+)/.exec(String(err));
        if (m) return m[1];
        throw err;
      }
      throw new Error("expected a replay miss");
    }
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    const keyA = await keyFor([a]);
    expect(await keyFor([a])).toBe(keyA);
    expect(await keyFor([b])).not.toBe(keyA);
    expect(await keyFor(["data:image/png;base64,AQID"])).toBe(keyA);
    expect(await keyFor([a, b])).not.toBe(keyA);
  });
});

describe("generateImage transport", () => {
  const PNG_B64 = Buffer.from([137, 80, 78, 71]).toString("base64");
  const imgOk = () =>
    Response.json({ data: [{ b64_json: PNG_B64 }] });

  it("a 503 then a 200 returns the image", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("warmup", { status: 503 }))
      .mockResolvedValueOnce(imgOk());
    vi.stubGlobal("fetch", fetchMock);
    const out = await generateImage(liveEnv(), {
      prompt: "a bag",
      size: "1080x1350",
    });
    expect([...out.png]).toEqual([137, 80, 78, 71]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a dropped connection then a 200 returns the image", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(imgOk());
    vi.stubGlobal("fetch", fetchMock);
    const out = await generateImage(liveEnv(), {
      prompt: "a bag",
      size: "1080x1350",
    });
    expect([...out.png]).toEqual([137, 80, 78, 71]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("three 500s throw", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      generateImage(liveEnv(), { prompt: "a bag", size: "1080x1350" }),
    ).rejects.toThrow("Muse Image /images/generations: 500");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
