# Takarítás és komponensbontás — terv

*2026-07-29 · Fable xHigh. Előzmények:
[CROSS_CONVERSATION_BUG_ANALYSIS.md](CROSS_CONVERSATION_BUG_ANALYSIS.md) (a
címzési modell) és
[MULTI_PROJECT_PARALLEL_RUNS_PLAN.md](MULTI_PROJECT_PARALLEL_RUNS_PLAN.md)
(a futás-regiszter, `f00656a`). Ez a terv a harmadik, utolsó lépcső: a
szerkezet.*

## Kiindulás (mért, 2026-07-29)

| | érték |
|---|---|
| `src/App.tsx` | **16 224 sor**, ebből az `App()` függvény ~9 300 |
| hookok az `App()`-ban | 95 useState · 65 useRef · 61 useEffect |
| top-level segédkomponens a fájlban | 16 (`MessageRow`, `TurnProgressCard`, `WorkFlowCard`…) — jó irány, de mind ugyanabban a fájlban |
| önálló modul | `conversationState`, `deterministicId`, `messageIdentity`, `chatTimeline`, `agentEvent`, `agentError` — 1,1k sor, 50 teszttel |

**Miért most biztonságos, amikor eddig nem volt az:** az állapot már
ID-címzett (minden írás gazdát nevez meg), a futás tárgy (`RunHandle`), a
mentés azonosságra kérdez. A bontás ezért ma *mechanikus* művelet — kód
költözik, nem jelentés. Fél évvel ezelőtt ugyanez a művelet a címzési hibák
átrendezése lett volna.

**Miért kell egyáltalán:** a 95 useState egyetlen függvényben azt jelenti,
hogy minden állapot minden kódsorral érintkezhet. A cross-conversation
hibacsalád ebből a szerkezetből született, és minden jövőbeli módosítás
ugyanebben a térben mozog. A cél nem szépség — a cél, hogy egy jövőbeli
változtatás ne érhessen hozzá ahhoz, amihez semmi köze.

## Elvek

1. **Minden lépés után zöld.** `tsc -b` + 50 frontend-teszt + build; a Rust
   nem változik. Egy lépés = egy fogás; félkész állapot nem marad éjszakára.
2. **Viselkedésváltozás tilos.** Ez a terv nem javít és nem szépít — költöztet.
   Ha egy lépés közben hibát találunk, az külön commit, külön döntés.
3. **Előbb kifelé olvasható határ, aztán költözés.** Egy komponens akkor
   emelhető ki, ha a propjai leírhatók egy mondatban. Ha nem írhatók le, előbb
   az állapotot kell rendezni (A és C szakasz), nem a JSX-et vágni.
4. **Props, nem context.** Explicit props még akkor is, ha sok; context csak
   ott marad, ahol már van (`FileActionContext`). A rejtett csatorna pont az,
   amitől szabadulunk.
5. **Komponens-tesztfuttató nincs** (a tesztek node-alapú egységtesztek). Ezért
   minden kiemelésnek copy-paste-mechanikusnak kell lennie: a JSX és a
   handlerek változatlanul költöznek, csak a bemenetük válik névvé. A kézi
   GUI-ellenőrzés lépésenként egy 2 perces lista, nem egy nagy teszt a végén.

## A) Takarítás — a `RunHandle` legyen teljes igazság

Kis fogások; együtt egy commit is lehet. Számok a mai állapotból.

| | mi | hivatkozás | művelet |
|---|---|---|---|
| A1 | alias-refek: `activeRequestIdRef` (6), `runOwnerConversationIdRef` (3), `activeLiveMessageIdRef` (2), `activeTurnIdRef` (11), `activeTurnTimingRef` (3), `runPlanRef` (4), `turnCompletedRequestIdRef` (3) | 32 | az olvasók a `viewedRun` / `runsRef`-ből olvasnak; a `syncRunAliases()` és a refek törlődnek |
| A2 | `codeStatus` (state) → `RunHandle.statusLabel`; a nézet a `viewedRun`-ból olvassa, futás nélkül „készen" | 3 író | a state törlődik |
| A3 | `transportStatus`, `watchdogMessage` → handle-mezők, ugyanígy | 3+5 | a state-ek törlődnek |
| A4 | `isCancelling` → `RunHandle.cancelling` | 5 | a state törlődik |
| A5 | `runProjectPathRef` (4) — a handle `projectPathKey`-e óta felesleges | 4 | olvasók átvezetése, ref törlése |
| A6 | `preparingRequestIdRef` (8), `cancelledRequestIdsRef` (6) → handle-mezők (`status: "preparing"` már létezik; a cancelled-halmaz futásonként egy bit) | 14 | refek törlése |
| A7 | `activePlanRef` (6) — a *nézeté*, nem a futásé; marad, de átnevezve dokumentálni, hogy miért nem a handle-é | 6 | csak komment/név |

**A-szakasz vége:** a futásról szóló minden tény egyetlen helyen, a
handle-ben lakik. Ez nem opcionális kozmetika: a C-szakasz (hook-kivonás)
enélkül nem lehetséges, mert az aliasok az `App()` scope-jához kötik a
regisztert.

*Ellenőrzés:* teljes zöld + kézzel: egy futás (stream, stop, hiba), két
projekt párhuzamosan, lánc. Ugyanaz a lista, mint a 2. fázisnál.

## B) Komponensbontás — levelektől befelé

A render ma: sidebar 14999–15631 (~630 sor) · timeline-építés 14301–14935
(~630 sor) + `workLogGroups` memo · composer 15694–15945 (~250 sor) ·
overlay-k 15947–16070. Sorrend kockázat szerint, a legkisebbtől:

### B1. Overlay-k és dialógusok → `src/components/overlays.tsx`

`ImagePreviewOverlay` (már komponens), az `appDialog` űrlap, a jóváhagyás/
kérdés promptok. Bemenetük kevés és tiszta (a dialog-state + 2-3 callback).
~200 sor ki.

### B2. Settings → `src/components/SettingsPanel.tsx`

A `settingsOpen` blokk + `RetentionSettingsSection` + `ModelPicker` átköltözik.
Props: a beállítás-értékek és setterjeik (sok, de mind primitív). ~400 sor ki.

### B3. Sidebar (fa + GENERAL előzmények + lábléc) → `src/components/Sidebar.tsx`

Props: `sortedProjects`, `generalConversations`, aktív kijelölés, futás-jelzők
(`conversationRunState` — függvényként megy át), és a handlerek
(select/rename/delete/new, mind létezik névvel). A fa *nem* kap hozzáférést a
cache-hez vagy a runs-táblához — amit tudnia kell, névvel kapja. ~700 sor ki.

### B4. Composer → `src/components/Composer.tsx`

A form + idézetek + képek + modellválasztók + queued-pill. **A szándékosan
kontrollálatlan input a kiemelés után is kontrollálatlan marad** —
az `inputDraftRef` / quote-draft refek a komponensbe költöznek, a submit
callbackként megy be (`onSubmit`). Ez a legérzékenyebb határ: a submit maga
(a ~700 soros `submitMessage`) **nem** költözik, az App-ban marad a C-ig.
~450 sor ki.

### B5. Timeline → `src/components/Timeline.tsx` + `src/timelineBuild.ts`

A legnagyobb fogás, két félben:

- **B5a — tiszta építés:** a `timelineContent`-et építő ~630 sor renderhez nem
  kötött része (csoportosítás, szűrés, a „melyik sor látszik" döntések) a már
  létező `chatTimeline.ts` mintájára tiszta függvényekbe költözik
  (`timelineBuild.ts`) — ezek **tesztelhetők**, és ez az egyetlen hely, ahol a
  bontás új tesztet is hoz.
- **B5b — render:** a JSX (`MessageRow`-k, kártyák, élő panel) `Timeline`
  komponensbe, props-szal.

~900 sor ki, és a message-stream renderelése memo-határt kap (a 6. lépés
trace-kártya problémája — a renderenként képzett tömbök — itt oldódik meg
ingyen, mert az építés kikerül a renderből).

**B-szakasz vége:** `App.tsx` ~13 000 sor alá, az `App()` render része
~500 sor „elrendezés". A fájlméret felét még mindig a submit/esemény/sync
logika adja — az a C dolga.

## C) Állapot-modulok — az `App()` zsugorítása

Csak az A és B után; itt már minden határ látszik.

| | mi | hova |
|---|---|---|
| C1 | futás-regiszter: `runsRef` + `beginRun`/`endRun`/`runFor*` + `writeOwned*` + az eseménykezelő | `src/hooks/useRunRegistry.ts` — bemenete a cache-műveletek és a `viewedConversationId`, kimenete a regiszter-API |
| C2 | beszélgetés-cache + hidrálás + mentőhurok + sync-effektek | `src/hooks/useConversationStore.ts` |
| C3 | `submitMessage` + stop + regenerálás + lánc-indítás | `src/hooks/useAgentTurn.ts` — a C1–C2 API-jára épül |

A C nem „még több fájl" öncélúan: a C1 után a futás-logika *importálható és
tesztelhető* React nélkül is (a regiszter ma is ref-alapú, state-et csak a
`runsRevision` érint), a C3 után pedig a 700 soros submit végre egy néven
hívható egység.

**Végállapot-cél:** `App.tsx` < 3 000 sor — elrendezés és összekötés; minden
más néven nevezett modul. Nem szentírás-szám, hanem mérce: ha egy lépés után
nem csökken, a lépés rossz volt.

## Állapot — 2026-07-29 éjszaka

`App.tsx`: **16 224 → 14 744 sor**. Minden lépés külön commit, mindegyik után
`tsc -b` + 50 frontend-teszt + build zöld; a Rust érintetlen (169/169).

| lépés | commit | eredmény |
|---|---|---|
| A1–A6 takarítás | `023e958` | a `syncRunAliases()` és hét alias-ref megszűnt; a `codeStatus`/`transport`/`watchdog`/`cancelling`, a futás munkakönyvtára és a megszakítás-bit a `RunHandle`-be költözött |
| B1 overlay-k | `b96a420` | `src/components/overlays.tsx` (492 sor) — képnagyító, párbeszéd, Claude jóváhagyás/kérdés, parancspaletta + a hozzájuk tartozó négy típus |
| B2 beállítások | `bc5ade8` | `src/components/SettingsPanel.tsx` (100 sor) |
| B3 oldalsáv | `43d2d53` | `src/components/Sidebar.tsx` (760 sor) + `src/syncFormat.ts` + `src/components/runMarks.tsx` |

**A7 elmaradt** (az `activePlanRef` átnevezése) — kozmetika, nem sürgős.

### B4 (composer) — megkezdve, visszavéve

A szerkesztő nem olyan levél, mint a többi: a lánc-szakasz beállítói
(`activePipelineRecipe`, `cycleStageValue`, `stageValue`, `stageProvider`),
a `ModelPicker`, a `STAGE_ROLE_LABELS`/`FALLBACK_EFFORTS`/`shortModelLabel`
segédek és a jóváhagyás-jelző (`pendingClaudeApproval`/`Question`) mind
átnyúlnak rajta. Ez ~30 további prop és két segédmodul, nem egy fogás.

**Javasolt bontás a következő menetre:**

1. **B4a** — a modellválasztó és a lánc-beállítók külön:
   `src/components/ModelPicker.tsx` (a meglévő komponens + `shortModelLabel`,
   `FALLBACK_EFFORTS`) és `src/components/StageSettings.tsx`
   (`STAGE_ROLE_LABELS` + a szakasz-gombok). Mindkettő zárt, kevés proppal.
2. **B4b** — a maradék composer (idézetek, képek, textarea, küldés gomb) a
   két kész komponensre támaszkodva. A refek (`inputRef`, `imageInputRef`,
   `quoteInputRefs`, `quoteInstructionDraftsRef`, `inputDraftRef`) propként
   mennek be — **a beviteli mező kontrollálatlan marad**.

A B5 (timeline) és a C szakasz változatlanul áll a fenti terv szerint.

## Amihez NEM nyúlunk

- Rust modulok, stílusréteg, viselkedés — semmi.
- Nincs state-management könyvtár (Redux/Zustand/stb.): a címzési modell a
  miénk, és épp most lett helyes.
- Nincs átnevezési hadjárat és nincs mappa-újrarendezés a `components/` +
  `hooks/` létrehozásán túl.
- A kontrollálatlan composer-input és a görgetés-refek mintája marad — ezek
  tudatos teljesítmény-döntések voltak, nem adósság.

## Ellenőrzési protokoll (minden lépésnél ugyanaz)

1. `npx tsc -b` tiszta;
2. `npm run test:timeline` 50/50 (B5a után több);
3. `npm run build` zöld;
4. 2 perces kézi lista: egy kör fut+kész, stop, két projekt párhuzamosan,
   lánc-panel, sidebar-műveletek (átnevezés/törlés/új), settings nyit/zár.

Commit lépésenként (A egyben mehet), hogy bármelyik fogás önmagában
visszavonható legyen.

## Sorrend és becslés

| lépés | méret | kockázat | megjegyzés |
|---|---|---|---|
| A1–A7 takarítás | közepes | kicsi — egy írós aliasok | előfeltétele C-nek |
| B1 overlay-k | kicsi | minimális | bemelegítés |
| B2 settings | kicsi | minimális | |
| B3 sidebar | közepes | kicsi | a fa csak neveket lát |
| B4 composer | közepes | **közepes** — kontrollálatlan input | a submit nem mozdul |
| B5 timeline | nagy | közepes | B5a hoz új teszteket |
| C1 regiszter-hook | közepes | közepes | React nélkül tesztelhetővé válik |
| C2 store-hook | nagy | közepes | |
| C3 turn-hook | közepes | kicsi — addigra minden határ áll | |

Realistán ez több munkamenet. Minden lépés után az app kiadható — nincs
olyan pont, ahol „félig szét van szedve".
