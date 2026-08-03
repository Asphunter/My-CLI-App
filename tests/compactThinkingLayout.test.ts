import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const component = readFileSync(
  new URL("../src/CompactAnswersTimeline.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("a rövid gondolkodáslista nem növeli vissza a mért panelmagasságot", () => {
  assert.match(
    styles,
    /\.compact-thinking-list\s*\{[^}]*\bflex:\s*0\s+1\s+auto\s*;/s,
  );
  assert.doesNotMatch(
    styles,
    /\.compact-thinking-list\s*\{[^}]*\bflex:\s*1\s+1\s+auto\s*;/s,
  );
});

test("a kompakt gondolkodás közvetlenül a bulletpontokkal indul", () => {
  assert.doesNotMatch(component, />GONDOLKODÁS MENETE</);
  assert.match(styles, /\.compact-thinking-list\s*\{[^}]*padding:\s*10px 4px 0/s);
});

test("futás közben csak a provider ikon kap orbit animációt", () => {
  assert.match(
    styles,
    /\.compact-answers-layout\.is-current::after\s*\{\s*display:\s*none;/,
  );
  assert.match(
    styles,
    /\.compact-answer-status-rail\.is-running \.compact-answer-provider-mark::before[^}]*provider-status-orbit/s,
  );
});

test("a részletes mód egyszerre mutatja a válasz, lépések és gondolkodás sávot", () => {
  assert.match(app, /className="detailed-trace-grid"/);
  assert.match(app, /detailed-answer-lane/);
  assert.match(app, /detailed-steps-lane/);
  assert.match(app, /detailed-thinking-lane/);
  assert.match(
    styles,
    /grid-template-columns:\s*minmax\(260px, 36fr\)\s+minmax\(220px, 28fr\)\s+minmax\(260px, 36fr\)/,
  );
});

test("a részletes pipeline nem tart külön VÁLASZ fület", () => {
  assert.doesNotMatch(app, /PIPELINE_ANSWER_TAB/);
  assert.match(app, /style=\{\{ "--tab-count": runStages\.length \}/);
  assert.match(app, /style=\{\{ "--tab-count": liveRunStages\.length \}/);
});

test("a kész terv jobb sávja alapból a kiválasztott lépés részletét mutatja", () => {
  assert.match(
    app,
    /effectivePlannedSteps\.length > 0 \? "detail" : "raw"/,
  );
});

test("a kért fekete Tree és válaszfelület a pontos szürke chat-háttéren marad", () => {
  assert.match(styles, /--chat-bg:\s*#000/);
  assert.match(styles, /--tick4-answer-bg:\s*#000/);
  assert.match(styles, /--tick4-on-answer:\s*#fbe7c5/);
  assert.match(styles, /\.workspace\s*\{\s*background:\s*#000/);
  assert.match(styles, /\.composer-multi-ai-toggle[^}]*background:\s*#000/s);
  assert.match(
    styles,
    /\.compact-answer-card::before,\s*\.detailed-answer-lane::before\s*\{[^}]*width:\s*3px;[^}]*background:\s*#a59b7c\s*!important;/s,
  );
});
