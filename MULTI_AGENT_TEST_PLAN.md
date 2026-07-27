# TERV → KÓD → REVIEW — bulletproof tesztterv

Cél: a lánc **bizonyítottan** működjön, ne csak lefusson egyszer. Dátum: 2026-07-26.
Elv: minden állításhoz bizonyíték (SQL-lekérdezés, journal-számlálás, screenshot vagy
teszt-kimenet). Ami nem ellenőrizhető, az nincs kész — ezt a leckét ma kétszer
tanultuk meg (mérőszám ≠ ránézés; "lefordul" ≠ "működik").


## Állapot (2026-07-27)

| Teszt | Állapot | Megjegyzés |
|---|---|---|
| U0 kiemelés | ✅ | `pipeline::run_stages`, injektált executorral |
| U1, U1b session-öröklés | ✅ | |
| U2 artefaktum-lánc | ✅ | |
| U3 hiba megállítja a láncot | ✅ | |
| U4, U4b felülbírálások | ✅ | **hibát talált:** a gyártó-csere sosem működött |
| U5 request_ids ellenőrzés | ⬜ | |
| U6 képek csak az elsőnek | ✅ | |
| U7 JAVÍTANDÓ = completed | ✅ | |
| U8, U8b futam-helyreállítás | ✅ | **hibát talált:** a futam lelőtte magát |
| U9 kanonikus id | ⬜ | a függvény globális store-t nyit, előbb ki kell emelni |
| U10 verdikt-fixture-ök | 🔄 | az L1 review-szövege felhasználható |
| I1 jelvény a journalon | ✅ | |
| I2 jelvény-öröklés merge-en | ✅ | **hibát talált:** a jelvény eltűnt |
| I3 három szakasz = három válasz | ✅ | |
| **L1 teljes lánc** | ✅ | lent részletezve; a bíráló megfogta a kódoló hamis sikerjelentését |
| L2 terv nem ír | ✅ | az L1 mellékesen igazolta |
| L3 Claude-bíráló tesztet futtat | ⬜ | |
| L4 JAVÍTANDÓ-ág szándékosan | ⬜ | az L1 véletlenül produkálta, de nem célzottan |
| L5 hibás szakasz | ⬜ | |
| L6 újraindítás lánc közben | ⬜ | |
| L7 megszakítás | 🔄 | a lánc-megszakítás megvan (`l7`, `l7b`); az élő futás sorra vár |
| L8 budget subscription alatt | ⬜ | |
| L9 interaktivitás | 🔄 | a jóváhagyás-ág élesben lefutott; kérdés-ág nem |
| L10 újragenerálás | ⬜ | |
| X1–X3 másik gép | ⬜ | |

Menet közben javított defektek, mind teszttel rögzítve: futam öngyilkosság ·
jóváhagyásra váró turn halála · néma gyártó-csere · elvesző jelvény.

Az éjszakai automata sor (2026-07-27) két továbbit talált, mindkettőt a saját
futásán, nem elemzésből:

- **A stop gomb hibának számított.** A leállítás a szolgáltatónál megszakított
  kérésként csapódik le, így a szakasz hibát adott vissza, és a futam `failed`
  lett „A Claude-kérés megszakítva" indoklással — vagyis a program a felhasználó
  ellen könyvelte el, hogy megnyomta a gombot. Javítva (`e78b1d0`), teszt: `l7b`.
- **Egy lánc után a szerkesztő némán megtagadta a küldést.** A lánc szakaszonként
  külön request id-vel fut, a turn-lezáró reset viszont a beküldés id-jére van
  kötve, így lánc után soha nem futott le: az `isStreaming` és a submit-zár bent
  ragadt. A gomb késznek látszott, és minden további üzenetet eldobott app-
  újraindításig — a funkció indításonként egyszer volt használható. Javítva
  (`0efcd2f`). Ezt a defekt maga rejtette el: az utána következő teszteket is
  ő tette tönkre, amíg a küldés eredménye nem került a naplóba.

## 0. Kiindulási állapot — mi van már lefedve és mi nincs

| Réteg | Van | Nincs |
|---|---|---|
| pipeline.rs tiszta függvények | 8 teszt (prompt, vágás, verdikt, állapotgép, presetek) | — |
| Bridge tool-profilok | 3 teszt | a profil tényleges átjutása a `query()`-ig |
| Store | jelvény round-trip, kanonikus id visszaadása *(új, teszteletlen)* | `fail_interrupted_pipeline_runs` |
| **Runner (`pipeline_send`)** | **semmi** | session-öröklés, artefaktum-lánc, hiba-megállás, felülbírálások |
| **Élő 3 szakaszos lánc** | **soha nem futott** | minden |
| Sync | jelvény a message-oszlopban | jelvény túlélése reducer-merge-ön |
| Frontend lánc-út | semmi | kapcsoló → futtatás → megjelenítés |

## 1. Előfeltételek (minden élő teszt előtt)

- [ ] `npm run build` **ÉS** `cargo build` — a frontend a binárisba van ágyazva; e nélkül a régi UI fut (ma kétszer szívtunk ezzel).
- [ ] Az app a friss binárisból fut, CDP porttal (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`).
- [ ] DB-mentés: `Copy-Item $env:LOCALAPPDATA\min\min.db $env:LOCALAPPDATA\min\min.db.pre-test`.
- [ ] **Fixture-reset szkript** (minden L-teszt előtt lefut):
  - `claude-fixture/math.js` visszaírása a hibás állapotra:
    `const add = (a, b) => a + b;` + `const multiply = (a, b) => a + b;` (+ export)
  - `math.test.js` létezik és a multiply-t is teszteli (a JAVÍTANDÓ-ághoz kell).
- [ ] Journal-alapvonal rögzítése: a legmagasabb event-sequence feljegyzése
  (`ls .min-sync/v2/events/<device>/ | tail -1`) — minden teszt után delta-mérés.

## 2. U — Unit tesztek (Rust), ELŐBB ezek

A runner ma egy 150 soros ciklus a `lib.rs`-ben, tesztelhetetlenül. **U0 = kiemelés:**
a ciklus magja `pipeline::run_stages(recipe, inputs, executor)` alakú legyen, ahol az
`executor` egy injektált closure (a valódi híváshelyen `run_agent_turn`). Ez nem
refaktor öncélból: e nélkül az összes alábbi eset csak élő API-hívással tesztelhető.

| ID | Mit bizonyít | Elvárás |
|---|---|---|
| U1 | Session-öröklés futtatókörnyezetenként | Fable(plan)→Opus(code): a 2. szakasz **ugyanazt** a session id-t kapja, amit az 1. visszaadott; a Codex-szakasz sosem kap Claude-sessiont |
| U2 | Artefaktum-lánc | a 3. szakasz promptja tartalmazza az 1. ÉS 2. szakasz szövegét, fejlécekkel, az eredeti feladat legelöl |
| U3 | Hiba megállítja a láncot | 2. szakasz hibája után a 3. executor **nem hívódik meg**, futam `failed`, 1. szakasz eredménye megmarad |
| U4 | Felülbírálások | modell/effort/gyártó-csere alkalmazódik; gyártóváltás runtime-ot vált és Claude-modellt töröl Codexnél |
| U5 | request_ids ≠ szakaszszám → elutasítás | hibaüzenet, semmi nem indul |
| U6 | Képek/kontextus csak az 1. szakasznak | 2-3. szakasz kérése üres images/context |
| U7 | JAVÍTANDÓ verdikt = completed futam | státusz `completed`, verdikt eltárolva |
| U8 | `fail_interrupted_pipeline_runs` | running futam induláskor `failed` + magyar hibaszöveg |
| U9 | Kanonikus id visszaadása | `label_pipeline_stage_answer` a most jelölt sor id-jét adja; nincs sor → `None` |
| U10 | Verdikt-parser bővítés | minden élő futás review-szövege bekerül fixture-ként (visszacsatolás: L-tesztek táplálják) |

## 3. I — Integrációs tesztek (sync, in-memory)

| ID | Mit bizonyít | Megjegyzés |
|---|---|---|
| I1 | A jelvény túléli a journal round-tripet | message.upsert → reducer → snapshot: `pipeline` mező érintetlen |
| I2 | **GYANÚS LYUK:** újra-publikálás jelvény nélkül | a `merge_message_versions` (sync.rs) és `merge_snapshot_message_versions` (store.rs) **nem örökíti** a `pipeline` mezőt úgy, mint a `detailed`-et — ha egy későbbi, jelvény nélküli másolat magasabb ranggal érkezik, a reducer-kimenetben a jelvény eltűnhet (az SQL COALESCE lokálisan véd, a snapshot-réteg nem). Teszt: settled válasz jelvénnyel + újabb rangú másolat jelvény nélkül → a jelvény maradjon. **Ha bukik: javítás ugyanazzal a mintával, mint a detailed.** |
| I3 | Vegyes lánc a store-ban | 3 szakasz-üzenet 3 külön turnnel: coalesce után 3 sor, sorrendben |

## 4. L — Élő tesztek (CDP-vezérelt GUI, fixture-projekt)

Minden L-teszt után **kötelező integritás-őr** (szkriptelve, ld. 6. pont).

### L1 — TELJESÍTVE (2026-07-27), négy defekt árán

**Eredmény:** a lánc végigfut (`completed`, 3/3), és a bíráló *megfogta a kódoló
hamis sikerjelentését*: a KÓD azt írta, „2 teszt, 2 pass", a Codex-review
lefuttatta és `1 fail (9 !== 20)`-t talált → `VERDIKT: JAVÍTANDÓ`. A `math.js`
tényleg javítatlan maradt. Egy-agentes futásnál ez a hamis „kész" lett volna a
végeredmény. Az L2 is teljesült: a terv-szakasz egyetlen fájlt sem módosított.

**Amit az öt nekifutás kiderített (mind javítva):**
1. A futam lelőtte magát: az újraindítás-felismerő minden store-nyitáskor futott.
2. A jóváhagyásra váró turn 10 perc után meghalt — az idle-óra nem tudta, hogy
   emberre vár. Nem lánc-specifikus.
3. `apply_stage_overrides` sosem olvasta a `provider` mezőt: a GUI gyártó-cellája
   semmit nem csinált.
4. A szakasz-jelvény nem élte túl a merge-et.

**Cáfolt hipotézisek** (mind a három tévedés volt, mielőtt ránéztem a képernyőre):
modellváltás resume-on · újrahasznált bridge-folyamat · sérült session.

### L1 (eredeti leírás) — teljes Terv → Kód → Review lánc
1. Fixture-reset. Pipa ✓, MULTI-AI, alapértelmezett lánc (Fable/max → Opus/medium → Codex Sol/medium).
2. Prompt: *"A math.js-ben a multiply összead. Javítsd meg, és győződj meg róla, hogy a tesztek zöldek."*
3. **Elvárt:** 3 szakasz fut végig; a composer-státuszsor lépked (1/3 → 2/3 → 3/3).
4. **Bizonyíték:**
   - DOM: 3 jelvény (`1/3 TERV · Claude · Fable 5`, `2/3 KÓD · Claude · Opus 5`, `3/3 REVIEW · Codex`), a review-n verdikt-jelvény;
   - a review-szöveg a DOM-ban **pontosan egyszer** szerepel (dedup-fix regressziója!);
   - SQL: `SELECT turn_id, COUNT(*) FROM messages WHERE role='assistant' AND pipeline_json IS NOT NULL GROUP BY turn_id` → minden érték 1;
   - `pipeline_runs.status='completed'`, `current_stage=2`;
   - a KÓD-kártyán FÁJLOK/VÁLTOZÁSOK (+1 −1) és Visszavonás gomb;
   - `math.js` ténylegesen javítva (fájl-hash), `node --test` zöld;
   - a terv-szakasz guardja **nulla** változott fájlt jelent.
5. **Rögzítendő:** a review nyers szövege → U10 parser-fixture.

### L2 — Terv-szakasz nem tud írni (kikényszerítés, nem ígéret)
- Prompt, ami kifejezetten csábít: *"Azonnal javítsd a math.js-t, ne tervezgess."*
- Elvárt: az 1. szakasz akkor sem ír, ha akarna — a `math.js` hash a szakasz alatt változatlan, a guard 0 fájlt jelent, a bridge-diagnosztika `toolProfile: read_only`-t és csökkentett toolCount-ot mutat.
- A fájlt végül a 2. szakasz javítja (a lánc egésze sikeres).

### L3 — Claude-reviewer tesztet futtat, de nem szerkeszt
- A REVIEW gyártóját a GUI-ban Claude-ra léptetjük.
- Elvárt: a 3. szakasz work itemjei közt **van Bash** (`node --test`), a verdikt a tényleges tesztkimenetre hivatkozik; a szakasz alatt fájl-hash változatlan.

### L4 — JAVÍTANDÓ ág
- Fixture-reset + a `divide` függvénybe is ugyanaz a hiba, de a prompt csak a multiply-ról szól, a tesztfájl viszont a divide-ot is fedi.
- Elvárt: sárga `JAVÍTANDÓ` jelvény, tooltipben az indok; futam `completed` (a verdikt eredmény, nem hiba); NEM indul automatikus javító-kör.

### L5 — Hibás szakasz megállítja a láncot
- CDP-ből direkt `pipeline_send` hívás, a review szakasz modellje szándékosan
  létező-de-hibás (pl. üres string vagy `gpt-nemletezik`).
- Elvárt: 1-2. szakasz eredménye megvan és látszik; futam `failed`, a 3. szakasz
  hibaszövege magyar és konkrét; a UI nem pörög tovább.

### L6 — Újraindítás lánc közben
- L1 indítása, az app kilövése a 2. szakasz alatt (`Stop-Process`).
- Elvárt újraindulás után: `pipeline_runs.status='failed'`, error = "A lánc újraindítás miatt megszakadt."; az 1. szakasz válasza látszik jelvénnyel; nincs örök spinner; a turns-orphan-recovery a 2. szakasz turnjét is lezárta.

### L7 — Megszakítás gomb lánc közben *(ismert rés!)*
- A Claude-oldali cancel ma hibát dob ("a megszakítás a live runtime bekötésével aktiválódik"), és a runner ciklusát semmi nem állítja meg.
- **Először dönteni kell:** (a) a Megszakítás a futó szakasz után ne indítson újabbat (minimum), vagy (b) valódi szakasz-cancel. A teszt az elfogadott viselkedést rögzíti. Addig a terv szerint ez **defekt, nem teszteset**.
- Elvárt (minimum-változat): kattintás után a hátralévő szakaszok nem indulnak, futam `cancelled`, UI "kihagyva" jelöléssel.

### L8 — Subscription + budget nem üti ki a szakaszt
- A pipeline-kérés ma feltétel nélkül továbbadja a `claudeBudgetUsd`-t minden szakasznak; a védelem a bridge `budgetOption`-jában van. Elvárt: subscription módban egyik Claude-szakasz sem hal el budget-hibával; a bridge-diagnosztika mutatja, hogy a budget ki lett hagyva.

### L9 — Interaktivitás a láncban (opcionális, de ajánlott)
- L9a: a terv-szakasz kérdez (AskUserQuestion) → a lánc várakozik, válasz után folytat.
- L9b: a kód-szakasz Bash-jóváhagyást kér → jóváhagyás után folytat; elutasításnál értelmes hibaút.

### L10 — Újragenerálás kizárása
- Egy szakasz-válasz Újragenerálás gombja: elvárt, hogy sima egy-agentes turnként fusson (a runPipeline kizárja a regenerációt), és **ne** rontsa el a futam-jelvényeket. Ha az eredmény zavaros (jelvényes választ jelvénytelen vált fel), defektként rögzíteni és dönteni: gomb rejtése szakasz-kártyán vs. teljes futam újrafuttatása.

## 5. X — Cross-device (a másik gép)

| ID | Mit bizonyít | Elvárás |
|---|---|---|
| X1 | Kész futam renderelése | L1 után sync: a másik gépen ugyanaz a 3 kártya, jelvények, verdikt; review egyszer |
| X2 | Nincs visszhang-regresszió | a futam publish-e utáni journal-delta < 100 event, ismételt publish 0 |
| X3 | Jelvény-tartósság | a másik gép publish-e után ITT sem tűnik el a jelvény (I2 élő párja) |

## 6. Integritás-őr (minden L-teszt után, szkriptelve)

```sql
-- 1 válasz / turn (dedup-regresszió)
SELECT turn_id, COUNT(*) c FROM messages WHERE role='assistant'
GROUP BY conversation_id, turn_id HAVING c > 1;          -- elvárt: üres
-- fosszília-őr (válasz a kérdése előtt)
SELECT COUNT(*) FROM messages a JOIN messages q
  ON q.conversation_id=a.conversation_id AND q.turn_id=a.turn_id AND q.role='user'
WHERE a.role='assistant' AND a.sequence < q.sequence;    -- elvárt: 0
-- futamok lezárva
SELECT COUNT(*) FROM pipeline_runs WHERE status='running'; -- elvárt: 0 (app leállás után)
```
Plusz: journal-delta számlálás; fixture-diff csak a várt fájlokra.

## 7. Kapu — mikor mondjuk ki, hogy "működik"

Minden sor zöld, bizonyítékkal:

- [ ] U0–U10 megírva és zöld (cargo)
- [ ] I1–I3 zöld; ha I2 bukott, a javítás + újrafutás után zöld
- [ ] L1 kétszer egymás után zöld (nem véletlen siker)
- [ ] L2, L3, L4, L5, L6, L8 zöld
- [ ] L7 döntés megszületett és implementálva/tesztelve
- [ ] X1–X3 zöld a másik gépen
- [ ] Teljes regresszió: cargo (135+új), bridge 26, frontend 37+új, fmt tiszta
- [ ] Integritás-őr minden élő teszt után üres/0

## 8. Ismert kockázatok, amiket a terv céloz

1. **A 3 szakaszos lánc még sosem futott** — az L1 az igazi első próba; reális, hogy a Fable-modellazonosítót vagy a Codex-review promptját javítani kell.
2. **I2: jelvény-öröklés hiánya a merge-ekben** — gyanús, célzott teszt dönt.
3. **L7: nincs lánc-megszakítás** — ez ma defekt, nem hiányzó teszt.
4. **Budget-átadás** minden szakasznak — a bridge-védelemre támaszkodik, L8 igazolja.
5. A runner tesztelhetetlen alakja — U0 kiemelés nélkül a terv fele nem végrehajtható.

## 9. Végrehajtási sorrend és becslés

1. U0 kiemelés + U1–U9 (a legolcsóbb, a legtöbb hibát itt fogjuk meg)
2. I1–I3 (I2 valószínű javítással)
3. L1 kétszer (első élő futás — itt derül ki minden)
4. L2–L6, L8 · 5. L7 döntés+implementáció · 6. L9–L10 · 7. X1–X3 · 8. Kapu-ellenőrzés

Egy ülésben: U+I. Külön ülésben: L-sor (élő futások lassúak, szakaszonként 1–3 perc).
