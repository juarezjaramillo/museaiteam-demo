import { encodeWav } from "@museaiteam/shared";

/** Downmix + resample any decoded buffer to mono 24 kHz for transcription. */
export async function toMono24k(audioBuffer: AudioBuffer): Promise<Float32Array> {
  const len = Math.max(1, Math.ceil(audioBuffer.duration * 24000));
  const ctx = new OfflineAudioContext(1, len, 24000);
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

/** Decode a voice memo (m4a, mp3, wav, webm, ogg) into a 24 kHz mono WAV. */
export async function fileToWav(file: Blob): Promise<{ wav: Blob; seconds: number }> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    const mono = await toMono24k(decoded);
    return { wav: encodeWav(mono, 24000), seconds: mono.length / 24000 };
  } finally {
    await ctx.close();
  }
}
