# Futás közbeni chat — részletes implementációs terv

*2026-08-01 · csak terv, ebben a körben nincs kódimplementáció*

## Rövid döntés

A composer futás közben ne egyszerűen a következő turnt készítse elő. Két,
egyértelműen különválasztott küldési módot kapjon:

1. **TERELÉS** — az üzenet még az aktuálisan futó AI-turnbe kerül, így a modell
   munka közben tud reagálni rá és irányt váltani.
2. **KÖVETKEZŐ ÜZENET** — az üzenet tartós sorba kerül, majd a jelenlegi teljes
   futás biztonságos lezárása után új turnként indul.

A futás közbeni alapértelmezés a **TERELÉS** legyen. Ez felel meg annak, amit a
felhasználó „futás közbeni chatként” vár: lehessen pontosítani, kérdezni vagy
megállítani egy rossz irányt anélkül, hogy a teljes futást le kellene állítani.

Ez a dokumentum felülírja a `PARALLEL_WORK_REVERT_STEER_PLAN.md` F3 szakaszának
Codex-korlátozását. Az akkori feltételezéssel szemben a jelenlegi Codex
app-server támogatja a valódi `turn/steer` hívást, ezért ChatGPT/Codex esetén
sem kell a következő turnre halasztani az inputot.

## Kutatással igazolt technikai alap

### Codex / ChatGPT

A friss helyi Codex manual szerint az app-server `turn/steer` metódusa új turn
indítása nélkül fűz inputot az aktív turnhöz:

```json
{
  "method": "turn/steer",
  "id": 32,
  "params": {
    "threadId": "thr_123",
    "input": [
      { "type": "text", "text": "Előbb a hibás teszteket javítsd." }
    ],
    "expectedTurnId": "turn_456"
  }
}
```

Fontos protokolltulajdonságok:

- az `expectedTurnId` csak az éppen futó turnnel egyezhet;
- nincs új `turn/started` esemény;
- a steer nem módosíthat modellt, effortot vagy más turn-opciót;
- aktív turn nélkül a kérés hibával tér vissza;
- a turnváltási verseny emiatt felismerhető, nem kell rossz stage-nek elküldeni
  az üzenetet.

### Claude

A projektben telepített `@anthropic-ai/claude-agent-sdk@0.3.218` tartalmazza:

- a `Query.streamInput(stream: AsyncIterable<SDKUserMessage>)` API-t;
- az `SDKUserMessage.priority?: "now" | "next" | "later"` mezőt;
- string helyett `AsyncIterable<SDKUserMessage>` kezdeti promptot.

Az `agent-bridge/steering-probe.mjs` korábbi élő próbája már igazolta, hogy egy
futó Claude-turn `priority: "now"` üzenetet átvesz, irányt vált, majd rendesen
lezárul. Ezért itt sem prompt-trükkről vagy következő turnre váró közelítésről
van szó.

## A jelenlegi működés diagnózisa

### Ami már jó alap

- A `RunHandle` beszélgetéshez, projekthez és request ID-hez kötött; több
  projekt futása nem egyetlen globális „aktív kérésen” osztozik.
- A Multi-AI pipeline minden stage-hez külön request ID-t tart fenn.
- A Claude Rust-runtime már őrzi a bridge `stdin` writerét, mert az approval és
  user-question válaszok ma is ezen mennek vissza.
- A pipeline request-ID térképe és a frontend stage-progress eseményei alapján
  meghatározható, melyik AI és melyik fázis fut éppen.
- A timeline és a SQLite-store már ismeri a turn-, provider- és pipeline-
  metaadatokat.

### Ami ma nem valódi futás közbeni chat

A `src/App.tsx` jelenlegi megoldása beszélgetésenként csak egy logikai flaget
tart (`queuedSendRef` / `queuedSendConversations`). Ha futás közben Entert
nyomunk:

- a szöveget nem másolja ki változtathatatlan queue-elembe;
- a textarea tartalma marad az egyetlen „sorban álló üzenet”;
- nincs több üzenet, szerkesztés, sorrendezés vagy cél-stage;
- beszélgetésváltáskor a composer kiürül;
- a futás végén csak akkor történik `requestSubmit()`, ha még ugyanaz a
  beszélgetés van nyitva;
- a modell a futó turn közben semmit nem kap meg.

Ezért a mostani flaget nem érdemes tovább foltozni. Valódi inputobjektumra,
provider-ACK-ra és tulajdonos-beszélgetés alapján működő dispatchre van szükség.

## Felhasználói működés

### 1. Futó turn alatt

A composer láthatóan futás közbeni módra vált:

```text
┌  ⇢ TERELÉS · KÓD · ChatGPT  ────────────────────────────────┐
│ Írj a futó AI-nak…                                          │
│                                                   [küldés ⇢] │
└──────────────────────────────────────────────────────────────┘
```

- A fejléc-chip megnevezi a célt: például `KÓD · ChatGPT`, `REVIEW · Claude`
  vagy `GENERAL · ChatGPT`.
- Enter az aktuálisan kijelölt mód szerint küld.
- Shift+Enter továbbra is sortörés.
- A küldőgomb melletti kis menüben választható:
  - `Terelés most`;
  - `Következő üzenetként sorba`.
- A Tab maradjon normál fókusznavigáció; ne vegyük át rejtett shortcutnak.
- Opcionális gyorsbillentyű: `Ctrl+Shift+Enter` az alapértelmezéssel ellentétes
  küldési mód.

### 2. Mit jelent itt a „chat”

A TERELÉS ugyanannak a futó agentnek szól, ugyanabban a turnben. Nem indul
párhuzamos mini-chat és nem jön létre második válaszkártya. A modell következő
kommentárja, tool-döntése vagy végső válasza már az új input figyelembevételével
folytatódik.

Több terelés is küldhető egymás után. Mindegyik külön állapotot kap, és a
timeline-ban a tényleges elfogadási sorrendben jelenik meg.

### 3. Küldési állapotok

Egy menet közbeni input kliensoldali állapotgépe:

```text
draft
  └─ send ─► sending
                ├─ provider ACK ─► accepted ─► persisted
                └─ reject/exit  ─► failed ─► draft visszaállítva
```

- A textarea csak provider-ACK után ürül ki.
- Küldés közben a timeline-ban lehet egy halvány, lokális pending buborék.
- Elfogadás után pipa és `MENET KÖZBEN → KÓD` jelölés jelenik meg.
- Hiba esetén a teljes szöveg, quote és támogatott attachment visszakerül a
  composerbe; semmi nem vész el.
- A kliens nem állítja, hogy „elküldve”, ha csak a Rust-parancsig jutott el.

### 4. Stage-váltás közbeni verseny

A user a `KÓD` stage-re nézve nyomhat küldést, miközben közben már a `REVIEW`
indul el. Ilyenkor tilos csendben a REVIEW-nak átadni ugyanazt az üzenetet.

A küldés rögzíti a cél request ID-t, provider turn ID-t és egy stage-epochot.
Ha ezek már nem aktuálisak:

- a backend `target_changed` eredményt ad;
- a draft megmarad;
- a GUI kiírja: `Közben REVIEW indult. Küldés ennek a fázisnak vagy sorba
  állítás?`;
- csak új, látható felhasználói akció küldi el másik stage-nek.

### 5. Finalizálás és snapshot-mentés

Amikor a provider turnje már lezárult, de a snapshot/fájlösszesítés még fut:

- TERELÉS már nem választható, mert nincs élő provider-turn;
- a composer automatikusan `KÖVETKEZŐ ÜZENET` módot mutat;
- a user ettől még írhat és sorba állíthat;
- a következő turn csak a teljes guard/snapshot finalizálás után indul.

## Közös adatmodell

Új, providersemleges frontend típusok kerüljenek külön modulba, például
`src/runInput.ts`:

```ts
type RunInputMode = "steer" | "follow_up";

type RunInputTarget = {
  conversationId: string;
  rootRequestId: string;
  providerRequestId: string;
  provider: "codex" | "anthropic";
  providerThreadId?: string;
  providerTurnId?: string;
  pipelineRunId?: string;
  stageIndex?: number;
  stageRole?: "plan" | "code" | "review";
  stageEpoch: number;
};

type RunInputPayload = {
  inputId: string;
  mode: RunInputMode;
  text: string;
  modelPrompt: string;
  quoteRefs: QuoteReference[];
  images: PendingImageAttachment[];
  target?: RunInputTarget;
  createdAt: string;
};

type RunInputDelivery =
  | { status: "draft" }
  | { status: "sending"; sentAt: string }
  | { status: "accepted"; acceptedAt: string; target: RunInputTarget }
  | { status: "failed"; code: RunInputErrorCode; message: string };
```

Az `inputId` UUID és idempotenciakulcs. Ugyanaz az `inputId` dupla kattintás,
React újrarender vagy transport-retry miatt sem juthat el kétszer ugyanahhoz a
runtime-hoz.

## A célpont feloldása

Egyetlen tiszta függvény legyen felelős a composer aktuális céljáért:

```ts
resolveRunInputTarget(conversationId, runs, pipelineProgress)
```

Szabályok:

1. A beszélgetés saját `RunHandle` példányából indul, nem az éppen renderelt
   globális refből.
2. EGY AI esetén a root request ID a provider request ID is.
3. Multi-AI esetén a `pipelineProgress.requestId` / aktív `chainRequestId` a
   provider request ID.
4. A provider az aktív stage saját providere, nem a composer pillanatnyi model
   választása.
5. `turnCompleted`, `finalizing` vagy hiányzó aktív provider-turn esetén nincs
   steer target.
6. A célpont egy monoton `stageEpoch` értéket is kap; minden stage-váltás növeli.

Ez a resolver külön unit tesztet kap, mert a korábbi stage- és projekt-routing
hibák nagy része abból eredt, hogy a renderelt beszélgetésből következtettünk a
futó kérésre.

## Tauri API és eseményprotokoll

### Új parancs

```rust
#[tauri::command]
async fn agent_steer(request: AgentSteerRequest)
    -> Result<AgentSteerQueued, AgentSteerError>
```

Kérésmezők:

- `input_id`;
- `conversation_id`;
- `root_request_id`;
- `provider_request_id`;
- `provider`;
- `expected_provider_turn_id`;
- `expected_stage_epoch`;
- `text` vagy normalizált content-block lista;
- pipeline stage metaadatok.

A parancs sikeres visszatérése csak azt jelenti, hogy a kérés a megfelelő aktív
runtime transportjába bekerült. A tényleges provider-válasz külön esemény:

```text
agent-input-status {
  inputId,
  conversationId,
  rootRequestId,
  providerRequestId,
  status: sending | accepted | rejected,
  code?, message?,
  acceptedTarget?
}
```

Nem kerül rövid, önkényes ACK-timeout a rendszerbe. Ha a provider nem válaszol,
az input `sending` marad; process exit, cancel vagy turn completion esetén a
runtime köteles az összes függő inputot determinisztikusan `rejected` állapotba
tenni. Az ACK-várakozás soha nem állítja le az alapfutást.

### Hibatípusok

Legalább az alábbi gépi kódok legyenek:

- `no_active_run`;
- `no_active_turn`;
- `target_changed`;
- `transport_closed`;
- `provider_rejected`;
- `unsupported_payload`;
- `duplicate_input`;
- `run_cancelled`;
- `runtime_failed`.

A frontend ezekből fordít magyar üzenetet; ne a Rust/Node szabad szövegét
próbálja értelmezni.

## Codex-runtime implementáció

Érintett fő fájl: `src-tauri/src/codex.rs`.

### Szükséges változtatások

1. Az `ActiveRequest` bővüljön az alábbiakkal:
   - sorosított `ChildStdin` writer vagy dedikált writer actor/channel;
   - `thread_id`;
   - valódi provider `turn_id`;
   - monoton JSON-RPC request-ID generátor;
   - pending steer ACK-ek térképe `rpc_id -> input_id`;
   - elfogadott `input_id`-k idempotenciahalmaza.
2. A `turn/start` response-ból ne csak a buffered notificationöket őrizzük meg;
   a visszaadott turn ID kerüljön az aktív requestbe és a frontend eseménybe.
3. Minden app-server stdin-írás ugyanazon a sorosított útvonalon menjen:
   initialize, thread/start/resume, turn/start, approval response és turn/steer.
   Két JSONL frame nem fűződhet össze.
4. Az `agent_steer` Codex-ága a rögzített `threadId`, `input` és
   `expectedTurnId` mezőkkel írja ki a `turn/steer` JSON-RPC kérést.
5. A meglévő stdout read loop különböztesse meg:
   - provider notification;
   - provider által indított request;
   - a mi pending steer kérésünkre érkező response/error.
6. Sikeres response esetén `accepted`, JSON-RPC error esetén típusos `rejected`
   esemény menjen a frontendnek.
7. A turn lezárásának pillanatában előbb záródjon a steer-kapu és utána induljon
   a snapshot-finalizálás. Így egy késői input nem csúszhat a következő turnbe.
8. Process exit/cancel minden pending ACK-et rendezzen; ne maradjon örök pending
   UI-állapot.

### Codex-specifikus tesztek

- aktív turn + helyes `expectedTurnId` → `turn/steer` pontos frame;
- hibás/régi turn ID → `target_changed`;
- két gyors steer → két külön, nem összefűzött JSONL frame és helyes ACK;
- ugyanaz az `inputId` kétszer → egyszeri provider-küldés;
- turn completion és steer race → vagy elfogadott a régi turnben, vagy tiszta
  reject; soha nem kerül az új turnbe;
- cancel közben pending steer → `run_cancelled`;
- server-request response és steer párhuzamos írása nem korrumpálja a streamet.

## Claude bridge implementáció

Érintett fő fájlok: `src-tauri/src/claude.rs`, `agent-bridge/main.mjs`.

### Rust-oldal

1. A már létező `send_to_request(...)` útvonalon új `steer_turn` bridge-frame
   menjen, tehát új processz vagy új Claude-session nem kell.
2. A frame tartalmazza az `inputId`, request ID, elvárt session/turn azonosító,
   stage metaadat és content payload mezőket.
3. A `turn_finished`, `turn_failed`, cancel és bridge exit minden pending
   inputot lezár.

### Node bridge

1. Az `activeRequests` turnobjektuma kapjon `TurnInputBroker` példányt.
2. A broker:
   - egyszer adja át a kezdeti user promptot;
   - FIFO-ban fogad több futás közbeni üzenetet;
   - `SDKUserMessage` objektumot készít `priority: "now"` értékkel;
   - ismeri a lezárt/cancelled állapotot;
   - input ID alapján deduplikál.
3. A `query()` async inputtal induljon, vagy a `Query.streamInput(...)` útvonalat
   használja. Az implementáció elején izolált teszt döntse el a két támogatott
   API közül azt, amelyik több egymás utáni inputnál és turnlezárásnál
   determinisztikusan működik. A már sikeres async-generátoros probe legyen a
   referencia és fallback.
4. `steer_accepted` csak akkor menjen vissza, amikor az SDK inputcsatornája az
   elemet ténylegesen átvette; a Node stdin-frame puszta beolvasása még nem ACK.
5. A broker a result után azonnal záródjon. Későbbi input `no_active_turn`.
6. Az overload/session-retry ág ne veszítsen és ne duplázzon inputot:
   - a még át nem adott elemek maradnak a broker queue-jában;
   - az SDK-nak már átadott input ugyanabban a retry-attemptben nem ismétlődik;
   - minden input stabil `inputId` jelölést kap a bridge belső journaljában;
   - bizonytalan provider-határnál a bridge ne állítson hamis exactly-once
     garanciát, hanem naplózza az attemptet és csak bizonyítottan át nem adott
     elemet játsszon újra.

### Claude-specifikus tesztek

- nulla steerrel a mai turn pontosan ugyanúgy lezárul;
- egy és több `priority: "now"` input sorrendhelyesen átmegy;
- a bridge `steer_accepted` eseménye a megfelelő input ID-t viszi;
- turn vége után érkező steer nem jut a következő turnbe;
- cancel bezárja a brokert és rejecteli a pending elemeket;
- 529/retry előtt és után érkező inputok nem vesznek el;
- approval/question várakozás közben küldött steer nem keveredik az approval
  response protokolljával.

## Multi-AI pipeline szemantikája

A pipeline-ban két külön követelményt kell egyszerre teljesíteni:

1. az üzenet az **éppen futó stage-et** azonnal terelje;
2. a user új követelménye a **későbbi stage-ekből se vesszen ki**.

### Aktív stage

- A frontend az aktív stage saját provider request ID-ját célozza.
- A Rust pipeline-regiszter validálja a pipeline run ID-t, stage indexet és
  stage-epochot.
- A provider ACK után az input bekerül a pipeline `run input journaljába`.

### Későbbi stage-ek

Minden elfogadott menet közbeni input strukturált journalbejegyzés:

```json
{
  "inputId": "...",
  "acceptedAtStage": 2,
  "acceptedAtRole": "code",
  "text": "A listát ne kártyákból, hanem kompakt sorokból építsd.",
  "acceptedAt": "..."
}
```

A későbbi stage-promptok kapjanak egy külön, egyértelmű blokkot:

```text
[A FUTÁS KÖZBEN HOZZÁADOTT FELHASZNÁLÓI UTASÍTÁSOK]
- ...
```

Ezt nem a provider nyers outputjából kell visszabányászni. A pipeline state
explicit mezőként vigye tovább. Ugyanez a journal kerüljön bele:

- PLAN → CODE átadásba;
- CODE → REVIEW átadásba;
- review alapján indított v2 `retryFeedback` kontextusába;
- resume/restart state-be, ha a pipeline egy stage-től folytatható.

### Stage-határon sorba álló input

Ha nincs aktív provider-turn a két stage között, TERELÉS nem lehetséges. A GUI
ilyenkor röviden `Következő fázis indul…` állapotot mutat, és felajánlja:

- `Küldés a következő fázisnak` — stage-input queue;
- `Új turnként később` — conversation follow-up queue.

A két queue ne legyen összemosva: az első ugyanazon pipeline kontextusa, a
második új user-turn.

## Perzisztencia és sync

### Elfogadott terelések

Az elfogadott terelés a beszélgetés történetének része. Ha nincs elmentve és
szinkronizálva, egy másik gépen úgy látszana, hogy a modell magától váltott
irányt.

A store schema következő verziójában (a jelenlegi v23 után v24) a `messages`
tábla kapjon `interaction_json TEXT` mezőt. Normál üzenetnél `NULL`, elfogadott
terelésnél például:

```json
{
  "kind": "steer",
  "inputId": "...",
  "parentTurnId": "client-turn-...",
  "targetProvider": "codex",
  "targetRequestId": "stage-request-...",
  "targetProviderTurnId": "turn_...",
  "pipelineRunId": "...",
  "stageIndex": 2,
  "stageRole": "code",
  "acceptedAt": "..."
}
```

Szabályok:

- csak provider által elfogadott steer lesz tartós user message;
- `turn_id` a root kliens-turnhöz kösse, hogy ugyanabban a work groupban maradjon;
- a konkrét stage-cél az `interaction_json`-ban marad;
- `LocalMessage`, snapshot export/import, reducer, journal és sync merge mind
  vigye ezt a mezőt;
- régi üzeneteknél a `NULL` jelentése normál turnkezdő user message;
- az `inputId` alapján a sync reducer is deduplikáljon.

### Következő üzenetek queue-ja

A follow-up queue ezzel szemben **eszközlokális**, amíg ténylegesen el nem
indul. Egy másik gép nem tud a jelen gépen futó processz után automatikusan
folytatni.

Új lokális, sync-exportból kizárt SQLite tábla:

```text
pending_followups
- id
- conversation_id
- position
- body
- model_prompt
- quote_refs_json
- attachments_json
- request_settings_json
- created_at
- updated_at
```

A queue a küldés pillanatában rögzítse a teljes payloadot és a request
beállításait. Ne a későbbi textarea-, model- vagy pipeline-állapotból épüljön.

App újraindításkor:

- a queue megmarad;
- mivel a korábbi futó processz már nem él, semmi ne induljon el láthatatlanul;
- a composer felett `1 elküldetlen következő üzenet` recovery-kártya jelenjen
  meg `Küldés`, `Szerkesztés`, `Törlés` gombokkal.

## Timeline és történeti megjelenítés

Az elfogadott terelés ne nyisson új run-kártyát. Ugyanazon work groupon belül,
időrendi user-buborékként jelenjen meg:

```text
AI gondolkodás / műveletek
⇢ TE · MENET KÖZBEN → KÓD    "Legyen egy sor minden BWV."
AI következő kommentárja / műveletei
végső válasz
```

Érintett logika:

- `chatTimeline.ts` a `kind: "steer"` user message-et a `parentTurnId` work
  groupjához kapcsolja, nem új user→assistant párnak tekinti;
- Részletes nézetben időrendi trace marker legyen;
- Nem-Részletes nézetben kompakt bézs user-buborék jelenjen meg a kapcsolódó
  válasz/gondolkodás előtt;
- Multi-AI-nál stage badge is látszódjon;
- reload és másik gépről érkező sync után ugyanaz a csoportosítás épüljön fel;
- failed/pending input csak lokális overlay, nem történeti message.

## A follow-up queue új működése

A jelenlegi `Set<string>` és DOM `requestSubmit()` megoldást teljesen váltsa le
egy `QueuedFollowUp[]` modell.

Tulajdonságok:

- beszélgetésenként FIFO lista;
- több üzenet felvehető;
- minden elem szerkeszthető, törölhető és átrendezhető;
- a teljes szöveg, quote, attachment és request recipe már queue-záskor rögzül;
- a futás befejezése után tulajdonos-beszélgetés alapján indul, akkor is, ha a
  user közben másik projektet néz;
- nincs szükség aktív DOM formra vagy aktív textarea-tartalomra;
- a queue dispatch ugyanazt a tiszta `startTurn(payload)` függvényt hívja, mint
  a normál composer-küldés;
- projektzár és max párhuzamos futásszám miatt ideiglenesen várhat, de állapota
  látható marad;
- stop nem törli automatikusan a follow-up queue-t.

A composer feletti queue-sáv első verziója:

```text
KÖVETKEZŐ ÜZENETEK · 2
1. "Ha kész, futtasd a mobilon is…"   [szerkeszt] [↑] [↓] [×]
2. "A listában legyen kereső…"        [szerkeszt] [↑] [↓] [×]
```

## Attachment- és speciális inputszabályok

### Első szállítható verzió

- TERELÉS: text és quote-ok szövegesen kibontva;
- KÖVETKEZŐ ÜZENET: a mai teljes payload, képekkel együtt;
- új kép csatolása aktív steerhez kezdetben nem támogatott;
- ha van kép, a GUI automatikus váltás helyett egyértelműen közli:
  `Képes üzenet jelenleg csak következő üzenetként küldhető.`

Ez csökkenti annak kockázatát, hogy Codex content block és Claude MessageParam
eltérő fájl-élettartama miatt egy ideiglenes attachment eltűnjön turn közben.

### Későbbi bővítés

Képes steer akkor kapcsolható be, ha mindkét providerre van integrációs teszt a
content blockról, ideiglenes fájl-élettartamról, cancelről és reloadról.

### Ami soha ne legyen steer

- slash command;
- model- vagy effort-váltás;
- pipeline recipe-váltás;
- Részletes/Nem-Részletes módváltás;
- v2 review-újrafuttatás indítása.

Ezek új turn vagy UI-művelet, nem a futó provider inputja.

## Stop, bezárás és hibák

### Stop

- A már elfogadott terelés a historyban marad.
- A `sending` terelés `run_cancelled` hibát kap és draftként visszaállítható.
- A pipeline stage-input queue törlődik, mert ugyanahhoz a megszakított runhoz
  tartozott.
- A conversation follow-up queue megmarad.

### Ablakbezárás

A meglévő futásvédelmi dialógus térjen ki arra is, ha pending steer vagy queue
van. Futó provider processz lezárásakor minden input státusza rendeződjön, majd
a follow-up queue maradjon recoveryre.

### Provider-kapcsolati hiba

- A steer hibája önmagában ne cancelje a futó turnt.
- A draft maradjon meg.
- Retry ugyanazzal az `inputId`-val csak akkor menjen, ha a backend biztosan
  rejectelte; bizonytalan ACK esetén előbb runtime-state lekérdezés szükséges.
- Ha maga a provider turn is meghalt, a normál turn-failure útvonal zárja le a
  kártyát és ajánlja fel a follow-upként újraküldést.

## Implementációs bontás

### 0. fázis — szerződés és regressziós alap

- A jelen dokumentum döntéseinek rögzítése.
- `agent-input-status` payload és hibakódok közös TS/Rust definíciója.
- A jelenlegi queue-bugokat reprodukáló frontend tesztek:
  beszélgetésváltás, több queue-elem, finalizing állapot.
- A Codex app-server és Claude SDK verzió/capability diagnostic logja.
- Nincs UI bekapcsolva ebben a fázisban.

### 1. fázis — tiszta frontend input- és queue-modell

- Új `src/runInput.ts` reducer és selectorok.
- `submitMessage` felbontása:
  - `captureComposerPayload()`;
  - `resolveRunInputTarget()`;
  - `sendSteer(payload, target)`;
  - `enqueueFollowUp(payload)`;
  - `startTurn(payload, ownerConversationId)`.
- A `queuedSendRef`, `queuedSendConversations` és `releaseQueuedSend()` még
  feature flag mögött marad, amíg az új queue nem teljes.
- Pure unit tesztek target routingra és state transitionökre.

### 2. fázis — store v24 és lokális follow-up queue

- `messages.interaction_json` migráció.
- `pending_followups` lokális tábla és CRUD Tauri-parancsok.
- `LocalMessage` / sync / snapshot mező továbbítása.
- Migrációs, export-import, journal-reducer és kétgépes merge tesztek.
- Régi v23 adatbázisból veszteségmentes indulás.

### 3. fázis — Codex valódi steer

- Codex writer és aktív turn-regiszter bővítése.
- `turn/start` valódi turn ID eltárolása.
- `turn/steer` JSON-RPC és ACK-korreláció.
- Close/cancel/race/idempotencia tesztek.
- Élő smoke: hosszú GENERAL és hosszú CODING turn közben két terelés.

### 4. fázis — Claude valódi steer

- `TurnInputBroker` és `steer_turn` bridge-protokoll.
- `priority: "now"` továbbítás, ACK és lifecycle.
- Több input, approval, cancel és retry tesztek.
- A meglévő `steering-probe.mjs` automatikus regressziós tesztté alakítása úgy,
  hogy normál tesztben mockolt SDK-val fusson; az élő próba külön maradjon.

### 5. fázis — pipeline journal és stage-routing

- Stage epoch és aktív provider request resolver.
- Elfogadott steer journal továbbvitele a következő stage-ekbe és v2-be.
- Stage-határ input queue.
- PLAN, CODE, REVIEW és PLAN→REVIEW recipe tesztek vegyes providerrel.

### 6. fázis — végleges composer és timeline UX

- TERELÉS / KÖVETKEZŐ választó és cél-chip.
- Pending/accepted/failed user marker.
- Többelemű queue-sáv szerkesztéssel és rendezéssel.
- Részletes és Nem-Részletes timeline integráció.
- Keyboard, fókusz, screen-reader label és kis ablakmagasság ellenőrzése.

### 7. fázis — régi út eltávolítása és hardening

- Régi boolean queue és DOM `requestSubmit()` eltávolítása.
- Diagnostic logok és recovery nézet.
- Teljes regresszió EGY AI, Multi-AI, GENERAL, v2, stop, app-restart és
  párhuzamos projektek mellett.
- Feature flag végleges bekapcsolása, majd a flag eltávolítása.

## Fájlszintű változtatási térkép

| Fájl | Tervezett felelősség |
|---|---|
| `src/App.tsx` | Composer orchestration szétbontása, target kiválasztása, eseménybekötés |
| `src/runInput.ts` | Új, tiszta input/queue state machine és selectorok |
| `src/chatTimeline.ts` | Steer ugyanabba a work groupba rendezése |
| `src/CompactAnswersTimeline.tsx` | Menet közbeni user-marker megjelenítése |
| `src/agentEvent.ts` | `agent-input-status` normalizálás |
| `styles.css` | Cél-chip, pending/accepted/failed buborék, queue lista |
| `src-tauri/src/lib.rs` | Providersemleges Tauri command, pipeline target-validáció |
| `src-tauri/src/codex.rs` | App-server writer, `turn/steer`, JSON-RPC ACK routing |
| `src-tauri/src/claude.rs` | `steer_turn` frame és bridge lifecycle |
| `agent-bridge/main.mjs` | Claude `TurnInputBroker`, SDK streaming input |
| `src-tauri/src/store.rs` | v24 migráció, interaction meta, pending follow-up CRUD |
| `src-tauri/src/sync.rs` | Elfogadott steer meta sync és deduplikáció |
| `tests/runInput.test.ts` | Frontend state/routing/queue tesztek |
| `tests/chatTimeline.test.ts` | Történeti csoportosítás és reload regresszió |
| `agent-bridge/*.test.mjs` | Claude input lifecycle és protokoll |

## Kötelező tesztmátrix

| Mód | Provider | Eset | Elvárt eredmény |
|---|---|---|---|
| GENERAL | Codex | 1 steer | Ugyanabba a turnbe érkezik, nincs új kártya |
| CODING EGY AI | Codex | 2 gyors steer | Sorrendhelyes ACK és history |
| CODING EGY AI | Claude | 1 steer tool futás alatt | `priority: now`, normál turnlezárás |
| TERV→KÓD→REVIEW | vegyes | steer KÓD közben | KÓD azonnal kapja, REVIEW prompt is örökli |
| TERV→REVIEW | vegyes | steer PLAN közben | PLAN kapja, REVIEW örökli |
| Multi-AI | bármely | küldés stage-váltáskor | Látható `target_changed`, nincs félreküldés |
| bármely | bármely | steer finalizing alatt | Csak queue választható |
| bármely | bármely | cancel pending ACK-kal | Draft visszaáll, run lezár |
| bármely | bármely | beszélgetésváltás | Futás és input saját ownerhez marad |
| két projekt | vegyes | párhuzamos futások | Mindkét composer a saját targetet mutatja |
| queue | bármely | másik beszélgetés van nyitva | Saját beszélgetésében automatikusan indul |
| queue | bármely | app restart | Recovery-kártya, nincs néma auto-run |
| sync | bármely | második gép | Elfogadott steer ugyanabban a work groupban |
| retry | Claude | 529 közben steer | Nincs elvesztés vagy app-oldali duplázás |
| race | Codex | turn complete + steer | ACK vagy tiszta reject, új turnbe nem szivárog |

## Manuális átvételi forgatókönyv

1. Indíts hosszú KÓD futást ChatGPT-vel.
2. Miközben fájlt olvas, küldd: `Ne nyúlj a styles.css-hez.`
3. A buborék először pending, majd pipás `MENET KÖZBEN → KÓD` legyen.
4. A futás folytatódjon, ne jöjjön létre új turnkártya.
5. A változáslistában ne legyen `styles.css`.
6. Ugyanezt ismételd Claude-dal.
7. Multi-AI KÓD stage alatt küldj új követelményt, majd ellenőrizd, hogy a
   REVIEW explicit módon ellenőrzi azt.
8. Tegyél két következő üzenetet queue-ba, válts másik projektre, és ellenőrizd,
   hogy a megfelelő beszélgetésben, FIFO-ban indulnak.
9. Indíts újabb futást, állítsd le steer küldése közben, majd ellenőrizd, hogy a
   szöveg visszakapható és semmi nem került a következő turnbe.
10. Indítsd újra az appot, és ellenőrizd a megmaradt, de automatikusan el nem
    indított follow-up recoveryt.

## Nem cél ebben a fejlesztésben

- Két külön AI-turn párhuzamos futtatása ugyanabban a beszélgetésben.
- Külön „mellék-chat” agent indítása a fő kódoló mellett.
- Provider rejtett chain-of-thoughtjának megjelenítése.
- Modell/effort menet közbeni cseréje.
- Képes Claude/Codex steer az első szállításban.
- A queue felhőn át történő automatikus átvétele másik gépen.

## Kockázatok és ellenszerek

### 1. Az AI későn veszi figyelembe a terelést

A provider elfogadása nem garantálja, hogy egy már futó tool-hívás félbeszakad.
A UI ezért az elfogadás pontos helyét mutatja, és nem ír olyat, hogy a modell
„végrehajtotta”. A végső megfelelést a REVIEW vagy a user ellenőrzi.

### 2. Input rossz pipeline stage-be kerül

Ellenszer: request ID + provider turn ID + stage epoch kötelező együtt, stale
célra reject, automatikus átirányítás nélkül.

### 3. Duplázás retry vagy dupla kattintás miatt

Ellenszer: stabil `inputId`, backend idempotenciahalmaz, ACK-korreláció, sync
deduplikáció.

### 4. Composer-szöveg elvesztése

Ellenszer: immutable payload capture küldéskor; textarea csak ACK után ürül;
rejectnél teljes draft restore; follow-up SQLite-perzisztencia.

### 5. App-server JSONL korrupció

Ellenszer: egyetlen writer actor/lock és monoton JSON-RPC ID-k; concurrency
teszt approval + steer párhuzamos írással.

### 6. Claude retry bizonytalan kézbesítése

Ellenszer: broker-szintű delivery journal és attempt-state; csak bizonyítottan
át nem adott input automatikus replaye. Bizonytalan esetben a GUI jelezzen, ne
állítson hamis exactly-once garanciát.

## Kész definíciója

A funkció csak akkor tekinthető késznek, ha:

- ChatGPT/Codex és Claude is valódi, ugyanabba a turnbe küldött steer inputot
  kap;
- működik GENERAL, EGY AI és minden Multi-AI stage alatt;
- a user mindig látja, melyik providernek és fázisnak küld;
- stage-race esetén nincs néma félreküldés;
- több follow-up üzenet tartósan sorba állítható és beszélgetésváltás után is
  a helyén marad;
- elfogadott steer reload és sync után is a megfelelő work groupban látszik;
- stop, provider exit és app-restart után nincs elveszett vagy következő turnbe
  átszivárgó input;
- a célzott Rust, Node és frontend tesztek zöldek;
- a manuális ChatGPT- és Claude-smoke is bizonyítja a menet közbeni irányváltást;
- az ellenőrzéshez nem készül release build; csak célzott tesztek és fejlesztői
  futtatás szükséges.

## Javasolt commit-sorrend

1. `refactor: extract run input and follow-up queue state`
2. `feat: persist steer metadata and local follow-up queue`
3. `feat: steer active codex app-server turns`
4. `feat: stream mid-turn input to claude bridge`
5. `feat: carry live user input across pipeline stages`
6. `feat: add runtime chat composer and timeline UI`
7. `test: harden runtime chat races recovery and sync`

Minden commit önmagában tesztelhető legyen. A régi queue-út csak akkor kerüljön
ki, amikor az új follow-up queue és mindkét provider steering útja már zöld.
