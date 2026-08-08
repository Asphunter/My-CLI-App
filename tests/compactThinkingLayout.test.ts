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

test("a részletes mód három hasábban mutatja a lépéseket, a tartalmat és a fájlokat", () => {
  assert.match(app, /detailed-trace-grid/);
  assert.doesNotMatch(app, /className="detailed-trace-lane detailed-answer-lane"/);
  assert.match(app, /detailed-steps-lane/);
  assert.match(app, /detailed-thinking-lane/);
  assert.match(app, /detailed-files-lane/);
  assert.match(
    styles,
    /--detailed-answer-track: max\(260px, min\(var\(--compact-answer-width[\s\S]*--detailed-steps-track: calc\(100% - var\(--detailed-answer-track\)\)[\s\S]*grid-template-columns:[\s\S]*minmax\(0, 1fr\)[\s\S]*calc\(var\(--detailed-steps-track\) - var\(--files-lane-track\)\)[\s\S]*var\(--files-lane-track\)/,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane,[\s\S]*\.detailed-plan-lane \{[\s\S]*position: absolute;[\s\S]*right: var\(--detailed-steps-track\);[\s\S]*bottom: auto;[\s\S]*left: 0;[\s\S]*height: 100%;[\s\S]*overflow-y: auto/,
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
  // Bézs panelen a bézs karika és az áttetsző kiemelés eltűnt: a jelölés tinta.
  assert.match(styles, /\.detailed-plan-step\.is-highlighted\s*\{[^}]*border:\s*0;[^}]*background:\s*rgba\(0, 0, 0, \.14\)/s);
  assert.match(styles, /\.detailed-plan-step-number\s*\{[^}]*width:\s*21px;[^}]*height:\s*21px;[^}]*place-items:\s*center/s);
  assert.match(styles, /\.detailed-plan-step-index\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*place-items:\s*center/s);
  assert.match(styles, /\.detailed-plan-step\.is-highlighted \.detailed-plan-step-number\s*\{[^}]*place-items:\s*center;[^}]*border-radius:\s*50%;[^}]*background:\s*#12120e;[^}]*color:\s*#e8e2cd/s);
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

test("a verziócímke a kiválasztott fázis nyilához tapad, és kattintásra vált", () => {
  // Se natív <select> (a 21 px-es sínbe nem fér), se fel/le nyíl, se görgetés:
  // egyszerű kattintás vált, a címke pedig a ▶ nyíl mellett ül.
  assert.doesNotMatch(app, /<select\s+aria-label="Verzió választása"/);
  assert.doesNotMatch(styles, /\.pipeline-run-version select/);
  assert.doesNotMatch(app, /pipeline-run-version-step/);
  assert.doesNotMatch(styles, /\.pipeline-run-version-step/);
  assert.doesNotMatch(app, /onWheel=\{\(event\) => stepVersion/);
  assert.match(app, /className="pipeline-run-version-value"/);
  assert.match(app, /title="Kattintás: verzióváltás"/);
  assert.match(styles, /\.pipeline-run-version\s*\{[^}]*cursor:\s*pointer/s);
  // A sorpozíciót az aktív fázis indexe adja (21 px ikon + 9 px rés), tehát a
  // címke a nyíllal együtt mozog; a vízszintes hely közvetlenül a nyíl mellett.
  assert.match(app, /const activeTabIndex = Math\.max\(/);
  assert.match(app, /runStageTabs\.findIndex\(\(item\) => item\.stageIndex === selectedStage\)/);
  assert.match(app, /"--active-tab-index": activeTabIndex/);
  assert.match(
    styles,
    /\.detailed-run-shell \.pipeline-run-version\s*\{[^}]*top:\s*calc\(var\(--active-tab-index, 0\) \* 30px\);[^}]*right:\s*calc\(100% \+ 7px\)/s,
  );
  assert.doesNotMatch(
    styles,
    /\.detailed-run-shell \.pipeline-run-version\s*\{[^}]*left:\s*26px/s,
  );
});

test("a lezárt futás kiválasztott fázisát bal oldali, jobbra mutató nyíl jelöli", () => {
  assert.match(app, /className="pipeline-run-header is-history"/);
  assert.match(app, /className="pipeline-run-header is-live"/);
  assert.match(
    styles,
    /\.pipeline-run-header\.is-history \.pipeline-run-tab\.is-active::before\s*\{[^}]*right:\s*calc\(100% \+ 1px\)[^}]*border-left:\s*5px solid #d7ceaf/s,
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
  // A válasz bal éle fekete: a panel maga lett bézs, bézs élt nem lehetne látni.
  assert.match(styles, /\.compact-answer-card::before,[\s\S]*width:\s*3px;[\s\S]*background:\s*#000\s*!important;/);
  assert.match(styles, /\.detailed-run-shell \.detailed-trace-card::before,[\s\S]*background:\s*#000\s*!important;/);
  assert.match(styles, /\.detailed-thinking-lane,[\s\S]*box-shadow:\s*inset 3px 0 0 #000\s*!important/s);
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
  // A fájl-hasáb a keret halk oldalán él: a felső-alsó élét és a lépések
  // felőli határvonalát is a fade-tail rajzolja, nem egy második khaki vonal.
  assert.match(
    styles,
    /\.detailed-files-lane\s*\{[^}]*grid-column:\s*3;[^}]*background-color:\s*#000;[^}]*background-size:\s*100% 1px, 100% 1px/s,
  );
  assert.match(
    styles,
    /\.detailed-files-lane::before\s*\{[^}]*width:\s*1px;[^}]*background:\s*var\(--detailed-fade-tail\)/s,
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
    /\.detailed-thinking-lane,[\s\S]*box-shadow:\s*inset 3px 0 0 #000 !important/,
  );
  assert.match(
    styles,
    /\.detailed-steps-lane\s*\{[^}]*grid-column:\s*2;[^}]*background-color:\s*#000[^}]*background-size:\s*100% 1px, 100% 1px/s,
  );
  // A guard 28-ról 10 px-re fogyott: két-három üres sornyi rés volt a válasz
  // elején és végén, és a lecsengő sávnak ennyi nem kell.
  assert.match(
    styles,
    /\.detailed-trace-grid::before\s*\{[^}]*top:\s*0;[^}]*height:\s*10px;[^}]*linear-gradient\(180deg, var\(--answer-surface\) 0%, var\(--answer-surface\) 34%, transparent 100%\);[^}]*background-size:\s*100% 1px, 0 0, 100% 100%/s,
  );
  assert.match(
    styles,
    /\.detailed-trace-grid::after\s*\{[^}]*bottom:\s*0;[^}]*height:\s*10px;[^}]*linear-gradient\(0deg, var\(--answer-surface\) 0%, var\(--answer-surface\) 34%, transparent 100%\);[^}]*background-size:\s*100% 1px, 0 0, 100% 100%/s,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane,[\s\S]*padding:\s*10px 8px 10px 7px/,
  );
  assert.match(
    styles,
    /\.detailed-step-list\s*\{[^}]*margin-bottom:\s*10px/s,
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
    /\.detailed-answer-toolbar\s*\{[^}]*top:\s*7px;[^}]*left:\s*auto;[^}]*transform:\s*none/s,
  );
  assert.match(
    styles,
    /\.detailed-answer-toolbar\s*\{[^}]*z-index:\s*6;[^}]*right:\s*calc\(var\(--detailed-steps-track\) \+ 9px\)/s,
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

test("a VÁLASZ tartalom szerint nő 320-ig, de a magasabb szomszédokat kitölti", () => {
  assert.match(app, /const measureDetailedAnswerHeight = \(\) =>/);
  assert.match(app, /detailedAnswerPanelHeight\([\s\S]*content\.scrollHeight/);
  assert.match(app, /observer\.observe\(content\)/);
  assert.match(app, /ref=\{detailedGridRef\}/);
  // A 320 a rács min-height-jét vezérli: ennyit kérhet a válasz *egyedül*.
  // Kézi magasságnál viszont a húzott érték a padló is, különben a rács a
  // tartalomnál nem lett alacsonyabb, a sáv meg igen — és a kettő különbsége
  // fekete résként nyílt ki a válasz alja és a rács alsó őrsávja között.
  assert.match(
    styles,
    /min-height:\s*var\(--detailed-card-height, var\(--detailed-answer-height, 140px\)\)/,
  );
  assert.match(
    styles,
    /\.detailed-thinking-lane,[\s\S]*height:\s*100%;[\s\S]*overflow-y:\s*auto/,
  );
  // A sávnak nincs saját plafonja: a sor magasságát viszi, és abban görget.
  assert.match(
    styles,
    /\.detailed-thinking-lane,[\s\S]*max-height:\s*none;/,
  );
  assert.doesNotMatch(styles, /--detailed-answer-max-height/);
  assert.doesNotMatch(app, /--detailed-answer-max-height/);
});

test("a fájlok mindkét módban saját, teljes magasságú harmadik hasábot kapnak", () => {
  // Jóváhagyott arányok a kártya teljes szélességén: VÁLASZ 50%, a lépés/
  // gondolkodás hasáb a maradék 3/4-e, a fájl-sáv a maradék — 240px padlóval.
  // Fájlok nélkül a sáv 0px, és minden képlet a kéthasábos alakra esik vissza.
  assert.match(
    styles,
    /\.compact-answer-card,\s*\.detailed-trace-grid\s*\{\s*--files-lane-track:\s*0px;\s*\}/,
  );
  assert.match(
    styles,
    /\.compact-answer-card\.has-file-lane,\s*\.detailed-trace-grid\.has-file-lane\s*\{\s*--files-lane-track:\s*max\(240px, 12\.5%\);\s*\}/,
  );
  // A válasz alapszélessége a húzóka maximuma: a `100%` fallback mellett a
  // `min()` mindig a plafont (`100% - 240px - fájlsáv`) választja, amíg a
  // felhasználó nem húz saját értéket.
  assert.match(styles, /--compact-answer-width, 100%/);
  assert.match(app, /displayedChangeSummary\.length > 0 \? " has-file-lane" : ""/);
  assert.match(component, /\$\{changes \? " has-file-lane" : ""\}/);
  // A fejléc+5 soros korlát és a lenyitó gomb kikerült: minden fájl kifér,
  // görgetés csak a hasáb plafonja felett (~20+ fájl) jön elő.
  assert.doesNotMatch(app, /CHANGE_SUMMARY_COLLAPSED_ROWS/);
  assert.doesNotMatch(app, /trace-change-expand/);
  assert.doesNotMatch(styles, /\.trace-change-expand/);
  // A darabszám-korlát helyét churn-alapú csoport vette át: az érdemi sorok
  // mindig látszanak, csak a nulla-változásúak csuklanak össze.
  assert.match(app, /className="trace-change-untouched-toggle"/);
  assert.match(app, /fájl változás nélkül/);
  assert.match(app, /\{view\.changed\.map\(renderRow\)\}/);
  assert.match(styles, /\.trace-change-untouched-toggle\s*\{/);
  // A −0 és a státusz oszlop csak akkor épül fel, ha megkülönböztet.
  assert.match(app, /\{view\.showRemoved && \(/);
  assert.match(app, /view\.showStatus \? statusLabel\(file\.status\) : null/);
  assert.match(
    styles,
    /\.trace-change-list li\.has-status\.has-removed\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto auto/s,
  );
  assert.match(
    styles,
    /\.detailed-step-changes \.trace-change-list\s*\{[^}]*overflow-y:\s*auto/s,
  );
  assert.match(
    styles,
    /\.compact-files-panel \.trace-change-list\s*\{[^}]*overflow-y:\s*auto/s,
  );
  // Nem-Részletes: a fájlpanel már nem a válasz aljához kötött abszolút réteg,
  // hanem rács-hasáb (a c797e2d-nél eltört top-kötés végleg megszűnt).
  assert.match(component, /className="compact-files-panel"/);
  assert.doesNotMatch(styles, /\.compact-answer-change-slot/);
  assert.doesNotMatch(
    styles,
    /\.compact-files-panel\s*\{[^}]*top:\s*var\(--compact-answer-height/s,
  );
  // Összecsukott középső hasáb mellett a fájl-hasáb megmarad.
  assert.match(
    styles,
    /\.compact-answers-layout\.is-thinking-collapsed\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) var\(--files-lane-track\)/s,
  );
  assert.match(
    styles,
    /\.detailed-trace-grid\.is-steps-collapsed\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) var\(--files-lane-track\)/s,
  );
  assert.match(
    styles,
    /\.detailed-trace-grid\.is-steps-collapsed \.detailed-files-lane\s*\{\s*grid-column:\s*2;\s*\}/,
  );
});

test("keskeny ablakon a fájl-hasáb csíkká csuklik, nem a válasz fogy", () => {
  // 1100 px-en a válasz 295 px-re szorult; az engedményt a fájloknak kell
  // megtenniük. A `--files-lane-track` cseréjével minden szélesség-képlet
  // (rács, csukott kártya, elválasztók, átméretező-plafonok) magától követi.
  assert.match(
    styles,
    /@media \(max-width: 1250px\) \{[\s\S]*?--files-lane-track:\s*28px/,
  );
  assert.match(app, /className="files-lane-strip"/);
  assert.match(app, /className=\{`\$\{className\} files-lane-body\$\{open \? " is-open" : ""\}`\}/);
  assert.match(app, /<FilesLane\s+className="compact-answer-changes"/);
  assert.match(app, /<FilesLane\s+className="detailed-step-changes"/);
  // Az overlay a hasábból lóg ki — ha a sáv vágna, a „felfelé fülek" hibája
  // ismétlődne meg.
  assert.match(
    styles,
    /@media \(max-width: 1250px\) \{[\s\S]*?\.detailed-files-lane,\s*\.compact-files-panel \{\s*overflow: visible/,
  );
  assert.match(
    styles,
    /\.files-lane-body \{[\s\S]*?position: absolute;[\s\S]*?z-index: 9;[\s\S]*?right: 0;/,
  );
  // Esc és kívülre kattintás zárja.
  assert.match(app, /event\.key === "Escape"\) setOpen\(false\)/);
  assert.match(app, /document\.addEventListener\("pointerdown", closeOnOutside, true\)/);
  // 680 px alatt a rács blokkokra esik: ott nincs csík, a panel végigfolyik.
  assert.match(
    styles,
    /@media \(max-width: 680px\) \{[\s\S]*?--files-lane-track:\s*0px;[\s\S]*?\.files-lane-strip \{ display: none; \}/,
  );
});

test("a kártya magasságát a VÁLASZ vagy a LÉPÉSEK szabja meg, a fájlok nem", () => {
  // Egy 45 fájlos lista korábban magasra húzta a kártyát, és a rövid válasz
  // alatt üres feketét hagyott. A fájl-hasáb tartalma ezért abszolút: a sáv
  // nem visz saját belmagasságot a rács sorába.
  assert.match(
    styles,
    /\.files-lane \{[\s\S]*?position: absolute;[\s\S]*?inset: 0;/,
  );
  assert.match(
    styles,
    /\.detailed-files-lane \{[\s\S]*?min-height: 0;/,
  );
  // A kompakt oldalon ugyanez: a mért padló a válasz, nem a fájlok.
  assert.match(component, /const columnsFloorHeight = Math\.ceil\(answerHeight\);/);
  assert.match(component, /const displayedContentFloor = panelHeights\?\.answer;/);
  assert.doesNotMatch(component, /panelHeights\?\.changes/);
});

test("a reload és a lépés-kapcsoló a szöveg felett lebeg, nem tolja el a sorokat", () => {
  // A jobb oldali 48 / 34 / 84 px-es fenntartások miatt a válasz sorai
  // három-négy szónyival a panel széle előtt megálltak; a terv-hasábban a
  // 58 px-es padding hagyott egy még nagyobb, teljes magasságú fekete sávot.
  assert.doesNotMatch(styles, /padding-right:\s*84px/);
  assert.doesNotMatch(styles, /padding-right:\s*34px/);
  assert.doesNotMatch(styles, /padding:\s*2px 58px/);
  assert.match(styles, /\.detailed-plan-content \{[^}]*padding: 2px 0 10px 3px/s);
  assert.match(
    styles,
    /\.detailed-final-answer \{[\s\S]*?padding: 10px 0 4px 0;/,
  );
  // A gombok saját, magasabb rétegen ülnek, tömör háttérrel.
  assert.match(
    styles,
    /\.detailed-answer-toolbar \{[\s\S]*?z-index: 6;/,
  );
  assert.match(
    styles,
    /\.compact-answer-action-row \{[^}]*z-index:\s*7;[^}]*background:\s*linear-gradient/s,
  );
});

test("a Részletes kártyán ugyanaz a két húzóka van, mint a Nem-Részletesen", () => {
  // Oszlop-húzóka a VÁLASZ és a LÉPÉSEK határán, magasság-húzóka az alsó
  // keretvonalon — a kompakt kártya párja.
  assert.match(app, /className="detailed-column-resizer"/);
  assert.match(app, /className="detailed-height-resizer"/);
  assert.match(app, /startDetailedResize\("columns", event\)/);
  assert.match(app, /startDetailedResize\("height", event\)/);
  assert.match(app, /aria-orientation="vertical"[\s\S]*?onPointerDown=\{\(event\) => startDetailedResize\("columns"/);
  // A szélesség a közös változón megy, tehát a két mód egymásra illeszkedik.
  assert.match(app, /"--compact-answer-width": `\$\{detailedAnswerWidth\}px`/);
  assert.match(app, /"--detailed-card-height": `\$\{detailedCardHeight\}px`/);
  assert.match(app, /"--detailed-lane-cap": `\$\{detailedCardHeight\}px`/);
  assert.match(
    styles,
    /\.detailed-column-resizer \{[\s\S]*?left: var\(--detailed-answer-track\);[\s\S]*?cursor: col-resize;/,
  );
  assert.match(
    styles,
    /\.detailed-height-resizer \{[\s\S]*?bottom: -5px;[\s\S]*?cursor: row-resize;/,
  );
  // Húzott magasságnál a sávok plafonja is a húzott érték, különben a rács
  // kinyílna, de a sávok 420-nál megállnának.
  assert.match(
    styles,
    /\.detailed-trace-lane \{[^}]*max-height: var\(--detailed-lane-cap, min\(420px, calc\(100vh - 210px\)\)\)/s,
  );
  assert.match(styles, /height: var\(--detailed-card-height, auto\)/);
  // Becsukott lépés-oszlopnál nincs mit húzni a két hasáb között.
  assert.match(app, /\{!stepsCollapsed && \(\s*<div\s+className="detailed-column-resizer"/);
});

test("a VÁLASZ kapja a saját felületet, a többi hasáb fekete", () => {
  // A válasz önálló lapként olvasható a körülötte fekete LÉPÉSEK /
  // GONDOLKODÁS MENETE és FÁJLOK hasábok között.
  assert.match(styles, /--answer-surface:\s*#a59b7c/);
  assert.match(
    styles,
    /\.detailed-thinking-lane,[\s\S]*?background-color:\s*var\(--answer-surface\)/,
  );
  assert.match(
    styles,
    /\.detailed-final-answer \{[^}]*background:\s*var\(--answer-surface\)/s,
  );
  assert.match(styles, /\.compact-answers-panel \{ background: var\(--answer-surface\) !important; \}/);
  // A lépés-sáv és a kompakt rács viszont fekete lett.
  assert.match(
    styles,
    /\.detailed-steps-lane \{[^}]*background-color:\s*#000/s,
  );
  assert.match(
    styles,
    /\.compact-answers-layout \{[\s\S]*?background-color:\s*#000 !important/,
  );
  assert.match(
    styles,
    /\.compact-thinking-panel:not\(\.is-collapsed\) \{[^}]*background:\s*#000/s,
  );
  // A válaszon ülő átmenetek (guard-sávok, gomb-háttér) is a felületet követik,
  // különben fekete csík maradna a panel tetején és alján.
  assert.match(
    styles,
    /linear-gradient\(180deg, var\(--answer-surface\) 0%, var\(--answer-surface\) 34%, transparent 100%\)/,
  );
  assert.match(
    styles,
    /linear-gradient\(0deg, var\(--answer-surface\) 0%, var\(--answer-surface\) 34%, transparent 100%\)/,
  );
  assert.doesNotMatch(styles, /linear-gradient\(90deg, transparent, #000 2[24]%\)/);
});

test("a válasz alatti maradékot vonal zárja, nem sraffozott felület", () => {
  // A kitöltött, átlós minta renderelési hibának olvasódott. A vonal színe
  // viszont jelentést hordoz: bézs = lezárult, borostyán = megszakítva.
  assert.doesNotMatch(
    styles,
    /\.compact-answers-panel::after\s*\{[^}]*repeating-linear-gradient/s,
  );
  assert.match(
    styles,
    /\.compact-answers-panel::after\s*\{[^}]*background:\s*var\(--answer-surface\);[^}]*border-top:\s*1px solid var\(--detailed-fade-tail/s,
  );
  assert.match(
    styles,
    /\.compact-answer-card\.is-interrupted \.compact-answers-panel::after\s*\{\s*border-top-color:\s*rgba\(215, 163, 109/,
  );
});

test("a LIVE KÓD panel csak írás közben él, nem ül a stream aljára", () => {
  // Korábban külön ág rakta ki a stream legvégére, ha a futás már véget ért —
  // így egy sokkal korábbi válaszhoz tartozó panel a beszélgetés legalján ült.
  assert.doesNotMatch(
    app,
    /!liveTurnContent &&\s*viewedLiveFiles\.files\.length > 0 &&\s*liveCodePanel/,
  );
  assert.match(app, /\{liveCodePanel\}/);
});

test("a technikai csoport azonosítója nem változik minden új sorral", () => {
  // Az id-ban benne volt az utolsó elem is, ezért streamelés közben minden új
  // technikai sorral megváltozott — a kinyitott csoport így „becsukódott".
  const timeline = readFileSync(
    new URL("../src/compactAnswerTimeline.ts", import.meta.url),
    "utf8",
  );
  assert.match(timeline, /id: `technical:\$\{items\[0\]\.id\}`/);
  assert.doesNotMatch(timeline, /technical:\$\{items\[0\]\.id\}:\$\{items\.at\(-1\)/);
});

test("futás közben a technikai csoport nyílik, narratív elemre csukódik", () => {
  for (const source of [app, component]) {
    assert.match(
      source,
      /if \(!streaming \|\| technicalAutoPaused\) return;[\s\S]{0,200}?last\.kind === "technical" \? last\.id : null/,
    );
  }
});

test("a kézzel becsukott technikai csoport nem nyílik vissza futás közben", () => {
  // Minden új technikai sor újrafuttatta az automatikát, így a becsukás
  // azonnal visszaugrott. Az első kézi kattintás után az automatika hallgat,
  // és csak a következő válasznál indul újra.
  for (const source of [app, component]) {
    assert.match(source, /setTechnicalAutoPaused\(true\);/);
    assert.match(source, /technicalAutoPaused\]/);
  }
  assert.match(component, /setTechnicalAutoPaused\(false\);/);
});

test("csak a DeepSeek menet közbeni sorai kapnak külön bulletet, a lezárt válasz prózája nem", () => {
  // A többi szolgáltató maga ír listát; ott a sor-bullet dupla felsorolás lenne.
  assert.match(
    app,
    /streaming && provider === "deepseek" \? \(\s*<ul className="compact-answer-stream">/,
  );
  assert.match(app, /liveNarrationLines\(block\.text\)/);
  assert.match(styles, /\.compact-answer-stream \{[^}]*list-style: none/s);
  // A lezárt válasz továbbra is a rendes bekezdés-renderelőt kapja.
  assert.match(
    app,
    /\) : \(\s*<div className="compact-answer-text">\s*\{answerParagraphs\(\s*block\.text,/,
  );
});

test("a panelek csak akkor jelennek meg, ha van mit mutatniuk", () => {
  assert.match(app, /const liveTurnHasContent =/);
  assert.match(app, /Boolean\(liveAnswer\?\.text\?\.trim\(\)\)/);
  // Csak szöveg számít tartalomnak. A szintetikus előkészítő lépés miatt a
  // lépéslista azonnal nem üres, az aktivitások pedig élőben mérve már 300
  // ms-nál befutnak — mindkettő üres, pörgő kártyát nyitna ki.
  assert.doesNotMatch(
    app,
    /const liveTurnHasContent =[\s\S]{0,240}?activePlan\.steps\.length > 0/,
  );
  assert.doesNotMatch(
    app,
    /const liveTurnHasContent =[\s\S]{0,240}?liveStageActivities\.length > 0/,
  );
  assert.match(app, /liveStageCommentary\.some\(\(entry\) => entry\.body\?\.trim\(\)\)/);
  // Amíg nincs tartalom, csak a fázissín renderel — kártya nélkül. Egyágenses
  // futásnál viszont nincs sín, ott a rejtés semmit nem mutatna.
  assert.match(
    app,
    /\{pipelineProgress && !liveTurnHasContent && !liveFinishedStagePanel \? \(\s*liveRunHeader/,
  );
  // Fázisváltáskor a mutatott szakasz csak akkor lép, ha az újnak van tartalma.
  assert.match(app, /const \[liveRevealedStage, setLiveRevealedStage\]/);
  assert.match(app, /if \(!liveTurnHasContent\) return;/);
  assert.match(
    app,
    /liveStageChoice \?\? liveRevealedStage \?\? pipelineProgress\.stageIndex/,
  );
});

test("a megszakított pipeline a még el nem indult fázisokat is megőrzi", () => {
  assert.match(app, /const expectedStageCount = Math\.max/);
  assert.match(app, /const runStageTabs = chainSlots\.map/);
  assert.match(app, /disabled=\{item\.pending\}/);
  assert.match(app, /item\.pending \? " is-future"/);
});
