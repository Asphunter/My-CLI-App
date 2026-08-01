import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompactAnswerTimeline,
  buildCompactTraceSections,
  looksHungarianNarrative,
} from "../src/compactAnswerTimeline.ts";

test("azonos provider item deltái egy válaszblokkba fűződnek", () => {
  const blocks = buildCompactAnswerTimeline({
    answers: [
      { id: "a1", itemId: "assistant-1", sequence: 20, text: "Első " },
      { id: "a2", itemId: "assistant-1", sequence: 21, text: "válasz." },
    ],
    trace: [],
    streaming: false,
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "Első válasz.");
});

test("külön itemId és több bekezdés külön, teljes blokkok maradnak", () => {
  const blocks = buildCompactAnswerTimeline({
    answers: [
      { id: "a1", itemId: "assistant-1", sequence: 20, text: "Első.\n\nMásodik bekezdés." },
      { id: "a2", itemId: "assistant-2", sequence: 40, text: "Következő válasz." },
    ],
    trace: [],
    streaming: false,
  });
  assert.deepEqual(blocks.map((block) => block.text), [
    "Első.\n\nMásodik bekezdés.",
    "Következő válasz.",
  ]);
});

test("minden trace kizárólag a közvetlenül utána következő válaszhoz kerül", () => {
  const blocks = buildCompactAnswerTimeline({
    answers: [
      { id: "a1", itemId: "assistant-1", sequence: 20, text: "Egy." },
      { id: "a2", itemId: "assistant-2", sequence: 40, text: "Kettő." },
    ],
    trace: [
      { id: "trace-a", sequence: 10 },
      { id: "trace-b", sequence: 30 },
    ],
    finalAnswer: { id: "final", text: "Három." },
    streaming: false,
  });
  assert.deepEqual(blocks.map((block) => block.trace.map((item) => item.id)), [
    ["trace-a"],
    ["trace-b"],
    [],
  ]);
});

test("válasz nélküli élő trace pending sort kap", () => {
  const blocks = buildCompactAnswerTimeline({
    answers: [],
    trace: [{ id: "trace-a", sequence: 10 }],
    streaming: true,
    turnId: "turn-1",
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].id, "next:turn-1");
  assert.equal(blocks[0].pending, true);
  assert.deepEqual(blocks[0].trace.map((item) => item.id), ["trace-a"]);
});

test("a pending sor ugyanazzal az identitással alakul élő végső válasszá", () => {
  const pending = buildCompactAnswerTimeline({
    answers: [],
    trace: [],
    streaming: true,
    turnId: "turn-1",
  });
  const answering = buildCompactAnswerTimeline({
    answers: [],
    trace: [],
    finalAnswer: { id: "final", turnId: "turn-1", text: "Készül." },
    streaming: true,
    turnId: "turn-1",
  });
  assert.equal(pending[0].id, answering[0].id);
  assert.equal(answering[0].pending, false);
});

test("a commentary-prefixet tartalmazó finalText nem duplikálja a köztes választ", () => {
  const blocks = buildCompactAnswerTimeline({
    answers: [
      { id: "a1", itemId: "assistant-1", sequence: 20, text: "Ellenőrzöm." },
    ],
    trace: [],
    finalAnswer: {
      id: "final",
      text: "Ellenőrzöm.A végeredmény rendben van.",
    },
    streaming: false,
  });
  assert.deepEqual(blocks.map((block) => block.text), [
    "Ellenőrzöm.",
    "A végeredmény rendben van.",
  ]);
});

test("csak turn finalText esetén egyetlen végső blokk készül", () => {
  const blocks = buildCompactAnswerTimeline({
    answers: [],
    trace: [{ id: "trace-a", sequence: 10 }],
    finalAnswer: { id: "final", text: "Kész válasz." },
    streaming: false,
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].final, true);
  assert.equal(blocks[0].text, "Kész válasz.");
  assert.deepEqual(blocks[0].trace.map((item) => item.id), ["trace-a"]);
});

test("megszakított futás után nem marad pending spinner", () => {
  const blocks = buildCompactAnswerTimeline({
    answers: [],
    trace: [{ id: "trace-a", sequence: 10 }],
    streaming: false,
  });
  assert.deepEqual(blocks, []);
});

test("régi, item-határ nélküli snapshot egy stabil végső blokk", () => {
  const first = buildCompactAnswerTimeline({
    answers: [],
    trace: [],
    finalAnswer: { id: "legacy", text: "Régi teljes válasz." },
    streaming: false,
  });
  const second = buildCompactAnswerTimeline({
    answers: [],
    trace: [],
    finalAnswer: { id: "legacy", text: "Régi teljes válasz." },
    streaming: false,
  });
  assert.deepEqual(first, second);
});

test("eltérő érkezési sorrendből sequence alapján azonos timeline készül", () => {
  const input = {
    answers: [
      { id: "a2", itemId: "assistant-2", sequence: 40, text: "Kettő." },
      { id: "a1", itemId: "assistant-1", sequence: 20, text: "Egy." },
    ],
    trace: [
      { id: "trace-b", sequence: 30 },
      { id: "trace-a", sequence: 10 },
    ],
    streaming: false,
  };
  const first = buildCompactAnswerTimeline(input);
  const second = buildCompactAnswerTimeline({
    ...input,
    answers: [...input.answers].reverse(),
    trace: [...input.trace].reverse(),
  });
  assert.deepEqual(first, second);
});

test("a magyar narráció megjelenítési fallbackje nem téveszti össze a parancsot az emberi összefoglalóval", () => {
  assert.equal(
    looksHungarianNarrative(
      "A helyi projekt beállításai rendben vannak, és most ellenőrzöm a telefont.",
    ),
    true,
  );
  assert.equal(
    looksHungarianNarrative("Investigating Flutter doctor hang causes"),
    false,
  );
  assert.equal(
    looksHungarianNarrative("$ flutter doctor -v; adb devices -l"),
    false,
  );
});

test("az egymással váltakozó reasoning és command események is egy technikai sorba kerülnek", () => {
  const sections = buildCompactTraceSections([
    { id: "r1", presentation: "reasoning", summary: "Assessing" },
    { id: "c1", presentation: "command", summary: "$ flutter --version" },
    { id: "r2", presentation: "reasoning", summary: "Verifying" },
    { id: "c2", presentation: "command", summary: "$ adb devices" },
  ]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].kind, "technical");
  assert.equal(
    sections[0].kind === "technical" ? sections[0].label : "",
    "Technikai részletek — 2 gondolat • 2 parancs",
  );
});

test("a magyar narráció és a fontos hiba megszakítja a technikai csoportot", () => {
  const sections = buildCompactTraceSections([
    { id: "r1", presentation: "reasoning", summary: "Assessing" },
    {
      id: "hu",
      presentation: "narrative",
      summary: "A gépi ellenőrzés elkészült.",
    },
    { id: "c1", presentation: "command", summary: "$ adb devices" },
    {
      id: "error",
      presentation: "status",
      summary: "ADB failed",
      important: true,
    },
  ]);
  assert.deepEqual(
    sections.map((section) => section.kind),
    ["technical", "primary", "technical", "primary"],
  );
});
