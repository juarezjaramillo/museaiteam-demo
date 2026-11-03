import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../api.js";
import { fileToWav } from "../lib/wav.js";

export interface VoiceMeta {
  audioKey: string;
  seconds: number;
}

const MAX_RECORD_MS = 5 * 60 * 1000;

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface SseEvent {
  type: string;
  transcript?: string;
  message?: string;
  audioKey?: string;
  seconds?: number;
}

/**
 * Speak-to-text for goals and briefs: record (or pick a voice memo),
 * stream the words live from Muse Voice Transcribe, then hand the
 * finished text to the parent.
 */
export function VoiceInput({
  org,
  context,
  onTranscript,
}: {
  org: string;
  context: "goal" | "brief";
  onTranscript: (finalText: string, meta: VoiceMeta) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [working, setWorking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [finished, setFinished] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [caption, setCaption] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const partialRef = useRef(partial);
  partialRef.current = partial;
  const recRef = useRef<{
    stream: MediaStream;
    rec: MediaRecorder;
    chunks: Blob[];
    audioCtx: AudioContext;
    raf: number;
    timer: ReturnType<typeof setInterval>;
    stopAt: ReturnType<typeof setTimeout>;
    started: number;
  } | null>(null);
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;

  useEffect(
    () => () => {
      const r = recRef.current;
      if (r) {
        cancelAnimationFrame(r.raf);
        clearInterval(r.timer);
        clearTimeout(r.stopAt);
        r.stream.getTracks().forEach((t) => t.stop());
        r.audioCtx.close().catch(() => {});
      }
    },
    [],
  );

  function reset() {
    setFinished([]);
    setPartial("");
    setError("");
    setCaption(false);
    setElapsed(0);
    setLevel(0);
  }

  async function upload(wav: Blob) {
    setWorking(true);
    setCaption(true);
    try {
      const form = new FormData();
      form.append("audio", wav, "audio.wav");
      form.append("context", context);
      const res = await fetch(`${API_BASE}/api/orgs/${org}/voice/transcribe`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok || !res.body) {
        let message = "Couldn't hear that one. Try again.";
        try {
          message = ((await res.json()) as { error?: string }).error ?? message;
        } catch {
          /* keep default */
        }
        setError(message);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const turns: string[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          let evt: SseEvent;
          try {
            evt = JSON.parse(t.slice(5).trim()) as SseEvent;
          } catch {
            continue;
          }
          if (evt.type === "transcript" && typeof evt.transcript === "string") {
            setPartial(evt.transcript);
          } else if (evt.type === "speechComplete" && typeof evt.transcript === "string") {
            turns.push(evt.transcript);
            setFinished([...turns]);
            setPartial("");
          } else if (evt.type === "error") {
            setError(evt.message ?? "Couldn't hear that one. Try again.");
            await reader.cancel().catch(() => {});
            return;
          } else if (evt.type === "done" && evt.audioKey) {
            // Cumulative partials repeat earlier turns inside later text;
            // keep only turns no later text already contains.
            const parts = [...turns, partialRef.current].filter(Boolean);
            const full = parts
              .filter((p, i) => !parts.slice(i + 1).some((later) => later.includes(p)))
              .join(" ");
            if (!full.trim()) {
              setError("Couldn't hear that one. Try again.");
              return;
            }
            cbRef.current(full, { audioKey: evt.audioKey, seconds: evt.seconds ?? 0 });
            return;
          }
        }
      }
      setError("The connection dropped before your words arrived. Try again.");
    } catch {
      setError("Couldn't send that recording. Try again.");
    } finally {
      setWorking(false);
    }
  }

  async function convertAndUpload(blob: Blob) {
    try {
      const { wav } = await fileToWav(blob);
      await upload(wav);
    } catch {
      setError("That doesn't look like audio we can read. Try again.");
      setWorking(false);
    }
  }

  function stopTracks() {
    const r = recRef.current;
    recRef.current = null;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    clearInterval(r.timer);
    clearTimeout(r.stopAt);
    r.stream.getTracks().forEach((t) => t.stop());
    r.audioCtx.close().catch(() => {});
    setLevel(0);
  }

  async function startRecording() {
    reset();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Allow the microphone to speak to your team, or use a voice memo.");
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      stopTracks();
      setRecording(false);
      if (chunks.length > 0) void convertAndUpload(new Blob(chunks));
    };
    const audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const d = (data[i] - 128) / 128;
        sum += d * d;
      }
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
      const r = recRef.current;
      if (r) r.raf = requestAnimationFrame(tick);
    };
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 250);
    rec.start();
    const raf = requestAnimationFrame(tick);
    const stopAt = setTimeout(() => recRef.current?.rec.stop(), MAX_RECORD_MS);
    recRef.current = { stream, rec, chunks, audioCtx, raf, timer, stopAt, started };
    setRecording(true);
  }

  function stopRecording() {
    recRef.current?.rec.stop();
  }

  return (
    <div className="voice">
      <div className="row">
        <button
          className="voice-mic"
          disabled={working}
          onClick={() => (recording ? stopRecording() : void startRecording())}
        >
          {recording && <span className="voice-dot" />}
          Speak
        </button>
        {recording && (
          <>
            <span className="dim">{formatTime(elapsed)}</span>
            <span className="voice-meter">
              <span className="voice-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
            </span>
          </>
        )}
        <button className="link sm" disabled={recording || working} onClick={() => fileRef.current?.click()}>
          or use a voice memo
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) {
              reset();
              void convertAndUpload(f);
            }
          }}
        />
      </div>
      {(finished.length > 0 || partial) && (
        <p className="voice-live">
          {finished.join(" ")}
          {finished.length > 0 && partial ? " " : ""}
          {partial && <span className="voice-partial">{partial}</span>}
        </p>
      )}
      {caption && <p className="dim voice-caption">Heard by Muse Voice Transcribe</p>}
      {error && <p className="voice-error">{error}</p>}
    </div>
  );
}
