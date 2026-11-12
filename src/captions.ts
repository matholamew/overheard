// Pure helpers that turn Voz's word list into readable text, caption cues and
// export files. No DOM here, so this module can be tested under plain Node.

export interface Word {
  text: string;
  start: number; // seconds
  end: number; // seconds
  speaker?: number; // from the Who model, 0-based, when speakers were labelled
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: number;
}

const SENTENCE_END = /[.!?]["')\]]?$/;

/** Joins words, fixing spacing around punctuation the model emits as tokens. */
export function joinWords(words: Word[]): string {
  return words
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+([,.!?;:%)\]}])/g, "$1")
    .replace(/([(\[{])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SegmentOptions {
  maxChars: number; // longest cue text
  maxDuration: number; // longest cue, seconds
  pauseBreak: number; // a silence at least this long always starts a new cue
}

export const CAPTION_DEFAULTS: SegmentOptions = { maxChars: 84, maxDuration: 6, pauseBreak: 0.8 };

/**
 * Splits words into caption-sized segments. A segment ends at a long pause, at
 * the end of a sentence once it has some length, or when it would grow past
 * maxChars / maxDuration.
 */
export function segmentWords(words: Word[], opts: SegmentOptions = CAPTION_DEFAULTS): Segment[] {
  const segments: Segment[] = [];
  let current: Word[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const seg: Segment = {
      start: current[0].start,
      end: current[current.length - 1].end,
      text: joinWords(current),
    };
    if (current[0].speaker !== undefined) seg.speaker = current[0].speaker;
    segments.push(seg);
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word.text.trim()) continue;

    if (current.length > 0) {
      const prev = current[current.length - 1];
      const gap = word.start - prev.end;
      const projectedText = joinWords([...current, word]);
      const projectedDuration = word.end - current[0].start;
      if (word.speaker !== prev.speaker) {
        flush();
      } else if (gap >= opts.pauseBreak) {
        flush();
      } else if (projectedText.length > opts.maxChars || projectedDuration > opts.maxDuration) {
        // Overflowing: end the cue at its last clause break if there is one in
        // the back half, so the next cue starts at a natural phrase.
        let cut = -1;
        for (let k = current.length - 1; k >= Math.ceil(current.length / 2); k--) {
          if (/[,;:]$/.test(current[k].text)) {
            cut = k;
            break;
          }
        }
        if (cut >= 0 && cut < current.length - 1) {
          const rest = current.slice(cut + 1);
          current = current.slice(0, cut + 1);
          flush();
          current = rest;
        } else {
          flush();
        }
      }
    }

    current.push(word);

    // Prefer to end cues at sentence boundaries once they carry a few words.
    if (SENTENCE_END.test(word.text) && joinWords(current).length >= 24) flush();
  }
  flush();
  return segments;
}

/**
 * Rows for reading (the Timed view and timestamped text): a new row at every
 * pause or change of speaker, so sentences are never cut in half the way
 * subtitle cues are. A very long unbroken stretch still ends at a sentence
 * once it passes `softMax` characters, and anywhere past `hardMax`, so one
 * row can't swallow minutes of a speech.
 */
export function readingRows(words: Word[], pause = 0.8, softMax = 420, hardMax = 900): Segment[] {
  const rows: Segment[] = [];
  let current: Word[] = [];
  let chars = 0;
  const flush = () => {
    if (current.length === 0) return;
    const row: Segment = { start: current[0].start, end: current[current.length - 1].end, text: joinWords(current) };
    if (current[0].speaker !== undefined) row.speaker = current[0].speaker;
    rows.push(row);
    current = [];
    chars = 0;
  };
  for (const word of words) {
    if (!word.text.trim()) continue;
    const prev = current[current.length - 1];
    if (prev && (word.speaker !== prev.speaker || word.start - prev.end >= pause)) flush();
    current.push(word);
    chars += word.text.length + 1;
    if ((chars >= softMax && SENTENCE_END.test(word.text)) || chars >= hardMax) flush();
  }
  flush();
  return rows;
}

export interface Paragraph {
  text: string;
  speaker?: number;
}

/** Groups sentences into paragraphs, starting a new one at a long pause or a new speaker. */
export function toParagraphBlocks(words: Word[], pauseBreak = 2, maxChars = 600): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (current.length) {
      const p: Paragraph = { text: joinWords(current) };
      if (current[0].speaker !== undefined) p.speaker = current[0].speaker;
      paragraphs.push(p);
    }
    current = [];
  };
  for (const word of words) {
    if (!word.text.trim()) continue;
    const prev = current[current.length - 1];
    if (prev && (word.start - prev.end >= pauseBreak || word.speaker !== prev.speaker)) flush();
    current.push(word);
    if (SENTENCE_END.test(word.text) && joinWords(current).length >= maxChars) flush();
  }
  flush();
  return paragraphs;
}

/** Paragraph texts only, for callers that don't need speakers. */
export function toParagraphs(words: Word[], pauseBreak = 2, maxChars = 600): string[] {
  return toParagraphBlocks(words, pauseBreak, maxChars).map((p) => p.text);
}

/** Turns a speaker number into a display name; undefined when there is none. */
export type NameOf = (speaker: number | undefined) => string | undefined;
const noNames: NameOf = () => undefined;

/** Plain text with "Name: " before each paragraph when speakers are known. */
export function toPlainText(paragraphs: Paragraph[], nameOf: NameOf = noNames): string {
  return paragraphs
    .map((p) => {
      const name = nameOf(p.speaker);
      return name ? `${name}: ${p.text}` : p.text;
    })
    .join("\n\n");
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** 3725.5 -> "01:02:05,500" (SRT) or "01:02:05.500" (VTT). */
export function formatTimestamp(seconds: number, separator: "," | "."): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

/** Short clock for the UI: 65 -> "1:05", 3725 -> "1:02:05". */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** SRT: "[Name] " before a cue whenever the speaker changes. */
export function toSrt(segments: Segment[], nameOf: NameOf = noNames): string {
  let last: number | undefined = -1;
  return segments
    .map((seg, i) => {
      const name = nameOf(seg.speaker);
      const label = name && seg.speaker !== last ? `[${name}] ` : "";
      last = seg.speaker;
      return `${i + 1}\n${formatTimestamp(seg.start, ",")} --> ${formatTimestamp(seg.end, ",")}\n${wrapCue(label + seg.text)}\n`;
    })
    .join("\n");
}

const vttEscape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** WebVTT: each cue carries a <v Name> voice tag when speakers are known. */
export function toVtt(segments: Segment[], nameOf: NameOf = noNames): string {
  const cues = segments
    .map((seg) => {
      const name = nameOf(seg.speaker);
      const body = name ? `<v ${vttEscape(name)}>${vttEscape(seg.text)}` : vttEscape(seg.text);
      return `${formatTimestamp(seg.start, ".")} --> ${formatTimestamp(seg.end, ".")}\n${name ? body : wrapCue(body)}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${cues}`;
}

/** Breaks a cue into at most two balanced lines, as players expect. */
export function wrapCue(text: string, maxLine = 42): string {
  if (text.length <= maxLine) return text;
  const words = text.split(" ");
  let best = text;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const score = Math.abs(a.length - b.length);
    if (score < bestScore) {
      bestScore = score;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

export function toTimestampedText(segments: Segment[], nameOf: NameOf = noNames): string {
  return segments
    .map((s) => {
      const name = nameOf(s.speaker);
      return `[${formatClock(s.start)}] ${name ? `${name}: ` : ""}${s.text}`;
    })
    .join("\n");
}
