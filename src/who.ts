// Speaker labelling with Desert Ant's Who model. Loaded only when the
// "Label who's speaking" box is ticked, so the transcription path is unchanged.
import type { Turn } from "./speakers";

declare const __LITERT_DIR__: string;

type WhoModule = typeof import("@desert-ant-labs/who");
type WhoInstance = Awaited<ReturnType<WhoModule["Who"]["load"]>>;

let whoPromise: Promise<WhoInstance> | null = null;

/** Loads Who once per page. Its LiteRT runtime is served from this site at a pinned version. */
export function loadWho(): Promise<WhoInstance> {
  if (!whoPromise) {
    whoPromise = (async () => {
      const { Who } = await import("@desert-ant-labs/who");
      return Who.load({
        litertWasmDir: new URL(__LITERT_DIR__, location.href).href,
        accelerator: "auto",
      });
    })().catch((err) => {
      whoPromise = null;
      throw err;
    });
  }
  return whoPromise;
}

/**
 * The whole recording as mono 16 kHz samples. Who needs it all at once (unlike
 * Voz, which streams), so decode it compactly: an hour is about 230 MB, where
 * letting the browser decode it whole would be several GB for a long video.
 */
export async function decodeMono16k(file: Blob, onProgress?: (fraction: number) => void): Promise<Float32Array> {
  const { wavSource, mediaSource } = await import("voz-stream");
  const source = (await wavSource(file)) ?? (await mediaSource(file));
  if (!source) throw new Error("Couldn't read this file's audio to label speakers.");
  const total = Math.max(1, source.totalSamples);
  const chunks: Float32Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await source.pull(16000 * 4);
    if (!chunk || chunk.length === 0) break;
    chunks.push(chunk);
    length += chunk.length;
    onProgress?.(Math.min(1, length / total));
  }
  const out = new Float32Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Who spoke when, with very brief "speakers" (a laugh, a cough) folded away. */
export async function findSpeakers(who: WhoInstance, samples: Float32Array): Promise<{ turns: Turn[]; count: number }> {
  const result = (await who.diarize({ samples, sampleRate: 16000 })).keepingSpeakers({ minimumShare: 0.01 });
  return {
    turns: result.turns.map((t) => ({ speaker: t.speaker, start: t.start, end: t.end })),
    count: result.speakerCount,
  };
}
