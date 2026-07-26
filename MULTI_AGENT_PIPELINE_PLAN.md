# Multi-agent (Codex + Claude) pipeline — megvalósítási terv

Állapot: **terv, kód még nincs.** Dátum: 2026-07-26. **V2 — a megbeszélt döntésekkel frissítve.**

## V2 döntések (felülírják a lenti részleteket, ahol ütköznek)

1. **Per-szakasz modell és effort is választható**, nem csak agent. Pl. Terv =
   Claude **Fable**, Kód = Claude **Opus 5**, Review = **Codex**. Kulcs-belátás:
   azonos runtime-on belüli modellváltás **nem veszít kontextust** — a Claude
   session turnönként más modellel folytatható, a session emlékszik. A "lossy
   átadás" kockázat csak runtime-váltásnál él (ott az artefaktum-blokk visz).
   Ebből következik az ajánlott fő preset: **Terv(Claude/Fable) →
   Kód(Claude/Opus 5, ugyanaz a session) → Review(Codex, független)** — a
   szerző-oldal folytonos, a bíráló-oldal idegen szem.
2. **GUI: a Részletes pipa bővül.** Pipa nélkül = mai kompakt egy-agent mód.
   Pipa bepipálva megjelenik egy kétállású csúszka:
   `Részletes ◄──► Multi-AI`. Bal = mai részletes egy-agent; jobb = pipeline a
   beállításokban konfigurált recepttel. A választás üzenetenként tárolódik és
   syncel (a meglévő `detailed` + új `pipeline` mezőkön). A recept részletei
   (szakaszok, agent/modell/effort) a Beállításokban élnek, a composer tiszta
   marad.
3. **A review tömör:** alapból egyetlen sor (verdikt-jelvény + egymondatos
   indok), kattintásra nyílik ki. Háromszoros szövegmennyiséget senki nem olvas
   végig naponta.
4. **Reviewer és tesztfuttatás:** Claude-reviewer kaphat Bash-t Edit/Write
   nélkül (a tool-lista granuláris → kikényszeríthető "futtass, de ne írj").
   A Codex-sandbox durvább (read-only VAGY workspace-write), ezért a
   Codex-reviewer read-only marad, és a teszteredményt a Kód-szakasz
   artefaktuma hozza (a kódoló amúgy is lefuttatja a teszteket).
5. **F2-be bekerül a párhuzamos OLVASÁS** (több lencsés review, több szakaszos
   audit) — írás nélkül kockázatmentes, és ez az erős modellek valódi terepe.
   Párhuzamos ÍRÁS továbbra sem terv része (worktree-alapú külön projekt lenne).

---

## 0. Mit értettem meg (megerősítés)

Egyetlen promptot **szakaszok láncaként** akarsz futtatni, ahol minden szakasznak
saját szerepe és saját agentje van — például *Terv (Claude) → Kódolás (Codex) →
Review (Claude)*. **De nem mindig:** a lánc ("recept") **promptonként választható
a GUI-ban**, a Részletes pipa melletti vezérlővel, és az alapértelmezés a mai
egy-agentes mód marad. A példa-kombó csak egy preset a többi közül.

## 1. Vélemény

**Jó ötlet, és a kódbázis szokatlanul készen áll rá.** Három dolog miatt:

1. A `turns` tábla **már ma is turn-szinten** tárolja a runtime-ot
   ([store.rs:96](src-tauri/src/store.rs#L96)) — vegyes Codex/Claude beszélgetés
   sématörés nélkül ábrázolható. A szakasz = sima turn, minden meglévő
   csővezeték (üzenetek, LÉPÉSEK, tervek, diff-panel, sync, rollback) ingyen jön.
2. A review szakasznak ma már van **mit** néznie: a diff-oldalak és a
   changeSummary a tegnapi munkával szinkronizálódnak — a reviewer valódi diffet
   kap, nem elmesélt változást.
3. A "melyik agent mit tud" kérdés nálad valós: Claude-előfizetés + Codex
   egyszerre él, a két erősség tényleg komplementer.

**Amit viszont ne csináljunk:** ne építsünk "multi-agent frameworköt"
(párhuzamos agentek, egymásnak üzengetés, verseny + bíró). A szekvenciális
recept a meglévő turn-modellre illeszkedik; a párhuzamosság új
hibaosztályokat nyitna (két agent egyszerre írja ugyanazt a fájlt), és a mai
sync-tapasztalatok után pont tudjuk, mennyibe kerül egy új konkurencia-réteg.
Ha egyszer kell, külön fázis legyen.

## 2. Fő ajánlások (döntést kérnek)

| # | Ajánlás | Miért |
|---|---|---|
| A1 | **Szerep-kikényszerítés tool-szinten, ne csak promptban.** A Terv és Review szakasz Claude-nál szűkített `ENABLED_TOOLS`-t kap (csak Read/Glob/Grep), Codexnél `sandbox: read-only`-t. | "Ne módosíts fájlt" promptban = remény. Tool-listában = garancia. Mindkét horog már létezik: [main.mjs:594](agent-bridge/main.mjs#L594), [codex.rs:28](src-tauri/src/codex.rs#L28). |
| A2 | **A recept szabad legyen, ne fix szereposztás.** Preset: Terv=Claude, Kód=Codex, Review=Claude — de bármelyik szakasz agentje/modellje átállítható. | Te váltogatod a modelleket menet közben is; a terv ne kösse meg. |
| A3 | **V1-ben nincs automatikus javító-kör** (review elutasít → újrakódol). A review eredménye megjelenik, és TE döntesz. V2-ben jöhet 1 korlátos kör, kapcsolóval. | A hurok a legdrágább és legkockázatosabb rész; előbb lássuk, milyenek a review-k. |
| A4 | **Az egész pipeline opt-in marad**, a default az egy-agentes mód. A választás a user-üzeneten tárolódik (mint a `detailed` flag), tehát a történelemben látszik, mi hogyan készült — és syncel. | 3 szakasz ≈ 3× idő és 3× kvóta. Ez tudatos döntés legyen, ne alap. |
| A5 | **Újragenerálás szemantikája:** a teljes pipeline újrafut az 1. szakasztól. Szakaszonkénti újrafuttatás V2. | Az artefaktumok láncban függnek egymástól; részleges újrafuttatás féligazságokat gyárt. |

---

## 3. Fogalmak

- **Recept (recipe):** rendezett szakaszlista. Pl. `[{szerep: terv, agent: claude}, {szerep: kód, agent: codex}, {szerep: review, agent: claude}]`. Nevesített presetek + (V3-ban) saját szerkesztő.
- **Szakasz (stage):** a recept egy eleme; futáskor **egy sima turn** lesz belőle a beszélgetésben, saját request-iddel, saját LÉPÉSEK-kel.
- **Futam (pipeline run):** egy prompt egy végrehajtása egy recept szerint; a szakasz-turnök szülője.
- **Artefaktum:** amit egy szakasz a következőnek átad — a végső válaszszövege + (kód szakasznál) a changeSummary és a diff.

## 4. Architektúra-döntések

### 4.1 Az orchestrator Rust-ban él (új `pipeline.rs`)

A frontend NEM láncol. Okok:
- A Rust már ma is ura mindkét runtime-nak (`codex.rs`, `claude.rs`), az
  approvaloknak, a store-írásnak és az eseményeknek.
- Ablakbezárás/crash közben a lánc nem veszhet el vezérelhetetlenül: a futam
  állapota SQLite-ban van, induláskor az orphan-recovery (ma is létező minta,
  `recover_orphaned_agent_turns`) lezárja: futó futam → `failed`, a kész
  szakaszok eredménye megmarad.
- A frontend csak render + vezérlőgombok (megszakítás).

### 4.2 A szakasz = sima turn; a futam-metaadat az üzeneteken utazik

- Új tábla: `pipeline_runs (id, conversation_id, recipe_json, status,
  current_stage, created_at, updated_at)` — **lokális** vezérlőadat.
- A `turns` tábla bővül: `pipeline_id`, `stage_index`, `stage_role` (nullable —
  sima turnnál NULL).
- **Sync:** a turns tábla ma nem syncel, és ez maradjon is így. A másik gép a
  megjelenítéshez szükséges minimumot az **üzeneteken** kapja meg — pontosan a
  ma bevált mintával (`detailed`, `change_summary`): a `LocalMessage` bővül
  `pipeline` opcionális mezővel `{runId, stageIndex, stageCount, stageRole,
  stageAgent}`. Nincs új journal-eventtípus (a hat dispatch-hely érintetlen),
  nincs új ütközési felület: az üzenet írja egyszer, aki tudja.

### 4.3 Szerep-kikényszerítés (A1 részletei)

| Szakasz | Claude | Codex |
|---|---|---|
| Terv / Review | `ENABLED_TOOLS` = Read, Glob, Grep (írás/Bash nélkül); `maxTurns` alacsony (pl. 15) | `sandbox: "read-only"`, turn-limit |
| Kód | mai teljes készlet | mai `workspace-write` |

A bridge `start_turn` kérése per-turn kapja a tool-listát (ma konstans —
paraméterezhetővé kell tenni), a Codex `thread/start`/`resume` per-hívás kapja a
sandboxot (ma konstans — ugyanez).

### 4.4 Artefaktum-átadás

A szakasz-prompt sablonja (a meglévő 24k-s rehidratációs konvencióval,
`MAX_REHYDRATION_CONTEXT_CHARS` mintájára, artefaktumonként vágva):

```
[EREDETI FELADAT] — mindig szó szerint, teljes egészében
[ELŐZMÉNY-ARTEFAKTUMOK] — szakaszonként fejléccel:
  "A tervező (Claude) terve:" …
  "A kódoló (Codex) összefoglalója + változott fájlok (+diff):" …
[SZEREP-UTASÍTÁS] — a szakasz szerepe, kimeneti elvárás
```

Kimeneti elvárások szerepenként:
- **Terv:** számozott lépések + érintett fájlok + kockázatok. Fájlt nem módosít.
- **Kód:** a terv végrehajtása; a végén rövid összefoglaló. (A diff magától
  keletkezik: work itemek + changeSummary.)
- **Review:** kap diffet + tervet; kötelező záróformátum:
  `VERDIKT: ELFOGAD` vagy `VERDIKT: JAVÍTANDÓ` + pontokba szedett indok.
  A verdikt-sort a runner felismeri és a UI jelvényként mutatja.

Fontos: ugyanabban a beszélgetésben futó Claude-szakaszok a session-resume
miatt amúgy is látják a korábbi szakaszokat — az artefaktum-blokk ettől
függetlenül mindig bemegy, mert a Codex-szakasznak nincs közös memóriája, és a
láncnak determinisztikusnak kell lennie, nem session-állapotfüggőnek.

### 4.5 Állapotgép

```
futam:   pending → running(stage k) → completed | failed(stage k) | cancelled(stage k)
szakasz: a meglévő turn-státuszok (running/completed/failed) változatlanul
```

- **Hiba egy szakaszban** → futam `failed`, a hátralévő szakaszok ki sem
  indulnak; a UI megmutatja, hol állt meg és miért. A kész szakaszok eredménye
  (terv, diff) megmarad és látható.
- **Megszakítás** → az aktuális szakasz cancel (mai mechanizmus), futam
  `cancelled`, hátralévők "kihagyva" jelöléssel.
- **Review = JAVÍTANDÓ** nem hiba: a futam `completed`, a verdikt látszik (A3).
- **App-újraindulás futás közben** → futam `failed` + őszinte üzenet ("A lánc a
  2. szakasznál megszakadt újraindítás miatt"), kész szakaszok megmaradnak.

## 5. GUI-terv

### 5.1 Composer (a Részletes pipa mellé)

- Új vezérlő: **kombó-választó**. Alapállapot: `Egy agent` (mai működés,
  semmi nem változik). Lenyitva a presetek: `Terv → Kód → Review`,
  `Kód → Review`, (később: saját receptek).
- A választás **üzenetenként** él (mint a Részletes pipa), az utolsó választás
  megjegyzve. A user-üzenetre rákerül a recept — ezért a történetben és a
  másik gépen is látszik, mi hogyan készült.
- A chip mutatja a láncot röviden: `⛓ Claude → Codex → Claude`.

### 5.2 Idővonal

- A futam kap egy vékony **fejléccsíkot**: `KOMBÓ · 2/3 · Kódolás (Codex) fut…`
  szakasz-pöttyökkel (kész ✓ / fut ● / hátralévő ○ / kihagyva ⊘).
- Alatta szakaszonként **egy-egy mai kártya** (TurnProgressCard), jelvénnyel:
  `1/3 TERV · Claude`, `2/3 KÓD · Codex`, `3/3 REVIEW · Claude`.
- Kész szakasz kompakt kártyára esik össze; a futó a mai élő trace-t mutatja.
- A **kód-szakasz** kártyáján marad a FÁJLOK/VÁLTOZÁSOK panel és a
  **Visszavonás** (a rollback a kód-szakasz guardjához kötődik, ahogy ma).
- A **review** kártyán a verdikt jelvény: zöld `ELFOGAD` / sárga `JAVÍTANDÓ`.
- **Újragenerálás** a futam-fejlécen: teljes újrafutás (A5). A szakasz-kártyák
  egyedi újragenerálás-gombja V1-ben rejtve.

### 5.3 Beállítások

- Presetek listája a beállításokban (V1: a két beépített, csak sorrend-olvasás;
  V3: szerkesztő — szakasz hozzáadás/törlés, agent/modell/effort per szakasz).
- Per-szakasz turn-limitek defaultjai itt állíthatók (V2).

## 6. Sync és cross-device

- A szakasz-turnök üzenetei/work itemjei/tervei a **mai** csatornákon syncelnek
  — semmi új eventtípus.
- Az üzenetre tett `pipeline` mező (4.2) viszi a csoportosítást; a másik gép
  ugyanazt a fejléccsíkot + jelvényeket rajzolja a kész futamról.
- Élő futam a másik gépen nem látszik élőben (ma sem látszik az élő turn) —
  befejezés után áll össze. Ez tudatos: az élő állapot szinkronizálása pont az
  a fajta megosztott írás, amit kerülünk.
- A recept-választás a user-üzeneten van → egyszer íródik, nincs min veszekedni.

## 7. Költség, limitek, biztonság

- Per-szakasz `maxTurns`: terv 15, kód 40 (mai default), review 15 — configból.
- Claude subscription módban budget továbbra sincs (ismert szabály); API-kulcsos
  módban a futamra összesített budget-plafon (szakaszok öröklik a maradékot).
- Approvals: minden szakasz a mai jóváhagyás-folyamot használja; a futam várakozik.
- A terv/review szakasz tool-korlátozása (A1) egyben biztonsági él is: a
  "reviewer" nem tud "mellékesen javítani egyet" — csak a kód-szakasz ír.

## 8. Fázisok és feladatok

### F1 — Gerinc (ez az első leszállítható egység)
1. `pipeline.rs`: futam-állapotgép, szekvenciális runner, artefaktum-összefűzés
   méretkorláttal, verdikt-parszolás.
2. Séma: `pipeline_runs` tábla + `turns` 3 új oszlopa (v22 migráció);
   `LocalMessage.pipeline` mező + a ma bevált save/load/merge útvonalak.
3. Bridge + Codex: per-turn tool-lista / sandbox paraméterezhetőség (A1 első
   fele: csak a mechanizmus, a szűkített készletekkel).
4. Composer-vezérlő (2 preset), üzenetre mentett recept; futam-fejléc +
   szakasz-jelvények az idővonalon; megszakítás.
5. Orphan-recovery futamokra; hibaesetek UI-ja.
6. Tesztek: állapotgép-átmenetek, artefaktum-vágás, verdikt-parszolás,
   üzenet-metaadat round-trip (Rust); idővonal-csoportosítás (frontend);
   élő smoke a fixture-projekten (Terv→Kód→Review, math.js-hiba).
7. Cross-device ellenőrzés: kész futam renderelése a másik gépen.

### F2 — Kikényszerítés és finomítás
- Per-szakasz turn-limitek beállításból; read-only enforcement élesítése és
  tesztjei (terv-szakasz tényleg nem tud írni); cancel/kihagyva UX; futam
  költség-összesítő a fejlécen (API-módra).

### F3 — Kényelem
- Korlátos javító-kör (review→fix→re-review, max 1, kapcsolóval, A3);
  szakaszonkénti újrafuttatás; recept-szerkesztő; per-szakasz modell/effort a
  composerből; (opcionálisan, ha igény lesz: párhuzamos variánsok — külön terv).

## 9. Nyitott kérdések neked

1. **Preset-készlet:** a `Terv → Kód → Review` mellett kell-e a `Kód → Review`
   kettes is V1-be? (Olcsóbb kombó, gyakori eset.)
2. **A terv-szakasz kimenete kérdezzen-e vissza?** (Claude AskUserQuestion-t
   tehet fel terv közben — engedjük a futam közepén, vagy terv-szakaszban
   tiltsuk és döntsön magától?) Javaslatom: engedjük, a futam vár.
3. **Elnevezés a GUI-ban:** "Kombó", "Lánc", "Pipeline", más?
4. Review-verdikt formátum magyarul (`VERDIKT: ELFOGAD/JAVÍTANDÓ`) — jó így?
