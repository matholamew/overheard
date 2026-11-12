// Joins Voz's words to Who's turns, and spots people introducing themselves.
// Pure functions, no DOM, so they run under plain Node tests.

import type { Word } from "./captions";

export interface Turn {
  speaker: number;
  start: number;
  end: number;
}

/**
 * Gives every word the speaker whose turn covers most of it. Words in a gap
 * between turns take the nearest turn within `reach` seconds, and failing
 * that the previous word's speaker, so nobody's sentence is split by a breath.
 */
export function assignSpeakers(words: Word[], turns: Turn[], reach = 1.0): Word[] {
  if (turns.length === 0) return words.map((w) => ({ ...w }));
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  let previous: number | undefined;
  let from = 0;

  return words.map((word) => {
    // Turns are sorted by start; skip those that ended well before this word.
    while (from < sorted.length && sorted[from].end < word.start - 30) from++;

    let best: number | undefined;
    let bestOverlap = 0;
    let nearest: number | undefined;
    let nearestGap = Infinity;
    for (let i = from; i < sorted.length; i++) {
      const t = sorted[i];
      if (t.start > word.end + reach) break;
      const overlap = Math.min(word.end, t.end) - Math.max(word.start, t.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = t.speaker;
      }
      const gap = overlap > 0 ? 0 : Math.min(Math.abs(word.start - t.end), Math.abs(t.start - word.end));
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = t.speaker;
      }
    }
    const speaker = best ?? (nearestGap <= reach ? nearest : previous) ?? nearest;
    previous = speaker;
    return { ...word, speaker };
  });
}

/** Capitalised words that follow "I'm" without being anyone's name. */
const NOT_NAMES = new Set(
  `I A An The So Just Not Going Here There Really Sure Glad Happy Excited Back Good Great Fine Okay Ok OK Yeah Yes No
   Well Also Still Actually Sorry Thank Thanks Very Pretty Always Gonna Trying Looking Talking Doing Joined Joining With
   Your Our Their My His Her Hosting Host Today Now Currently From In At On Like Kind Sort Literally Basically Honestly
   Definitely Totally Absolutely Probably Done Ready All Both Hi Hello Hey Welcome Calling Coming Speaking Recording
   Live Running Working Based Out Off Up Down Over Gonna Wondering Thinking Curious Interested Honored Honoured Thrilled
   Delighted Pleased Lucky Grateful Proud Hoping Planning About Somebody Someone Everyone Nobody One Two Three
   Mister Mr Mrs Ms Miss Doctor Dr Professor Your You We They He She It This That What Who Why How When Where
   Monday Tuesday Wednesday Thursday Friday Saturday Sunday English American Canadian British`.split(/\s+/),
);

const cleanToken = (t: string) => t.replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, "").replace(/'s$/i, "");
const isNameToken = (t: string) =>
  /^\p{Lu}[\p{L}'-]{1,24}$/u.test(t) && !NOT_NAMES.has(t) && !NOT_NAMES.has(t.replace(/'.*$/, ""));

/**
 * Looks at the start of each speaker's speech for a self-introduction:
 * "my name is Sarah", "I'm Sarah Chen", "this is Tom", "it's Priya", "Matt here".
 * Returns speaker -> name. A name claimed by two speakers goes to the first.
 *
 * Only the speaker's own opening words count, so "thanks, Sarah" said by
 * someone else never names the wrong person.
 */
export function detectNames(words: Word[], opening = 30): Map<number, string> {
  const firstWords = new Map<number, string[]>();
  for (const w of words) {
    if (w.speaker === undefined) continue;
    const list = firstWords.get(w.speaker) ?? [];
    if (list.length < opening) {
      list.push(w.text);
      firstWords.set(w.speaker, list);
    }
  }

  const found = new Map<number, string>();
  const taken = new Set<string>();
  const speakers = [...firstWords.keys()].sort((a, b) => a - b);

  for (const speaker of speakers) {
    const tokens = firstWords.get(speaker)!.flatMap((t) => t.split(/\s+/)).filter(Boolean);
    // Keywords keep their apostrophes ("it's", "i'm"); names drop a possessive.
    const lower = tokens.map((t) => t.replace(/^[^\p{L}]+|[^\p{L}']+$/gu, "").replace(/’/g, "'").toLowerCase());
    const clean = tokens.map(cleanToken);

    const nameAt = (i: number): string | null => {
      if (i >= clean.length || !isNameToken(clean[i])) return null;
      // A second capitalised word is a surname, unless a sentence ended first.
      const endsSentence = /[.!?]$/.test(tokens[i]);
      if (!endsSentence && i + 1 < clean.length && isNameToken(clean[i + 1])) return `${clean[i]} ${clean[i + 1]}`;
      return clean[i];
    };

    let name: string | null = null;
    for (let i = 0; i < lower.length && !name; i++) {
      const w = lower[i];
      const next = lower[i + 1];
      if (w === "my" && next === "name" && (lower[i + 2] === "is" || lower[i + 2] === "'s")) name = nameAt(i + 3);
      else if (w === "name's") name = nameAt(i + 1);
      else if (w === "i'm" || w === "im") name = nameAt(i + 1);
      else if (w === "i" && next === "am") name = nameAt(i + 2);
      else if (w === "this" && next === "is") name = nameAt(i + 2);
      else if ((w === "it's" || w === "its") && i <= 4) name = nameAt(i + 1);
      // "Matt here." / "Matt here, ..." at the start of a sentence; not "Boston here is great".
      else if (
        next === "here" &&
        (i === 0 || /[.!?,]$/.test(tokens[i - 1])) &&
        (i + 2 >= tokens.length || /[.!?,;:]$/.test(tokens[i + 1])) &&
        isNameToken(clean[i])
      )
        name = clean[i];
    }
    if (name && !taken.has(name.toLowerCase())) {
      found.set(speaker, name);
      taken.add(name.toLowerCase());
    }
  }
  return found;
}
