# Claude LÉPÉSEK-követés — diagnosztika és javítási terv

## 1. Cél és hatókör

A Részletes Multi-AI lánc TERV → KÓD → REVIEW nézetében a Claude futásának
lépéskijelölése legyen ugyanolyan stabil és igazmondó, mint a ChatGPT-é:

- a KÓD ne mutassa automatikusan az első tervpontot aktívnak, mielőtt erről
  modell-esemény érkezett;
- egy tool-hívás ahhoz a lépéshez kerüljön, amely alatt valóban történt;
- két Claude task-státuszfrissítés között a kijelölés ne ugorjon előre vagy
  vissza találgatás miatt;
- a REVIEW saját 3–5 pontos listája ugyanilyen szabályok szerint működjön;
- a TERV szövegéből képzett fő lépések sorrendje és azonosítója ne változzon
  attól, hogy Claude a saját taskjait egyenként hozza létre.

Ez a dokumentum diagnosztika és megvalósítási terv. A létrehozásakor
forráskód-módosítás nem történt.

## 2. Jelenlegi adatfolyam

### 2.1 ChatGPT

1. A Codex app-server natív `turn/plan/updated` eseményt küld.
2. Az esemény egyszerre tartalmazza a teljes listát, a lépések azonosítóját és
   státuszát.
3. A frontend `normalizePlanSnapshot` után közvetlenül frissíti a futás
   `PlanSnapshot` állapotát.
4. A következő reasoning/tool esemény az aktuális `inProgress` lépéshez kerül.

Ez az út teljes listás, ezért a kliensnek nem kell több tool-hívásból
visszaépítenie a pillanatképet.

### 2.2 Claude

1. A Claude Agent SDK az új natív buildben `TaskCreate` / `TaskUpdate` párral
   kezeli a checklistet; a régi `TodoWrite` továbbra is támogatott tartalék.
2. A bridge a `TaskCreate` hívásokat egy `turn.tasks` Mapben gyűjti.
3. A `TaskCreate` eredményében kapott task-ID-t a `turn.taskKeyById` kapcsolja
   vissza a tool-use azonosítóhoz.
4. Minden `TaskCreate` és `TaskUpdate` után a bridge saját
   `turn/plan/updated` eseményt állít elő.
5. A KÓD indulásakor a frontend már előre betölti a TERV számozott pontjait
   `carried-plan-*` azonosítókkal.
6. A Claude által létrehozott taskokat a frontend szöveges hasonlósággal
   próbálja ráilleszteni ezekre a hordozott pontokra.

Érintett helyek:

- `agent-bridge/policy.mjs`: `PLAN_TOOLS`, `planFromTasks`;
- `agent-bridge/main.mjs`: `planFromChecklistCall`, `emitToolStarted`,
  `emitToolCompleted`;
- `src/App.tsx`: pipeline stage indítása, `turn/plan/updated` feldolgozása,
  tool-esemény → `planStepId` hozzárendelés, `TurnProgressCard.activeStep`.

## 3. Meglévő szabályok és konfiguráció

### 3.1 Pipeline-prompt

`src-tauri/src/pipeline.rs`, `StageRole::instruction` már előírja:

- KÓD előtt a modell vegye fel a TERV számozott pontjait todo-listaként;
- a taskok szövege szó szerint a tervpont címe legyen;
- mindig az aktuális lépés legyen folyamatban;
- a befejezett lépést jelölje késznek;
- REVIEW alatt legyen külön 3–5 pontos checklist, és azt munka közben tartsa
  karban.

A hiba tehát nem abból ered, hogy a Claude semmilyen erre vonatkozó utasítást
nem kap.

### 3.2 Claude settings és projektutasítások

A bridge az SDK-t `settingSources: []` értékkel indítja. Emiatt sem a globális
`~/.claude/settings.json`, sem a projekt `.claude/settings.local.json` fájlja
nem vezérli ezt a viselkedést.

Az `AGENTS.md` és `CLAUDE.md` fájlokat a bridge saját
`collectProjectInstructions` útvonala olvassa be és fűzi a system prompthoz.
Ezek kiegészítő projektutasítások; a lépésállapot gépi továbbítását nem tudják
garantálni.

## 4. Bizonyított és valószínű hibamechanizmusok

### D1 · P1 — A KÓD első pontja modelljelzés nélkül aktívvá válik

A KÓD stage indulásakor a hordozott terv első eleme rögtön `inProgress`, a
többi `pending` státuszt kap. Ez még a Claude első `TaskCreate` vagy
`TaskUpdate` eseménye előtt történik.

Következmény: a kezdeti Read/Glob/Grep és minden rosszul hozzárendelt későbbi
esemény az első pont alatt jelenik meg. A UI állítása nem eseményen alapul.

### D2 · P1 — A hordozott terv és a Claude tasklista fuzzy szövegegyezéssel kapcsolódik

A frontend az első 40 normalizált karakter részleges tartalmazását használja,
és akkor tekinti a bejövő listát a terv megfelelőjének, ha legalább a fele
egyezőnek látszik.

A Claude a taskokat egyenként hozza létre, ezért ugyanaz a növekvő lista lehet:

- egy elemnél elfogadott;
- három elemnél elutasított;
- további egyező elemek után ismét elfogadott.

Ez önmagában előre–hátra kijelölésváltást és részleges státusz-visszaállást
okozhat. Hasonló című tervpontoknál a `find` az első részleges egyezést
választhatja, nem feltétlenül a helyeset.

### D3 · P1 — Nincs tartós „utolsó hiteles aktív Claude task” állapot

Két `TaskUpdate` között előfordulhat olyan pillanatkép, amelyben az előző task
már `completed`, a következő viszont még csak `pending`. A renderelő ilyenkor
az első pending pontot választja, illetve fallbackekből próbál következtetni.

A kijelölésnek ehelyett az utolsó explicit `in_progress` taskot kellene
megtartania mindaddig, amíg explicit következő aktív task vagy a stage lezárása
nem érkezik.

### D4 · P1 — A tool-események hozzárendelése pillanatnyi UI-állapotból történik

Egy activity `planStepId` értékének sorrendje jelenleg:

1. az adott plan-update esemény lokális override-ja;
2. fájlnév-alapú következtetés;
3. az éppen `inProgress` lépés;
4. az első lépés.

A `planStepIdOverride` csak az aktuális esemény feldolgozásának lokális
változója. Maga a plan-update nem lesz activity, ezért az override nem köti a
következő Read/Edit/Bash hívást tartósan a taskhoz. A rendszer végül a
`run.plan` pillanatnyi státuszára támaszkodik.

### D5 · P2 — A fallback túl agresszíven választja az első lépést

Ha nincs explicit aktív task, és a tool-hívásból nem nyerhető ki a tervben
szereplő fájlnév, az esemény az első lépéshez kerül. Ez különösen gyakori:

- Bash tesztfuttatásnál;
- általános Grep/Glob/Read hívásnál;
- több fájlt érintő tervpontnál;
- REVIEW alatt, ahol a lépések követelményvizsgálatok, nem fájlnevek.

A „nem tudjuk” állapotot jelenleg hamisan „első lépésként” ábrázoljuk.

### D6 · P2 — A Claude GUI task-ID indexalapú

`planFromTasks` a Map aktuális, szűrt sorrendjéből készít `task-0`, `task-1`, …
azonosítókat. Törölt task kiesésekor az utána következő GUI-ID-k eltolódhatnak.
Ez elveszítheti a korábbi timingot, kijelölést és activity-kapcsolatot.

### D7 · P2 — A prompt helyes szándékot kér, de nem kényszerít eseménysorrendet

A jelenlegi szöveg azt mondja, hogy a checklistet munka közben tartsa karban,
de nem rögzíti gépszerűen az elvárt sorrendet:

1. összes task létrehozása;
2. pontosan egy task `in_progress`;
3. csak ezután tool-hívás;
4. befejezéskor `completed`;
5. következő task `in_progress` még annak első tool-hívása előtt.

A prompt erősítése szükséges védőréteg, de önmagában nem helyettesíti a
determinista kliensoldali állapotgépet.

## 5. Naplóbizonyíték

A `%LOCALAPPDATA%/min/claude-bridge.log` 2026-07-30-i „Smith chart stuff 24”
futásában:

- KÓD indulás: 19:23:33Z;
- az első nyolc `turn/plan/updated`: 19:23:43Z–19:23:54Z, ami megfelel az
  egyenként felépített tasklistának;
- további státuszfrissítések csak később, több csoportban érkeztek;
- REVIEW indulás: 19:33:52Z;
- a saját tasklista 19:34:00Z–19:34:09Z között épült fel;
- a következő frissítések 19:34:46Z, 19:35:41Z és 19:37:07Z körül érkeztek.

Ez bizonyítja, hogy Claude képes használható task-eseményt küldeni, de azok
ritkábbak és több külön tool-hívásból állnak össze. A jelenlegi bridge-log csak
az eseménytípust írja ki, a task-ID/státusz tartalmat nem, ezért a pontos
átmenetsorrend további célzott diagnosztika nélkül nem rekonstruálható.

## 6. Tervezett javítás

### Fázis A · Diagnosztikai eseménynapló

1. A bridge plan-frissítésekor strukturált, tartalomkorlátozott diagnosztika:
   - request/stage azonosító;
   - Claude task-ID;
   - művelet (`create`/`update`/`delete`);
   - régi és új státusz;
   - task sorszáma;
   - tárgy normalizált hash-e vagy rövid, redaktált előtagja.
2. A frontend naplózza, hogy egy bejövő task:
   - melyik carried plan ID-hoz kapcsolódott;
   - explicit, fájlnév-fallback vagy unassigned úton kapott-e step-ID-t;
   - mi okozott aktív lépésváltást.
3. A napló ne tartalmazzon promptot, teljes taskleírást vagy fájltartalmat.

### Fázis B · Stabil Claude taskazonosság

1. A bridge a valódi Claude task-ID-ból készítsen stabil GUI-ID-t, például
   `claude-task:<id>`.
2. A `TaskCreate` tool-use ID csak ideiglenes kulcs legyen a tool_result
   megérkezéséig.
3. A valódi ID megérkezésekor az elem ne új taskként szülessen újra, hanem
   ugyanaz az objektum kapja meg a végleges azonosítót.
4. Törlés ne számozza át a többi taskot.

### Fázis C · Determinisztikus carried-plan megfeleltetés

1. A KÓD stage indulásakor készüljön külön mapping-állapot:
   `claudeTaskId -> carriedPlanStepId`.
2. Elsődleges párosítás a létrehozási sorrend alapján történjen, mert a prompt
   eleve a TERV sorrendjének szó szerinti felvételét írja elő.
3. A normalizált szövegegyezés csak ellenőrzés legyen:
   - erős egyezés: a sorrendi mapping elfogadva;
   - gyenge/nem egyezés: diagnosztikai jelzés, de a már stabil mapping ne
     változzon visszamenőleg;
   - elemszám- vagy sorrendeltérés: a Claude saját lista külön identitást kap,
     nem részleges fuzzy merge-et.
4. Már összekapcsolt taskot későbbi részleges pillanatkép ne kapcsolhasson másik
   tervponthoz.

### Fázis D · Explicit aktív-task állapotgép

Futásonként tárolandó:

- `explicitActiveStepId`;
- `lastExplicitActiveStepId`;
- `lastPlanTransitionSequence`;
- `planSource`: `codex-native | claude-task | carried-plan | fallback`.

Átmenetek:

1. `TaskUpdate(status=in_progress)` állítja az explicit aktív lépést.
2. Ugyanazon task `completed` állapota lezárja, de nem választ automatikusan
   másik pending lépést.
3. A következő aktív lépés csak új explicit `in_progress` eseménytől változik.
4. Stage-vége lezárja az utolsó aktív lépést.
5. Két explicit jel között a kijelölés az utolsó hiteles lépésen marad.
6. Egyszerre több `in_progress` task esetén a legfrissebb explicit update nyer,
   és diagnosztikai figyelmeztetés készül.

### Fázis E · Activity hozzárendelés

Az új prioritás:

1. explicit Claude/Codex aktív step-ID;
2. az activity eseményben közvetlenül érkező step-ID;
3. egyértelmű, már stabil task/tool kapcsolat;
4. egyértelmű fájlnév-egyezés;
5. `unassigned`, nem az első lépés.

Az `unassigned` események megjelenítése:

- stage-szintű „Előkészítés / általános munka” csoportban; vagy
- az első későbbi explicit aktív lépéshez csatolva, csak ha időrendileg azelőtt
  történtek és még nem volt korábbi explicit aktív task.

Soha ne állítsuk bizonyíték nélkül, hogy az első tervpont alatt történtek.

### Fázis F · KÓD indulási állapot

1. A carried plan minden eleme `pending` státusszal induljon.
2. A kliensoldali `client-pre-plan`/„Kódolás előkészítése” sor maradhat aktív,
   amíg nincs explicit task-jel.
3. Az első tervpont csak első explicit `in_progress` vagy egyértelmű fallback
   esemény után legyen aktív.

### Fázis G · REVIEW

1. A REVIEW saját taskjai stabil Claude task-ID-val jelenjenek meg.
2. A review-lista ne használjon fájlnév-fallbacket elsődleges léptetésre.
3. A review általános Read/Grep/Bash eseményei az explicit aktív review-taskhoz
   kerüljenek.
4. Ha Claude egyáltalán nem hoz létre tasklistát, maradjon egy őszinte
   „Bírálat folyamatban” szintetikus sor; ne generáljunk hamis 3–5 pontos
   haladást.

### Fázis H · Prompt megerősítése

A KÓD és REVIEW utasításába rövid, protokollszerű blokk kerüljön:

- hozd létre az összes taskot munka előtt;
- egyszerre pontosan egy legyen `in_progress`;
- a taskot még az első hozzá tartozó tool-hívás előtt állítsd
  `in_progress` állapotba;
- befejezés után azonnal `completed`, majd a következő `in_progress`;
- ne jelölj több lépést egyszerre, és ne a végén zárd le őket tömbösen.

Ez javítja a Claude viselkedését, de a frontendnek továbbra is helyesen kell
kezelnie a megszegett protokollt.

## 7. Invariánsok

1. Modelljelzés nélkül egy carried plan step sem `inProgress`.
2. Stabil step-ID a stage teljes élettartama alatt nem változik.
3. Részleges tasklista nem törölhet és nem számozhat át már ismert lépést.
4. Pending lépés nem válik aktívvá pusztán azért, mert ő az első pending.
5. Egy activity utólag nem vándorolhat másik lépéshez új render miatt.
6. Explicit státusz mindig erősebb a fájlnév-fallbacknél.
7. Bizonytalan esemény `unassigned`; nem hamisan „első lépés”.
8. A TERV szövegének számozott pontjai maradnak a KÓD kanonikus lépései.
9. ChatGPT natív plan útvonala nem változhat meg ettől a javítástól.
10. Hidegindítás és store round-trip után ugyanazok az ID-k, státuszok és
    activity-kapcsolatok álljanak helyre.

## 8. Tesztterv

### 8.1 Bridge unit tesztek

- több egymás utáni `TaskCreate` növekvő listája stabil ID-ket tart;
- tool_result után a valódi task-ID átveszi az ideiglenes kulcs helyét;
- `TaskUpdate(in_progress/completed)` csak a cél taskot módosítja;
- task törlése nem számozza át a többit;
- ismeretlen task-ID nem hoz létre néma, duplikált elemet;
- egyszerre több aktív task diagnosztikát ad, determinisztikusan választ.

### 8.2 Frontend állapotgép-tesztek

- KÓD indulásakor nincs aktív carried step;
- nyolc egyenként érkező TaskCreate nem „írja újra” a TERV-listát;
- részleges lista 1/1 → 1/3 → 2/5 arányánál sincs visszaugrás;
- `step1 completed`, majd később `step2 in_progress` között step1 marad az
  utolsó hiteles kijelölés vagy semleges állapot látszik;
- tool-események a legutóbbi explicit aktív taskhoz kerülnek;
- státusz nélküli Bash-esemény `unassigned`, nem step1;
- hasonló első 40 karakterű tervcímek nem keverednek;
- törölt Claude task nem mozgatja át a későbbi taskok trace-ét;
- hidegindítás után a mapping és timing stabil.

### 8.3 REVIEW tesztek

- 3–5 task egyenkénti létrehozása nem ugráltatja a kijelölést;
- Read/Grep/Bash az explicit aktív review-taskhoz kerül;
- tasklista nélküli review egy szintetikus, őszinte sort mutat;
- stage-vége csak a ténylegesen aktív lépést zárja le.

### 8.4 ChatGPT regresszió

- a natív teljes `turn/plan/updated` lista továbbra is azonnal érvényesül;
- stabil Codex step-ID-k és timingok megmaradnak;
- TERV/KÓD/REVIEW jelenlegi jól működő ChatGPT viselkedése változatlan;
- az új Claude-specifikus állapot nem szivárog Codex futásba.

### 8.5 Integrációs GUI-próba

Ugyanazon 5–8 pontos tervvel fusson:

1. Claude KÓD + Claude REVIEW;
2. ChatGPT KÓD + ChatGPT REVIEW;
3. vegyes Claude KÓD + ChatGPT REVIEW;
4. vegyes ChatGPT KÓD + Claude REVIEW.

Másodpercenként rögzítendő:

- aktív step-ID és cím;
- task transition sequence;
- tool event → step-ID;
- előre és visszafelé váltások száma;
- unassigned események száma és oka.

Elfogadási feltétel: explicit modell-visszalépés nélkül nulla visszafelé ugrás,
és minden explicit task-intervallum tool-eseménye ugyanahhoz a step-ID-hoz
marad kötve.

## 9. Megvalósítási sorrend

1. Diagnosztikai payload és célzott reprodukció.
2. Bridge stabil task-ID és transition esemény.
3. Frontend explicit aktív-task állapotgép.
4. Carried-plan determinisztikus mapping.
5. Activity-hozzárendelés és unassigned kezelés.
6. KÓD indulási és REVIEW fallback javítása.
7. Prompt megerősítése.
8. Unit, store round-trip és GUI integrációs tesztek.
9. Claude/ChatGPT összehasonlító audit.

## 10. Érintendő fájlok

- `agent-bridge/main.mjs`
- `agent-bridge/policy.mjs`
- `agent-bridge/protocol.test.mjs` vagy külön task-state tesztmodul
- `src/App.tsx`
- célszerűen új `src/planTracking.ts`
- célszerűen új `tests/planTracking.test.ts`
- `src-tauri/src/pipeline.rs`
- szükség esetén `src/chatTimeline.ts` és `tests/chatTimeline.test.ts` a
  perzisztált mappinghez

## 11. Nem cél

- a ChatGPT natív plan-protokoll lecserélése;
- Claude settings/hook/plugin források engedélyezése;
- reasoning szövegből szabad szöveges lépéshaladás kitalálása;
- minden tool-hívás erőltetett hozzárendelése valamelyik tervponthoz;
- a TERV tartalmi vagy vizuális újratervezése.

## 12. Kész definíció

A javítás akkor kész, ha:

- Claude KÓD és REVIEW alatt a kijelölés kizárólag bizonyítható átmenetet
  követ;
- az első lépéshez nem gyűlik automatikusan a teljes stage munkája;
- nincs részleges tasklista okozta előre–hátra ugrálás;
- a futás után minden activity ugyanazon lépés alatt marad, ahol élőben volt;
- a ChatGPT útvonal regresszió nélkül működik;
- a bridge, frontend, Rust és GUI integrációs tesztek zöldek.

## 13. Megvalósítási állapot — 2026-07-30

Az A–H fázisok kódoldali része elkészült:

- a Claude bridge stabil, nem indexelt task-ID-t és aktív lépés-információt küld;
- a KÓD hordozott terve minden modellnél `pending` állapotból indul, majd létrehozási sorrendben, szigorú címellenőrzéssel kap státuszt;
- az explicit aktív lépés tartós, a bizonytalan események semleges `unassigned` sorba kerülnek;
- a REVIEW ugyanazt az explicit állapotátvitelt használja;
- a KÓD/REVIEW prompt protokollja rögzíti a taskok létrehozási és lezárási sorrendjét;
- elkészült a bridge-, frontend-build-, timeline- és Rust-egységteszt-ellenőrzés.

A tényleges Claude/ChatGPT GUI összehasonlító futtatás továbbra is manuális integrációs ellenőrzés.
