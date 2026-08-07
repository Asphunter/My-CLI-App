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
    /\.detailed-thinking-lane,[\s\S]*\.detailed-plan-lane \{[\s\S]*position: absolute;[\s\S]*bottom: auto;[\s\S]*left: var\(--detailed-steps-track\);[\s\S]*height: 100%;[\s\S]*overflow-y: auto/,
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
  assert.match(app, /style=\{\{ "--tab-count": runStageTabs\.length \}/);
  assert.match(app, /style=\{\{ "--tab-count": liveRunStages\.length \}/);
  assert.doesNotMatch(app, /className="pipeline-run-slider"/);
});

test("az egylépéses tervet a KÓD nem cseréli előkészítő placeholderre", () => {
  assert.match(app, /derivedPlanSteps\.length >= 1/);
  assert.match(app, /progress\.role === "code" && carriedSteps\.length >= 1/);
  assert.match(app, /source: carriedSteps\.length >= 1 \? "carried-plan" : "fallback"/);
  assert.match(app, /if \(bornSteps\.length >= 1\)/);
  assert.doesNotMatch(app, /carriedSteps\.length >= 2/);
  assert.doesNotMatch(app, /derivedPlanSteps\.length >= 2/);
});

test("a terv mindig teljes marad, és a kiválasztott lépés bekezdését emeli ki", () => {
  assert.match(app, /planTextSegments\(answer\?\.text \?\? ""\)/);
  assert.match(app, /data-plan-step-index=\{segment\.stepIndex\}/);
  assert.match(app, /segment\.stepIndex === selectedStepIndex \? " is-highlighted"/);
  assert.match(app, /className="detailed-plan-step-index">[\s\S]*\{segment\.number\}/);
  assert.match(app, /className="detailed-plan-step-period">\.<\/span>/);
  assert.match(styles, /\.detailed-plan-step\.is-highlighted\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/s);
  assert.match(styles, /\.detailed-plan-step-number\s*\{[^}]*width:\s*21px;[^}]*height:\s*21px;[^}]*place-items:\s*center/s);
  assert.match(styles, /\.detailed-plan-step-index\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*place-items:\s*center/s);
  assert.match(styles, /\.detailed-plan-step\.is-highlighted \.detailed-plan-step-number\s*\{[^}]*place-items:\s*center;[^}]*border-radius:\s*50%;[^}]*background:\s*#a59b7c;[^}]*color:\s*#050607/s);
  assert.doesNotMatch(app, /detailed-plan-view-toggle/);
  assert.doesNotMatch(app, />RAW</);
  assert.doesNotMatch(app, />RÉSZLET</);
});

test("a KÓD és REVIEW végső válasza az utolsó lépés folyamába kerül", () => {
  assert.match(app, /const finalAnswerStep = isCodeOrReviewStage \? steps\.at\(-1\)/);
  assert.match(app, /className=\{`detailed-final-answer/);
  assert.match(app, /trace-step-final-mark/);
  assert.match(app, /is-verdict-step is-verdict-/);
  assert.match(app, /finalAnswerRow && !isReviewStage/);
  assert.doesNotMatch(app, /const finalAnswerStepLabel = isReviewStage \? "VERDIKT"/);
});

test("a fázisválasztó felirat nélküli, vertikális provider rail", () => {
  assert.match(app, /label: STAGE_ROLE_LABELS\[item\.role\] \?\? item\.role/);
  assert.match(app, /pipeline-stage-provider-mark/);
  assert.match(app, /normalizeAgentProvider\(item\.agent\) \?\? "codex"/);
  assert.match(styles, /\.detailed-run-shell \.pipeline-run-tabs\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(styles, /\.detailed-run-shell \.pipeline-run-tabs::after\s*\{[^}]*width:\s*1px[^}]*background:\s*rgba\(165, 155, 124, \.58\)/s);
  assert.match(styles, /\.detailed-run-shell \.pipeline-run-tab\.is-running::after/);
  assert.match(styles, /\.detailed-run-shell \.pipeline-run-tab\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(styles, /\.detailed-run-shell \.pipeline-run-tab\.is-verdict-accepted,[\s\S]*border:\s*1px solid #39434b !important/);
  assert.doesNotMatch(styles, /\.detailed-run-shell \.pipeline-run-tab\.is-verdict-accepted\s*\{[^}]*#2ee174/s);
});

test("az élő fázissáv a futáskor ténylegesen kiválasztott providereket mutatja", () => {
  assert.match(app, /const recipeWithStageOverrides = \(/);
  assert.match(app, /const provider = override\?\.provider \?\? stage\.provider/);
  assert.match(app, /const pipelineRecipeSnapshot =/);
  assert.match(app, /pipelineRecipeSnapshot \? \{ recipe: pipelineRecipeSnapshot \} : undefined/);
  assert.match(app, /const livePipelineRecipe = viewedRun\?\.chain\?\.recipe \?\? activePipelineRecipe/);
  assert.match(app, /provider: stage\.provider/);
});

test("a futáseredményt a számláló jelzi, nem a REVIEW fázis kerete", () => {
  assert.match(app, /runOutcome\?: "accepted" \| "changes" \| "stopped"/);
  assert.match(app, /const chainInterrupted = stage/);
  assert.match(app, /iterationOf\(message\.pipeline\) === selectedVersion/);
  assert.match(app, /runCounterState === "passed"[\s\S]*\? "✓"/);
  assert.match(app, /runCounterState === "failed"[\s\S]*\? "×"/);
  assert.match(app, /runCounterState === "stopped"[\s\S]*\? "■"/);
  assert.match(app, /className="detailed-run-result-mark"/);
  assert.match(styles, /\.detailed-answer-status-rail\.is-passed time\s*\{ color: #72d493; \}/);
  assert.match(styles, /\.detailed-answer-status-rail\.is-failed time\s*\{ color: #ee737d; \}/);
  assert.match(styles, /\.detailed-answer-status-rail\.is-stopped time\s*\{ color: #d7b56d; \}/);
});

test("a lezárt futás kiválasztott fázisát bal oldali, jobbra mutató nyíl jelöli", () => {
  assert.match(app, /className="pipeline-run-header is-history"/);
  assert.match(app, /className="pipeline-run-header is-live"/);
  assert.match(
    styles,
    /\.pipeline-run-header\.is-history \.pipeline-run-tab\.is-active::before\s*\{[^}]*right:\s*calc\(100% \+ 4px\)[^}]*border-left:\s*7px solid #d7ceaf/s,
  );
  assert.doesNotMatch(
    styles,
    /\.pipeline-run-header\.is-live \.pipeline-run-tab\.is-active::before/,
  );
});

test("a reasoning slider nem jelenít meg natív hover üzenetet", () => {
  assert.doesNotMatch(
    app,
    /title=\{`\$\{PROVIDER_LABELS\[provider\]\}[^`]*Reasoning:/,
  );
});

test("a kért fekete Tree és válaszfelület a pontos szürke chat-háttéren marad", () => {
  assert.match(styles, /--chat-bg:\s*#000/);
  assert.match(styles, /--tick4-answer-bg:\s*#000/);
  assert.match(styles, /Detailed mode v2:[\s\S]*--tick4-on-answer:\s*#fff/);
  assert.match(styles, /\.workspace\s*\{\s*background:\s*#000/);
  assert.match(styles, /\.composer-multi-ai-toggle[^}]*background:\s*#000/s);
  assert.match(styles, /\.compact-answer-card::before,[\s\S]*width:\s*3px;[\s\S]*background:\s*#a59b7c\s*!important;/);
  assert.match(styles, /\.detailed-run-shell \.detailed-trace-card::before,[\s\S]*background:\s*#a59b7c\s*!important;/);
  assert.match(styles, /\.detailed-thinking-lane,[\s\S]*box-shadow:\s*inset 3px 0 0 #a59b7c\s*!important/s);
  assert.match(styles, /\.detailed-final-answer\s*\{[^}]*border:\s*0/s);
});

test("a részletes nézet keretet zár: a vonalak nem halnak el, hanem végigfutnak", () => {
  assert.match(
    styles,
    /\.detailed-run-shell \.detailed-trace-card\s*\{[^}]*border:\s*0\s*!important/s,
  );
  // A keret vonala a felénél leesik arra az erősségre, ahol még éppen látszik,
  // és azzal fut a végéig — nem `transparent`-be, különben a keret nyitva marad.
  assert.match(
    styles,
    /--detailed-fade-line:\s*linear-gradient\(90deg, #a59b7c 0%[^;]*rgba\(165, 155, 124, \.2\) 100%\);/,
  );
  // A panelen belüli, rövid elválasztóknak viszont maradt az elhaló változat:
  // 20%-on megállva a végük levágott vonalnak látszana.
  assert.match(
    styles,
    /--detailed-inner-fade-line:\s*linear-gradient\(90deg, #a59b7c 0%[^;]*transparent 100%\);/,
  );
  assert.match(
    styles,
    /\.detailed-step-changes::before\s*\{[^}]*background:\s*var\(--detailed-inner-fade-line\)/s,
  );
  assert.match(
    styles,
    /--detailed-answer-rule-width:\s*min\(100%, max\(0px, calc\(var\(--detailed-prompt-width, 720px\) - var\(--detailed-steps-track\)\)\)\)/,
  );
  assert.match(app, /\.user-message \.message-body/);
  assert.match(app, /prompt\.getBoundingClientRect\(\)\.right - shell\.getBoundingClientRect\(\)\.left/);
  assert.match(app, /"--detailed-prompt-width": detailedPromptWidth/);
  assert.match(
    styles,
    /\.detailed-thinking-lane,[\s\S]*box-shadow:\s*inset 3px 0 0 #a59b7c !important/,
  );
  assert.match(
    styles,
    /\.detailed-steps-lane\s*\{[^}]*background-position:\s*left top, left bottom;[^}]*background-size:\s*100% 1px, 100% 1px/s,
  );
  assert.match(
    styles,
    /\.detailed-trace-grid::before\s*\{[^}]*top:\s*0;[^}]*height:\s*28px;[^}]*linear-gradient\(180deg, #000 0%, rgba\(0, 0, 0, \.9\) 34%, transparent 100%\);[^}]*background-size:\s*100% 1px, 3px 100%, 100% 100%/s,
  );
  assert.match(
    styles,
    /\.detailed-trace-grid::after\s*\{[^}]*bottom:\s*0;[^}]*height:\s*28px;[^}]*linear-gradient\(0deg, #000 0%, rgba\(0, 0, 0, \.9\) 34%, transparent 100%\);[^}]*background-size:\s*100% 1px, 3px 100%, 100% 100%/s,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane,[\s\S]*padding:\s*28px 7px 28px 8px/,
  );
  assert.match(
    styles,
    /\.detailed-step-list\s*\{[^}]*margin-bottom:\s*10px/s,
  );
  assert.match(
    styles,
    /\.detailed-step-changes::before\s*\{[^}]*background:\s*var\(--detailed-inner-fade-line\)/s,
  );
  assert.match(
    styles,
    /\.detailed-step-changes \.trace-change-summary\s*\{[^}]*border:\s*0[^}]*background:\s*#000/s,
  );
  assert.match(
    styles,
    /\.detailed-step-changes \.trace-change-heading\s*\{[^}]*border-bottom:\s*0/s,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane \.answer-code-block,[\s\S]*position:\s*relative;[\s\S]*overflow:\s*visible;[\s\S]*border:\s*0;[\s\S]*border-radius:\s*0;[\s\S]*background-color:\s*#000;[\s\S]*box-shadow:\s*none;/,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane \.answer-code-block::before,[\s\S]*left:\s*-11px;[\s\S]*width:\s*var\(--detailed-answer-rule-width\);[\s\S]*background:\s*var\(--detailed-code-fade-line\)/,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane \.answer-code-block \.code-header,[\s\S]*border-bottom:\s*0;[\s\S]*background:\s*transparent;/,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane \.answer-heading-1,[\s\S]*border-bottom:\s*0/,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane \.trace-answer-text > p,[\s\S]*max-width:\s*min\(100%, 1000px\)/,
  );
  assert.match(
    styles,
    /\.detailed-answer-toolbar\s*\{[^}]*top:\s*7px;[^}]*right:\s*7px;[^}]*left:\s*auto;[^}]*transform:\s*none/s,
  );
  assert.doesNotMatch(
    app,
    /className="detailed-final-answer-toolbar"/,
  );
  assert.match(
    styles,
    /\.detailed-thinking-list \.compact-technical-heading\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*calc\(100% - 34px\)/s,
  );
  assert.doesNotMatch(app, /aria-label=\{copiedAnswer/);
});

test("a részletes lépések kompakt számozott timeline-on és fade szeparátorokkal jelennek meg", () => {
  assert.match(styles, /\.detailed-step-list\s*\{[^}]*gap:\s*1px/s);
  assert.match(styles, /\.trace-step-target \+ \.trace-step-target::before\s*\{[^}]*height:\s*1px;[^}]*linear-gradient/s);
  assert.match(app, /className="detailed-step-index">\{stepIndex \+ 1\}<\/span>/);
  assert.match(app, /data-step-number=\{stepIndex \+ 1\}/);
  assert.match(styles, /\.detailed-step-list \.trace-step-marker\s*\{[^}]*width:\s*21px;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*border-radius:\s*50%/s);
  assert.match(styles, /\.detailed-step-list \.detailed-step-index\s*\{[^}]*color:\s*#a59b7c;[^}]*font-size:\s*9px;[^}]*text-align:\s*center/s);
  assert.match(styles, /\.detailed-step-list \.trace-step-row\.is-selected \.trace-step-marker,[\s\S]*background:\s*#a59b7c;[\s\S]*color:\s*#050607/);
  assert.match(styles, /\.detailed-step-list \.trace-step-row,[\s\S]*background:\s*transparent !important/);
  assert.match(app, /className="detailed-step-changes"/);
  assert.match(app, /className="trace-total-elapsed detailed-steps-total"/);
  assert.doesNotMatch(app, /completedStepCount/);
  assert.doesNotMatch(app, /detailed-steps-summary/);
  assert.doesNotMatch(app, /className="detailed-inline-changes"/);
});

test("a user D ikon is kör alakú", () => {
  assert.match(styles, /\.user-avatar\s*\{[^}]*border:\s*1px solid #77745f;[^}]*border-radius:\s*50%/s);
});

test("a technikai részleteket csak a felirat nyitja és nincs mellette nyíl", () => {
  assert.match(app, /className="compact-technical-heading"/);
  assert.match(
    app,
    /className="compact-technical-heading"[\s\S]*?className="trace-thinking-bullet"[\s\S]*?<button[\s\S]*?className="compact-technical-toggle"[\s\S]*?className="compact-technical-label"/,
  );
  assert.doesNotMatch(
    app,
    /className="compact-technical-label"[^<]*<\/span>\s*<span className="trace-internal-caret"/,
  );
  assert.match(
    styles,
    /\.compact-technical-toggle\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%/s,
  );
});

test("a verdikt konklúziója a REVIEW utolsó lépése alatt marad", () => {
  assert.match(app, /\{isReviewStage && runFooter\}/);
  assert.doesNotMatch(app, /A bíráló elfogadta/);
  assert.match(styles, /\.detailed-step-list > \.pipeline-answer-next\s*\{[^}]*border:\s*0/s);
});

test("a KÓD a pipeline eseményben kapott tervet használja a tárolási verseny előtt", () => {
  assert.match(app, /progress\.planText \?\?[\s\S]*chainRun\.planText \?\?/);
  assert.match(app, /planText\?: string \| null/);
});

test("a user bubble normál betűsúlyt használ", () => {
  assert.match(
    styles,
    /\.user-message \.message-body,[\s\S]*\.user-message \.message-body strong\s*\{\s*font-weight:\s*400\s*!important;/,
  );
});

test("a lezárt pipeline csak mért időt mutat, a reviewer javításkérése pedig FAIL", () => {
  assert.match(app, /overallElapsed \|\| \(streaming \? "0:00" : "—"\)/);
  assert.match(app, /verdict === "changes_requested" \|\| verdict === "changes"/);
  assert.match(app, /progress\.phase === "finished"[\s\S]*\? "completed"/);
  assert.match(app, /stageStartedAt: receivedStageTiming\?\.startedAt/);
  assert.match(app, /stageCompletedAt: receivedStageTiming\?\.completedAt/);
});

test("a Részletes composer három vezérlősora nem nyúlik a textarea magasságával", () => {
  assert.match(
    styles,
    /\.composer-shell > \.composer-controls\s*\{[^}]*top:\s*auto;[^}]*bottom:\s*0;[^}]*height:\s*var\(--composer-control-height\)/s,
  );
  assert.match(
    styles,
    /--composer-control-height:\s*calc\(3 \* var\(--composer-control-row-height\)\)/,
  );
  assert.match(
    styles,
    /\.composer-stage-grid\s*\{[^}]*grid-template-rows:\s*repeat\(3, var\(--composer-control-row-height\)\)[^}]*height:\s*100%/s,
  );
});

test("a kevés lépéses VÁLASZ tartalom szerint nő, majd 320 px-nél görget", () => {
  assert.match(app, /const measureDetailedAnswerHeight = \(\) =>/);
  assert.match(app, /detailedAnswerPanelHeight\([\s\S]*content\.scrollHeight/);
  assert.match(app, /observer\.observe\(content\)/);
  assert.match(app, /ref=\{detailedGridRef\}/);
  assert.match(
    styles,
    /min-height:\s*var\(--detailed-answer-height, 140px\)/,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane,[\s\S]*height:\s*100%;[\s\S]*overflow-y:\s*auto;[\s\S]*max-height:\s*var\(--detailed-answer-max-height, 320px\)/,
  );
});

test("a megszakított pipeline a még el nem indult fázisokat is megőrzi", () => {
  assert.match(app, /const expectedStageCount = Math\.max/);
  assert.match(app, /const runStageTabs = chainSlots\.map/);
  assert.match(app, /disabled=\{item\.pending\}/);
  assert.match(app, /item\.pending \? " is-future"/);
});
