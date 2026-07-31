# Kód-rehaul — 2026-07-31

Teljes átvilágítás a Claude-alapú Részletes MULTI-AI útvonalon: `agent-bridge/`,
`src/App.tsx` futtatás-kezelés, `src-tauri/` (pipeline, claude, store, lib).
A súlyozás: **KRITIKUS** = automatikusan javítva ebben a körben; **KÖZEPES** /
**ALACSONY** = dokumentálva, szándékosan érintetlen.

---

## KRITIKUS — javítva

### C1. A bridge 256 KB-os sor-limitje eldobja a nagy session-válaszokat
**Hely:** `agent-bridge/protocol.mjs` (`MAX_LINE_BYTES = 256 * 1024`),
párja: `src-tauri/src/claude.rs` session_store RPC-válasz írása.

A Rust oldal a `session_store_response`-t egyetlen JSONL-sorként írja a bridge
stdin-jére. Egy Claude-session betöltése (`load`) az ÖSSZES entry-t hozza — a
store-ban ma is van **4,5 MB-os session** és **2,19 MB-os egyetlen entry**
(126 sessionből 8 nagyobb 700 KB-nál). A `parseLine` viszont minden 256 KB
feletti sort `RangeError`-ral eldob, így a válasz sosem ér célba: a függő
művelet **60 másodpercig vár, majd timeoutol**, a „softened" fallback pedig
`null`-t ad — a Claude **elfelejti a session-t és némán újat kezd**.

Ez a magyarázata a korábban vadászott tüneteknek: „session store timeout",
„a REVIEW szakasz turn közben halt meg", „az elakadás végső gyökere"
(GUI-audit P3/7). A 15 s → 60 s timeout-emelés a tünetet kezelte, nem az okot.

**Fix:** a limit 64 MB-ra nő. A limit célja egy elszabadult stream elleni
védelem lokális pipe-on — 64 MB erre bőven elég, session-válasznak is.

### C2. Párhuzamos futásnál a kósza pipeline-esemény az ELSŐ runra íródik
**Hely:** `src/App.tsx`, `pipeline-progress` listener.

A handler fallbackje `runsRef.current.values().next().value` — ha a requestId
egyik runhoz sem köthető (pl. straggler esemény egy már lezárt lánctól), az
esemény a Map **első** runjára íródik. Két párhuzamos projekt-futásnál (ez a
branch lényege) a B lánc kósza eseménye az A lánc szakasz-sávját és carried
plan-jét írja át.

**Fix:** a fallback csak `runsRef.current.size === 1` esetén él (ugyanaz a
szabály, mint a `runForEvent`-ben); előtte a stage-suffix nélküli külső
requestId-vel is próbálkozunk.

### C3. A GONDOLKODÁS MENETE kibontott belső gondolkodása nyers szöveg
**Hely:** `src/App.tsx`, internal history render (`<div>{line}</div>`).

A kibontott belső gondolkodás sorai InlineMarkdown nélkül renderelődtek —
képlet, kód-chip, félkövér nem jelent meg bennük. A TeX-prompt fix (7d3a77f)
után a thinking szöveg képleteket fog hordozni; nyersen ellentmondana a
panel többi részének.

**Fix:** a history-sorok is `InlineMarkdown`-on át mennek.

### C4. Hibás kódolású (mojibake) felhasználói hibaüzenetek
**Hely:** `src-tauri/src/store.rs` (~70 db), `src-tauri/src/lib.rs` (10),
`src-tauri/src/claude.rs` (2), `agent-bridge/main.mjs` (3).

`"A Claude SessionStore mÅ±velete hiÃ¡nyzik."` és társai — egy korábbi
szerkesztés dupla-UTF-8 kódolással írta vissza az ékezetes literálokat.
Ezek felhasználónak megjelenő hibaüzenetek.

**Fix:** mechanikus visszaállítás (`Å±`→`ű`, `Ã¡`→`á`, `Ã©`→`é`, `Å‘`→`ő`,
`Ã­`→`í`, `Ã³`→`ó`, `Ã¶`→`ö`, `Ã¼`→`ü`, `Ãº`→`ú`, `Ã`→`Á` stb.), csak
string-literálokban.

### C5. A KÓD szakasz 40 körnél kifullad, és „connection_failed"-nek látszik
**Hely:** `src-tauri/src/pipeline.rs` (recept: `max_turns: 40`),
`agent-bridge/errors.mjs` (classifier).

Két hiba fedte egymást. (1) A kódoló szakasz plafonja 40 SDK-kör volt, de a
lépéskövetési protokoll (TaskUpdate minden lépés előtt és után) nyolc lépésnél
önmagában ~16 kört visz el — valódi feladaton a szakasz rendre elérte a
plafont, a lánc leállt, a részmunka visszagördült. (2) Az SDK szó szerinti
hibája („Reached maximum number of turns (40)") a classifier egyik
`turn_limit` mintájára sem illeszkedett, így a fallback **connection_failed**
címkét adott — a hiba Claude-kapcsolati problémának álcázta magát.

**Fix:** a KÓD szakasz plafonja 120 (a 200-as hard ceiling alatt, továbbra is
elszabadulás-védelem); a classifier felismeri a „maximum number of turns"
szöveget, a hiba mostantól `turn_limit`-ként jelenik meg.

---

## KÖZEPES — dokumentálva, nem javítva

### M1. `todo-${index}` lista-azonosítók instabilak
`agent-bridge/policy.mjs` — a `TodoWrite` teljes listát ír, az id a sorszám.
Ha a modell átrendezi/beszúr, az id másik sorra csúszik: időzítés és trace a
rossz lépéshez tapad. A `TaskCreate/TaskUpdate` út (planId a tool_use-ból) ezt
már jól csinálja; a TodoWrite-út tartalom-hash alapú id-t érdemelne.

### M2. Carried-plan címpárosítás: a nem párosuló task elveszik
`App.tsx` `mapIncomingTasksToCarried` — sorrendi párosítás + 12 karakteres
prefix-egyezés. Ha Claude a terv címét átfogalmazza, a task nem párosul, és a
státuszfrissítései a KÓD listán nem látszanak. A stage-prompt már kéri a szó
szerinti címet; ha a gyakorlatban mégis csúszik, fuzzy-párosítás kell.

### M3. Háttér-lánc carried plan fallbackje a nézett beszélgetésből olvas
`App.tsx` pipeline-progress `started` ág: `messagesRef.current.find(...)` a
NÉZETT beszélgetés üzenetei közt keresi a terv szövegét. Háttérben futó láncnál
ez üres — ilyenkor csak a `chainRun.planText` menti meg; ha az nincs, a KÓD
lista placeholderrel indul.

### M4. `TaskGet` hiányzik az `ENABLED_TOOLS`-ból
`policy.mjs` — a `PLAN_TOOLS`-ban benne van, a SDK-nak átadott listában nincs.
A Claude Code házi szabálya („TaskUpdate előtt TaskGet") így nem követhető;
a modell hibaüzenetet kap, ha megpróbálja.

### M5. Kettős `turn/started`
`main.mjs` — a `runLiveTurn` maga is emit-el egyet, majd a SDK `init` eseménye
még egyet. A GUI dedupe-ol, de a protokoll szintjén zaj.

### M6. Overload-retry nem nulláz mindent
`main.mjs` — 529-retry ágon a `toolMeta` és a `lastActiveTaskKey` megmarad az
előző próbálkozásból (a fresh-session ág a toolMeta-t üríti, ez az ág nem).
Ma ártalmatlan (az id-k egyediek), de állapot-szivárgásra hajlamos hely.

### M7. `append_agent_text_delta` kumulatív-heurisztika
`claude.rs` — ha egy inkrementális delta történetesen a teljes eddigi pufferrel
kezdődik, a kód kumulatívnak nézi és CSERÉL, szöveget veszítve. Valószínűtlen,
de determinisztikusan nem kizárt.

### M8. `store.rs` session-load mindig a teljes entrylistát adja
Nincs lapozás/limit; a 64 MB-os keret (C1 után) elég, de egy több-tíz-MB-os
session előbb-utóbb újra falba ütközik. Hosszú távon: inkrementális load vagy
head/tail protokoll.

## ALACSONY — megjegyzések

- **L1.** `emit_compat_event` minden eseményt kétszer emit-el (`agent-event` +
  `codex-event` kompat) — render-terhelés élő stream alatt.
- **L2.** `maxKnownTimelineSequence` minden renderen végigmegy az összes
  üzeneten és aktivitáson (`App.tsx` törzsében, nem memo-ban).
- **L3.** `summariesFor` a thinking-blokk **félkövér** kiemeléseire szűkíti az
  élő belső listát — szándékos sűrítés, de a teljes szöveg csak kibontásra
  látszik; ha a thinking képlet-nehéz, a preview félrevezető lehet.
- **L4.** `protocol.mjs` `redactForDiagnostic` a `text`/`content` kulcsokat
  hosszra cseréli — de pl. a `body` kulcsot nem; diagnosztikai dump-ban
  (`MIN_AGENT_BRIDGE_DUMP`) amúgy is minden kimegy, env-kapcsolóval.
- **L5.** Ismeretlen bridge-üzenettípus a Rust olvasóban `Err`-rel öli a turnt
  (`claude.rs` `Some(other)`) — verzió-eltérésnél merev; együtt shippelt kód
  mellett ma kockázatmentes.
- **L6.** `unknown` tool-klasszifikáció → deny sablonszöveggel; a modellnek
  hasznosabb lenne a megengedett eszközök listája.

---

## A kör commitjai

1. `7d3a77f` — TeX-jelölés minden stage-promptban + KaTeX-védelem az
   `overflow-wrap: anywhere` ellen (a „break-elt képletek" gyökere: a Claude
   Unicode-képleteket írt, amit a KaTeX nem ismer fel).
2. `a450e30` — A LÉPÉSEK panel kézi visszalépés után újra követi a futást,
   amint az új lépésre ugrik.
3. *(ez a kör)* — C1–C4 fixek.
