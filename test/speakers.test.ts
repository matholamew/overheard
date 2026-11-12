import { test } from "node:test";
import assert from "node:assert/strict";
import { assignSpeakers, detectNames } from "../src/speakers.ts";
import type { Word } from "../src/captions.ts";

/** Words from "text" spread 0.3 s apart from `start`, all said by `speaker`. */
const say = (text: string, start: number, speaker?: number): Word[] =>
  text.split(" ").map((t, i) => ({ text: t, start: start + i * 0.3, end: start + i * 0.3 + 0.25, speaker }));

test("assignSpeakers follows the turns", () => {
  const words = [...say("hello there friend", 0), ...say("hi back to you", 2)];
  const turns = [
    { speaker: 0, start: 0, end: 1 },
    { speaker: 1, start: 1.9, end: 3.3 },
  ];
  const out = assignSpeakers(words, turns);
  assert.deepEqual(out.map((w) => w.speaker), [0, 0, 0, 1, 1, 1, 1]);
});

test("words in a short gap take the nearest turn; long gaps keep the previous speaker", () => {
  const words: Word[] = [
    { text: "one", start: 0, end: 0.2 },
    { text: "two", start: 1.15, end: 1.3 }, // 0.15 s after turn 0 ends
    { text: "three", start: 9, end: 9.2 }, // nowhere near any turn
  ];
  const out = assignSpeakers(words, [
    { speaker: 0, start: 0, end: 1 },
    { speaker: 1, start: 20, end: 21 },
  ]);
  assert.deepEqual(out.map((w) => w.speaker), [0, 0, 0]);
});

test("overlapping turns: the larger overlap wins", () => {
  const out = assignSpeakers([{ text: "x", start: 1, end: 2 }], [
    { speaker: 0, start: 0, end: 1.2 },
    { speaker: 1, start: 1.1, end: 3 },
  ]);
  assert.equal(out[0].speaker, 1);
});

test("no turns leaves words unlabelled", () => {
  assert.equal(assignSpeakers(say("a b", 0), [])[0].speaker, undefined);
});

test("detectNames finds common self-introductions", () => {
  const words = [
    ...say("Hi everyone, I'm Sarah Chen and welcome to the show.", 0, 0),
    ...say("Thanks Sarah. My name is Tom, glad to be here.", 10, 1),
    ...say("Hey, it's Priya.", 20, 2),
    ...say("Matt here, coming to you from Boston.", 30, 3),
    ...say("This is Dev. Good morning.", 40, 4),
    ...say("Can I jump in? Lee here. I run Saturdays.", 50, 5),
  ];
  const names = detectNames(words);
  assert.equal(names.get(0), "Sarah Chen");
  assert.equal(names.get(1), "Tom");
  assert.equal(names.get(2), "Priya");
  assert.equal(names.get(3), "Matt");
  assert.equal(names.get(4), "Dev");
  assert.equal(names.get(5), "Lee");
});

test("detectNames ignores phrases that only look like introductions", () => {
  const words = [
    ...say("I'm so glad we finally did this. I'm Going to start.", 0, 0),
    ...say("This is great. It's Monday, which is fine.", 10, 1),
    ...say("I am not sure about that, honestly.", 20, 2),
    ...say("We went out there. Boston here is great.", 30, 3), // "here" mid-sentence after a place
  ];
  assert.equal(detectNames(words).size, 0);
});

test("detectNames only reads each speaker's own opening, not names said to them", () => {
  const filler = Array(12).fill("and so on").join(" ");
  const words = [
    ...say(`Welcome back everyone. ${filler}`, 0, 0),
    ...say("Great to be here.", 40, 1),
    ...say("By the way, I'm Alex, I should have said.", 50, 0), // too late in speaker 0's speech
  ];
  assert.equal(detectNames(words).has(0), false);
});

test("a name claimed twice goes to the first speaker only", () => {
  const words = [...say("I'm Sam.", 0, 0), ...say("I'm Sam too.", 5, 1)];
  const names = detectNames(words);
  assert.equal(names.get(0), "Sam");
  assert.equal(names.has(1), false);
});
