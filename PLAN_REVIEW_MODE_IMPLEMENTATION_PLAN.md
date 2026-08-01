# TERV REVIEW mód — implementációs terv

Állapot: **implementálva és automatizáltan ellenőrizve.**  
Dátum: 2026-07-31.

## 1. Döntés röviden

Új, külön választható Multi-AI recept készül:

```text
TERV → TERV REVIEW → VÁLASZ
```

Ez a mód **nem indít KÓD szakaszt**, és egyik agentnek sem enged projektfájlt
módosítani. A futam egy implementálható műszaki tervet készít, majd egy másik,
független agent ellenőrzi azt. A jelenlegi
`TERV → KÓD → REVIEW` recept változatlanul és alapértelmezettként megmarad.

Ez különösen fontos hardverközeli, forráskutatásos feladatoknál — például DIY
VNA esetén —, mert még alkatrészválasztás vagy kódolás előtt kiszűrhetők a hibás
feltételezések, hiányzó mérési/kallibrációs lépések, irreális specifikációk és a
forrásprojektek újrahasznosítási kockázatai.

## 2. Felhasználói működés

### 2.1 Módválasztás

A `Részletes + Multi-AI` beállításban a fix TERV–KÓD–REVIEW oszloprács KÓD
oszlopa kapja a módválasztó checkboxot:

- bepipálva: `TERV → KÓD → REVIEW` — ez marad az alapértelmezés;
- üresen: `TERV → TERV REVIEW` — tervezés és független tervbírálat,
  kódolás nélkül.

A KÓD oszlop üres állapotban is látható, így a teljes lánc egyetlen kattintással
visszakapcsolható, és nincs külön, helyet foglaló receptválasztó sor.

A kiválasztott receptet a kliens megjegyzi. A normál, a Részletes EGY-AI és a
meglévő Multi-AI működés nem változik meg attól, hogy az új recept bekerül.

### 2.2 Futás közbeni megjelenítés

Az új mód panelje három fület mutat:

```text
1/2 TERV | 2/2 TERV REVIEW | VÁLASZ
```

- A `TERV` fülön a tervező élő menete és végleges terve látszik.
- A `TERV REVIEW` fülön a bíráló saját, sorrendben végigjárt checklistje,
  megállapításai és verdiktje látszik.
- A `VÁLASZ` fül elsődleges tartalma maga a terv. Elfogadáskor zöld státusz
  jelzi, hogy a tervet a bíráló elfogadta; elutasításkor a javítandó tételek és
  az újratervezés gomb jelenik meg.

A TERV REVIEW nem kap RAW/DETAIL tervíró nézetet: az a `TERV` szerep sajátja.
A bírálat a KÓD/REVIEW-hoz hasonló, valódi lépéssávot kap.

### 2.3 Verdikt és újratervezés

A tervbíráló kötelező utolsó sora:

```text
VERDIKT: ELFOGAD — <egymondatos indok>
```

vagy:

```text
VERDIKT: JAVÍTANDÓ — <egymondatos indok>
```

`JAVÍTANDÓ` esetén a gomb neve:

```text
Újra a TERV-től (v2)
```

Az új kör:

1. megkapja az eredeti feladatot;
2. megkapja az előző tervet és a tervbíráló teljes kifogását;
3. újrafuttatja a `TERV`, majd a `TERV REVIEW` szakaszt;
4. ugyanabban a beszélgetéspanelben jelenik meg új verzióként;
5. legfeljebb a jelenlegi három körös korlátig ismételhető.

Elfogadott terv után nincs automatikus KÓD-indítás. A felhasználó később külön
kérheti az implementációt.

## 3. Recept és szerepmodell

### 3.1 Új beépített recept

Új receptazonosító:

```text
plan_review
```

Alapbeállításai:

| Szakasz | Alap agent | Modell / effort | Turn-limit | Tool profil |
|---|---|---|---:|---|
| TERV | Claude | a jelenlegi tervező-default | a jelenlegi tervező-limit | `read_only` |
| TERV REVIEW | ChatGPT/Codex | a jelenlegi review-default | 120 | `read_only` |

A második agent alapból másik runtime legyen, hogy valóban független szemmel
olvassa a tervet. A composer jelenlegi per-szakasz agent-, modell- és
effort-választása mindkét szakasznál működjön.

### 3.2 Új, külön szerep

A Rust `StageRole` új eleme `PlanReview`, wire-formája pedig pontosan
`plan_review` legyen. Nem szabad a meglévő `Review` szerepet újrahasznosítani,
mert annak feladata implementáció, diff és tesztek vizsgálata.

Az új szerep tulajdonságai:

- UI-címke: `TERV REVIEW`;
- artifact-címke: `A terv bírálata`;
- tool profil: `ReadOnly`;
- verdictet tartalmazó review-szerep;
- mindig friss sessionből indul, akkor is, ha ugyanaz a runtime készítette a
  tervet;
- rendezett checklistet használ, de projektfájlt nem ír és parancsot nem futtat.

A compound enumérték miatt a role wire-nevét nem
`format!("{:?}").to_lowercase()` módszerrel kell előállítani, mert abból
`planreview` lenne. Egy explicit `StageRole::as_wire()` adja a stabil
`plan_review` értéket minden progress-, message- és store-útvonalon.

### 3.3 Recept-metaadat

A jelenlegi recept csak szakaszlistát tárol, miközben a kliens a KÓD kimenetét
és a KÓD-tól újrafuttatást feltételezi. A recept kapjon explicit viselkedési
metaadatot:

```text
outputRole: plan | code
retryFromRole: plan | code
reviewTarget: plan | implementation
```

Értékek:

| Recept | outputRole | retryFromRole | reviewTarget |
|---|---|---|---|
| `plan_review` | `plan` | `plan` | `plan` |
| `plan_code_review` | `code` | `code` | `implementation` |

Ezzel nem a szakaszok számából vagy sorrendjéből kell kitalálni, mit mutasson a
VÁLASZ fül és honnan induljon egy javítókör.

## 4. A tervbíráló promptja

A TERV REVIEW prompt az eredeti feladatot kapja meg először, szó szerint; utána
a TERV szakasz artifactját. A szereputasítás mondja ki, hogy a bíráló:

1. független műszaki tervbíráló, nem a terv szerzője;
2. nem írhat kódot vagy fájlt, és nem futtathat parancsot;
3. az első workspace-/webes vizsgálat előtt 3–6 pontos checklistet hoz létre;
4. egyszerre pontosan egy checklist-elemet tart `in_progress` állapotban;
5. először az eredeti feladat ellen ellenőriz, és csak utána vizsgálja a terv
   belső konzisztenciáját;
6. külön választja a blokkoló hibákat és a nem blokkoló ajánlásokat;
7. bizonyítékokra és ellenőrizhető forrásokra támaszkodik;
8. a kötelező, géppel felismerhető verdiktsorral zár.

Minimum ellenőrzési szempontok:

- követelmény-lefedettség és visszakövethetőség;
- számszerű értékek, tartományok, mértékegységek és toleranciák;
- kimondatlan feltételezések és még eldöntendő kérdések;
- architektúra, interfészek és megvalósíthatóság;
- mérési, kalibrációs, verifikációs és hibakeret-stratégia;
- biztonság, hibautak, gyárthatóság és beszerzési kockázat;
- külső GitHub projektek forrásminősége, licence és az átvétel határai;
- hiányzó alternatívaelemzés és a terv legkockázatosabb pontjai.

A Claude `read_only` profiljában a Read/Glob/Grep és WebSearch/WebFetch már
rendelkezésre áll, míg Edit/Write/Bash nincs. Codex esetén a read-only sandbox
garantálja a nem írást. A forráskutatás engedélyezett, a projekt módosítása nem.

## 5. Backend-változások terve

### 5.1 `src-tauri/src/pipeline.rs`

- `StageRole::PlanReview` és az explicit `as_wire()` bevezetése.
- Segédpredikátumok: `is_review_role()` és `starts_fresh_session()`; mind a
  `Review`, mind a `PlanReview` verdiktet ad és független sessionből indul.
- A `PlanReview` külön promptja, artifact-címe és `ReadOnly` tool profilja.
- A strict step-tracking protokoll kiterjesztése a tervbírálatra.
- A verdict-parser futtatása mindkét review-szerepnél.
- A `plan_review` recept és a recept-metaadatok hozzáadása.
- Receptvalidáció:
  - `PlanReview` előtt legyen `Plan`;
  - implementáció-review előtt legyen `Code`;
  - a deklarált output- és retry-szerep létezzen a receptben;
  - továbbra is legfeljebb egy KÓD szakasz lehessen.
- A meglévő `plan_code_review` működése és alapbeállításai maradjanak
  változatlanok.

### 5.2 `src-tauri/src/lib.rs`

- Minden eltárolt és kiküldött role-név az új `as_wire()` függvényt használja.
- A PlanReview ugyanúgy kapja meg az eredeti feladatot és a terv artifactját,
  de sessiont nem örököl a tervezőtől.
- A tervnapló ne csak `StageRole::Review` eredményt keressen, hanem a recept
  review-célja alapján a megfelelő bírálatot.
- A naplófejlécek legyenek egyértelműek:
  - `## v1 tervbírálat` a `plan_review` receptben;
  - `## v1 kódbírálat` a teljes receptben.
- Az agentek által végzett változtatások továbbra is egy közös snapshotban
  futnak; a runner által létrehozott tervfájl az egyetlen szándékos fájlváltozás
  a TERV REVIEW módban.

### 5.3 Tárolás és szinkron

A `pipeline_runs.recipe_json` már eltárolja a tényleges receptet, ezért ehhez
nem kell új adatbázistábla. A történeti üzeneteknek azonban ismerniük kell a
receptet, hogy egy későbbi újrafuttatás ne a composer pillanatnyi választását
használja.

A `LocalMessagePipeline` / frontend `MessagePipeline` kapjon legalább
`recipeId` mezőt. A régi üzeneteknél ez opcionális; kompatibilis fallbackként a
szakaszszerepekből rekonstruálható a régi `plan_code_review` recept.

A syncelt message JSON mezőbővítése miatt külön SQLite-oszlop és destruktív
migráció nem szükséges. Round-trip teszt igazolja, hogy a `recipeId` a lokális
mentésen és a syncen át is megmarad.

## 6. Frontend-változások terve

### 6.1 Típusok és címkék

Az összes szűkített role union bővüljön `plan_review` értékkel:

- `PipelineRecipeStage.role`;
- `PipelineProgressEvent.role`;
- `PipelineStageResult.role`;
- `STAGE_ROLE_LABELS`;
- `PRE_PLAN_STEP_LABELS`.

A TERV-specifikus RAW/DETAIL logikát továbbra is kizárólag a `plan` role
aktiválja; a `plan_review` a review-checklist UI-t használja.

### 6.2 Receptválasztás és futó recept rögzítése

- A KÓD-checkbox és a fix háromoszlopos rács csak `Részletes + Multi-AI` módban
  jelenjen meg.
- Az utolsó receptazonosító localStorage-ban megmaradjon.
- Küldéskor a tényleges recept teljes snapshotja kerüljön a futó run-state-be.
- A futó és történeti panel mindig a saját receptjéből rajzolja a füleket,
  akkor is, ha a felhasználó közben átállítja a composert.
- A per-stage override-ok meglévő `recipeId:stageIndex` kulcsozása megmaradhat;
  így a két recept beállításai nem írják felül egymást.

A composer fix háromoszlopos rácsot használ: a TERV és a bírálati oszlop mindig
kap beállításokat, a KÓD oszlop pedig checkboxként is működik. A KÓD nélküli
állapotban az oszlop üres/letiltott helyőrző marad, így nem ugrik el a composer.
Vizuális teszt ellenőrzi a rácsot és a mobil szélességet.

### 6.3 Receptfüggő VÁLASZ és fájlpanel

A jelenlegi összegzés a KÓD szakaszt tekinti válasznak, a change summaryt pedig
mindig a KÓD kártyához köti. Ezt a recept `outputRole` mezője vezérelje:

- teljes recept: a KÓD összefoglalója marad a VÁLASZ;
- TERV REVIEW: a TERV szövege legyen a VÁLASZ;
- a verdikt footer szövege a `reviewTarget` alapján beszéljen tervről vagy
  implementációról;
- ha nincs KÓD szakasz, a runner által létrehozott tervfájl change summaryja a
  TERV kártyához tartozzon, ne vesszen el a `codeStageIndex == -1` eset miatt.

### 6.4 Általános újrafuttatás

A `rerunChainFromCode` helyett receptvezérelt `rerunChainFromReview` készüljön:

- mindig a történeti lánc saját `recipeId`-ját használja;
- `retryFromRole` alapján választja a kezdőszakaszt;
- a megfelelő review-role legfrissebb kifogását adja át;
- a kezdőszakasz előtti elfogadott artifactokat viszi tovább;
- a gombcím, tooltip és footer a `reviewTarget` alapján változik;
- a három iterációs limit mindkét receptnél változatlanul érvényes.

A meglévő teljes recept újrafuttatása továbbra is KÓD-tól induljon, és ugyanazt
a v1 tervfájlt naplózza. A TERV REVIEW újrafuttatása viszont TERV-től induljon,
ezért új tervfájlt kapjon.

## 7. Tervfájl-verziózás

Első kör:

```text
tervek/2026-07-31-<slug>-v1.md
```

Elutasított terv javított köre:

```text
tervek/2026-07-31-<slug>-v2.md
```

Minden fájl a saját tervverzióját és a hozzá tartozó tervbírálatot tartalmazza.
Nem szabad az új TERV kimenetét a v1 fájl végére nyersen hozzáfűzni, mert a
jelenlegi plan-writer append módban nyitja meg a fájlt, és így két terv
összemosódna.

Szabályok:

- a teljes `TERV → KÓD → REVIEW` javítóköre továbbra is ugyanazt a v1 tervet
  őrzi, mert ott a TERV nem fut újra;
- a `TERV → TERV REVIEW` minden újratervezési köre új `-vN.md` fájlt kap;
- az új fájl naplózza, hogy az előző tervbírálat mely kifogását orvosolja;
- a régi tervverziók megmaradnak, így a döntési történet auditálható;
- a PLAN/terv `.md` fájlok továbbra is normál projektfájlok, tehát egy későbbi
  commitba bekerülhetnek.

## 8. Tesztterv

### 8.1 Rust unit- és integrációs tesztek

- A `PlanReview` serde round-tripja pontosan `plan_review`.
- A PlanReview `ReadOnly`; nem kap Edit/Write/Bash jogosultságot.
- A PlanReview friss sessionből indul még azonos provider/runtime mellett is.
- A prompt sorrendje: eredeti feladat → terv artifact → szereputasítás.
- A prompt tartalmazza a terv-specifikus ellenőrzési szempontokat és a strict
  checklist-protokollt.
- Mindkét review-role verdiktje felismerhető.
- A hibás receptvalidációk elutasításra kerülnek.
- A két beépített recept megvan, a régi recept változatlan marad.
- A tervnapló a megfelelő `tervbírálat`/`kódbírálat` blokkot írja.
- A v2 újratervezés nem ír bele a v1 tervfájlba.
- A `recipeId` message/store/sync round-tripja megmarad.

### 8.2 Frontend tesztek

- A KÓD checkbox a két recept között vált, és csak Multi-AI módban látható.
- A `plan_review` panel két szakaszfület és VÁLASZ fület rajzol.
- Elfogadáskor a VÁLASZ a tervet és az elfogadott státuszt mutatja.
- Elutasításkor `Újra a TERV-től (v2)` jelenik meg.
- A teljes receptnél továbbra is `Újra a KÓD-tól (v2)` jelenik meg.
- A történeti lánc újrafuttatása nem a composer aktuális receptjét használja.
- A futó panel szakaszai nem változnak meg a KÓD checkbox menet közbeni átállítására.
- A tervfájl change summaryja PlanReview módban a TERV szakasznál jelenik meg.
- Régi, `recipeId` nélküli pipeline-üzenetek változatlanul renderelődnek.

### 8.3 Manuális acceptance tesztek

1. Egy tisztán szoftveres feladat TERV REVIEW módban: létrejön terv és verdikt,
   forráskód nem változik.
2. Egy forráskutatásos DIY VNA feladat: a review ellenőrzi a frekvenciatartományt,
   dinamikatartományt, iránycsatolót/bridge-et, ADC/LO architektúrát,
   kalibrációt, hibakeretet, GitHub-forrásokat és licenceket.
3. Szándékosan hiányos terv: `JAVÍTANDÓ`, majd v2-ben új TERV és új tervfájl.
4. Claude tervező + ChatGPT tervbíráló, majd fordított agentkiosztás.
5. A meglévő `TERV → KÓD → REVIEW` teljes smoke tesztje regresszió nélkül.
6. App-újraindítás és másik gépről betöltés: a recept és a két szakasz helyesen
   rekonstruálódik.

## 9. Implementációs sorrend

1. Role- és recipe-modell: `PlanReview`, wire-forma, metaadatok, validáció.
2. PlanReview prompt, tool-profil, session-izoláció és verdict-feldolgozás.
3. Plan-file naplózás és külön vN fájlok az újratervezési körökhöz.
4. `recipeId` perzisztencia és backward-compatible store/sync kezelés.
5. Frontend role-típusok, címkék és KÓD-checkboxos receptváltás.
6. Recepthez kötött live/historical run-state és dinamikus VÁLASZ fül.
7. Általános, receptvezérelt újrafuttatás.
8. Unit-, integrációs és frontend tesztek.
9. Manuális smoke a normál szoftveres és a DIY VNA forgatókönyvvel.

## 10. Várhatóan érintett fájlok

- `src-tauri/src/pipeline.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/store.rs`
- `src/App.tsx`
- `styles.css`
- a kapcsolódó Rust-, frontend- és bridge-tesztek

Az `agent-bridge/policy.mjs` működését várhatóan nem kell módosítani, mert a
szükséges `read_only` profil és a webes olvasóeszközök már léteznek; csak a
PlanReview szerepet kell ehhez a profilhoz kötni.

## 11. Nem része ennek az implementációnak

- Automatikus továbblépés elfogadott tervről KÓD-ra.
- A négylépcsős `TERV → TERV REVIEW → KÓD → REVIEW` recept. A mostani
  metaadat-alapú kialakítás ezt később lehetővé teszi, de külön UX- és
  artifact-átadási döntést igényel.
- Párhuzamosan futó több tervbíráló vagy többségi szavazás.
- A bíráló által végzett „mellékes” fájljavítás.
- Források automatikus megbízhatósági pontozása.

## 12. Kész definíció

Az implementáció akkor tekinthető késznek, ha:

- a felhasználó külön kiválaszthatja a `TERV REVIEW` receptet;
- a futam TERV-et és független TERV REVIEW-t készít, KÓD nélkül;
- egyik agent sem tud projektfájlt módosítani;
- a bíráló lépései élőben, sorrendben követhetők;
- a VÁLASZ a tervet és annak verdiktjét mutatja;
- elutasítás után v2 terv készül külön `-v2.md` fájlban;
- a történeti és szinkronizált panelek a saját receptjüket őrzik;
- a meglévő TERV–KÓD–REVIEW és az EGY-AI módok regresszió nélkül működnek;
- minden automatizált teszt és a két manuális smoke forgatókönyv sikeres.

---

## 13. Megvalósítási állapot

Az implementáció elkészült. A recept-metaadatok (`outputRole`, `retryFromRole`,
`reviewTarget`) explicit módon bekerültek a backend/frontend receptmodellbe,
miközben a korábbi, metaadat nélküli pipeline-üzenetekhez kompatibilis fallback
maradt. A TERV promptja és a terv-lépcső feldolgozása nem kényszerít többé
nyolc/tizenkét pontos felső korlátot; a lépésszámot a modell határozza meg.

Automatikusan ellenőrizve:

- frontend build: sikeres;
- timeline tesztek: 81/81 sikeres;
- Claude bridge tesztek: 34/34 sikeres;
- Rust tesztek: teljes suite 176/176, valamint a recept-metaadat wire-teszt
  célzott futásban 1/1 sikeres.

Manuális acceptance smoke futtatása még külön, élő agent-kvótás futamként
szükséges.
