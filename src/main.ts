import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/fraunces/full-italic.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./style.css";
import type { Voz as VozClass, VozResult } from "@desert-ant-labs/voz";
import {
  formatClock,
  readingRows,
  segmentWords,
  toParagraphBlocks,
  toPlainText,
  toSrt,
  toTimestampedText,
  toVtt,
  type NameOf,
  type Paragraph,
  type Segment,
  type Word,
} from "./captions";
import { assignSpeakers, detectNames } from "./speakers";

declare const __ORT_WASM_URL__: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  notices: $("notices"),
  inputPanel: $("input-panel"),
  dropzone: $("dropzone"),
  fileInput: $<HTMLInputElement>("file-input"),
  progressPanel: $("progress-panel"),
  progressLabel: $("progress-label"),
  progressPct: $("progress-pct"),
  progressFill: $("progress-fill"),
  progressDetail: $("progress-detail"),
  errorPanel: $("error-panel"),
  errorMessage: $("error-message"),
  errorRetry: $("error-retry"),
  resultPanel: $("result-panel"),
  resultTitle: $("result-title"),
  resultStats: $("result-stats"),
  newFile: $("new-file"),
  mediaSlot: $("media-slot"),
  speakerToggle: $<HTMLInputElement>("speaker-toggle"),
  cast: $("cast"),
  castList: $("cast-list"),
  transcript: $("transcript"),
  copyBtn: $("copy-btn"),
  downloadBtn: $("download-btn"),
  downloadMenu: $("download-menu"),
};

// ---------- environment checks ----------

let engineLabel = "checking…";

function notice(text: string, bad = false) {
  const div = document.createElement("div");
  div.className = bad ? "notice bad" : "notice";
  div.textContent = text;
  els.notices.append(div);
}

async function checkEnvironment() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  let adapter: unknown = null;
  try {
    adapter = gpu ? await gpu.requestAdapter() : null;
  } catch {
    adapter = null;
  }
  engineLabel = adapter ? "WebGPU" : "CPU";
  if (!adapter) {
    notice(
      "This browser has no WebGPU, so transcription will run on the CPU. It still works, just much more slowly. Recent Chrome, Edge or Safari on a laptop works best.",
      true,
    );
  }
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || matchMedia("(pointer: coarse)").matches;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (mobile) {
    notice("On a phone the first run downloads ~400 MB and needs ~2.5 GB of memory. Use Wi-Fi; the tab may be closed by the browser.");
  } else if (memory !== undefined && memory < 4) {
    notice("This device reports under 4 GB of memory. Transcription needs about 2.5 GB and may fail.");
  }
}

// ---------- model ----------

let vozPromise: Promise<VozClass> | null = null;

const looksLikeNetworkError = (err: unknown) =>
  /network|aborted|failed to fetch|load failed|HTTP 5\d\d/i.test(err instanceof Error ? err.message : String(err));

/**
 * Voz reports download progress per file (6 files, one of them ~350 MB), so its
 * bar sits still for minutes. Count bytes instead: while the model loads, wrap
 * fetch and tally every Hugging Face response as it streams in.
 */
function trackModelBytes(onBytes: (loaded: number, total: number) => void): () => void {
  const original = globalThis.fetch;
  let loaded = 0;
  let total = 0;
  const isHub = (u: string) => /huggingface\.co|hf\.co|xethub|cdn-lfs/.test(u);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const asked = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!res.ok || !res.body || !(isHub(asked) || isHub(res.url))) return res;
    total += Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        loaded += value.byteLength;
        onBytes(loaded, Math.max(total, loaded));
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return () => {
    globalThis.fetch = original;
  };
}

const mb = (bytes: number) => Math.round(bytes / 1_000_000).toLocaleString();

async function loadOnce(): Promise<VozClass> {
  const [{ Voz }, ort] = await Promise.all([
    import("@desert-ant-labs/voz"),
    import("onnxruntime-web/webgpu"),
  ]);
  // Point ONNX Runtime at the one .wasm file it needs (served from R2 under
  // /vendor/). Passing an object with only `wasm` keeps its bundled .mjs glue.
  ort.env.wasm.wasmPaths = { wasm: new URL(__ORT_WASM_URL__, location.href).href };
  let downloading = false;
  let preparing = false;
  const prepare = () => {
    if (preparing) return;
    preparing = true;
    showProgress(
      "Preparing model…",
      engineLabel === "WebGPU"
        ? "Compiling for this device. This takes a few seconds."
        : "Compiling for this device. Without WebGPU this can take a minute or two.",
    );
  };
  const stop = trackModelBytes((loaded, total) => {
    if (!downloading) {
      downloading = true;
      showProgress("Downloading the speech model…", "");
    }
    setProgress(loaded / total);
    els.progressDetail.textContent =
      `${mb(loaded)} of ${mb(total)} MB. This happens once; next time it loads from this browser.`;
    if (loaded >= total && total > 50_000_000) prepare();
  });
  try {
    const voz = await Voz.load({
      ort,
      // Per-file progress: only used to notice that every file has arrived.
      onProgress: (fraction) => {
        if (fraction >= 1 && downloading) prepare();
      },
    });
    return voz;
  } finally {
    stop();
  }
}

function loadModel(): Promise<VozClass> {
  if (!vozPromise) {
    vozPromise = (async () => {
      showProgress("Loading speech model…", "The first visit downloads about 400 MB once. After that it loads from this browser.");
      try {
        return await loadOnce();
      } catch (err) {
        // A dropped connection mid-download is common on big files: try once more.
        if (!looksLikeNetworkError(err)) throw err;
        console.warn("Model load failed, retrying once", err);
        showProgress("Connection dropped, retrying…", "Picking up the download again.");
        await new Promise((r) => setTimeout(r, 1500));
        return await loadOnce();
      }
    })().catch((err) => {
      vozPromise = null; // allow a retry
      throw err;
    });
  }
  return vozPromise;
}

// ---------- UI state ----------

function show(panel: "input" | "progress" | "error" | "result") {
  els.inputPanel.classList.toggle("hidden", panel !== "input");
  els.progressPanel.classList.toggle("hidden", panel !== "progress");
  els.errorPanel.classList.toggle("hidden", panel !== "error");
  els.resultPanel.classList.toggle("hidden", panel !== "result");
}

function showProgress(label: string, detail = "") {
  show("progress");
  els.progressLabel.textContent = label;
  els.progressDetail.textContent = detail;
  setIndeterminate();
}

function setProgress(fraction: number) {
  els.progressFill.classList.remove("indeterminate");
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  els.progressFill.style.width = `${pct}%`;
  els.progressPct.textContent = `${pct}%`;
}

function setIndeterminate() {
  els.progressFill.classList.add("indeterminate");
  els.progressPct.textContent = "";
}

function showError(err: unknown) {
  console.error(err);
  const message = err instanceof Error ? err.message : String(err);
  let help = "";
  if (/dynamically imported module|no available backend/i.test(message)) {
    help =
      "\n\nThe speech engine couldn't start in this browser. Please send this message to whoever runs Overheard.";
  } else if (/webassembly|vendor|wasm/i.test(message)) {
    help =
      "\n\nThe speech engine's own files (about 75 MB, served from this site) didn't finish downloading. " +
      "It's usually a dropped connection: try again. If it keeps happening, try another browser or network, " +
      "or turn off browser shields or ad blocking for this site.";
  } else if (/decode|codec|demux|unsupported|container/i.test(message)) {
    help = "\n\nThis browser couldn't read that file's audio. Try an MP4/M4A/MP3/WAV, or convert it first.";
  } else if (/memory|allocation|out of/i.test(message)) {
    help = "\n\nThe device ran out of memory. Close other tabs or use a laptop/desktop.";
  } else if (/huggingface|hf\.co|meta\.json|\.onnx/i.test(message) || /failed to fetch|network|load failed/i.test(message)) {
    help =
      "\n\nCouldn't download the speech model (from huggingface.co). Check your connection, " +
      "and that an ad blocker, firewall or VPN isn't blocking it, then try again.";
  } else if (/HTTP 4\d\d/i.test(message)) {
    help = "\n\nA model file was refused. If this keeps happening, sign out and back in.";
  }
  els.errorMessage.textContent = message + help;
  show("error");
}

// ---------- transcription ----------

interface SpeakerName {
  name: string;
  /** true when found in the speaker's own introduction and not yet confirmed. */
  guessed: boolean;
}

interface Current {
  name: string;
  base: string;
  result: VozResult;
  words: Word[];
  /** Subtitle-sized cues, for the SRT and VTT downloads. */
  segments: Segment[];
  /** Reading rows (new row at each pause or speaker change), for the Timed view. */
  rows: Segment[];
  paragraphs: Paragraph[];
  /** Speaker numbers in order of first speech; empty when speakers weren't labelled. */
  speakers: number[];
  names: Map<number, SpeakerName>;
  mediaUrl: string;
}

const nameOf: NameOf = (speaker) => {
  if (speaker === undefined || !current || current.speakers.length === 0) return undefined;
  const typed = current.names.get(speaker)?.name.trim();
  return typed || `Speaker ${current.speakers.indexOf(speaker) + 1}`;
};

/** Runs Who on the file and attaches a speaker to every word. Never throws:
 *  if it fails, the transcript is still shown, with a note. */
async function labelSpeakers(file: File, words: Word[]): Promise<{ words: Word[]; speakers: number[]; names: Map<number, SpeakerName> }> {
  const none = { words, speakers: [] as number[], names: new Map<number, SpeakerName>() };
  try {
    const { loadWho, decodeMono16k, findSpeakers } = await import("./who");
    showProgress("Working out who's speaking…", "Loading the speaker model. The first time, that's about 32 MB.");
    const stop = trackModelBytes((loaded, total) => {
      setProgress(loaded / total);
      els.progressDetail.textContent = `Speaker model: ${mb(loaded)} of ${mb(total)} MB. This happens once.`;
    });
    let who;
    try {
      who = await loadWho();
    } finally {
      stop();
    }
    showProgress("Working out who's speaking…", "Reading the audio.");
    setProgress(0);
    const samples = await decodeMono16k(file, setProgress);
    showProgress("Working out who's speaking…", "Listening for different voices.");
    const { turns } = await findSpeakers(who, samples);
    const labelled = assignSpeakers(words, turns);
    const speakers = [...new Set(labelled.map((w) => w.speaker).filter((s): s is number => s !== undefined))];
    if (speakers.length < 2) return none; // one voice: labels would only add noise
    const names = new Map<number, SpeakerName>();
    for (const [speaker, name] of detectNames(labelled)) names.set(speaker, { name, guessed: true });
    return { words: labelled, speakers, names };
  } catch (err) {
    console.warn("Speaker labelling failed", err);
    const message = err instanceof Error ? err.message : String(err);
    notice(`Speakers couldn't be labelled this time, so the transcript has no names. (${message.slice(0, 160)})`);
    return none;
  }
}

let current: Current | null = null;
let view: "segments" | "text" = "segments";

async function handleFile(file: File) {
  if (!file.type.startsWith("audio/") && !file.type.startsWith("video/") && !/\.(mkv|m4a|opus|webm|mov|mp3|wav|flac|ogg|aac|mp4)$/i.test(file.name)) {
    showError(new Error(`"${file.name}" doesn't look like an audio or video file.`));
    return;
  }
  try {
    const voz = await loadModel();
    showProgress(`Transcribing ${file.name}…`, `Running on ${engineLabel}. Keep this tab open.`);
    setProgress(0);
    const started = performance.now();
    const result = await voz.transcribe(file, { onProgress: setProgress });
    const wall = (performance.now() - started) / 1000;
    console.info("voz timings", voz.timings, { wall });

    const labelled =
      els.speakerToggle.checked && result.words.length > 0
        ? await labelSpeakers(file, result.words)
        : { words: result.words as Word[], speakers: [] as number[], names: new Map<number, SpeakerName>() };

    if (current) URL.revokeObjectURL(current.mediaUrl);
    current = {
      name: file.name,
      base: file.name.replace(/\.[^.]+$/, "") || "transcript",
      result,
      words: labelled.words,
      segments: segmentWords(labelled.words),
      rows: readingRows(labelled.words),
      paragraphs: toParagraphBlocks(labelled.words),
      speakers: labelled.speakers,
      names: labelled.names,
      mediaUrl: URL.createObjectURL(file),
    };
    renderResult(file);
  } catch (err) {
    showError(err);
  }
}

function renderResult(file: File) {
  if (!current) return;
  const { result } = current;
  els.resultTitle.textContent = current.name;
  const speed = result.realtimeFactor >= 10 ? Math.round(result.realtimeFactor) : result.realtimeFactor.toFixed(1);
  els.resultStats.textContent =
    `${formatClock(result.duration)} of audio · transcribed in ${result.processingTime.toFixed(1)}s ` +
    `(${speed}× real time on ${engineLabel}) · ${result.words.length.toLocaleString()} words` +
    (current.speakers.length ? ` · ${current.speakers.length} speakers` : "");

  els.mediaSlot.replaceChildren();
  const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(file.name);
  const media = document.createElement(isVideo ? "video" : "audio");
  media.src = current.mediaUrl;
  media.controls = true;
  media.preload = "metadata";
  if (isVideo) (media as HTMLVideoElement).playsInline = true;
  media.addEventListener("timeupdate", () => highlight(media.currentTime));
  els.mediaSlot.append(media);

  renderCast();
  renderTranscript();
  show("result");
}

/** The "Who's speaking" list: one editable name per speaker. */
function renderCast() {
  if (!current) return;
  const cur = current;
  els.cast.classList.toggle("hidden", cur.speakers.length === 0);
  els.castList.replaceChildren();
  const spoken = new Map<number, number>();
  for (const w of cur.words) if (w.speaker !== undefined) spoken.set(w.speaker, (spoken.get(w.speaker) ?? 0) + 1);
  const totalWords = Math.max(1, cur.words.length);

  cur.speakers.forEach((speaker, i) => {
    const row = document.createElement("label");
    row.className = "cast-row";
    const num = document.createElement("span");
    num.className = "cast-num";
    num.textContent = String(i + 1);
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `Speaker ${i + 1}`;
    input.value = cur.names.get(speaker)?.name ?? "";
    input.dataset.speaker = String(speaker);
    input.autocomplete = "off";
    input.spellcheck = false;
    const tag = document.createElement("span");
    tag.className = "cast-tag";
    const guessed = cur.names.get(speaker)?.guessed;
    tag.textContent = guessed ? "from intro" : `${Math.round(((spoken.get(speaker) ?? 0) / totalWords) * 100)}%`;
    if (guessed) tag.title = "Found where this person introduced themselves. Edit if it's wrong.";
    input.addEventListener("input", () => {
      cur.names.set(speaker, { name: input.value, guessed: false });
      tag.textContent = `${Math.round(((spoken.get(speaker) ?? 0) / totalWords) * 100)}%`;
      tag.removeAttribute("title");
      renderTranscript();
    });
    row.append(num, input, tag);
    els.castList.append(row);
  });
}

function focusSpeaker(speaker: number | undefined) {
  if (speaker === undefined) return;
  const input = els.castList.querySelector<HTMLInputElement>(`input[data-speaker="${speaker}"]`);
  if (!input) return;
  input.focus();
  input.select();
  input.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function speakerTag(speaker: number | undefined): HTMLElement | null {
  const name = nameOf(speaker);
  if (!name) return null;
  const tag = document.createElement("button");
  tag.type = "button";
  tag.className = "who";
  tag.textContent = name;
  tag.title = "Rename this speaker";
  tag.addEventListener("click", (e) => {
    e.stopPropagation();
    focusSpeaker(speaker);
  });
  return tag;
}

function renderTranscript() {
  if (!current) return;
  els.transcript.replaceChildren();
  if (current.result.words.length === 0) {
    els.transcript.textContent = "No speech was detected in this file.";
    return;
  }
  els.transcript.classList.toggle("has-speakers", current.speakers.length > 0);
  if (view === "segments") {
    const frag = document.createDocumentFragment();
    let lastSpeaker: number | undefined = -1;
    current.rows.forEach((seg, i) => {
      const row = document.createElement("div");
      row.className = "seg";
      row.dataset.index = String(i);
      const time = document.createElement("time");
      time.textContent = formatClock(seg.start);
      // Inner inline span so the highlighter follows the words, line by line.
      const text = document.createElement("span");
      const ink = document.createElement("span");
      ink.className = "hl";
      ink.textContent = seg.text;
      const tag = seg.speaker !== lastSpeaker ? speakerTag(seg.speaker) : null;
      lastSpeaker = seg.speaker;
      if (tag) {
        row.classList.add("turn");
        text.append(tag, " ");
      }
      text.append(ink);
      row.append(time, text);
      row.addEventListener("click", () => seek(seg.start));
      frag.append(row);
    });
    els.transcript.append(frag);
  } else {
    for (const p of current.paragraphs) {
      const el = document.createElement("p");
      el.className = "para";
      const tag = speakerTag(p.speaker);
      if (tag) el.append(tag, " ");
      el.append(p.text);
      els.transcript.append(el);
    }
  }
}

function seek(seconds: number) {
  const media = els.mediaSlot.querySelector<HTMLMediaElement>("video, audio");
  if (!media) return;
  media.currentTime = seconds;
  void media.play().catch(() => {});
}

let activeIndex = -1;
function highlight(time: number) {
  if (!current || view !== "segments") return;
  const segs = current.rows;
  let idx = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].start <= time) idx = i;
    else break;
  }
  if (idx === activeIndex) return;
  els.transcript.querySelector(".seg.active")?.classList.remove("active");
  activeIndex = idx;
  const row = els.transcript.querySelector<HTMLElement>(`.seg[data-index="${idx}"]`);
  if (row) {
    row.classList.add("active");
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// ---------- export ----------

function exportAs(format: string): { content: string; ext: string; type: string } {
  if (!current) throw new Error("Nothing to export");
  switch (format) {
    case "srt":
      return { content: toSrt(current.segments, nameOf), ext: "srt", type: "application/x-subrip" };
    case "vtt":
      return { content: toVtt(current.segments, nameOf), ext: "vtt", type: "text/vtt" };
    case "timestamped":
      return { content: toTimestampedText(current.rows, nameOf), ext: "timestamped.txt", type: "text/plain" };
    case "json":
      return {
        content: JSON.stringify(
          {
            file: current.name,
            duration: current.result.duration,
            text: current.result.text,
            speakers: current.speakers.map((s) => ({ speaker: s, name: nameOf(s) })),
            rows: current.rows.map((row) => ({ ...row, name: nameOf(row.speaker) })),
            captions: current.segments.map((seg) => ({ ...seg, name: nameOf(seg.speaker) })),
            words: current.words,
          },
          null,
          2,
        ),
        ext: "json",
        type: "application/json",
      };
    default:
      return { content: toPlainText(current.paragraphs, nameOf), ext: "txt", type: "text/plain" };
  }
}

function download(format: string) {
  if (!current) return;
  const { content, ext, type } = exportAs(format);
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${current.base}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- wiring ----------

const SPEAKER_PREF = "overheard.labelSpeakers";

function wire() {
  try {
    const saved = localStorage.getItem(SPEAKER_PREF);
    if (saved !== null) els.speakerToggle.checked = saved === "1";
  } catch {
    /* storage unavailable: keep the default (on) */
  }
  els.speakerToggle.addEventListener("change", () => {
    try {
      localStorage.setItem(SPEAKER_PREF, els.speakerToggle.checked ? "1" : "0");
    } catch {
      /* not remembered, which is fine */
    }
  });

  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files?.[0];
    els.fileInput.value = "";
    if (file) void handleFile(file);
  });
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  for (const type of ["dragenter", "dragover"]) {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    els.dropzone.addEventListener(type, () => els.dropzone.classList.remove("over"));
  }
  els.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });
  // Dropping anywhere else shouldn't navigate away and lose a transcript.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  const reset = () => {
    show("input");
    els.downloadMenu.classList.add("hidden");
  };
  els.errorRetry.addEventListener("click", reset);
  els.newFile.addEventListener("click", reset);

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      view = tab.dataset.view === "text" ? "text" : "segments";
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      activeIndex = -1;
      renderTranscript();
    });
  });

  els.copyBtn.addEventListener("click", async () => {
    if (!current) return;
    const text =
      view === "segments" ? toTimestampedText(current.rows, nameOf) : toPlainText(current.paragraphs, nameOf);
    try {
      await navigator.clipboard.writeText(text);
      els.copyBtn.textContent = "Copied";
    } catch {
      els.copyBtn.textContent = "Copy failed";
    }
    setTimeout(() => (els.copyBtn.textContent = "Copy"), 1500);
  });

  els.downloadBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.downloadMenu.classList.toggle("hidden");
  });
  els.downloadMenu.addEventListener("click", (e) => {
    const format = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.format;
    if (format) download(format);
    els.downloadMenu.classList.add("hidden");
  });
  document.addEventListener("click", () => els.downloadMenu.classList.add("hidden"));

  window.addEventListener("beforeunload", (e) => {
    if (!els.progressPanel.classList.contains("hidden")) e.preventDefault();
  });
}

function setDateline() {
  const el = document.getElementById("today");
  if (el) {
    el.textContent = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
}

setDateline();
wire();
void checkEnvironment();
