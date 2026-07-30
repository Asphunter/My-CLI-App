# GUI-audit és javítási terv — 2026-07-30, „Smith chart stuff 23" futás

## 1. Mi történt (a kísérlet)

A min-t magam indítottam és vezéreltem (CDP-n át, koordináták nélkül), a futásról
másodpercenkénti képernyő-trace, a hídról teljes nyers esemény-dump készült, és
ugyanazt a promptot magam is megoldottam referenciának.

- **Projekt:** `Smith chart stuff 23` (újonnan létrehozva, üres mappa — csak a sablon `AGENTS.md`).
- **Prompt:** „Kérek egy animációt ahogy a pont a Smith charton forog amikor beteszek egy
  50 Ohmos load elé egy 100 Ohmos Tline-t, és növelem a Tline EL hosszát nulláról 2pí-ig."
- **Lánc:** MULTI-AI, Claude · Opus 5 · medium mindhárom szakaszon (a REVIEW-t a
  ChatGPT-alapértelmezésről kézzel váltottam át).
- **Időzítés:** indítás 19:48:20 · TERV 1:16 · KÓD ~7:35 · REVIEW ~6:40 (ebből ~63 mp
  session-betöltési állás, lásd F6) · vége ~20:03. Eredmény: `VERDIKT: JAVÍTANDÓ`.
- **Trace-anyagok** (a `Conversation audits/20260730-gui-audit/` mappában, ill. képek a `Screenshots/`-ban):
  - `Screenshots/881.png … 1386.png` — a futás képkockái (csak a változó frame-ek);
  - `frames.csv` — időbélyeg → fájlnév index (a változatlan másodpercek is sorban);
  - `bridge-dump.jsonl` — a Claude-híd MINDEN kimenő borítéka időbélyeggel (mit kapott a GUI);
  - `claude-bridge.log` — híd-diagnosztika (session-store időzítések, degradációk).
- Ismert trace-lyukak: 19:56:50–20:03 között a rögzítő kihalt (az átmenetet DOM-mintavételek
  fedik), és ahol a Claude-ablak a min fölött volt, ott azt fotózta (pl. `1384.png`) —
  a rögzítő a képernyő-régiót viszi, nem az ablak tartalmát.

## 2. Ami bizonyítottan jól működik (a korábbi javítások regressziócsekkje)

| Viselkedés | Bizonyíték |
|---|---|
| TERV indulás: nincs hamis kiemelés/halványítás, a pontok simán íródnak egymás alá, fejléc „készül" | `884.png`, `905.png` |
| `##` fejezetcímek rendes címként renderelve (terv RAW + válaszok) | `884.png` („Kiindulás") |
| KÓD: hordozott terv-lépések (8), tiltott 3/3 REVIEW + VÁLASZ fül futás közben, `is-running` jelzés | DOM-pulzus 19:50 |
| Parancs-bulletek `cd "…" && ` előtag nélkül | DOM-pulzus (`$ python -c "import sys,numpy…"`) |
| FÁJLOK/VÁLTOZÁSOK a KÓD alatt élőben, relatív úttal, +/− számokkal | DOM-pulzus (`smith_tline_anim.py MÓDOSÍTVA +297−8`) |
| KÓD→REVIEW váltás: nincs lyuk, nem ragad a KÓD válaszán, a REVIEW saját lépésén áll | DOM-pulzus 19:57:0x |
| Lezárt lánc: VÁLASZ fül az alapértelmezett, a strip végén; 3/3 REVIEW piros (`is-verdict-changes`) | `final.js` DOM-dump, `1386.png` |
| Piros footer „A bíráló javítást kér." + Újra a KÓD-tól (v2) + Javíttatom | `final.js` DOM-dump |
| Nyers `VERDIKT: …` záró sor levágva a megjelenített szövegről | `final.js` (verdictInText: null) |
| Terv-fájl (`tervek/…-v1.md`) + a futás végén `## v1 bírálat` napló hozzáfűzve | `Smith chart stuff 23/tervek/` |
| SessionStore-hiba már nem öli meg a REVIEW-t (degradáció + napló) | `claude-bridge.log` 17:58:04 |

## 3. Hibák és javítási terv

### F2 · P1 — A Claude nem kap checklist-eszközt → a LÉPÉSEK csak tartalékból mozog

**Tünet:** a kódoló és a bíráló is kiírja: „Nincs TodoWrite eszközöm…”; a REVIEW lépéslistája
1 szintetikus sor; a KÓD lépések csak a fájlnév-egyeztető tartalék-léptetésből haladnak.
**Bizonyíték:** `bridge-dump.jsonl` — a KÓD alatt **0 db** `turn/plan/updated`; használt eszközök:
Glob/Bash/Write/Read/Edit. A `Glob` a `tools:`-listából regisztrálódik, tehát a mechanizmus él —
a `TodoWrite` nevet viszont a natív SDK-build már nem ismeri.
**Gyökérok:** az SDK új natív buildjében a checklist-eszköz a **`TaskCreate` / `TaskUpdate`**
(lásd `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`: `TaskCreateInput`
`subject/description/activeForm`, `TaskUpdateInput` `status`), a `TodoWrite` nevet a `tools:`
lista csendben eldobja.
**Javítás (agent-bridge/policy.mjs + main.mjs):**
1. `ENABLED_TOOLS` += `"TaskCreate", "TaskUpdate", "TaskList"`; `PLAN_TOOLS` += ugyanezek.
2. A hídban task-állapot: `turn.tasks = new Map()` (id → {subject, activeForm, status}, beérkezési
   sorrendben). `TaskCreate` tool_use → új elem `pending`-gel (az input `activeForm`/`subject`
   mezőiből); `TaskUpdate` → státuszfrissítés (`in_progress`/`completed`).
3. Minden változás után `turn/plan/updated` esemény a meglévő alakban
   (`planFromTodos`-analóg: `{id, step, status}` lista) — a GUI-n semmit nem kell módosítani.
4. A `canUseToolForTurn` "plan" ága és az `emitToolStarted` plan-ága is ismerje az új neveket
   (az auto-allow marad).
5. Teszt: `policy.test`-be a TaskCreate/TaskUpdate → plan-lista leképezés.

### F6 · P1 — 60 mp néma állás a REVIEW elején: a session-`load` sosem tér vissza

**Tünet:** a REVIEW indulásakor ~63 mp-ig semmi nem történik (korábban: itt halt meg a lánc).
**Bizonyíték:** `claude-bridge.log`: `session store timeout {"operation":"load","waitedMs":60005,
"pendingOps":0}` (17:58:04), majd `op degraded` → friss session, a turn 17:58:07-kor elindult.
A `bridge-dump.jsonl`-ben: `ready` 17:57:04 → `session_started` 17:58:07. A Rust-oldali
lassú-op naplóba (>2 s) **semmi** nem került — a kérés/válasz kör a csövön veszik el, nem az
SQLite-ban (a betöltendő session: 115 sor, ~1,1 MB; a DB-lekérdezés mérve 0,07 s).
**Gyanú:** a többmegabájtos, egyetlen soros JSON-válasz írása a híd stdin-jére elakad, miközben
a Rust olvasó-szála épp ezt a választ írja (ugyanaz a szál olvas és ír — öntorlódás).
**Javítás, két lépcsőben:**
1. *Azonnali (olcsó):* a lánc REVIEW szakasza induljon **friss sessionnel** — a bíráló minden
   kontextusát a prompt artifact-blokkja hordozza, a session-folytatás itt csak kockázat.
   `pipeline.rs`: a `StageExecution` kapjon `fresh_session` jelzőt (Review → true), a runner ne
   adjon `session_id`-t; ezzel a 60 mp-es állás és a hibaosztály a láncból eltűnik.
2. *Gyökérok (mérés után):* Rust-oldali per-op napló (op indul/kész + válaszméret bájtban) a
   `session_store_request` ágban; ha beigazolódik a nagy-válasz elakadás, a válaszírást külön
   szálra (csatornán át) kell vinni, vagy a `load`-ot lapozni (`offset/limit` a protokollban).
   A 60 mp-es türelem + degradáció addig is védőháló.

### F5 · P2 — A Claude magyar narrációja élőben továbbra sem látszik + a VÁLASZ idő előtt „pofázik"

**Tünet (két arca ugyanannak):**
1. a GONDOLKODÁS MENETE futás közben csak angol thinking-sorokat és tool-sorokat mutat;
   a magyar átkötő mondatok csak a szakasz legvégén jelennek meg (ömlesztve);
2. a KÓD kártya már a szakasz **közepén** átvált VÁLASZ nézetre, és ott növekvő, összeragadt
   státusz-szöveg „íródik", miközben a LÉPÉSEK még bőven futnak. Ok: a narráció a
   válasz-streambe érkezik (`final_answer` fázis — a KÓD alatt 128 delta ment át így, mérve),
   a nézet-automatika pedig „streamelés közben, amint van válasz-szöveg → VÁLASZ" szabállyal
   dolgozik. Ez Codexnél helyes (ott szöveg = tényleg a válasz), Claude-nál az első
   narráció-mondat átdobja a nézetet. Bizonyíték: DOM-minta 19:55 (stepsCount=0 a futó KÓD
   alatt), dump final_answer-számláló.
**Bizonyíték:** dump: 128 `final_answer` delta mellett **0 db** `commentary` delta
`item.type=agentMessage`-dzsel a futás közben — az előző körben bevezetett élő-narráció csak a
tool_use-t is tartalmazó üzenetekre állt rá, a Claude viszont a narrációt **külön, csak-szöveg
üzenetekben** küldi, majd külön üzenetben hívja az eszközt.
**Javítás (agent-bridge/main.mjs, assistant-ág):**
- Egy új assistant-üzenet érkezésekor, ha van *korábbi, még nem narrált* `assistantTexts`-elem,
  azt azonnal emitálni kommentárként (egy-üzenetnyi késleltetés, de élő). A turn-végi sweep és a
  `liveCommentary` halmaz a duplázást már kizárja.
- A végső válasz tisztaságához: a `final_answer` delta `itemId`-jába kerüljön bele az üzenet
  azonosítója is (`assistant-<msgid>-<index>`), így két külön üzenet szövege közé a GUI
  blokkhatár-logikája üres sort tesz — a `1386.png`-n látható „…(folyamatban).7. lépés…"
  összeragadás megszűnik.

### F3 · P2 — A TERV RAW nézete szétfeszíti a kártyát (vízszintes túllógás)

**Tünet:** terv-streamelés közben a kártya a viewport jobb szélén túlnyúlik, a RAW/DETAIL váltó
és a jobb keret nem látszik.
**Bizonyíték:** `884.png`, `905.png` (a szöveg a kép széléig fut); KÓD alatt mérve nincs
túllógás (card 1226 px < 1536) — a jelenség terv-tartalom-függő.
**Gyökérok:** a terv hosszú, szóköz nélküli képlet-chipjei
(pl. `Z0_LINE*(Z_L + j*Z0_LINE*tan(θ/2))/(Z0_LINE + j*Z_L*tan(θ/2))`) nem törhetnek meg:
az `answerParagraphs` bekezdései a `.trace-plan-content`-ben nem kapják meg a
`overflow-wrap:anywhere`-t (az csak a `.trace-thinking-item p`-n van).
**Javítás (styles.css):**
`.trace-plan-content p { overflow-wrap: anywhere; }` és
`.trace-plan-content .inline-code { white-space: normal; overflow-wrap: anywhere; }`,
plusz biztosítéknak `.trace-thinking-panel { min-width: 0; }`. Ellenőrzés: a fenti képlettel
töltött terv-szöveg ne tolja 1536 fölé a `document.documentElement.scrollWidth`-et.

### F1 · P3 — Hidegindítás után átmenetileg hiányzik a 3/3 REVIEW fül a lezárt láncról

**Tünet:** app-indítás után pár másodperccel a 22-es projekt lezárt láncán a strip
`1/3 TERV | 2/3 KÓD | VÁLASZ` volt (a REVIEW fül és a hozzá tartozó kártya hiányzott).
**Bizonyíték:** DOM-dump 19:44-kor (indulás után) a hiányos strippel; a DB-ben mindhárom
szakasz-sor hibátlan metaadattal; később ugyanazt a beszélgetést megnyitva a strip teljes
(`check22.js`). Önjavító, de zavaró — pontosan ez adta a „bugos v1 REVIEW panel" élményt.
**Gyanú:** a hidratálás sorrendje — a strip a work-group-okból épül, és amíg a
workItems/commentary/planHistory szeletek nem érnek be, a review-szakasz csoportja a régi
üzenet-sorrendből nem áll össze.
**Javítás:** a `stagesByChain` építése ne a work-group-ok válaszain, hanem KÖZVETLENÜL a
`messages` pipeline-metaadatos sorain alapuljon (a csoport csak a kártya tartalmához kell,
a fül-sávhoz nem) — így a strip a metaadatból mindig teljes, hidratálástól függetlenül.

### F4 · P3 — Ismétlődő parancs-bullet a GONDOLKODÁS MENETÉ-ben

**Tünet:** ugyanaz a `$ python -c "import sys,numpy…"` sor kétszer egymás alatt (KÓD-pulzus).
**Elemzés:** a dumpban a `commandExecution` started/completed párok száma egyezik (8/8) — nem
esemény-duplázás; a modell ténylegesen kétszer futtatta (retry). Teendő csak annyi, hogy a
lista jelölje az ismétlést (pl. „(2×)" a bullet végén, ha az előzővel azonos szövegű) — kozmetika.

## 4. Lánc-minőség (a kimenet vs. a saját referencia-megoldásom)

Referencia: `scratchpad/reference/smith_tline_reference.html` (én írtam ugyanarra a promptra:
önálló HTML, 100 Ω-os ÉS 50 Ω-os chart-nézet, zárt alakú Γ-számítás, önteszt-assertek).

### Q1 · A LÉNYEG: a lánc megfelezte a kért EL-tartományt — és senki nem vette észre

- A prompt: „növelem a Tline **EL hosszát** nulláról **2π-ig**" → βl = 0…2π → a chart-szög
  2βl = 0…4π → a pont **két** teljes kört tesz meg. (A korábbi futások — 16/18/21 — mind két
  fordulatot adtak, a 18-as bírálója külön ellenőrizte is; a referencia-megoldásom is kettőt ad.)
- A 23-as **terv** átdefiniálta: nála θ = 2βl fut 0…2π-ig („θ=2π-nél egy teljes körrel") —
  vagyis az EL csak π-ig jut, a pont **egy** kört tesz meg. A kódoló hűen követte (a docstring
  ki is mondja: „theta = 0..2pi … ami bl = 0..pi"), a bíráló pedig a **tervhez** horgonyzott:
  végig θ-nyelven ellenőrzött, az `[EREDETI FELADAT]` blokk számszerű követelményét nem vetette
  össze a tervvel. Az eredmény fizikailag konzisztens, de **nem az, amit a felhasználó kért**.
- **Javítás (src-tauri/src/pipeline.rs, szerep-utasítások):**
  - Tervező: „Az eredeti feladat számszerű paramétereit (tartományok, mértékegységek, darabszámok)
    szó szerint tartsd meg. Ha bármelyiket átértelmezed, tedd külön `## Eltérés a feladattól`
    blokkba, indoklással."
  - Bíráló: „Először az EREDETI FELADAT ellen ellenőrizz, csak utána a terv ellen: minden
    számszerű követelményt (tartomány, egység, darabszám) külön vess össze a megvalósítással.
    A terv hibája is hiba."
- Várt hatás: az ilyen csendes követelmény-drift vagy a tervben válik láthatóvá, vagy a
  bírálatban bukik el — nem a felhasználónál.

### Q2 · Amiben a lánc erős volt (megtartandó)

- A bíráló **maga futtatta** a teszteket (7 passed), független numerikus keresztellenőrzést
  csinált (5,7e−14 eltérés a naiv tan-alakhoz képest), és egy **valódi** paraméterezési bugot
  talált pontos sorszámokkal (`ChartPanel` a globálisokat használja az `args` helyett,
  `smith_tline_anim.py:147,150,154,157`), reprodukcióval. Ez a szint a cél — a Q1-es horgonyzási
  javítással együtt.
- A kód minősége jó: zárt alakú (szingularitásmentes) számítás, saját chart-rajzoló, HUD,
  CLI, GIF-fallback, 7 teszt, README. A két-paneles megoldása (rendszer- és vonal-referencia
  külön) ekvivalens a referencia-megoldásom két-nézetes váltójával — ezt a döntést a bíráló
  helyesen fogadta el dokumentált eltérésként.

### Q3 · Tempó (elvárás-beállítás, nem hiba)

Opus 5 · medium lánc: ~15 perc totál (TERV 1:16 + KÓD 7:35 + REVIEW 6:40, amiből 63 mp az F6).
A Codex-lánc ugyanerre 4–7 perc volt. Az F6-os fix ~1 percet visszaad; a többi a modell tempója.

## 5. Állapot: mind a 8 tétel megvalósítva (2026-07-30 este)

| # | Mit | Hol | Hat a ChatGPT-módra? |
|---|---|---|---|
| 1 | `TaskCreate`/`TaskUpdate` a checklist-eszközök; a híd vezeti a listát (`turn.tasks`, a task-azonosítót az eszköz eredményéből köti hozzá), és `turn/plan/updated`-ként küldi. A `TodoWrite` továbbra is működik. | agent-bridge/policy.mjs, main.mjs | nem |
| 2 | A bíráló friss sessionnel indul (ugyanazon a futtatón is) | src-tauri/src/pipeline.rs | **igen** (szándékosan) |
| 3 | Szerep-utasítások: a tervező szó szerint őrzi a feladat számszerű követelményeit és külön blokkban vallja be az eltérést; a bíráló ELŐBB az eredeti feladat ellen ellenőriz | src-tauri/src/pipeline.rs | **igen** (szándékosan) |
| 4 | Élő magyar narráció (új assistant-üzenet = az előző szövege biztosan narráció) + üzenetenkénti válasz-itemId (nincs egyberagadás) + a kártya lánc-szakasz futása közben a LÉPÉSEK-en marad | agent-bridge/main.mjs, src/App.tsx | a nézet-szabály igen, de Codexnél nincs mit elkapnia |
| 5 | Terv-RAW tördelés: a képlet-chipek törhetnek, a panel `min-width: 0` | styles.css | igen (mindkettőnél javít) |
| 6 | A fül-sáv közvetlenül az üzenetek lánc-metaadatából épül (hidratálástól függetlenül teljes) | src/App.tsx | igen (mindkettőnél javít) |
| 7 | Session-store mérés: lekérdezés- és kiírás-idő külön, válaszmérettel, 500 ms fölött naplóba | src-tauri/src/claude.rs | nem |
| 8 | Egymás utáni azonos parancs egy sor + `(n×)` szorzó | src/App.tsx | igen (kozmetika) |

Tesztek a változás után: 172 Rust, 62 timeline, 27 bridge — mind zöld (a bridge-hez új teszt:
a task-eszközök ugyanazt a lépéslista-alakot adják, a törölt elem kiesik).

## 5b. A javítások utáni futás leletei (2026-07-30, „Smith chart stuff 24")

| # | Tünet | Gyökérok | Javítás |
|---|---|---|---|
| U1 | A „készül" óra minden szakaszváltásnál nullázódott | a kártya órája a *szakasz* tervének kezdetétől járt, az pedig szakaszonként újraindul | a futó kártya megkapja a futás kezdetét (`runStartedAt`), és onnan számol; lezárt kártyák a saját szakaszidejüket tartják |
| U2 | A KÓD lépéslistája megjelent, majd fentről lefelé újra „kiíródott" | az F2-es javítás után a kódoló tényleg felveszi a checklistet — de elemenként, nyolc hívásban, és minden hívás egy-egy hosszabb listát küldött, ami lecserélte a hordozott tervet | ha a bejövő lista a hordozott tervet tükrözi, a lista NEM cserélődik: csak az állapotok kerülnek át rá (a pontok, azonosítók, sorrend maradnak) |
| U3a | KÓD közben a korábbi lépésekre nem lehetett kattintani | a tiltás csak a státuszt nézte (`pending` → nem kattintható), a nyomot nem | ami már írt magáról valamit (`hasTraceForStep`), az kattintható, státusztól függetlenül |
| U3b | TERV-ben a kijelölés végig az elsőn állt, majd a végén az utolsóra ugrott | a terv pontjaira is a „hol tart a munka" szabály futott (`inProgress` → utolsó kész lépés) | a terv pontjai nem munkafázisok: írás közben az utolsó megszületett pont, kész terven az első — olvasási sorrendben |
| U4 | A REVIEW LÉPÉSEK-nél a GONDOLKODÁS MENETE panel keskeny lett | a verdikt-sáv (`.pipeline-answer-next`) a kártya közvetlen gyereke, a LÉPÉSEK-nézet pedig rács — a sáv rácselemként a jobb hasábba ült be | a sáv saját, teljes szélességű sort kap (`grid-column: 1 / -1`); mérve: a panel 390 px → **1183 px** |

## 6. Prioritzált teendők (összefoglaló)

| # | Mit | Hol | Prio |
|---|---|---|---|
| 1 | TaskCreate/TaskUpdate engedélyezés + plan-leképezés | agent-bridge/policy.mjs, main.mjs | P1 |
| 2 | REVIEW szakasz friss sessionnel (60 mp-es load-állás ki) | src-tauri/src/pipeline.rs, lib.rs | P1 |
| 3 | Szerep-utasítások: számszerű követelmény-őrzés (terv + bíráló) | src-tauri/src/pipeline.rs | P1 |
| 4 | Élő magyar narráció csak-szöveg üzenetekből + üzenethatár a válasz-streamben | agent-bridge/main.mjs | P2 |
| 5 | Terv-RAW törésszabályok (overflow-wrap) | styles.css | P2 |
| 6 | Strip a messages-metaadatból (hidegindítási hiányzó fül) | src/App.tsx (stagesByChain) | P3 |
| 7 | Session-load Rust-oldali per-op mérés (bájtokkal) | src-tauri/src/claude.rs | P3 |
| 8 | Ismételt parancs-bullet „(n×)" jelölés | src/App.tsx | P3 |

## 7. Megjegyzés a mostani app-példányról

A most futó min-t én indítottam, két extra env-vel: `MIN_AGENT_BRIDGE_DUMP` (nyers esemény-dump)
és `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` (CDP-vezérléshez).
Egy sima újraindítás (parancsikon / start-min.cmd) mindkettőt elereszti — állandósítani nem kell.
