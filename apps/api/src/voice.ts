import { z } from "zod";
import { crewName } from "@museaiteam/shared";
import { addVoiceSpend } from "./billing.js";
import type { Env } from "./bindings.js";
import {
  SparkClient,
  TRANSIENT_STATUSES,
  backoffMs,
  fetchWithTimeout,
  sleep,
} from "./spark.js";
import { audit } from "./db.js";
import { getProviderConfig, loadToken } from "./oauth.js";
import { listProducts } from "./integrations/shopify.js";
import { approvedRoles } from "./teams.js";
import { listGoals } from "./goals.js";

export const VOICE_MODEL = "muse-voice-transcribe-1.0";
export const VOICE_DOLLARS_PER_HOUR = 0.18;
export const VOICE_MAX_BYTES = 25 * 1024 * 1024;
export const VOICE_TIMEOUT_MS = 120_000;
/**
 * Fair-use rate for dictated notes: speech runs ~150 words a minute,
 * counted 1:1 into the meter the dashboard already calls words.
 */
export const VOICE_METER_WORDS_PER_SECOND = 2.5;

export function voiceMeterWords(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(1, Math.round(seconds * VOICE_METER_WORDS_PER_SECOND));
}

const META_ASR_URL = "https://api.meta.ai/v1/asr/transcribe";

/** First-12-bytes RIFF/WAVE check. */
export function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

/** Seconds of audio from the WAV header, or null when unreadable. */
export function wavSeconds(bytes: Uint8Array): number | null {
  if (!isWav(bytes) || bytes.length < 44) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = v.getUint32(24, true);
  const channels = v.getUint16(22, true);
  const bits = v.getUint16(34, true);
  const dataLen = v.getUint32(40, true);
  if (!rate || !channels || !bits) return null;
  return dataLen / ((rate * channels * bits) / 8);
}

const TOOL_NAMES: Record<string, string> = {
  shopify: "Shopify",
  hubspot: "HubSpot",
  slack: "Slack",
  notion: "Notion",
  linear: "Linear",
  github: "GitHub",
};

const productCache = new Map<string, { at: number; titles: string[] }>();

/** Test hook: drop cached product titles. */
export function _resetVoiceCaches(): void {
  productCache.clear();
}

async function shopifyTitles(env: Env, orgId: string): Promise<string[]> {
  const cached = productCache.get(orgId);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.titles;
  try {
    const token = await loadToken(env, orgId, "shopify");
    const { shop } = await getProviderConfig(env, orgId, "shopify");
    if (!token || typeof shop !== "string" || !shop) return [];
    const titles = (await listProducts(shop, token)).map((p) => p.title);
    productCache.set(orgId, { at: Date.now(), titles });
    // Stale orgs never come back: evict the oldest instead of growing forever.
    if (productCache.size > 500) {
      const oldest = productCache.keys().next();
      if (!oldest.done) productCache.delete(oldest.value);
    }
    return titles;
  } catch {
    return [];
  }
}

/**
 * Recognition bias: the org's own words. Max 50, deduped
 * case-insensitively, each at most 40 chars.
 */
export async function voiceKeywords(env: Env, orgId: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: unknown) => {
    if (typeof s !== "string") return;
    const t = s.trim().slice(0, 40);
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  const org = await env.DB.prepare("SELECT name FROM orgs WHERE id = ?")
    .bind(orgId)
    .first<{ name: string }>();
  push(org?.name);
  const teams = await env.DB.prepare("SELECT name FROM teams WHERE org_id = ?")
    .bind(orgId)
    .all<{ name: string }>();
  for (const t of teams.results ?? []) push(t.name);
  for (const role of await approvedRoles(env, orgId)) push(crewName(role));
  const conns = await env.DB.prepare("SELECT provider FROM oauth_tokens WHERE org_id = ?")
    .bind(orgId)
    .all<{ provider: string }>();
  for (const c of conns.results ?? []) push(TOOL_NAMES[String(c.provider)]);
  for (const g of (await listGoals(env, orgId)).filter((g) => g.status === "active")) {
    push(g.title);
  }
  for (const t of await shopifyTitles(env, orgId)) push(t);
  return out.slice(0, 50);
}

export const VoiceGoalShape = z.object({
  language: z.string(),
  title: z.string(),
  metric: z.string(),
  briefNote: z.string(),
  english: z.string(),
});
export type VoiceGoalShape = z.infer<typeof VoiceGoalShape>;

export const VoiceBriefShape = z.object({
  language: z.string(),
  original: z.string(),
  english: z.string(),
});
export type VoiceBriefShape = z.infer<typeof VoiceBriefShape>;

export type VoiceShape = VoiceGoalShape | VoiceBriefShape;

/**
 * Shape a transcript into a goal draft or a brief, in the owner's
 * language plus English. Bounds are clamped in code so a wild reply
 * degrades instead of failing.
 */
export async function shapeVoiceNote(
  env: Env,
  text: string,
  context: "goal" | "brief",
  client?: SparkClient,
): Promise<VoiceShape> {
  const c = client ?? new SparkClient(env);
  const clean = text.trim();
  if (context === "goal") {
    const res = await c.chat(VoiceGoalShape, {
      system:
        "You shape voice notes into goal drafts. You never invent facts, numbers, or promises. Reply JSON only.",
      user: [
        "Turn this spoken voice note into a goal draft.",
        'Reply JSON: {"language": "<language name, e.g. English>", "title": "<8-80 chars>", "metric": "<short number to move, or empty>", "briefNote": "<the owner\'s words cleaned up, max 2000 chars>", "english": "<English version, or the same text when already English>"}.',
        "Rules: do not add facts, numbers or promises the owner did not say. Keep their meaning; cut filler.",
        "Voice note:",
        `"""${clean}"""`,
      ].join("\n"),
      temperature: 0.3,
    });
    const title = res.data.title.trim().slice(0, 80);
    return {
      language: res.data.language.trim().slice(0, 40) || "unknown",
      title: title.length >= 8 ? title : clean.slice(0, 80),
      metric: res.data.metric.trim().slice(0, 120),
      briefNote: res.data.briefNote.trim().slice(0, 2000),
      english: res.data.english.trim() || clean,
    };
  }
  const res = await c.chat(VoiceBriefShape, {
    system:
      "You shape voice notes into team briefs. You never invent facts, numbers, or promises. Reply JSON only.",
    user: [
      "Turn this spoken voice note into today's team brief.",
      'Reply JSON: {"language": "<language name, e.g. Spanish>", "original": "<the note as said, cleaned of filler>", "english": "<English version, or the same text when already English>"}.',
      "Rules: do not add facts, numbers or promises the owner did not say. Keep their meaning; cut filler.",
      "Voice note:",
      `"""${clean}"""`,
    ].join("\n"),
    temperature: 0.3,
  });
  return {
    language: res.data.language.trim().slice(0, 40) || "unknown",
    original: res.data.original.trim() || clean,
    english: res.data.english.trim() || clean,
  };
}

/**
 * Voice-note playback: the key must live under this org's folder.
 * 404 for anything else (never reveal whether a foreign key exists).
 */
export async function serveVoiceAudio(
  env: Env,
  orgId: string,
  key: string,
): Promise<Response> {
  if (!key.startsWith(`voice/${orgId}/`)) {
    return new Response("not found", { status: 404 });
  }
  const obj = await env.ARTIFACTS.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": "audio/wav",
      "cache-control": "private, max-age=3600",
    },
  });
}

function sseResponse(body: ReadableStream<Uint8Array> | string): Response {
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function sseError(message: string): Response {
  return sseResponse(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
}

function mapMetaError(status: number): string {
  if (status === 413) return "That recording is too big.";
  if (status === 400) return "That doesn't look like audio we can read. Try again.";
  if (status === 429) return "Busy right now, try again in a minute.";
  return "Couldn't hear that one. Try again.";
}

/**
 * Transcribe upload: validate the WAV, stream Meta's partials back as
 * SSE, then store the audio and meter the spend. Meta failures become
 * a single plain `error` event; success ends with our own `done`.
 */
export async function transcribeUpload(
  env: Env,
  orgId: string,
  audio: unknown,
  context: unknown,
): Promise<Response> {
  if (!(audio instanceof Blob)) {
    return Response.json({ error: "expected an audio upload" }, { status: 400 });
  }
  if (context !== "goal" && context !== "brief") {
    return Response.json({ error: "expected context goal or brief" }, { status: 400 });
  }
  if (audio.size > VOICE_MAX_BYTES) {
    return Response.json({ error: "That recording is too big." }, { status: 400 });
  }
  const bytes = new Uint8Array(await audio.arrayBuffer());
  if (!isWav(bytes)) {
    return Response.json(
      { error: "That doesn't look like audio we can read. Try again." },
      { status: 400 },
    );
  }

  const keywords = await voiceKeywords(env, orgId);
  const sessionId = crypto.randomUUID();
  const callMeta = () => {
    const form = new FormData();
    form.append(
      "request",
      new Blob(
        [
          JSON.stringify({
            mode: "ENDPOINTING",
            model: VOICE_MODEL,
            audioEncoding: "WAV",
            partialMode: "CUMULATIVE",
            languageBias: ["English", "Spanish"],
            keywords,
          }),
        ],
        { type: "application/json" },
      ),
    );
    form.append("audio", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
    return fetchWithTimeout(
      `${META_ASR_URL}?sessionId=${sessionId}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.META_MODEL_API_KEY}`,
          accept: "text/event-stream",
        },
        body: form,
      },
      VOICE_TIMEOUT_MS,
    );
  };

  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await callMeta();
    } catch {
      res = null;
    }
    if (res && (res.ok || !TRANSIENT_STATUSES.has(res.status))) break;
    if (attempt < 2) await sleep(backoffMs(attempt));
  }
  if (!res || !res.ok || !res.body) return sseError(mapMetaError(res?.status ?? 500));

  const audioKey = `voice/${orgId}/${crypto.randomUUID()}.wav`;
  const seconds = wavSeconds(bytes) ?? 0;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let errored = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            let evt: { type?: string } | null = null;
            try {
              evt = JSON.parse(t.slice(5).trim()) as { type?: string };
            } catch {
              continue;
            }
            if (
              evt?.type !== "speechStart" &&
              evt?.type !== "transcript" &&
              evt?.type !== "speechComplete" &&
              evt?.type !== "error"
            ) {
              continue;
            }
            send(evt);
            if (evt.type === "error") {
              errored = true;
              break;
            }
          }
          if (errored) {
            await reader.cancel().catch(() => {});
            controller.close();
            return;
          }
        }
        await env.ARTIFACTS.put(audioKey, bytes);
        const cents = Math.round(((seconds / 3600) * VOICE_DOLLARS_PER_HOUR * 100) * 100) / 100;
        const meterWords = voiceMeterWords(seconds);
        await addVoiceSpend(env, orgId, meterWords);
        await audit(env, null, "human", "voice.metered", {
          org: orgId,
          seconds: Math.round(seconds * 10) / 10,
          cents,
          meterWords,
          key: audioKey,
        });
        send({ type: "done", audioKey, seconds });
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return sseResponse(stream);
}
