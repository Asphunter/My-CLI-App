# Párhuzamos munka · Visszaállítás · Menet közbeni terelés — terv (2026-07-28)

Három funkció, egy közös cél: a program ne egy futásra épüljön, hanem egy
fejlesztő munkanapjára. A terv minden állítása a mai kódból mért tény
(fájl:sor), nem emlék.

Elv (a repo többi tervével azonosan): minden fázis végén build + tesztek +
élő GUI-verifikáció screenshottal a `Screenshots/` mappába.

---

## 0. Mai állapot — mért tények

- **A backend már most is kérésenkénti.** Minden turn saját cancellation-t
  kap (`codex::begin_request` / `claude::begin_request`, request-id kulcs)
  és saját `spawn_blocking` szálon fut (`lib.rs:25–88`). A Codex app-server
  és a Claude bridge **turnönként külön processz**. Két egyidejű turn a
  Rust oldalon ma sem ütközne — a sorosítás kizárólag a frontend globális
  állapota.
- **A frontend egyfutásos.** `isStreamingRef` + ~15 globális ref/state
  (`activeRequestIdRef`, `activeTurnIdRef`, `activePlan`, `codeActivity`,
  `commentaryEntries`, `pipelineProgress`, `liveMessageId`, …) mind „az
  egyetlen futó kérés"-t jelenti. Az eseményszűrő
  (`handleAgentEvent`, App.tsx ~10126) minden más requestId-t eldob.
- **Snapshot minden turnhöz készül és megmarad.**
  `%LOCALAPPDATA%\min\agent-snapshots\<uuid>` — jelenleg 281 db. A snapshot
  a turn ELŐTTI teljes munkaterület-másolat (guard-limitekkel:
  10k fájl / 8MB fájl / 256MB össz, `codex.rs:672–674`). Van hozzá
  `rollback / apply / discard / preview` parancs (`lib.rs:561–615`).
- **A turns tábla nem ismeri a snapshotját.** Oszlopai közt nincs
  `snapshot_id` — a kapcsolat ma csak a frontend memóriájában él
  (`undoableSnapshot`, egyetlen utolsó). Ez a visszaállítás fő hiányzó
  láncszeme.
- **A turns tábla ismeri a sessiont.** `provider_session_id` oszlop van —
  a beszélgetés bármely pontjának Claude-sessionje visszakereshető.
- **A bridge promptja ma egyetlen string** (`main.mjs:772`,
  `createTurnPrompt`). A Claude Agent SDK viszont támogat AsyncIterable
  (streaming) inputot is — ez a terelés technikai kapuja.
- **Sync:** két gép, append-only journal, `sync_tombstones` tábla létezik —
  a visszaállításnak ezen is át kell mennie.

---

## F1 — Multi-projekt párhuzamos munka

### Cél
Amíg az A projektben fut egy lánc, a B projektben lehessen kérdezni,
láncot indítani, olvasni. Egy projekten belül marad az „egyszerre egy
futás" szabály (a workspace-snapshot két írót nem visel el).

### Architektúra-döntés
Nem „több globális", hanem **futás-objektum**: minden élő kérés a saját
állapotát hordozza, kulcsa a conversationId.

```ts
type LiveRun = {
  conversationId: string;
  projectPath: string | null;
  requestId: string;            // láncnál a futó stage requestje
  chainRequestIds: Set<string>; // a mai chainRequestIdsRef, futásonként
  turnId: string | null;
  kind: "single" | "chain";
  pipelineProgress: PipelineProgressEvent | null;
  liveMessageId: string | null;
  plan: PlanSnapshot;
  startedAt: number;
  cancelRequested: boolean;
};
// state: Map<conversationId, LiveRun>
```

### Lépések

- **F1.1 — Futás-regiszter és eseményrouting.** `liveRunsRef:
  Map<conversationId, LiveRun>`. A `handleAgentEvent` a requestId→run
  leképezéssel (fordított index: requestId→conversationId) válassza ki,
  MELYIK run állapotát frissíti — ne dobja el, ami nem az aktív nézeté.
  A mai globális refek első körben a *kiválasztott beszélgetés runjának*
  nézetei (getterek), így a 15k soros App.tsx nem egyszerre fordul át.
- **F1.2 — Nézet-függetlenítés.** A message/plan/activity/commentary state
  már ma beszélgetésenként cache-elt (`localConversationCacheRef`); ami
  nem az: `activePlan`, `codeActivity`, `commentaryEntries`,
  `pipelineProgress` élő frissítése. Ezek írása a run kulcsán át menjen;
  beszélgetés-váltáskor a nézet a run állapotából töltődjön (ma:
  elveszik / összekeveredik).
- **F1.3 — Composer-kapuk projekt-szintűre.** Az `isStreaming` helyett:
  `isConversationStreaming(activeConversationId)` és
  `isProjectBusy(projectPath)`. Küldés-tiltás CSAK akkor, ha az aktív
  projektben már fut valami. A `blockConversationMutationDuringStream`
  hívásait (7520, 7537, 7859, …) egyenként kell minősíteni: ami a futó
  beszélgetést védi, marad; ami globális kényelmi zár volt, projekt-szintű
  lesz.
- **F1.4 — Rust-oldali projekt-zár.** `pipeline_send` / `agent_send`
  elején: fut-e már turn ugyanarra a canonical cwd-re → magyar hibaüzenet
  („Ebben a projektben már fut egy kérés."). Ez fail-safe a frontend-kapu
  mögött; kell hozzá egy `live_project_locks: Mutex<HashMap<PathBuf,
  String>>` (cwd → request_id), a turn végén takarítva. Teszt: két
  konkurens hívás ugyanarra a cwd-re → a második hibázik; két különböző
  cwd-re → mindkettő fut.
- **F1.5 — Sidebar-jelzés.** A futó beszélgetés sorában pörgő/pont
  (a `LiveRun` map-ből triviális), projekt-fejlécen összesítve. A kész,
  de még nem megnézett futás: pötty (ehhez `lastSeenAt` a nézet-váltáskor).
- **F1.6 — Hang és fókusz.** A lezáró chime csak akkor szóljon
  automatikusan, ha a futás beszélgetése az aktív nézet; különben a
  sidebar-pötty jelez (a 9-es „Windows-értesítés" kívánság ide később
  csatlakozik, nem most).

### Nem-cél (kimondva)
- Egy projekten belüli két konkurens futás.
- Üzenetsor/queue (külön, kis fázis lehet F1 után: a composer streaming
  alatt is fogad, és a futás végén automatikusan elküldi — de csak az F1
  stabilizálása után).

### Tesztterv
- Rust: projekt-zár tesztek (fent). Frontend: `tests/`-be routing-teszt a
  requestId→run kiválasztásra (a `chainRequestIds` átvételével).
- GUI: A projektben 3-fázisú lánc indul → átváltás B projektre → EGY AI
  kérdés fut le közben → vissza A-ra: a lánc panelje hiánytalan (fázisok,
  kártya, verdikt); a B válasza a B-ben van. Screenshotok.
- Regresszió: a ma esti teljes forgatókönyv (lánc, v2-újrafutás, EGY AI)
  egyprojektes módban változatlanul működik.

### Kockázatok
- Az App.tsx globális refjeinek szétszálazása a legnagyobb munka; a
  getter-híd (F1.1) tartja kicsiben a diffet, de két-három napos, türelmes
  munka GUI-iterációval.
- A store mentési útvonala (`codeActivityRef` → save) ma az aktív
  beszélgetést menti; futásonkénti mentésre kell átkötni, különben a
  háttérben futó lánc trace-e az előtérben lévő beszélgetésbe íródna.

---

## F2 — Visszaállítás egy korábbi user inputra

### Cél
Bármely korábbi user üzenetnél: „Visszaállítás ide" — a beszélgetés ÉS a
munkaterület úgy álljon vissza, ahogy AZ ELŐTT az üzenet előtt volt,
akárhány turn van fölötte. (Claude Code „rewind" megfelelője.)

### Ami ehhez hiányzik, és ami már megvan
- Megvan: turnönkénti teljes bázis-snapshot a lemezen (281 db bizonyítja,
  hogy megmaradnak), rollback-mechanizmus, tombstone-os sync.
- Hiányzik: **turn ↔ snapshot összerendelés a store-ban**, és a
  visszaállító parancs, ami ezt végigjátssza.

### Lépések

- **F2.1 — `turns.snapshot_id` (v23 migráció).** A turn lezárásakor a
  guard-report snapshotId-ja a turns sorba íródik (codex + claude + lánc
  stage-ek egységesen; a láncnál a chain-guard snapshotja a run-hoz, a
  stage-snapshotok a stage-turnökhöz). Backfill nincs — régi turnökre a
  funkció nem ígérhető, és ezt a UI mondja is ki.
- **F2.2 — `conversation_revert_to(message_id)` Rust-parancs.** Sorrend:
  1. **Fájlok:** keresd a legkorábbi turnt, amelynek sorrendje a cél-üzenet
     UTÁNI, és van `snapshot_id`-ja → annak a snapshotnak a **bázisát**
     állítsd vissza (`restore_snapshot_base_files` már létezik) — a bázis
     a teljes munkaterület állapota a turn előtt, tehát egy lépésben jó,
     nem kell turnönként visszafelé sétálni.
  2. **Biztonsági háló:** a visszaállítás ELŐTT friss snapshot készül a
     mostani állapotról („revert-guard"), így maga a visszaállítás is
     visszavonható.
  3. **Beszélgetés:** a cél-üzenet UTÁNI messages/turns/work_items sorok
     törlése + `sync_tombstones` bejegyzés mindegyikre, hogy a másik gép
     is takarítson. A `pipeline_runs` érintett sorai szintén.
  4. **Session:** a cél-üzenet ELŐTTI utolsó turn `provider_session_id`-ja
     lesz az aktív resume-session (thread-kulcsonként); ha nincs, üres —
     új session indul.
- **F2.3 — UI.** User-buborék hover-menü: „⤺ Visszaállítás ide". Megerősítő
  dialóg tényekkel: hány üzenet törlődik, hány fájl áll vissza (a snapshot
  manifest diffjéből előre kiszámolva), és hogy a művelet a másik gépre is
  átterjed. Siker után a composerbe bekerül a cél-üzenet szövege
  (szerkeszthető újraküldéshez) — ez adja az „innen máshogy folytatom"
  munkafolyamatot.
- **F2.4 — Él-esetek.** Futó kérés közben tiltva (előbb Stop). General
  (projekt nélküli) beszélgetésben csak beszélgetés-csonkolás, fájl-rész
  nélkül. Ha a snapshot hiányzik/sérült (kézi törlés): a fájl-rész hibával
  megáll, a beszélgetés-rész el sem indul — fél-visszaállítás nincs.

### Tesztterv
- Rust: revert teszt fixture-rel — 3 turn, mindhárom ír fájlt; revert a
  2. user üzenetre → az 1. turn utáni fájl-állapot + 2 üzenet marad;
  tombstone-ok megvannak; a revert-guard snapshotból a revert visszavonható.
- Sync: revert az A gépen → journal átvitel → a B gépen a beszélgetés
  ugyanígy csonkolódik (meglévő sync-teszt minta a `sync.rs`-ben).
- GUI: chain-testben 3 futás után visszaállás az 1. üzenetre; a fájlok és
  a timeline együtt ugranak vissza; screenshot előtte/utána.

### Kockázatok
- A snapshot-bázis a guard-limiten túli fájlokat nem őrzi (256MB össz) —
  nagy projekten a revert fájl-része megtagadható; a dialógnak ezt előre
  jeleznie kell (a manifest tudja).
- OneDrive-lag: a visszaírt fájlokat a felhő késve szinkronizálja — nem a
  mi hibánk lesz, de a dialógba egy mondat kerül róla.

---

## F3 — Menet közbeni user input (a futó AI terelése)

### Cél
Fut a kódoló, látod, hogy rossz irányba megy → beírsz egy sort, és az
**még ebben a turnben** eljut hozzá. Ne Stop + újrafogalmazás legyen az
egyetlen eszköz.

### Technika
> **Igazolva (2026-07-28, `agent-bridge/steering-probe.mjs`).** A terv egyetlen
> bizonyítatlan feltevése állt: elfogad-e a Claude SDK inputot futó turn
> közben. Igen. A próba egy async generátorral indított turnbe 3 másodperc
> múlva beküldött egy `priority: "now"` üzenetet; a modell abbahagyta az
> eredeti feladatot és a terelést hajtotta végre, a turn pedig **normálisan
> lezárult** (6,5 s, `num_turns: 1`) — a nyitva tartott input-stream nem
> akasztja meg. Az SDK-ban erre külön mező van (`priority: 'now' | 'next' |
> 'later'`) és külön API (`query.streamInput`), tehát a terelés nem trükk,
> hanem támogatott fogalom.

- **Claude (bridge): valódi mid-turn terelés.** A SDK `query()` promptja
  string HELYETT async generátor: először a feladatot adja, utána nyitva
  marad, és a bridge stdin-jén érkező `steer` üzeneteket adja tovább
  ugyanabba a streaming-input sessionbe. A turn attól még egy turn marad
  (a result-események számát a meglévő ciklus kezeli); a `finalAnswer`
  továbbra is az utolsó assistant-üzenet szövege — a mai
  `turn.assistantTexts` logika változatlanul jó.
- **Codex (app-server): őszinte közelítés.** A protokollban nincs ismert
  mid-turn input. A terelés itt sorba áll, és (a) lánc esetén a KÖVETKEZŐ
  stage promptjába kerül `[MENET KÖZBENI UTASÍTÁS]` blokkként, (b) EGY
  AI-nál a turn végén automatikus follow-up turnként megy el. A UI ezt
  nem hazudja el: „A Codexnél a következő lépésben ér oda."

### Lépések

- **F3.1 — Bridge: streaming input.** `createTurnPrompt` → async
  generátor; új bridge-üzenettípus: `{type:"steer", payload:{text}}`;
  a bridge `steer_accepted` eseményt emitál (a GUI-nak). A generátor a
  turn lezárásakor záródik (a mai retry-ág — session-újraindítás — a
  generátort újraindítja a már beérkezett tereléseket megőrizve).
- **F3.2 — Rust: `agent_steer(request_id, text)` parancs.** Claude-runtime:
  a futó bridge-processz stdinjére írja a steer-frame-et (a processz-kézre
  a meglévő request-regiszter bővül a stdin-handle-lel). Codex vagy nem
  futó kérés: pufferbe teszi; a pipeline a stage-váltásnál üríti a puffert
  a következő stage promptjába (`stage_prompt` már ma is fogad
  feedback-blokkot — ugyanaz a minta, `pipeline.rs:195+`).
- **F3.3 — UI.** Streaming alatt a composer NEM tiltódik le, hanem
  átvált „terelés" módba: a küldőgomb más ikonnal (⇢), placeholder:
  „Súgás a futó AI-nak…". A terelő üzenet a timeline-ba kerül user-
  buborékként „menet közben" jelöléssel, és a store-ba is (külön
  `steer` flag a messages-ben — v23 migrációval együtt vihető).
  A LÉPÉSEK listában a terelés pillanata bulletként jelenik meg
  („⇢ user: …"), hogy utólag látszódjon, MIRE reagált a modell.
- **F3.4 — Lánc-szemantika.** A terelés mindig a FUTÓ stage-nek szól;
  ha az épp Codex-review, a puffer a lánc végéig él és a v2-újrafutás
  `retryFeedback`-jébe is bekerül. Stop esetén a puffer ürül (a Stop
  jelentése: „ezt hagyd abba", nem „később mondd el neki").

### Tesztterv
- Bridge-teszt (`agent-bridge/*.test.mjs` minta): a generátor a steer-t
  a turn közben adja át; turn-lezárás után érkező steer nem szivárog a
  következő turnbe.
- Rust: steer futó Claude-kérésre → stdin-frame; nem futóra → hiba;
  Codex-stage alatt → a következő stage promptjában megjelenik a blokk.
- GUI: hosszabb KÓD fázis közben beírt „a függvényt `stats.js`-be tedd,
  ne az `invoice.js`-be" terelés → a kész kód a terelést követi;
  screenshot a „menet közben" buborékról és az eredményről.

### Kockázatok
- Az SDK streaming-input viselkedése a részleteiben (result-események
  száma, maxTurns-interakció) csak élő próbával derül ki — az F3.1 első
  lépése egy izolált kis próbafuttatás legyen a bridge-en, mielőtt a GUI-t
  rákötjük.
- A terelés „megfogadása" modell-viselkedés, nem garancia — a UI ezért
  mutatja bulletként, hogy MIKOR ért oda: a felhasználó látja, ha a modell
  már túl volt rajta.

---

## Sorrend és méret

| # | Fázis | Miért ez a sorrend | Becslés |
|---|---|---|---|
| 1 | **F1** párhuzamos munka | Ez adja a futás-objektumot és a stream alatt élő composert — a másik kettő erre épül | nagy (a legnagyobb: App.tsx-szétszálazás) |
| 2 | **F3** terelés | A composer-átkapcsolás az F1-ből készen jön; a bridge-rész független és kicsi | közepes |
| 3 | **F2** visszaállítás | Független a másik kettőtől, de v23 migrációt oszt az F3-mal — a migráció egyszer megy ki | közepes |

Mindhárom fázis önállóan szállítható és commitolható; egyik sem hagyja
félkész állapotban a meglévő funkciókat.

## Nyitott kérdések (döntést kérnek, de nem blokkolók)

1. F1: két gép szinkronban — ha MINDKÉT gépen fut valami ugyanabban a
   projektben, a projekt-zár csak gépen belül véd. A journal-sync ezt ma
   is túléli (append-only), de a kártya-káosz ellen elég-e a „ne csináld"?
   (Javaslat: elég; a sync-ütközésjelző már ma is szól.)
2. F2: a visszaállítás töröljön vagy ágaztasson? (Terv: töröl, revert-guard
   snapshottal. Az ágaztatás [branch] szebb, de a timeline-modell ma nem
   tud elágazni, és nem éri meg most megtanítani rá.)
3. F3: a terelő üzenet menjen-e sync-be a másik gépre? (Terv: igen, sima
   user-üzenetként, `steer` flaggel — a beszélgetés története hazudna
   nélküle.)
