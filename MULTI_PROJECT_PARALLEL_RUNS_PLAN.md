# Párhuzamos futások projektek között — terv

*2026-07-28 · Fable xHigh. Előzmény: [CROSS_CONVERSATION_BUG_ANALYSIS.md](CROSS_CONVERSATION_BUG_ANALYSIS.md)
1–10. lépés. Ez a terv arra épül, ami ott már megépült — nélküle ez a munka
tilos lett volna.*

## Cél

Több beszélgetés futhasson egyszerre, amíg **különböző projektekben** vannak.
A felhasználó elindít egy kört az A projektben, átmegy a B projektbe, ott is
indít egyet; mindkét válasz a saját beszélgetésébe érkezik, a fában mindkét
sor pöttye pörög, és bármelyikbe visszakattintva az élő állapot látszik.

## Nem cél — és miért nem

- **Ugyanabban a projektben két párhuzamos futás.** A workspace guard
  projektgyökér-szintű: két futás ugyanazt a fájlkészletet snapshotolná,
  állítaná base-re és alkalmazná. Ez nem implementációs hiány, hanem
  szemantikai ütközés — a második futás „base" állapota a első félkész írása
  lenne. Garantált adatvesztés; a projekt-zár marad.
- **Egy beszélgetésben két párhuzamos kör.** A beszélgetés lineáris: a
  következő kérdés kontextusa az előző válasz. A meglévő `queuedSend` (Enter
  futás közben → a futás végén magától elindul) ezt már jól kezeli.
- **Big-bang átírás.** Négy fázis, mindegyik önmagában zöld és kiadható;
  az 1. fázis után még mindig egy futás van — csak már táblából.

## Mi van már kész (ellenőrzött tények, nem remények)

| réteg | állapot |
|---|---|
| Rust: futások nyilvántartása | `ACTIVE_REQUESTS: HashMap<request_id, …>` a codex.rs-ben **és** a claude.rs-ben — kulcsolt tábla, nem singleton. Approval/question is request-ID-vel kulcsolt. |
| Rust: izoláció | Minden `agent_send` saját async parancs, saját processz, saját snapshot a projekt `cwd`-je alatt. Két projekt futása a lemezen nem ér egymáshoz. |
| Frontend: címzés | Minden futás-eredetű írás gazdát nevez meg (`writeOwned*`, `updateOwnedPlanState`); gazdátlan írás = eldobás. A válasz-sor ID-je determinisztikus (`agentAnswerMessageId`), a runtime-mal azonos. |
| Frontend: mentés | A snapshot-mentés azonosságra kérdez (`conversationKeysMatch(localKey, messageKeyRef.current)`), nem „mi van kiválasztva"-ra. |
| Frontend: felület-csírák | `ThinkingDots` a fában a futás gazdájához kötve; zárolás futó beszélgetésre/projektre szűkítve (`blockRunOwnerMutation`, `blockRunProjectMutation`); `viewingActiveRun` már megkülönbözteti „fut" és „itt fut". |

**A hiány egyetlen helyen van: a frontend futás-állapota singleton.**
~13 modulszintű ref (`activeRequestIdRef`, `runOwnerConversationIdRef`,
`activeLiveMessageIdRef`, `activeTurnIdRef`, `activeTurnTimingRef`,
`runPlanRef`, `answerStreamRef`, `planTextBufferRef`,
`agentMessagePhasesRef`, `processedCodexEventsRef`,
`completedTerminalTurnsRef`, `preparingRequestIdRef`,
`turnCompletedRequestIdRef`, `cancelledRequestIdsRef`,
`chainRequestIdsRef`…) plusz globális state-ek (`isStreaming`,
`isCancelling`, `codeStatus`, `transportStatus`, `watchdogMessage`,
`pipelineProgress`, `liveRunResume`, `undoableSnapshot`, `agentApplyBusy`,
`queuedSend`). Az eseménykezelő első sora ma is: *„ha nincs aktuális kérés,
dobd el."*

## A célmodell

```
RunHandle = {
  requestId            // immutable, a kulcs
  ownerConversationId  // immutable, submitkor dől el
  ownerConversationKey // cache-kulcs (írásmód-toleráns kereséshez)
  projectPath | null   // coding: a projekt-zár kulcsa; GENERAL: null
  provider, threadId   // threadId, amint az első esemény meghozza
  liveMessageId, clientTurnId, turnTiming
  plan                 // a futás saját terve (ma: runPlanRef)
  answerStream         // pufferelt kiírás (ma: answerStreamRef)
  planTextBuffer, agentMessagePhases
  processedEvents, completedTerminalTurns   // dedup, futásonként
  status: preparing | streaming | finalizing | done
  codeStatus, transportStatus, watchdogAt
  cancelled, turnCompletedRequestId
  chain?: { progress, resume, stageRequestIds }   // 4. fázis
}

runsRef: Map<requestId, RunHandle>
runByConversationRef: Map<conversationId, requestId>
runByProjectRef: Map<projectPathKey, requestId>
```

**Esemény-útvonal (fail-closed, a B1-tanulság szerint):**

1. `codexEvent.requestId` → `runsRef.get(...)` — az elsődleges út.
2. Nincs requestId (a wire-en `request_id: Option<String>`!): `threadId` →
   futás, a handle-be mentett threadId alapján.
3. Egyik sem talál → **eldobás.** Nem „az aktuális futásé" — az a szivárgás
   újranyitása lenne. A chain-stragglerek a `chain.stageRequestIds` halmazon
   keresztül találják meg a futásukat (a mai `chainRequestIdsRef` a handle-be
   költözik).

Kulcs-elv, ami az egészet a korábbi három bukott javítástól megkülönbözteti:
**a routing kizárólag immutable kulcsokon megy** (requestId, ownerId — mindkettő
a submit pillanatában rögzül). Render-órához (`threadKey`, props, state)
egyetlen írás sem igazodik; a nézet-tagságot egyedül a szinkron állított
`messageKeyRef` dönti el, az is csak olvasáskor.

## Futtatási szabályok (3. fázistól élnek)

- Beszélgetésenként legfeljebb **1** futás. Enter futó beszélgetésben →
  `queuedSend`, beszélgetésenként tárolva (a szöveg a szerkesztőben van, ami
  beszélgetés-váltáskor már ma is cserélődik — a sor a beszélgetéssel utazik).
- Coding projektenként legfeljebb **1** futás (`runByProjectRef`, kulcs a
  normalizált projekt-path). Második indítás ugyanabban a projektben →
  értesítés: *„Ebben a projektben már fut egy válasz."* Nem áll sorba —
  a projekten belüli sorba állítás külön döntés, nem ennek a tervnek a része.
- GENERAL futás (`cwd: null`, nincs guard) projekt-zárat nem fog, csak
  beszélgetés-zárat.
- Globális plafon: **3** egyidejű futás (konstans). Nem elvi korlát — a gép
  és az OneDrive védelme; a 4. kérés világos üzenetet kap.
- Sync pull: ma minden streamelés alatt szünetel (`isStreamingRef`); ez marad
  úgy, hogy *bármely* aktív futás szünetelteti. Konzervatív, de helyes; a
  finomítása nem ennek a tervnek a része.

## Fázisok

### 1. fázis — Futás-regiszter, viselkedésváltozás nélkül

A `RunHandle` + a három Map bevezetése; **a plafon 1 marad.** Minden per-run
ref a handle-be költözik; a modulszintű refek megszűnnek vagy a „legutóbbi
futás" vékony aliasává válnak, amit csak a régi kód olvas, amíg a 2. fázis
le nem cseréli. Az eseménykezelő a fenti útvonalon routol; a `writeOwned*`
hívások gazdája a handle-ből jön (ma: `runOwnerConversationIdRef`).

A submit-út (`submitMessage`), a stop (`stopGeneration`), a hibaág és a
`finally` mind a saját handle-jét zárja le — a „gazdátlanítás" a handle
törlése, nem egy ref nullázása.

*Ellenőrzés:* `tsc -b`, 48 frontend-teszt, build; kézzel: egy futás minden
eddigi viselkedése változatlan (stream, stop, hiba, chain, regenerálás,
navigáció futás közben, pöttyök). Rust nem változik.

#### 1. fázis — kész (2026-07-28)

`RunHandle` + `runsRef` / `runByConversationRef` / `runByProjectRef`,
`beginRun` / `endRun` / `runForEvent` / `runForConversation` / `runForProject`.
A futás kap gazdát (`beginRun`) a küldés pillanatában, és a táblából kikerülve
(`endRun`) szűnik meg — a „gazdátlanítás" innentől a tábla művelete, nem egy
ref nullázása. Három belépési pont hoz létre futást: a rendes küldés, a
lánc (ugyanaz a handle, `chainRequestIds`-szel) és a lánc-újrafuttatás.

**A handle-be költözött** (megszűnt modulszintű refek): `agentMessagePhases`,
`planTextBuffer`, `processedEvents`, `completedTerminalTurns`,
`chainRequestIds`, `answerStream`, `provider`. A terv (`plan`), a
turn-azonosító, az élő üzenet azonosítója és a turn-óra szintén a handle-é —
ezekre a `syncRunAliases()` tart fenn olvasó-aliast a 2. fázisig, **egyetlen
íróval**, hogy ne keletkezzen második igazság.

**Az eseménykezelő** mostantól `runForEvent`-tel kezd, és ha nincs találat,
*eldob*. A `requestId` az elsődleges út, a lánc-szakaszok a
`chainRequestIds`-en, azonosító nélkül a `threadId` — és amíg a plafon 1, az
azonosító nélküli esemény az egyetlen futásé (a régi kód is így vette; ez a
sor a 3. fázisban tűnik el).

*Mérleg:* +1035 / −287 sor, `tsc -b` tiszta, 48/48, build zöld. A viselkedés
szándékoltan azonos: a plafon még 1.

#### Közben előkerült: a munkaterület-zár fizikai szintje (natív)

Tünet: megszakítás után **gyorsan** küldött prompt „Nem sikerült a
Claude-kérés" hibával halt el; húsz másodperc várakozás után jó volt.

Ok: a megszakított futás lezárása visszaállítja a munkaterületet a base-re
(fájlokat ír és töröl), miközben az új futás base-snapshotja beolvassa
ugyanazokat a fájlokat. Az olvasás egy közben eltűnt fájlon hasalt el, és az
egész `agent_send` elbukott. Semmi nem sorosította a kettőt: a guard eddig
nem tudott arról, hogy egy munkaterületen egyszerre csak egy művelet mehet.

Megoldás: **projektgyökérre vett zár a guard-műveletek idejére** — nem a
snapshot élettartamára. Ez a különbségtétel kötelező: a lánc egy külső
snapshotot tart a teljes futásra, és közben a szakaszok a sajátjaikat
készítik; élettartamra vett zár esetén a lánc magamagát zárná ki. A staging
belül visszaállít, ezért a zár **ugyanazon a szálon újra fogható**
(szálankénti mélységszámláló). Timeout 180 s, utána nevesített hiba.

Ez egyben a 3. fázis projekt-zárának a fizikai alapja: a logikai kapu
(„ebben a projektben már fut egy válasz") a felület dolga lesz, de a lemezt
innentől a natív zár védi akkor is, ha a felület téved.

*Ellenőrzés:* 168/168 Rust teszt, két újjal — a zár sorosít és egy szálon
beágyazható (`one_workspace_serializes_guard_work_and_nests_on_one_thread`),
és a visszaállítás mellett induló új snapshot nem hasal el
(`a_restoring_snapshot_does_not_break_a_snapshot_starting_beside_it`).

Mellékesen: a felismeretlen hibák eddig „A Claude-kérés nem sikerült"-re
egyszerűsödtek, és az egyetlen kapaszkodó — a natív üzenet — elveszett. Az
ismeretlen kódú hiba mostantól a valódi okot is kiírja, a munkaterület-
foglaltság pedig saját kódot és üzenetet kapott (`workspace_busy`).

#### És a tünet valódi oka: a projektfoglalás elutasított ahelyett, hogy várt volna

A fenti munkaterület-zár valós versenyt szüntet meg, de **nem ez okozta** a
stop utáni hibát. A teljes üzenet elárulta: *„Ebben a projektben már fut egy
kérés."* Ez a `lib.rs` `live_project_locks` foglalása — ami már létezett, és
**elutasít**, nem vár. A foglalás a `ProjectClaim` eldobásakor szabadul fel,
vagyis akkor, amikor a `send()` visszatér: a megszakított körnél ez a guard
lezárása után van, tíz-húsz másodperccel a stop után.

Tehát a lánc: stop → a felület azonnal enged küldeni → a natív foglalás még
él → az új kérés elutasítva. Húsz másodperc múlva jó, mert addigra a régi
`send()` visszatért.

Megoldás: a foglalás állapotot kapott (`ProjectLockState { request_id,
draining }`). A cancel-parancsok (`claude_cancel`, `codex_cancel`,
`pipeline_cancel_request`) lezárás alattira jelölik a megszakított kör
foglalását, és a következő kérés ilyenkor **megvárja** a felszabadulást
(Condvar, 120 s timeout), ahelyett hogy hibázna.

A megkülönböztetés szándékos: egy **élő** turnra nem várunk — az percekig
futhat, és a csendben várakozó kérés rosszabb, mint egy világos mondat.
Csak a *lezárás alatti* foglalásra, ami véges és rövid.

*Ellenőrzés:* 169/169, egy új esettel
(`a_stopped_turn_is_waited_out_instead_of_refusing_the_next_one`): élő kör
mellett az elutasítás megmarad, leállítás után ugyanaz a kérés megkapja a
projektet. A döntés `claim_project_root`-ba került, hogy az útvonal-
ellenőrzéstől függetlenül tesztelhető legyen.

### 2. fázis — A felület futásonként olvas

Az `isStreaming` 34 olvasóhelye három kérdésre bomlik:

| kérdés | ki kérdezi | válasz forrása |
|---|---|---|
| „Fut-e *ez* a beszélgetés?" | composer zár, stop gomb, élő panel, `viewingActiveRun`, watchdog, `codeStatus`/`transportStatus` kijelzés | a nézett beszélgetés handle-je (`runByConversationRef` + `messageKeyRef`) |
| „Fut-e *ez* a sor a fában?" | `ThinkingDots` | kész — már ID-alapú, csak a Map-ből olvas majd |
| „Fut-e *bármi*?" | sync pull szünet, projektgyökér-zár, globális plafon | `runsRef.size > 0` |

Ezen felül futásonkénti/beszélgetésenkénti lesz: befejező hang és notify
(a futás gazdájának nevével: *„A(z) »X« beszélgetés válasza kész"*, ha nem őt
nézzük), `undoableSnapshot` (beszélgetéshez kötve — háttérben befejeződött
futás nem ajánlhat visszavonást a képernyőn álló másik beszélgetésen),
`agentApplyBusy` (projekthez kötve), `queuedSend` (beszélgetéshez kötve).

*Ellenőrzés:* mint az 1. fázis, plusz kézi lista: futás közben másik
beszélgetésben a composer szabad, a stop gomb csak a futó beszélgetésben
látszik, a hang akkor is szól, ha máshol vagyunk, az undo nem jelenik meg
idegen beszélgetésen.

### 3. fázis — A plafon felengedése

A plafon 1 → 3; a projekt-zár és a beszélgetés-zár élesedik a submit-úton
(a szabályok fent). A `submitBusyRef` marad globális, de csak a szinkron
előkészítő szakaszt (képmentés) védi — az `await` utáni rész már a handle-é.

Ez a fázis szándékosan kicsi: az összes nehéz munka az 1–2. fázisban van, itt
csak egy konstans nő és két kapu élesedik. Ha bármi rossz, a plafon
visszaállítása 1-re egyetlen sor — azonnali, kockázatmentes revert-út.

*Ellenőrzés (élő GUI, a felhasználóval):* A-projekt fut + B-projektben
indítás; mindkét válasz a helyére érkezik (restart utáni lemez-ellenőrzéssel —
a v4/v5 ID-teszt a bizonyíték); A-ban második indítás blokkolva, világos
üzenettel; GENERAL fut coding mellett; stop csak a sajátját állítja le;
plafon-üzenet a 4. kérésre.

#### 2–4. fázis — kész (2026-07-28)

Egy menetben, a felhasználó kérésére; a tesztelés a végén, fázisonként bontott
listával, hogy egy hiba be legyen mérhető.

**2. fázis.** Az `isStreaming` state és a `isStreamingRef` megszűnt: a
„fut-e valami" a futás-tábla mérete (`anyRunActive()`), a render-jel egy
`runsRevision` számláló. A 34 olvasóhely szétvált a tervezett három kérdésre:

- *ez a beszélgetés fut-e* → `viewedRun` (composer, stop gomb, élő panel,
  watchdog, görgetés-tapadás, újragenerálás, lánc-újrafuttatás gombja);
- *ez a sor fut-e a fában* → `runForConversationKey`, tehát **több sor is
  pöröghet egyszerre**, mindegyik a magáét mutatja;
- *fut-e bármi* → sync-pull szünet, projektgyökér-csere, a plafon.

Gazdát kapott: `undoableSnapshots` (beszélgetésenként — egy háttérben
befejeződött coding kör visszavonása különben a képernyőn álló *másik*
beszélgetésen kínálná fel idegen projekt fájljait), `agentApplyProjects`
(projektenként), `queuedSendConversations` (beszélgetésenként, és a
felszabadítás is a gazdáé), az `is-cancelling` jelzés (a nézett futásé). A
befejező hang mellé notify került a gazda nevével, ha nem őt nézzük.

**3. fázis.** `MAX_CONCURRENT_RUNS = 3`, és a küldés három kapun megy át:
beszélgetés fut → sorba áll (`queuedSend`); projekt fut → világos elutasítás;
plafon → világos elutasítás. A `submitBusyRef` beszélgetésenkénti lett
(`submitBusyConversationsRef`), különben az előkészítő szakasz egy másik
beszélgetés indítását is blokkolta volna.

**4. fázis.** A `pipelineProgress` és a `liveRunResume` state megszűnt; a lánc
állapota a handle `chain` mezőjében lakik, a render pedig a *nézett* futásból
olvassa. Két projektben két lánc futhat anélkül, hogy egymás paneljére
hazudnának. A szakasz-események a `chainRequestIds`-en találnak haza.

*Mérleg:* `tsc -b` tiszta, 50/50 frontend, 169/169 Rust, build zöld. Élő
GUI-teszt nem futott — az a felhasználóé.

### 4. fázis — Chain/pipeline a regiszterben

A `pipelineProgress`, `liveRunResume`, stage-választások és a re-run állapot
a handle `chain` mezőjébe költözik; a chain-események a
`chain.stageRequestIds`-en routolnak. Chain közben a projekt-zár ugyanúgy áll
(egy chain = egy futás). Amíg ez nincs kész, **chain indítása a plafont
1-re szorítja** — a chain a 3. fázisban még kizárólagos futás marad, hogy a
4. fázis ne legyen blokkoló.

*Ellenőrzés:* chain fut A-ban + sima kör B-ben; a run-panel csak a saját
beszélgetésében látszik; re-run változatlan.

## Ismert kockázatok, nyitott kérdések

- **requestId nélküli események.** A threadId-fallback lefedi; ami így sem
  routolható, azt eldobjuk. Ha egy provider rendszeresen kulcs nélkül küld
  értékes eseményt, az a bridge-ben javítandó (requestId rátétele), nem a
  routing lazításával.
- **`codeStatus`/`transportStatus` ma globális kijelzők.** A 2. fázisban a
  nézett futásból származnak; futás nélküli beszélgetésen az alap („készen")
  állapot látszik. Apró viselkedésváltozás, de a mai érték hazudik is, ha
  közben más beszélgetés futott.
- **Erőforrás.** 3 párhuzamos futás = 3 provider-processz + turn-végi
  guard-pásztázások átfedésben. A 10. lépés párhuzamosítása után egy pásztázás
  szálkészletet használ; három egyszerre OneDrive-on lassabb lesz darabonként.
  A plafon konstans, tapasztalat alapján hangolható.
- **A 96 useState-es App().** A regiszter *nem* növeli a render-terhelést
  (a Map ref, nem state; a nézet a maga kis szeletét state-ként kapja), de a
  fájl tovább nő. A komponensbontás (eredeti 3. lépés) e terv után
  esedékes — előbb működjön, aztán költözzön.

## Sorrend és becslés

| fázis | méret | kockázat | kiadható utána? |
|---|---|---|---|
| 1. regiszter | nagy (a ~13 ref + eseménykezelő átvezetése) | közepes — tiszta mechanika, de sok hely | igen, viselkedés azonos |
| 2. felület | közepes (34 olvasóhely + 5 globális state) | közepes — itt dőlnek el a UX-részletek | igen, még mindig 1 futás |
| 3. plafon | kicsi | kicsi, revert egy sor | **itt jelenik meg a funkció** |
| 4. chain | közepes | közepes | igen |

A 3. fázis végi élő GUI-teszt a felhasználóval közös — a történet
(három bukott guard-javítás) miatt lemez-szintű ellenőrzéssel: restart után
a sorok ott vannak-e, ahol lenniük kell, és **csak** ott.
