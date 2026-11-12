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
  segmentWords,
  toParagraphs,
  toSrt,
  toTimestampedText,
  toVtt,
  type Segment,
} from "./captions";

declare const __ORT_WASM_DIR__: string;

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

async function loadOnce(): Promise<VozClass> {
  const { Voz } = await import("@desert-ant-labs/voz");
  let sawDownload = false;
  const voz = await Voz.load({
    wasmDir: __ORT_WASM_DIR__,
    onProgress: (fraction) => {
      sawDownload = true;
      setProgress(fraction);
      if (fraction >= 1) {
        showProgress("Preparing model…", "Compiling for this device. This takes a few seconds.");
        setIndeterminate();
      }
    },
  });
  if (!sawDownload) setIndeterminate();
  return voz;
}

function loadModel(): Promise<VozClass> {
  if (!vozPromise) {
    vozPromise = (async () => {
      showProgress("Loading speech model…", "First run downloads about 470 MB once; later visits load from cache.");
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
  if (/webassembly|vendor|wasm/i.test(message)) {
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

interface Current {
  name: string;
  base: string;
  result: VozResult;
  segments: Segment[];
  paragraphs: string[];
  mediaUrl: string;
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

    if (current) URL.revokeObjectURL(current.mediaUrl);
    current = {
      name: file.name,
      base: file.name.replace(/\.[^.]+$/, "") || "transcript",
      result,
      segments: segmentWords(result.words),
      paragraphs: toParagraphs(result.words),
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
    `(${speed}× real time on ${engineLabel}) · ${result.words.length.toLocaleString()} words`;

  els.mediaSlot.replaceChildren();
  const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(file.name);
  const media = document.createElement(isVideo ? "video" : "audio");
  media.src = current.mediaUrl;
  media.controls = true;
  media.preload = "metadata";
  if (isVideo) (media as HTMLVideoElement).playsInline = true;
  media.addEventListener("timeupdate", () => highlight(media.currentTime));
  els.mediaSlot.append(media);

  renderTranscript();
  show("result");
}

function renderTranscript() {
  if (!current) return;
  els.transcript.replaceChildren();
  if (current.result.words.length === 0) {
    els.transcript.textContent = "No speech was detected in this file.";
    return;
  }
  if (view === "segments") {
    const frag = document.createDocumentFragment();
    current.segments.forEach((seg, i) => {
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
      el.textContent = p;
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
  const segs = current.segments;
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
      return { content: toSrt(current.segments), ext: "srt", type: "application/x-subrip" };
    case "vtt":
      return { content: toVtt(current.segments), ext: "vtt", type: "text/vtt" };
    case "timestamped":
      return { content: toTimestampedText(current.segments), ext: "timestamped.txt", type: "text/plain" };
    case "json":
      return {
        content: JSON.stringify(
          {
            file: current.name,
            duration: current.result.duration,
            text: current.result.text,
            segments: current.segments,
            words: current.result.words,
          },
          null,
          2,
        ),
        ext: "json",
        type: "application/json",
      };
    default:
      return { content: current.paragraphs.join("\n\n"), ext: "txt", type: "text/plain" };
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

function wire() {
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
    const text = view === "segments" ? toTimestampedText(current.segments) : current.paragraphs.join("\n\n");
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
