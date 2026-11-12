import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatClock,
  formatTimestamp,
  joinWords,
  segmentWords,
  readingRows,
  toParagraphs,
  toParagraphBlocks,
  toPlainText,
  toTimestampedText,
  toSrt,
  toVtt,
  wrapCue,
  type Word,
} from "../src/captions.ts";

// Build words from "text@start-end" tokens.
const w = (spec: string): Word[] =>
  spec.split(" ").map((tok) => {
    const [text, times] = tok.split("@");
    const [start, end] = times.split("-").map(Number);
    return { text, start, end };
  });

test("formatTimestamp handles hours, rounding, and negatives", () => {
  assert.equal(formatTimestamp(3725.5, ","), "01:02:05,500");
  assert.equal(formatTimestamp(0.0004, "."), "00:00:00.000");
  assert.equal(formatTimestamp(59.9996, ","), "00:01:00,000");
  assert.equal(formatTimestamp(-1, ","), "00:00:00,000");
});

test("formatClock", () => {
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(0), "0:00");
});

test("joinWords fixes detached punctuation", () => {
  assert.equal(joinWords(w("Hello@0-1 ,@1-1 world@1-2 !@2-2")), "Hello, world!");
});

test("segmentWords breaks on long pauses", () => {
  const segs = segmentWords(w("one@0-0.3 two@0.4-0.7 three@2.0-2.3"));
  assert.deepEqual(segs.map((s) => s.text), ["one two", "three"]);
  assert.equal(segs[1].start, 2.0);
});

test("segmentWords respects max duration and max chars", () => {
  const words: Word[] = Array.from({ length: 40 }, (_, i) => ({ text: "word", start: i * 0.3, end: i * 0.3 + 0.25 }));
  const segs = segmentWords(words);
  for (const s of segs) {
    assert.ok(s.end - s.start <= 6, `segment too long: ${s.end - s.start}`);
    assert.ok(s.text.length <= 84, `segment too wide: ${s.text.length}`);
  }
  // No word is lost.
  assert.equal(segs.map((s) => s.text.split(" ").length).reduce((a, b) => a + b), 40);
});

test("segmentWords ends at sentence boundaries once long enough", () => {
  const segs = segmentWords(w("This@0-0.2 is@0.2-0.4 the@0.4-0.5 first@0.5-0.8 sentence.@0.8-1.2 Next@1.3-1.5 one.@1.5-1.8"));
  assert.equal(segs[0].text, "This is the first sentence.");
});

test("overflowing cues break at the last comma rather than mid-phrase", () => {
  const text =
    "Today we are talking about running in the rain, and why the Boston marathon is worth the training.";
  const words: Word[] = text.split(" ").map((t, i) => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.25 }));
  const segs = segmentWords(words);
  assert.equal(segs[0].text, "Today we are talking about running in the rain,");
  assert.equal(segs[1].text, "and why the Boston marathon is worth the training.");
});

test("empty input produces empty outputs", () => {
  assert.deepEqual(segmentWords([]), []);
  assert.deepEqual(toParagraphs([]), []);
  assert.equal(toSrt([]), "");
  assert.equal(toVtt([]), "WEBVTT\n\n");
});

test("SRT and VTT formatting", () => {
  const segs = [{ start: 1, end: 2.5, text: "Hello there." }, { start: 3, end: 4, text: "Bye." }];
  assert.equal(toSrt(segs), "1\n00:00:01,000 --> 00:00:02,500\nHello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nBye.\n");
  assert.ok(toVtt(segs).startsWith("WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello there.\n"));
});

test("wrapCue splits into two balanced lines", () => {
  const out = wrapCue("the quick brown fox jumps over the lazy dog near the river bank");
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(lines[0].length - lines[1].length) <= 8);
});

test("toParagraphs splits on long silences", () => {
  const paras = toParagraphs(w("Hi.@0-0.5 there.@0.6-1 New@5-5.3 topic.@5.3-5.8"));
  assert.deepEqual(paras, ["Hi. there.", "New topic."]);
});

test("segments and paragraphs break when the speaker changes", () => {
  const words: Word[] = [
    { text: "Hello", start: 0, end: 0.2, speaker: 0 },
    { text: "there.", start: 0.3, end: 0.5, speaker: 0 },
    { text: "Hi", start: 0.6, end: 0.8, speaker: 1 },
    { text: "back.", start: 0.9, end: 1.1, speaker: 1 },
  ];
  const segs = segmentWords(words);
  assert.deepEqual(segs.map((s) => [s.speaker, s.text]), [[0, "Hello there."], [1, "Hi back."]]);
  assert.deepEqual(toParagraphBlocks(words).map((p) => [p.speaker, p.text]), [[0, "Hello there."], [1, "Hi back."]]);
});

test("exports carry speaker names", () => {
  const segs = [
    { start: 0, end: 1, text: "Hello there.", speaker: 0 },
    { start: 1, end: 2, text: "Still me.", speaker: 0 },
    { start: 2, end: 3, text: "Hi <back>.", speaker: 1 },
  ];
  const names = ["Matt", "Sarah"];
  const nameOf = (s: number | undefined) => (s === undefined ? undefined : names[s]);
  const srt = toSrt(segs, nameOf);
  assert.ok(srt.includes("[Matt] Hello there."));
  assert.ok(srt.includes("\nStill me.")); // no repeat label for the same speaker
  assert.ok(srt.includes("[Sarah] Hi <back>."));
  const vtt = toVtt(segs, nameOf);
  assert.ok(vtt.includes("<v Matt>Hello there."));
  assert.ok(vtt.includes("<v Sarah>Hi &lt;back&gt;."));
  assert.ok(toTimestampedText(segs, nameOf).startsWith("[0:00] Matt: Hello there."));
  assert.equal(toPlainText([{ text: "Hi.", speaker: 1 }, { text: "No speaker." }], nameOf), "Sarah: Hi.\n\nNo speaker.");
});

test("readingRows break only at pauses and speaker changes, never mid-sentence", () => {
  // One sentence spoken over 9 seconds with no pause: subtitles split it, reading rows don't.
  const sentence = "And I would make the observation this is the first proclamation we've had that came with a complete business case embedded in it all.";
  const words: Word[] = sentence.split(" ").map((t, i) => ({ text: t, start: i * 0.35, end: i * 0.35 + 0.3 }));
  assert.ok(segmentWords(words).length > 1);
  const rows = readingRows(words);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, sentence);

  // A pause starts a new row; so does a new speaker.
  const more: Word[] = [
    { text: "Thank", start: 0, end: 0.2, speaker: 0 },
    { text: "you.", start: 0.25, end: 0.5, speaker: 0 },
    { text: "Next", start: 1.6, end: 1.8, speaker: 0 },
    { text: "item.", start: 1.85, end: 2.1, speaker: 0 },
    { text: "Second.", start: 2.2, end: 2.5, speaker: 1 },
  ];
  assert.deepEqual(readingRows(more).map((r) => r.text), ["Thank you.", "Next item.", "Second."]);
});

test("readingRows cap a very long unbroken stretch at a sentence end", () => {
  const words: Word[] = [];
  for (let i = 0; i < 400; i++) words.push({ text: i % 10 === 9 ? "word." : "word", start: i * 0.3, end: i * 0.3 + 0.25 });
  const rows = readingRows(words);
  assert.ok(rows.length > 1);
  for (const r of rows) assert.ok(r.text.length <= 900, `row too long: ${r.text.length}`);
  assert.equal(rows.map((r) => r.text.split(" ").length).reduce((a, b) => a + b), 400);
});
