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

test("a részletes mód két oszlopban mutatja a lépéseket és az aktuális tartalmat", () => {
  assert.match(app, /detailed-trace-grid/);
  assert.doesNotMatch(app, /className="detailed-trace-lane detailed-answer-lane"/);
  assert.match(app, /detailed-steps-lane/);
  assert.match(app, /detailed-thinking-lane/);
  assert.match(
    styles,
    /--detailed-steps-track: clamp\(260px, var\(--detailed-steps-width, 320px\), 40%\)[\s\S]*grid-template-columns:[\s\S]*var\(--detailed-steps-track\)[\s\S]*minmax\(0, 1fr\)/,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane,[\s\S]*\.detailed-plan-lane \{[\s\S]*position: absolute;[\s\S]*bottom: 0;[\s\S]*left: var\(--detailed-steps-track\);[\s\S]*overflow-y: auto/,
  );
  assert.match(
    styles,
    /\.detailed-run-shell \.detailed-thinking-list,[\s\S]*\.detailed-run-shell \.detailed-plan-content \{[\s\S]*overflow: visible !important/,
  );
  assert.match(
    styles,
    /\.detailed-run-shell \.detailed-final-answer-body,[\s\S]*\.detailed-run-shell \.turn-progress-answer-body \{[\s\S]*max-height: none !important;[\s\S]*overflow: visible !important/,
  );
});

test("a részletes pipeline nem tart külön VÁLASZ fület", () => {
  assert.doesNotMatch(app, /PIPELINE_ANSWER_TAB/);
  assert.match(app, /style=\{\{ "--tab-count": runStages\.length \}/);
  assert.match(app, /style=\{\{ "--tab-count": liveRunStages\.length \}/);
  assert.doesNotMatch(app, /className="pipeline-run-slider"/);
});

test("a terv mindig teljes marad, és a kiválasztott lépés bekezdését emeli ki", () => {
  assert.match(app, /planTextSegments\(answer\?\.text \?\? ""\)/);
  assert.match(app, /data-plan-step-index=\{segment\.stepIndex\}/);
  assert.match(app, /segment\.stepIndex === selectedStepIndex \? " is-highlighted"/);
  assert.doesNotMatch(app, /detailed-plan-view-toggle/);
  assert.doesNotMatch(app, />RAW</);
  assert.doesNotMatch(app, />RÉSZLET</);
});

test("a KÓD és REVIEW végső válasza az utolsó lépés folyamába kerül", () => {
  assert.match(app, /const finalAnswerStep = isCodeOrReviewStage \? steps\.at\(-1\)/);
  assert.match(app, /className=\{`detailed-final-answer/);
  assert.match(app, /trace-step-final-mark/);
  assert.match(app, /is-verdict-step is-verdict-/);
});

test("a fázisválasztó felirat nélküli, vertikális provider rail", () => {
  assert.match(app, /label: STAGE_ROLE_LABELS\[item\.role\] \?\? item\.role/);
  assert.match(app, /pipeline-stage-provider-mark/);
  assert.match(app, /normalizeAgentProvider\(item\.agent\) \?\? "codex"/);
  assert.match(styles, /\.detailed-run-shell \.pipeline-run-tabs\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(styles, /\.detailed-run-shell \.pipeline-run-tabs::after\s*\{[^}]*width:\s*1px[^}]*background:\s*rgba\(165, 155, 124, \.58\)/s);
  assert.match(styles, /\.detailed-run-shell \.pipeline-run-tab\.is-running::after/);
  assert.match(styles, /\.detailed-run-shell \.pipeline-run-tab\.is-verdict-accepted\s*\{[^}]*#2ee174/s);
});

test("a kért fekete Tree és válaszfelület a pontos szürke chat-háttéren marad", () => {
  assert.match(styles, /--chat-bg:\s*#000/);
  assert.match(styles, /--tick4-answer-bg:\s*#000/);
  assert.match(styles, /Detailed mode v2:[\s\S]*--tick4-on-answer:\s*#fff/);
  assert.match(styles, /\.workspace\s*\{\s*background:\s*#000/);
  assert.match(styles, /\.composer-multi-ai-toggle[^}]*background:\s*#000/s);
  assert.match(styles, /\.compact-answer-card::before,[\s\S]*width:\s*3px;[\s\S]*background:\s*#a59b7c\s*!important;/);
  assert.match(styles, /\.detailed-run-shell \.detailed-trace-card::before,[\s\S]*background:\s*#a59b7c\s*!important;/);
  assert.match(styles, /\.detailed-plan-lane\s*\{[^}]*box-shadow:\s*none\s*!important/s);
  assert.match(styles, /\.detailed-final-answer\s*\{[^}]*border-left:\s*0/s);
});

test("a részletes lépések szürke sorok, számláló nélkül és alattuk van a fájllista", () => {
  assert.match(styles, /\.detailed-step-list \.trace-step-row,[\s\S]*background:\s*#2c2c2c/);
  assert.match(app, /className="detailed-step-changes"/);
  assert.match(app, /className="trace-total-elapsed detailed-steps-total"/);
  assert.doesNotMatch(app, /completedStepCount/);
  assert.doesNotMatch(app, /detailed-steps-summary/);
  assert.doesNotMatch(app, /className="detailed-inline-changes"/);
});

test("a verdikt konklúziója a REVIEW utolsó lépése alatt marad", () => {
  assert.match(app, /\{isReviewStage && runFooter\}/);
  assert.doesNotMatch(app, /A bíráló elfogadta/);
  assert.match(styles, /\.detailed-step-list > \.pipeline-answer-next\s*\{[^}]*border:\s*0/s);
});

test("a user bubble normál betűsúlyt használ", () => {
  assert.match(
    styles,
    /\.user-message \.message-body,[\s\S]*\.user-message \.message-body strong\s*\{\s*font-weight:\s*400\s*!important;/,
  );
});
