# Claude CODING integráció – teljes megvalósítási terv

**Állapot:** az 1–16. fázis kódja és a 14.3/1–4 élő acceptance-szelete implementálva; a provider-neutral guard, a Claude runtime, a restart/cross-device recovery és a hibakezelési slice valódi debug GUI-ban ellenőrizve; a hitelesítés a 16. fázisban előfizetésesre váltott; release nincs a scope-ban  
**Készült:** 2026-07-23 · **Módosítva:** 2026-07-25  
**Célkörnyezet:** Windows, Tauri + React/Vite kliens, Rust backend, debug desktop shortcut  
**Kezdő API-keret:** 5 USD Claude API-kredit

## 1. Vezetői összefoglaló

Az 5 USD Claude API-kredit elegendő a Claude CODING integráció technikai vertical slice-ához és több valódi end-to-end GUI-smoke teszthez, ha:

- az automatizált tesztek túlnyomó része mockolt eseményfolyamot használ;
- az élő Claude-tesztek kis fixture repositoryban futnak;
- minden élő turn kap `maxBudgetUsd` és `maxTurns` korlátot;
- a hosszú kontextusú éles projekt csak a teljes alapfolyam igazolása után kerül sorra;
- a Claude Console automatikus kredittöltése ki van kapcsolva.

A cél nem egyszerű Claude-chat hozzáadása. A Claude a `CODING` mód teljes értékű coding agentje lesz a jelenlegi Codex mellett:

- projektkönyvtárban dolgozik;
- fájlokat olvas és módosít;
- parancsokat és teszteket futtat;
- streameli a választ, gondolkodási/lépésinformációt és tool-aktivitást;
- jóváhagyást és pontosító választ kérhet;
- megszakítható;
- újraindítás után folytatható;
- másik gépen a pontos beszélgetéshez és sessionhöz állítható vissza;
- ugyanazt a lokális snapshot/diff/apply/rollback védelmet használja, mint a Codex.

A `GENERAL` mód nem része ennek a munkának és változatlan marad. A Kimi integráció nem része ennek a körnek, de az új providerfüggetlen runtime és Claude bridge később újrahasznosítható hozzá.

## 2. Scope és nem-scope

### 2.1 Benne van

- Claude hitelesítés: elsődlegesen a lokális Claude Code előfizetéses bejelentkezés, tartalékként API-kulcs.
- Claude Agent SDK TypeScript integráció.
- Claude Sonnet 5 coding agent.
- Providerfüggetlen `AgentRuntime` réteg.
- Kétirányú bridge a Tauri/Rust backend és a Claude Agent SDK között.
- Szöveges prompt és csatolt képek.
- Fájlolvasás, fájlszerkesztés, parancsfuttatás és tesztfuttatás.
- Streamelt `VÁLASZ` és `LÉPÉSEK` események.
- Tool approval és `AskUserQuestion` kezelés.
- Cancel és process-tree leállítás.
- Költség- és tool-turn limit.
- Claude session persistence.
- SQLite- és OneDrive-v2-alapú session restore.
- Cross-device konfliktuskezelés.
- Snapshot, diff, apply, rollback és crash recovery.
- Valódi debug GUI-verifikáció a desktop shortcutból.

### 2.2 Nincs benne

- Release build és telepítő.
- Publikus vagy többfelhasználós szolgáltatás.
- Kimi, Bedrock, Vertex vagy Microsoft Foundry.
- Claude Desktop alkalmazás automatizálása.
- A Claude Desktop használata modell-backendként.
- A `GENERAL` mód providerének cseréje.

## 3. Definition of Done

A Claude-integráció csak akkor tekinthető késznek, ha mindegyik pont teljesül:

1. A meglévő Codex CODING-folyamat regresszió nélkül működik.
2. A CODING modellválasztóban elérhető a Claude Sonnet 5.
3. A Claude API-kulcs nem kerül frontend-tárolásba, SQLite-ba, OneDrive-ba vagy logba.
4. Claude a kiválasztott projekt valódi könyvtárában dolgozik.
5. Claude fájlokat tud olvasni és szerkeszteni.
6. Claude jóváhagyás után parancsot és tesztet tud futtatni.
7. A `VÁLASZ` és `LÉPÉSEK` folyamatosan frissül.
8. A tool-kártyák állapota stabil és sorrendhelyes.
9. Működik az approval: engedélyezés, elutasítás és sessionre megjegyzés.
10. Működik az `AskUserQuestion` GUI-folyamat.
11. Működik a cancel, és nem marad árva Claude/Node process.
12. Működik a per-turn költség- és turnlimit.
13. A snapshot nem kerül a Claude API-ra.
14. A diff preview, apply, rollback és discard működik.
15. Crash vagy appbezárás után a félbemaradt workspace-művelet helyreállítható.
16. App restart után ugyanaz a Claude session folytatódik.
17. Cross-device sync után a pontos projekt, conversation és Claude session áll helyre.
18. Párhuzamos kétgépes folytatás nem keveri össze a session-transcripteket.
19. Törölt conversation és Claude session nem tér vissza a syncből.
20. Egy turnhöz pontosan egy tartós végső válasz és egy completion hang tartozik.
21. A teljes folyamat a valódi debug desktop shortcutból végig lett tesztelve.
22. A GUI-verifikáció screenshotjai a projekt `Screenshots` mappájába kerültek növekvő numerikus fájlnévvel.

## 4. Célarchitektúra

```text
CODING React GUI
        |
        v
Tauri agent_* parancsok
        |
        v
AgentRuntimeRouter
   |                   |
   |                   +--> ClaudeRuntime (Rust process supervisor)
   |                              |
   |                              v
   |                       Claude Agent Bridge (TypeScript/JSONL)
   |                              |
   |                              v
   |                       Claude Agent SDK
   |                              |
   |                              v
   |                       Claude Sonnet 5 API
   |
   +--> CodexAppServerRuntime (meglévő Codex app-server)

Mindkét runtime
   |
   +--> közös AgentEvent stream
   +--> közös workspace guard
   +--> közös SQLite/OneDrive persistence
```

### 4.1 Fő architekturális döntések

1. **A Claude Agent SDK adja az agent-loopot.** Nem implementálunk saját Messages API tool-loopot.
2. **A Rust backend felügyeli a folyamatot.** A frontend nem indít közvetlenül Node- vagy Claude-processzt.
3. **A Claude bridge kétirányú, verziózott JSONL protokollt használ.**
4. **A snapshot lokális marad.** Claude a `cwd` alapján maga olvassa a projektet.
5. **Az alkalmazás conversation ID-ja a kanonikus azonosító.** A Claude session ID provider-specifikus másodlagos azonosító.
6. **A cross-device session transcript a saját SessionStore-adapterünkön keresztül szinkronizálódik.**
7. **A Codex nem kerül átírásra egyszerre.** Először változatlan működéssel runtime-adapter mögé kerül.

## 5. API-költségterv az 5 USD kerethez

### 5.1 Élő tesztlimitek

| Teszttípus | `maxBudgetUsd` | `maxTurns` | Modell/effort |
|---|---:|---:|---|
| API handshake | 0.05 | 1 | Sonnet 5 / low |
| Stream és cancel | 0.10 | 2 | Sonnet 5 / low |
| Read-only fixture repo | 0.15 | 3 | Sonnet 5 / low |
| Kis hibajavítás + teszt | 0.30 | 6 | Sonnet 5 / low |
| Approval + kérdés | 0.30 | 6 | Sonnet 5 / low |
| Session resume | 0.30 | 6 | Sonnet 5 / low |
| Teljes GUI smoke | 0.50 | 10 | Sonnet 5 / medium |

### 5.2 Keretfelosztás

- 0.50 USD: API-kapcsolat, stream és parser.
- 0.75 USD: fájlolvasás, szerkesztés és teszt.
- 0.75 USD: approval, cancel és resume.
- 1.00 USD: valódi GUI- és restartteszt.
- 2.00 USD: tartalék hibakeresésre és ismétlésre.

### 5.3 Költségvédelmi szabályok

- A Claude Console auto-reload legyen kikapcsolva.
- Minden élő turnnek kötelező `maxBudgetUsd` értéket adni.
- Minden élő turnnek kötelező `maxTurns` értéket adni.
- A bridge minden result eventből mentse a `total_cost_usd` és usage adatokat.
- A GUI jelenítse meg az aktuális turn és session összesített költségét.
- A limit kliensoldali becslés; nem tekinthető banki pontosságú hard capnek.
- Nagy repositoryn nem futtatunk élő tesztet, amíg a fixture-repós teljes flow nem zöld.
- A protokoll-, parser-, sync- és GUI-state tesztek Claude API nélkül fussanak.

## 6. Implementációs fázisok

### Fázis 0 – Baseline és vertical-slice fixture

#### Feladatok

1. Git worktree és aktuális változások ellenőrzése; felhasználói változások megőrzése.
2. A jelenlegi Codex-folyamat baseline tesztjeinek lefuttatása.
3. A jelenlegi debug desktop shortcut targetjének és working directoryjának ellenőrzése.
4. Új kisméretű fixture repository létrehozása tesztcélra:
   - 3–5 forrásfájl;
   - egy szándékos hiba;
   - egy gyors unit teszt;
   - nincs dependency install;
   - nincs build artifact.
5. Claude Console auto-reload ellenőrzési pont dokumentálása.
6. Az API-költségmérő kezdőegyenlegének kézi rögzítése a tesztjegyzőkönyvben.

#### Elfogadási feltétel

- A Codex baseline zöld.
- A fixture repo lokálisan, Claude nélkül determinisztikusan tesztelhető.
- A debug shortcut ugyanazt az alkalmazást indítja, amelyen a fejlesztés történik.

### Fázis 1 – Providerfüggetlen runtime-szerződés

#### Új backendstruktúra

```text
src-tauri/src/agent/
  mod.rs
  runtime.rs
  events.rs
  process.rs
  guard.rs
  credentials.rs
  claude.rs
  codex.rs
```

#### Runtime-szerződés

- `list_models`
- `start_turn`
- `resume_turn`
- `cancel_turn`
- `respond_to_approval`
- `respond_to_question`
- `capabilities`
- `shutdown`

#### Feladatok

1. A jelenlegi `codex_send` folyamat becsomagolása `CodexAppServerRuntime` mögé.
2. Az események providerfüggetlen envelope-ba helyezése.
3. Új Tauri parancsok bevezetése:
   - `agent_send`
   - `agent_cancel`
   - `agent_approval_response`
   - `agent_question_response`
   - `agent_models`
   - `agent_auth_status`
   - `agent_test_connection`
4. A régi `codex_*` parancsok ideiglenes kompatibilitási aliasának megtartása.
5. A frontend első körben továbbra is Codex runtime-ot választ, így a refaktor nem változtat UX-et.

#### Elfogadási feltétel

- Minden meglévő Codex teszt zöld.
- A valós Codex GUI-flow változatlanul működik.
- Az új agent parancsút ugyanazt az eredményt adja, mint a régi Codex-út.

### Fázis 2 – Claude Agent Bridge skeleton

#### Új könyvtár

```text
agent-bridge/
  package.json
  tsconfig.json
  src/
    main.ts
    protocol.ts
    claudeRuntime.ts
    eventMapper.ts
    permissions.ts
    sessionStore.ts
    errors.ts
```

#### Protokoll

##### Rust → bridge

- `initialize`
- `start_turn`
- `resume_turn`
- `cancel_turn`
- `approval_response`
- `question_response`
- `session_store_response`
- `shutdown`

##### Bridge → Rust

- `ready`
- `session_started`
- `agent_event`
- `approval_requested`
- `question_requested`
- `session_store_request`
- `turn_completed`
- `turn_failed`
- `fatal_error`

##### Minden envelope kötelező mezői

- `protocolVersion`
- `messageId`
- `requestId`
- `conversationId`
- `sessionId`, ha már ismert
- `sequence`
- timestamp

#### Biztonsági szabályok

- stdout kizárólag JSONL protokoll.
- stderr kizárólag szűrt diagnosztika.
- Maximális egyedi protokollsor-méret.
- Ismeretlen message type nem okozhat processtörést.
- Hibás JSON csak az érintett requestet állíthatja le.
- API-kulcs, environment és prompt nem logolható teljes egészében.

#### Első teszt

A bridge még Claude nélkül, fixture eseményeket streamel a Rust backendnek. A GUI ezekből megjeleníti a mock választ és tool-lépéseket.

### Fázis 3 – Credential Manager és Claude connection test

#### Settings GUI

- Claude API-kulcs beállítása.
- Maszkolt státusz: `beállítva` / `nincs beállítva`.
- `Kapcsolat tesztelése` gomb.
- API-kulcs törlése.
- Alapértelmezett modell.
- Alapértelmezett effort.
- Turnönkénti budget.
- Turnlimit.

#### Credential-kezelés

- A kulcs Windows Credential Managerbe kerül.
- A frontend mentés után nem kapja vissza a kulcsot.
- A Rust backend csak státuszt ad vissza.
- A bridge child process process-environmentben kapja meg.
- A kulcs nem jelenhet meg command-line argumentumban.
- A kulcs nem kerülhet crash reportba.

#### Connection test

1. Credential jelenlétének ellenőrzése.
2. Minimális, 0.05 USD budgetű kérés.
3. Claude Sonnet 5 hozzáférés ellenőrzése.
4. Streaming vagy normál result fogadása.
5. 401, 402, 429 és 5xx külön leképezése.
6. Modell, request ID és költség visszaadása; kulcs nélkül.

### Fázis 4 – Élő Claude coding vertical slice

#### SDK-konfiguráció

- `model: "claude-sonnet-5"`
- kezdetben `effort: "low"`
- adaptív thinking
- `maxBudgetUsd`
- `maxTurns`
- `cwd`: kiválasztott projektgyökér
- `abortController`
- `includePartialMessages: true`
- `agentProgressSummaries: true`
- `forwardSubagentText: true`, amikor a GUI már tudja kezelni
- `strictMcpConfig: true`
- kezdetben globális user plugin/hook betöltés nélkül
- Claude Code system-prompt preset plusz min-specifikus instrukciók

#### Toolkészlet

- `Read`
- `Glob`
- `Grep`
- `Edit`
- `Write`
- `Bash`
- `AskUserQuestion`
- később `Agent`/subagent

#### Vertical-slice feladat

1. Claude beolvassa a fixture repót.
2. Megtalálja a szándékos hibát.
3. Javaslatot ad.
4. Módosítja a fájlt.
5. Bash approvalt kér.
6. Lefuttatja a unit tesztet.
7. Végső választ ad.
8. A min elkészíti a diffet.
9. Rollback után a fixture repo visszaáll.

#### Elfogadási feltétel

- A teljes coding flow élő Claude-dal, fixture repóban végigmegy.
- A futás a beállított budget alatt marad vagy kulturált budget-stopot ad.
- Nem kerül teljes repo vagy snapshot az API-requestbe.

### Fázis 5 – Permission és felhasználói kérdések

#### Automatikusan engedélyezett

- `Read`
- `Glob`
- `Grep`
- projekten belüli `Edit`
- projekten belüli `Write`

#### Mindig blokkolt

- projekten kívüli írás;
- Credential Manager olvasása;
- min adatbázis olvasása;
- OneDrive sync-journal kézi szerkesztése;
- `.git` belső adatainak direkt módosítása;
- ismert credential fájlok olvasása;
- a workspace gyökérből való path traversal.

#### GUI approvalt kér

- minden Bash-parancs az első verzióban;
- fájltörlés;
- `git commit`;
- `git push`;
- dependency install;
- hálózati parancs;
- deployment;
- külső program indítása;
- projekten kívüli read-hozzáférés.

#### Válaszlehetőségek

- Engedélyezés egyszer.
- Engedélyezés erre a sessionre.
- Elutasítás.
- Elutasítás magyarázattal.

#### `AskUserQuestion`

- A Claude által küldött kérdések a min natív választó UI-jában jelennek meg.
- Kezelendő az egyszeres és többszörös választás.
- Támogatandó a szabad szöveges válasz.
- A bridge futása az answerig felfüggeszthető.
- Appbezárás esetén az approval/question állapot tartósan mentendő vagy explicit deny/defer döntéssel zárandó.

### Fázis 6 – Providerfüggetlen workspace guard

#### Átnevezendő/általánosítandó műveletek

- `codex_preview_snapshot` → `agent_preview_snapshot`
- `codex_apply_snapshot` → `agent_apply_snapshot`
- `codex_rollback_snapshot` → `agent_rollback_snapshot`
- `codex_discard_snapshot` → `agent_discard_snapshot`
- `codex_rebase_snapshot` → `agent_rebase_snapshot`

#### Turn-folyamat

1. Request lock.
2. Lokális workspace snapshot.
3. Snapshot ID tartós mentése.
4. Claude futtatása a valódi projekt `cwd`-jében.
5. Claude terminal event azonnali tartós mentése.
6. Workspace diff generálása.
7. Preview.
8. Apply, rollback vagy discard.
9. Request lock feloldása.

#### Állapotok

- `agent_running`
- `agent_completed`
- `workspace_pending`
- `workspace_applied`
- `workspace_rolled_back`
- `workspace_discarded`
- `workspace_conflicted`

#### Kritikus szabály

A tartós végső válasz nem várhat a lassabb snapshot-finalizálásra. A `turn_completed` és a durable `finalText` a válasz terminal határa; a workspace utófeldolgozás külön lifecycle.

#### 6.1 Megvalósítási állapot és ellenőrzési napló

2026-07-24-én a 4–6. fázis kódja elkészült a debug desktop shortcut által indított alkalmazásban.

- **Fázis 4:** a `Claude Sonnet 5 · Low` modellből valódi coding-turn indítható a kiválasztott projekt `cwd`-jében; a részleges `VÁLASZ` stream és a terminális `VÁLASZ kész` állapot működik. A bridge-turn befejezés után a Node worker lezárul, így nem marad függő `agent_send`.
- **Fázis 5:** a Claude `Bash` approval és `AskUserQuestion` kétirányú JSONL callbackje, a natív GUI-kártya, az egyszeri/session-szintű engedélyezés és a deny útvonal implementálva. A későn érkező válasz nem hagyhatja bent a modal ablakot. A GUI-ban a kérdéskártya megjelent; a szándékosan 0,05 USD-es tesztturn `budget_exceeded` miatt a parancs végrehajtása előtt leállt, a részleges változások el lettek vetve.
- **Fázis 6:** a Claude ugyanazt a provider-neutral snapshot/manifest/stage/apply/rollback útvonalat használja, mint a Codex; a snapshot nem kerül a Claude promptjába. A nagy/protected könyvtárak kizárása és a snapshot-méret regressziója Rust tesztekkel védett.
- **GUI evidence:** `Screenshots/713.png` – valódi Claude válasz `VÁLASZ kész`; `Screenshots/715.png` – natív Claude-kérdéskártya; `Screenshots/725.png` – új debug shortcutból tiszta, composerrel renderelt állapot.
- **Automatizált ellenőrzés:** Claude bridge 5/5 teszt, Rust 88/88 unit/sync teszt, TypeScript/Vite build, `cargo check` és debug cargo build sikeres. Release build és release artifact nem készült.

#### 6.2 Hátralévő acceptance-teszt

A végső élő permission acceptance-hez egy rövid, friss Claude-turn szükséges olyan budgettel, amelyben belefér: Bash approval → engedélyezés vagy tiltás → turn completion → snapshot diff → rollback/apply. A kontrollált 0,25 és 0,50 USD-es új beszélgetés-próbákban a modell szöveges választ adott, illetve egyszer `connection_failed`-del állt le, ezért Bash-végrehajtást akkor nem állítottam bizonyítottként. Fájlváltozás, automatikus apply vagy árva bridge-process egyik próbából sem maradt.

**Lezárva 2026-07-25-én:** előfizetéses hitelesítéssel a teljes Bash approval → engedélyezés → végrehajtás → tesztfuttatás → rollback lánc végigment. A blokkoló ok utólag azonosítható: a 0,05–0,50 USD-es budget önmagában kevés volt egy eszközhasználó turnhöz, mert a teljes flow notional költsége ~0,042 USD, és a budget a parancs végrehajtása előtt lépett közbe. Részletek a 16. fázisban.

### Fázis 7 – Egységes eseménymodell

#### Normalizált események

- `agent/session_started`
- `agent/turn_started`
- `assistant/text_delta`
- `assistant/reasoning_delta`
- `agent/plan_updated`
- `tool/started`
- `tool/progress`
- `tool/completed`
- `tool/failed`
- `subagent/started`
- `subagent/progress`
- `subagent/completed`
- `approval/requested`
- `question/requested`
- `usage/updated`
- `agent/turn_completed`
- `agent/turn_failed`
- `agent/turn_cancelled`

#### Kötelező mezők

- `conversationId`
- `requestId`
- `runtime`
- `provider`
- `model`
- `sessionId`
- `providerTurnId`, ha van
- `sequence`
- timestamp
- opcionális raw provider event audit/debug célra

#### Deduplikáció

- Egy terminal event kulcsa: `requestId + providerTurnId + terminalKind`.
- Egy turn állapota monoton halad; completedből nem lehet újra running.
- Későbbi üres/live snapshot nem írhat felül durable final választ.
- Completion hang turnönként pontosan egyszer szólhat.
- Duplikált sync import sem válasz-, sem hangduplikációt nem okozhat.

### Fázis 8 – Adatbázis-migráció

#### `conversations` új mezői

- `agent_runtime`
- `agent_provider`
- `agent_model`
- `agent_effort`
- `active_agent_session_id`

#### `turns` új mezői

- `agent_runtime`
- `provider_session_id`
- `provider_turn_id`
- `base_head_turn_id`
- `max_budget_usd`
- `total_cost_usd`
- `terminal_event_id`

#### Új `agent_sessions` tábla

- belső ID;
- conversation ID;
- provider;
- provider session ID;
- head turn ID;
- session státusz;
- létrehozási és módosítási idő;
- eredeti eszköz/origin;
- HLC.

#### Új `agent_session_entries` tábla

- provider session ID;
- `subpath`;
- entry UUID;
- sorrend/sequence;
- opaque JSON body;
- origin;
- HLC;
- létrehozási idő.

#### Új `agent_approvals` tábla

- request ID;
- tool use ID;
- tool név;
- input JSON;
- döntés;
- státusz;
- létrehozási és lezárási idő.

#### Migrációs kompatibilitás

- Minden korábbi CODING conversation automatikusan:
  - `agent_runtime = "codex_app_server"`
  - `agent_provider = "openai"`
- A `codex_thread_id` mező nem törlendő az első migrációban.
- A migráció újrafuttatva idempotens.
- Régi adatbázissal induló app nem veszíthet conversationt vagy turnt.

### Fázis 9 – Claude SessionStore és cross-device sync

#### SessionStore műveletek

- `append`
- `load`
- `listSessions`
- `listSessionSummaries`
- `listSubkeys`
- `delete`

#### Bridge ↔ Rust storage RPC

1. A bridge `session_store_request` üzenetet küld egy `operationId`-val.
2. A Rust backend SQLite-tranzakcióban elvégzi a műveletet.
3. Siker/hiba `session_store_response` formában visszakerül.
4. A bridge csak ezután folytatja az SDK műveletét.

#### Szinkronszabályok

- Az SDK entry opaque JSON; nem alakítjuk át providerfüggetlen chatüzenetté.
- `entry.uuid` alapján idempotens append.
- A sorrend stabil és visszaállítható.
- A subagent transcript `subpath` szerint külön lánc, de ugyanahhoz a sessionhöz tartozik.
- A session entryk a meglévő OneDrive v2 journalon keresztül syncelnek.
- Nem írunk közvetlen megosztott Claude JSONL-fájlokat OneDrive-ba.
- A törlés tombstone-alapú és kaszkádol a subagent bejegyzésekre.
- A remote delete nem írható felül későbbi stale lokális snapshottal.

#### Párhuzamos kétgépes folytatás

- Minden turn tárol `base_head_turn_id` értéket.
- Turn beküldésekor ellenőrizni kell, hogy a conversation head nem változott-e.
- Eltérő head esetén nem szabad ugyanabba a provider sessionbe vakon appendelni.
- Automatikus session fork készül.
- Mindkét ág megmarad és a GUI jelzi a konfliktust.
- Egyik ág sem veszhet el last-writer-wins felülírás miatt.

#### Restore acceptance

A zöld Sync állapot nem elegendő. Külön ellenőrizni kell:

- pontos project ID;
- pontos conversation ID;
- pontos agent provider;
- pontos Claude session ID;
- pontos utolsó durable turn;
- helyes title és tree-kijelölés;
- helyes üzenet- és trace-történet;
- folytatható következő Claude turn.

### Fázis 10 – CODING GUI

#### Modellválasztó

```text
OpenAI
  Codex modellek

Anthropic
  Claude Sonnet 5
```

#### Claude állapotinformáció

- provider badge;
- modell;
- effort;
- API-auth státusz;
- turn budget;
- turn költség;
- session összköltség;
- session running/paused/completed állapot;
- approvalra vagy válaszra várakozás.

#### Conversation-provider szabály

- Egy conversationhez rögzített provider tartozik.
- Meglévő Codex conversation nem válik csendben Claude-sessionné.
- A későbbi `Folytatás Claude-dal` funkció új conversation/session forkot készít.
- Az eredeti conversation változatlan marad.

#### VÁLASZ/LÉPÉSEK

- Claude text delta → `VÁLASZ`.
- Claude reasoning/progress → `LÉPÉSEK`.
- Tool use → tool-kártya.
- Subagent → beágyazott lépés.
- Approval és question → interaktív várakozó állapot.
- Result success → durable final válasz.
- Result failure → hibaállapot; nem ál-asszisztens üzenet.

### Fázis 11 – AGENTS.md és projektszabályok

#### Követelmények

1. A projekt gyökerének meghatározása.
2. A gyökér `AGENTS.md` beolvasása.
3. A releváns utasítások hozzáadása a Claude system prompt append részéhez.
4. Claude explicit utasítása, hogy szerkesztés előtt keresse meg az érintett alkönyvtárra érvényes további `AGENTS.md` fájlokat.
5. A felhasznált instrukciófájlok útvonalának auditálható rögzítése.
6. A globális/user Claude pluginek és hookok kezdetben ne töltődjenek automatikusan.
7. Későbbi `CLAUDE.md` támogatás csak opcionális, látható capability legyen.

#### Biztonsági cél

Ne örököljünk észrevétlenül olyan globális Claude hookot, plugint vagy MCP-t, amely a min engedélymodelljét megkerüli vagy külső műveletet indít.

### Fázis 12 – Képek és csatolmányok

#### Szabályok

- Csak a felhasználó által az adott turnhöz csatolt kép kerülhet az API-requestbe.
- Projektfájl nem kerül automatikusan base64-ként a promptba.
- Kép mérete és MIME-típusa validálandó.
- A frontend lokális útvonalat ad át Rustnak; a frontend nem olvassa az API-kulcsot.
- A bridge a Claude SDK által támogatott image content blockot kapja.
- A csatolmány hashével biztosítani kell az exact-once beküldést retry esetén.
- Nem támogatott vagy túl nagy kép magyar, javítható hibát ad.

### Fázis 13 – Hiba- és recovery-modell

#### Külön kezelt hibák

- API-kulcs hiányzik.
- API-kulcs hibás vagy visszavont.
- Nincs elegendő kredit.
- Rate limit.
- Provider túlterhelés.
- `maxBudgetUsd` elérve.
- `maxTurns` elérve.
- Bridge nem indul.
- Bridge összeomlik.
- Claude subprocess összeomlik.
- Stream idle timeout.
- Hibás vagy ismeretlen SDK-event.
- SessionStore load timeout.
- Session nem állítható vissza.
- Approval/question várakozás megszakadt.
- Workspace snapshot conflict.
- Cross-device head conflict.

#### UX

- Rövid magyar hiba a chatben.
- Technikai részlet a trace/debug panelen.
- Raw API-kulcs és teljes environment soha nem látható.
- Retry csak idempotens ponton történhet.
- Nem idempotens tool után automatikus turn-retry tilos.
- Ismeretlen terminal állapot nem játszhat completion hangot.

#### Process recovery

- Cancel teljes process tree-t állít le.
- Appbezáráskor kontrollált shutdown, majd timeout után kill.
- Startupkor félbemaradt request és snapshot audit.
- Durable final válasz megőrzése akkor is, ha a workspace-utófeldolgozás félbeszakadt.

### Fázis 14 – Tesztstratégia

#### 14.1 API-költség nélküli unit tesztek

- JSONL framing és részleges sorok.
- Ismeretlen message type.
- Sequence ordering.
- Duplikált event.
- Terminal lifecycle monotonicitás.
- Completion exact-once.
- Approval state machine.
- Question state machine.
- Cancel race.
- Process crash.
- API-hibakód leképezés.
- Credential redaction.
- Path containment.
- SessionStore append/load/delete.
- SessionStore UUID-deduplikáció.
- Subagent `subpath` restore.
- Tombstone és stale snapshot.
- Cross-device fork.
- Codex runtime regresszió.

#### 14.2 Mock bridge integrációs tesztek

- Text delta stream.
- Reasoning stream.
- Tool start/progress/result.
- Approval pause/resume.
- `AskUserQuestion` pause/resume.
- Max-budget failure.
- Process stderr zaj.
- Bridge restart.
- App reload/hydration.
- Diff/apply/rollback.

#### 14.3 Élő Claude API tesztek

1. Authentication és modell-hozzáférés.
2. Rövid stream.
3. Fixture repo fájllistázás.
4. Egy fájl beolvasása.
5. Szándékos hiba megtalálása.
6. Fájl javítása.
7. Tesztfuttatás Bash approval után.
8. Diff preview.
9. Rollback.
10. Következő turn ugyanabban a sessionben.
11. App restart utáni resume.
12. `AskUserQuestion` teszt.
13. Hosszabb művelet cancel.
14. Max-budget kulturált leállás.

#### 14.4 Cross-device szimuláció

- Két külön lokális app-adatkönyvtár/device ID.
- Közös v2 sync root.
- Első gép Claude sessiont indít és befejez.
- Második gép hydrál és ugyanazt a sessiont folytatja.
- Első gép visszahydrálja a második turnt.
- Párhuzamos beküldés forkot eredményez.
- Delete tombstone mindkét oldalon megmarad.
- Egyik oldalon sincs duplikált válasz vagy completion hang.

#### 14.5 Valódi debug GUI acceptance

1. A desktop debug shortcutból indul az app.
2. Claude API-kulcs beállítása.
3. Connection test.
4. Fixture projekt kiválasztása.
5. Claude Sonnet 5 kiválasztása.
6. Coding prompt beküldése.
7. `VÁLASZ` és `LÉPÉSEK` ellenőrzése.
8. Bash approval megválaszolása.
9. Diff preview.
10. Rollback.
11. Új prompt ugyanabban a sessionben.
12. App bezárása.
13. App újraindítása ugyanabból a shortcutból.
14. Pontos conversation és Claude session ellenőrzése.
15. Következő prompt és helyes kontextus.
16. Completion hang turnönként pontosan egyszer.
17. Screenshotok mentése a `Screenshots` mappába.

#### 9.1 Megvalósítási állapot – 2026-07-24

A 7–12. fázis stabil integrációs szelete elkészült, és a friss debug-binárisból indított élő GUI-ban ellenőrizve lett.

- **Fázis 7 – implementálva:** provider-semleges esemény-envelope, normalizált eseménytípusok, provider-turn/terminal azonosítók és frontend terminal-deduplikáció. A meglévő `codex-event` kompatibilitási útvonal megmaradt, az új `agent-event` útvonalat a következő UI-szelet fogja teljesen átvenni.
- **Fázis 8 – implementálva:** SQLite schema v20, idempotens v19→v20 migráció, conversation/turn agent-metaadatok, `agent_sessions`, `agent_session_entries` és `agent_approvals` táblák. A v4 migrációs fixture és a teljes Rust tesztcsomag zöld.
- **Fázis 9 – implementálva:** Claude SDK `SessionStore` RPC, opaque entry append/load/list/delete, UUID-alapú idempotencia, subpath-kezelés, OneDrive v2 journal eventek, HLC/tombstone összefésülés és agent-session compaction-state v2. A session a stabil SQLite conversation ID-hoz kötődik; a path/title cache-kulcs csak UI-állapot marad.
- **Recovery/fork hardening – implementálva:** eltűnt remote Claude session esetén automatikus új session + conversation context fallback; eltérő session/conversation head esetén resume helyett új provider session; restart után orphaned `running` turnök `failed` lezárása; aktív session-konfliktus látható UI-jelzése; a `\\?\\` Windows path-prefix és a render/cache kulcsok normalizált összevezetése. Törölt session opaque entry-i compactionból sem állíthatók vissza.

**Élő debug GUI bizonyíték:** a friss debug appban Claude válaszolt `PHASE789_DEBUG_FINAL_OK`. A lokális DB-ben `user_version=20`, completed turn, új provider session, provider-turn ID, cost és terminal event ID látszik; az új session headje a turnre mutat, az agent `running` turnök száma 0. Screenshot: `Screenshots/753.png`.

**Fázis 10 – restart- és cross-device recovery:** implementálva. A stabil SQLite conversation ID, provider session/head metadata, restart utáni orphan recovery, eltűnt session fallback, konfliktusjelzés és a lokális SQLite-snapshot/sync-snapshot hidratálási merge együtt védi a pontos beszélgetés- és válasz-visszaállítást. A két eszközös merge/fork logika Rust sync-regressziókkal fedett; teljes, két külön fizikai gépes online acceptance ebben a futásban nem történt.

**Fázis 11 – Claude runtime, sync és exact-once:** implementálva. Az `agent-event` és kompatibilis `codex-event` másolatok közös sequence-alapú identity guardot használnak; a Claude resume-útvonal kezeli a kumulatív/incrementális delta-kat; a natív és UI válasz-checkpoint ugyanazon request-ID-s kanonikus assistant-sort véglegesíti. A stale/duplikált assistant alias nem írhatja felül a későbbi végleges választ sem SQLite-mentésben, sem sync-hidratálásban, sem frontend merge-ben.

**Fázis 12 – debug desktop GUI acceptance:** implementálva, kizárólag debug shortcut/binárissal. A desktop debug GUI-ban Claude Sonnet 5 · Low módban a `PHASE1012_FINAL_GUI_ACCEPTANCE_OK` prompt végigfutott eszköz nélkül; a DB-ben a turn `completed`, session `d0c3e4fa-31b2-4a68-8374-e03eb46311db`, cost `0.0087954 USD`, terminal event `d117fde6-ca41-4e80-8204-8fa2cc6a6f22:d0c3e4fa-31b2-4a68-8374-e03eb46311db:completed`, és pontosan egy `final=1/live=0` assistant-sor maradt. A válasz restart után, a teljes Sync-ciklus után és a GUI legalján is látható. Screenshot: `Screenshots/757.png`.

**Fázis 13 – hiba- és process-recovery modell:** implementálva. A bridge külön hibakódot ad a hiányzó/hibás API-kulcsra, billingre, rate limitre, provider- és bridge-hibára, budget- és turnlimitre, timeoutra, cancelre és kapcsolat-hibára. A live turn API-kulcs nélkül fail-fast módon, `missing_api_key` kóddal zárul; a connection-test és a live hibaszöveg credential-redacted. A SessionStore-kérések 15 másodperces timeoutot kapnak, a Rust bridge-olvasó 10 perces idle timeoutot, minden timeout és process-lezárás takarítja a pending kéréseket. A frontend rövid magyar hibaüzenetet, stabil hibakódot és transport státuszt tárol; raw API-kulcs nem kerül a chatbe vagy trace-be.

**Fázis 14 – API-költség nélküli unit/mock lefedettség:** a jelenlegi slice lezárva. Az új `tests/agentError.test.ts` a stabil hibakódokat, credential-redactiont és timeout/cancel/bridge-crash szétválasztást fedi; az `agent-bridge/protocol.test.mjs` a missing-key, auth, billing, rate-limit, budget, turn-limit, SessionStore-timeout, cancel, bridge-crash és provider-server hibákat ellenőrzi; a Rust teszt az idle timeoutot és a session/sync regressziókat futtatja. A teljes jelenlegi tesztkép: frontend `32/32`, bridge `6/6`, Rust `102/102`, `node --check` és `cargo fmt --check` zöld.

**Fázis 15 – két-eszközös Claude-session szimuláció és friss debug GUI acceptance:** implementálva. Az új `two_device_claude_session_resume_fork_and_tombstone_converge` teszt két lokális store-ban ellenőrzi a session-hydratálást/folytatást, a párhuzamos forkot, az idempotens entry-importot, a tombstone elsőbbségét és a törölt session késői stale entry-jének elutasítását. A friss debug bináris a desktop shortcutból indult; restart után a pontos Coding conversation, a kanonikus `PHASE1012_FINAL_GUI_ACCEPTANCE_OK` válasz és a Claude modellválasztó megmaradt. A GUI-ban a `GENERAL` → `CODING` váltás is végig lett kattintva, a beszélgetési lista és a composer sértetlen maradt. Screenshot: `Screenshots/758.png`.

**14.3/1–3 élő Claude acceptance:** implementálva és debug GUI-ban bizonyítva. A `Kapcsolat tesztelése` eredménye `Kapcsolat rendben`, `claude-sonnet-5`, költsége `0.0014 USD`. A rövid, eszköz nélküli stream `PHASE14_SHORT_STREAM_OK` választ adott, a DB-ben a turn `completed`, provider-turn `3009cf6d-a60f-41a3-8fc1-ce0dfee3b7ea`, terminal event és `0.04157625 USD` költség szerepel. A dependency nélküli `claude-fixture` projektben Claude a `Read` eszközzel ellenőrizte a `README.md`, `math.js` és `math.test.js` fájlokat, módosítás nélkül; a végső válasz `PHASE14_FIXTURE_READ_OK` lett.

**Canonical conversation ID hardening:** az acceptance közben talált új-projekt/első-turn rést javítottam. Új Coding beszélgetésnél a küldés előtt stabil UUID kerül a local cache-be és az `agent_send` requestbe; a path/title UI-key többé nem kerülhet az agent session conversation ID-jaként az első turnbe. A regressziós teszt ezt külön ellenőrzi. Új fixture-beszélgetés bizonyítéka: conversation `33157e05-aee0-45c7-941f-087c54fc9e9e`, turn `9c3ff2bc-2bf4-57ee-9423-227509d9781a`, provider session `fd9a8634-07bc-4fd9-8946-c3bb34b96975`, terminal event jelen van, cost `0.00665765 USD`, assistant `final=1/live=0` pontosan egyszer. Screenshot: `Screenshots/759.png`.

**14.3/4 live Claude acceptance:** completed in the debug GUI. In a new `claude-fixture` conversation, Claude read only `README.md` and returned exactly `PHASE14_SINGLE_FILE_READ_OK`; no edit or command was requested. SQLite evidence: conversation `1c2a0841-1655-410d-8f0c-60bfae559b76`, completed turn `4f02dc53-265d-5fd8-9ab3-ac52c6dcd753`, provider session `4c4f004c-be96-4353-9a08-a353dc45f828`, cost `0.0386005 USD`, assistant `final=1/live=0` exactly once. The temporary journal publish warning cleared after recheck and the GUI returned to `Sync - synchronized`. Screenshot: `Screenshots/760.png`.

**Transient live-card race fix:** reproduced in the debug GUI with a DOM mutation observer. At turn finalization the correct completed answer and a second empty `VÁLASZ kész` card were simultaneously rendered for approximately 2.6 seconds; the second card was the still-mounted `liveTurnContent`, not a duplicate Claude/SQLite answer. Fixed `src/App.tsx` so the Coding live card also requires `!activeTurnHasCompleted`. Post-fix GUI acceptance with `PHASE14_TRACE_DUPLICATE_FIX_OK` showed one completed answer, zero `.live-turn-anchor` nodes after settlement, and no transient empty card.

**Korlát:** a tényleges Claude Bash execution approval/execution acceptance ebben a körben nem volt bizonyítottként elfogadva. **Feloldva 2026-07-25-én** – lásd a 16. fázis „Élő előfizetéses acceptance" szakaszát.

### Fázis 16 – Előfizetéses hitelesítés az API-kulcs helyett

2026-07-25-én a hitelesítési modell megváltozott: a coding turnök a gépen lévő Claude Code **előfizetéses bejelentkezéssel** futnak, nem pay-per-token API-kulccsal. Ez a 2.2 pont korábbi „Claude Pro/Max subscription login" kizárását felülírja.

#### Miért így

Az `ANTHROPIC_API_KEY` a hivatalos dokumentáció szerint *felülírja* az előfizetést akkor is, ha a felhasználó be van jelentkezve („When set, this key is used instead of your Claude Pro, Max, Team, or Enterprise subscription even if you are logged in"). Ezért az előfizetéses mód nem egy új kulcs beállítása, hanem a kulcs **kivétele** a bridge child process környezetéből: a becsomagolt Agent SDK bináris magától olvassa a `~/.claude/.credentials.json` loginját.

#### Megvalósítás

- **Feloldási sorrend:** ha van előfizetéses login → `subscription`; különben ha van mentett kulcs → `apiKey`; különben magyar hibaüzenet. A kulcsos út szándékosan megmaradt, mert terjesztés esetén az Agent SDK ToS-e csak azt engedi.
- **Rust (`src-tauri/src/claude.rs`):** `AuthMode`/`ResolvedAuth`; subscription módban `env_remove("ANTHROPIC_API_KEY")` és `env_remove("ANTHROPIC_AUTH_TOKEN")`, plusz `MIN_AGENT_AUTH_MODE=subscription`. Az OAuth tokeneket soha nem olvassuk ki; a credential fájlból kizárólag a `subscriptionType` plan-címke kerül elő a GUI-státuszhoz.
- **Bridge (`agent-bridge/auth.mjs`, `main.mjs`):** a `missing_api_key` fail-fast kapu előfizetéses módban nyitva van, mert ott a kulcs hiánya a helyes állapot.
- **Budget:** előfizetéses módban a `maxBudgetUsd` **nem** kerül ki az SDK-nak. Nincs per-turn USD számlázás, amit korlátozni lehetne, a notional költség viszont indokolatlanul leállíthatná a turnt (ahogy a fázis 5 tesztben a 0,05 USD tette). Ebben a módban a **`maxTurns` az egyetlen guard**, és a GUI a budget mezőt inaktívra állítja.
- **GUI:** a Claude beállítások a tényleges hitelesítési forrást mutatják (`Claude Max előfizetés · bejelentkezve` / `API-kulcs · sk-ant-…` / `Nincs beállítva`), a törlés gomb már csak mentett kulcsnál aktív.

#### Hatás a Definition of Done-ra

- A 3. pont változatlanul érvényes, kiegészül azzal, hogy az OAuth tokeneket sem olvassuk és nem logoljuk.
- A **12. pont (per-turn költség- és turnlimit) előfizetéses módban részlegesen nem alkalmazható**: a turnlimit érvényes, a USD-limit nem. Az 5. fejezet költségterve és az 5.1 tesztlimit-táblázat innentől csak a kulcsos tartalékútra vonatkozik; az élő acceptance-tesztek nem fogyasztják az 5 USD API-keretet, hanem az előfizetés rate limitjét.

#### Ellenőrzés

Rust `106/106`, Claude bridge `9/9`, frontend `34/34`, `cargo fmt --check` és `node --check` zöld, TypeScript/Vite build zöld. Az új tesztek: subscription-plan felismerés token-kiszivárgás nélkül, hiányzó/hibás login elutasítása, `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` törlése subscription módban, kulcs továbbítása apiKey módban, a bridge kapu és a budget-kihagyás. Release build és artifact **nem** készült.

#### Élő előfizetéses acceptance – 2026-07-25

A valódi bridge-et a Rust supervisorral azonos JSONL-protokollon, `MIN_AGENT_AUTH_MODE=subscription` környezetben, `ANTHROPIC_API_KEY` **nélkül** hajtottam meg.

1. **Kapcsolat-teszt:** `success=true`, `claude-sonnet-5`, `sessionId=ab1180d5-b486-4472-805e-d2662ffe17a1`. Az API-kulcs bizonyítottan nem volt a child process környezetében.
2. **Turnlimit-guard:** az első coding turn `maxTurns=2` mellett kulturáltan `turn_failed` / „Reached maximum number of turns (2)" állapotban állt le — előfizetéses módban tehát a turnlimit valóban a működő guard.
3. **Approval-útvonal:** a második futásban a bridge `approval_requested` eventet adott a pontos Bash parancsokkal. Az első kör szándékos driver-hibával `accept`-től eltérő döntést küldött, és a modell helyesen deny-ként kezelte — a **deny útvonal** így is bizonyított lett (a turn nem hajtotta végre a parancsot, és ezt a végső válasz meg is fogalmazta).
4. **Teljes flow (`accept`):** Claude beolvasta a fixture-t, megtalálta a szándékos `multiply` hibát, javította, Bash approval után lefuttatta a `node --test math.test.js`-t, és pontosan `PHASE14_BASH_APPROVAL_OK` választ adott. `sessionId=a952b834-5ffb-445f-af4b-fbb006792116`.
5. **Utóellenőrzés:** a javított `math.js` mellett a fixture teszt `2/2` zöld; a rollback visszaállította az eredeti fájlt; nem maradt segédfájl és nem maradt árva bridge/Node process.

Ezzel a 6.2 pont és a fázis 14 **Korlát** bejegyzése – a Claude Bash execution approval/execution – bizonyítottnak tekinthető, előfizetéses hitelesítéssel.

**Fontos megfigyelés:** a `result` event előfizetéses módban is ad `total_cost_usd` értéket (`0,0014` a kapcsolat-tesztre, `0,0416` a teljes coding turnre). Ez **notional**, nem az API-keretből levont költség — épp ezért lett volna végzetes a 0,05 USD-es budget: a teljes turn önmagában elvitte volna. A budget kihagyása előfizetéses módban tehát nem kényelmi döntés, hanem működési feltétel.

**Restart-ellenőrzés:** a friss debug bináris a shortcut targetjéből indult, és a pontos Coding beszélgetést a kanonikus `PHASE14_TRACE_DUPLICATE_FIX_OK` válasszal hidratálta. Screenshot: `Screenshots/762.png`.

#### GUI-ellenőrzés és az ott talált turnlimit-hiba

A Beállítások → Claude panel a debug GUI-ban `Hitelesítés: Claude Max előfizetés · bejelentkezve` állapotot mutat, a fejléc hintje `Claude Max előfizetés · aktív`, a budget mező `előfizetésnél inaktív` címkével szürke. A hitelesítési szelet ezzel vizuálisan is igazolt.

A képernyőn viszont kiderült egy valódi hiba: a **Turnlimit default 1 volt**, ami az API-kulcsos költségvédelem korából maradt, és előfizetéses módban egyszerűen működésképtelen — egy eszközhasználó turn (olvasás → szerkesztés → tesztfuttatás → válasz) nem fejezhető be egy agent-turnből. Ezt az élő acceptance is mutatta: `maxTurns=2` mellett a folyamat a Bash végrehajtás előtt elhalt.

Javítva:

- `DEFAULT_CLAUDE_MAX_TURNS` és `DEFAULT_MAX_TURNS` `1` → `12`;
- a clamp/GUI felső korlát `10` → `40` (`MAX_TURNS_CEILING`), mert előfizetéses módban a turnlimit az egyetlen guard, és nem szabad, hogy az legyen a szűk keresztmetszet;
- a `claude-auth-status` címke már nem vágódik le (`nowrap`/ellipsis helyett tördelés).

**Figyelem:** a meglévő telepítés `localStorage`-ában a korábbi `1` érték marad, mert a felhasználó explicit választását nem írjuk felül. Meglévő gépen a Turnlimit mezőt kézzel kell átállítani.

### Fázis 17 – 14.3/10, 12, 13 élő lezárása és az `AskUserQuestion` válaszvesztés javítása

2026-07-25-én a hátralévő élő acceptance-pontokból három lefutott, előfizetéses hitelesítéssel, a valódi bridge-en.

#### 14.3/10 – session-folytatás: **PASS**

Turn 1 rögzített egy tokent (`ZEBRA-4417`, válasz `ACK1`), majd `resume_turn` ugyanazzal a session ID-val visszaidézte. `sessionId=243fa4d6-4828-4bd5-b34c-4aa664ea4590` mindkét turnben azonos, a felidézés helyes.

#### 14.3/12 – `AskUserQuestion`: **javítás után PASS**

Az első futás protokoll-szinten végigment, de a végső válasz `QUESTION_OK: (no answer provided)` lett: **a felhasználó választása nem érte el a modellt**. Ok: az SDK az `answers` rekordot a kérdés **teljes `question` szövegével** kulcsolva olvassa, a GUI viszont a rövid `header`-t használta kulcsként (`question.header || question.question`). Az SDK a nem illeszkedő kulcsot csendben eldobja – nincs hiba, nincs log, a válasz egyszerűen elveszik.

Javítás két szinten:

- **Frontend:** az `answerKey` immár `question.question` (a `header` csak tartalék).
- **Bridge (`agent-bridge/questions.mjs`, új):** `normalizeQuestionAnswers` a beérkező választ a kérdés szövegére képezi le, akármilyen kulccsal jött (kérdésszöveg → header → egyértelmű egyválaszos eset). A multi-select tömb `", "`-vel fűzve megy, a szabad szöveg a külön `response` mezőben, üres válasz pedig deny-t ad, nem üres „answer"-t.

Élő bizonyíték: a javítás után a driver **szándékosan a régi, hibás header-kulcsot küldte**, és a válasz `QUESTION_OK:alpha.js` lett – tehát a bridge normalizálása önmagában is megmenti a rossz kulcsot küldő klienst.

#### 14.3/13 – cancel: **PASS**

Egy hosszú, folyamatban lévő turn 12 másodperc után `cancel_turn`-nel megszakítva `cancelled` kóddal és `A Claude-kérés megszakadt.` üzenettel zárult. A futás után **0 `node.exe` és 0 Claude Code process** maradt, tehát a DoD 11. pontja tartja magát. (Egy első mérés 4 árva processzt jelzett – ez hamis riasztás volt: a keresőparancs a saját shelljeit számolta meg, mert a minta a parancs szövegében is szerepelt.)

#### Ellenőrzés

Rust `106/106`, Claude bridge `16/16` (7 új teszt a válasz-normalizálásra), frontend `34/34`, `node --check`, `cargo fmt --check`, TypeScript/Vite build és debug cargo build zöld. Release nem készült.

### Fázis 18 – valódi GUI acceptance CDP-vel, és két súlyos hiba

A GUI-t Chrome DevTools Protocolon keresztül hajtottam meg: az appot `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` mellett indítva a WebView2 teljes DOM-ja vezérelhető, tehát a kattintások, beírások és állapot-ellenőrzések a valódi renderelt felületen történtek.

Megjegyzés a felület felderítéséhez: a `header.topbar` a kompakt layoutban `display: none`, ezért a Beállítások a parancspalettából, illetve az oldalsáv alján lévő `⚙ Beállítások` sorból nyílik. A rejtett gombok React-kezelője programozott kattintásra is tüzel.

#### GUI-igazolt pontok

- **Beállítások panel:** `Hitelesítés: Claude Max előfizetés · bejelentkezve`, a budget mező `disabled=true`, a modell `claude-sonnet-5`, effort `low`. Screenshot: `Screenshots/763.png`.
- **Turnlimit:** a GUI-ból `1` → `12`, `localStorage` perzisztálva. Screenshot: `Screenshots/764.png`.
- **Teljes coding turn Bash approvallal:** a prompt beküldése után két `CLAUDE JÓVÁHAGYÁS` kártya jött valódi parancsokkal, mindkettőn az „Engedélyezés egyszer" gombra kattintva a végrehajtás lefutott. Screenshot: `Screenshots/765.png`. SQLite-bizonyíték: turn `d8174a1e-9396-5b80-ac37-c10ed0031d61` `completed`, provider session `5de03aa9-fa20-4355-aaf8-f43f8b8bd9c5`, cost `0.081234`, terminal event jelen, és **pontosan egy** assistant sor `final=1 / live=0` a `PHASE145_GUI_BASH_OK` tartalommal.

#### Hiba 1 – `\\?\` path-prefix miatt a projekten belüli szerkesztés is tiltva volt

Egy fájlmódosítást kérő GUI-turn ezzel a válasszal állt le: *„I wasn't able to edit the file due to a permissions error."* – approval-kérés nélkül, tehát a bridge policy utasította el.

Gyökérok: a Rust `requested_cwd` **canonicalize**-t hív, ami Windowson `\\?\C:\...` extended-length formát ad, és ezt küldi `cwd`-ként a bridge-nek. Claude az `Edit`/`Write` eszközhöz kötelezően **absolute** `file_path`-t ad, normál `C:\...` formában. A guard `isInside` prefix-összehasonlítása így elhasalt, és a saját projekten belüli szerkesztést „workspace-en kívüli"-ként tiltotta.

Ez magyarázza, miért nem derült ki korábban: a `Read` relatív úttal jön, amit a bridge a `\\?\` rootra fűz, tehát *belül* van; a headless futásaimban pedig én tiszta útvonalat adtam cwd-nek, így csak a valódi app-útvonal hozza elő. A DoD 5. pontja („Claude fájlokat tud olvasni és **szerkeszteni**") tehát a GUI-ban eddig nem teljesült.

Javítás: új `agent-bridge/paths.mjs` – `stripExtendedLengthPrefix` (a `\\?\UNC\` formát is kezeli) és `normalizeGuardPath`; a `normalizeCwd` és az `isInside` mindkét oldalt egy közös formára redukálja. Teszttel fedve.

**Élő bizonyíték a javításra.** Ugyanaz a GUI-turn a javítás után:

- `math.js` a lemezen `left + right` → `left * right`, tehát Claude valóban szerkesztett;
- a végső válasz pontosan `PHASE145_GUI_EDIT_OK`;
- a `FÁJLOK / VÁLTOZÁSOK` összefoglaló `math.js MÓDOSÍTVA +1 −1`-et mutat;
- a fixture unit teszt `2/2` zöld, tehát a javítás tartalmilag helyes;
- `0` `.live-turn-anchor` a letisztulás után, azaz nincs átmeneti duplikált kártya;
- SQLite: turn `completed`, provider session `19a913a3-57c6-489f-ab81-939655586f21`, cost `0.0156506`, terminal event jelen, és **pontosan egy** `final=1 / live=0` assistant sor.

Screenshot: `Screenshots/768.png`. Ezzel a DoD 5. pontja először teljesül valóban az alkalmazásban.

#### Hiba 2 – a terv rollback/discard UI-ja nem létezik

A `agent_preview_snapshot`, `agent_apply_snapshot`, `agent_rollback_snapshot` és `agent_discard_snapshot` Tauri-parancsok mind regisztráltak, de a **frontend csak a preview-t és az apply-t hívja**: a preview kizárólag a `FÁJLOK / VÁLTOZÁSOK` összefoglaló felépítésére szolgál, az apply pedig `applyAgentSnapshotAutomatically`-val **automatikus**. A kódban ott a szándéknyilatkozat: *„There is intentionally no review dock anymore."* Rollbackre és discardra a frontendben egyetlen hívás sincs.

Tehát a DoD 14. pontja („diff preview, apply, rollback és discard működik") GUI-szinten így áll: preview ✓ (összefoglalóként), apply ✓ (automatikus), rollback ✗, discard ✗. A Rust oldal mindegyiket tudja és tesztelt.

**Ez terméktervezési döntést igényel, nem hibajavítást:** vagy a terv 6. fázisa és a DoD 14. pontja elavult (az auto-apply a végleges szándék), vagy a review dock / rollback gomb visszakerül a felületbe. Ezt nem döntöm el egyedül, mert a kód explicit szándéknyilatkozatot tartalmaz az ellenkezőjéről.

#### Hiba 3 – restart után a beszélgetés folytatódik, de a provider session nem

A 14.3/11 élő GUI-próba: az app bezárása és újraindítása után a beszélgetés és a `PHASE145_GUI_EDIT_OK` válasz visszajött, és a következő turnben Claude helyesen visszaidézte a tokent. **A kontextus tehát nem veszett el.** Screenshot: `Screenshots/769.png`.

Viszont a turn **új provider sessionben** futott: `19a913a3-57c6-489f-ab81-939655586f21` (restart előtt) → `9daa3427-34f4-4921-9810-c4b9b2199ee2` (utána), miközben mindkettő ugyanahhoz a conversationhöz (`f04ddfa7-e915-4995-b1a3-8b08e6bedaf8`) tartozik. A kontextust nem a provider-resume tartotta meg, hanem az, hogy resume nélkül a bridge a beszélgetés-átiratot beteszi a promptba (`conversationContext`). Ez a plan Fázis 9-ben leírt *tervezett fallback*, de a **DoD 16. pontja** („App restart után ugyanaz a Claude session folytatódik") így nem teljesül.

Gyökérok – ugyanaz a `\\?\` prefix-család, mint a Hiba 1-nél, csak a session-könyvelésben:

- Az `agent_sessions.project_key` **két alakban** létezik ugyanarra a könyvtárra: `C--Users-danis-OneDrive-my-projects-claude-fixture` és `----C--Users-danis-OneDrive-my-projects-claude-fixture`. A négy kötőjel a `\\?\` prefix elszanitizált maradványa, tehát egy projekthez két kulcs tartozik.
- A frontend session-cache kulcsa (`localStorage: min-claude-sessions`) `\\?\`-prefixes útvonal **plusz a csonkolt beszélgetés-cím** (`…\claude-fixture/Reply with exactly…`). A cím változásával a kulcs is változik.
- Ehhez a conversationhöz **7 `active` állapotú session-sor** halmozódott fel, ami a head-eltérés miatti ismételt forkolás jele.

Javaslat (nem hajtottam végre): a `\\?\` prefixet a Rust határon kell levágni, mielőtt bármilyen kulcs része lesz, és a frontend cache-kulcsot a stabil SQLite conversation ID-ra kell cserélni a path+cím helyett. Ez **nem mechanikus csere**: érinti a session-identitást, a HLC/tombstone merge-öt és a meglévő 7 sort, ezért migrációt és külön döntést kíván – egyedül nem nyúltam hozzá, mert egy elhibázott változtatás a meglévő session-történetet orphanné tenné.

### Fázis 19 – a Hiba 2 és Hiba 3 javítása

#### Rollback visszakerült a felületbe (DoD 14)

Döntés: az **auto-apply marad** – a felhasználó nem akar minden turn után jóváhagyó dokot –, de mellé kerül egy visszavonás, mert enélkül egy rossz módosítást csak kézzel vagy git-tel lehetne visszacsinálni, pedig a snapshot mentve van.

- `ChangeSummaryPanel` új opcionális `onRollback` / `rollbackBusy` propokat kap, és a `FÁJLOK / VÁLTOZÁSOK` lábában megjelenít egy `↺ Visszavonás` gombot.
- Új állapot: `undoableSnapshot`, amit az `applyAgentSnapshotAutomatically` sikeres apply után állít be – tehát mindig pontosan az a snapshot visszavonható, amelynek a változásai a lemezen vannak.
- A gomb **csak a legutóbbi turn kártyáján** jelenik meg (`isCurrentGroup`), mert a lemezen lévő állapot ahhoz tartozik; régebbi kártyákon félrevezető lenne.
- A `agent_rollback_snapshot` hívás hibáját nem nyeljük el: ha a guard elutasítja (mert a turn óta változtak a fájlok), az magyar üzenetként megjelenik – ez a helyes viselkedés, nem hiba.

A `discard` továbbra sincs kivezetve: staged állapot nélkül – auto-apply mellett – nincs mit elvetni, a visszavonás fedi az igényt.

#### Restart utáni resume (DoD 16)

A gyökérok nem tárolási hiba volt: a `19a913a3` sessionhöz **10 entry** rendben elmentve, helyes `project_key`-jel. A frontend viszont a resume session ID-t a `localStorage`-ból oldotta fel, **projekt-útvonal + csonkolt beszélgetés-cím** kulccsal – ez restartkor vagy címváltozáskor csendben mellényúl, és a turn új provider sessiont nyit.

Javítás: a küldés a **tartós, SQLite-ból jövő** `agentConversationStatus.activeSessionId`-t részesíti előnyben, amit a frontend a stabil conversation ID-val amúgy is lekér már; a `localStorage` kulcs csak visszafelé-kompatibilis tartalék marad a régi beszélgetésekhez. Ha a státusz `hasConflict`-ot jelez, továbbra sem resume-olunk, hanem szándékosan forkolunk.

**A valódi gyökérok viszont a Rust oldalon volt, és élő nyomkövetéssel jött elő.** A bridge diagnosztikája (`MIN_AGENT_BRIDGE_LOG`) megmutatta, hogy a frontend elküldte a session ID-t, a bridge mégis `resumeSessionId: null`-t kapott. Két helyen ugyanaz a hiba:

1. `record_agent_turn_start` a session fejét a beszélgetés **összes** turnjének legutolsójához hasonlította. A most küldött üzenet helyi sora (`provider_session_id IS NULL`) mindig előrébb állt, ezért minden folytatás cross-device eltérésnek látszott, és a kód `request.session_id = None`-t állított – vagyis szándékosan forkolt, minden egyes turnnél.
2. `agent_conversation_status` ugyanezt a fej-összevetést használta, ráadásul az `agent_sessions` sort `id` szerint kereste, holott a `conversations.active_agent_session_id` a **provider** session ID-t tárolja – így a session feje sosem volt megtalálható.

Javítás: mindkét helyen csak az **agent-turnök** számítanak a beszélgetés fejének (`provider_session_id IS NOT NULL`), a session pedig `provider_session_id` szerint kereshető. Ezzel a valódi cross-device fork-védelem megmarad, de a saját folytatás nem hamis konfliktus.

**Élő bizonyíték:** turn → app bezárás/újraindítás → turn, és a bridge mindkétszer `resumeSessionId: b9a869d9-db9a-40d3-aaac-65f1b9d90940`-t kapott; a DB-ben mindkét turn ugyanahhoz a provider sessionhöz tartozik. A DoD 16. pontja ezzel teljesül.

Ez a `\\?\` prefixes `project_key`-duplikációt is kezeli a gyakorlatban: a Hiba 1 javítása óta az új sessionök egységesen a `C--Users-…` kulccsal jönnek létre, a resume pedig nem a kulcson, hanem a conversation ID-n keresztül történik. A régi `----C--…` sorok érintetlenül maradnak, migrációra nem volt szükség.

#### Mellékes megfigyelés

Két `claude-fixture` könyvtár létezik: a GUI-projekt a `my projects\claude-fixture`-re mutat (ebben van `AGENTS.md` is), a repóban lévő `my AI CLI app\claude-fixture` külön példány. Az első GUI-turn azért nem produkált diffet, mert a GUI-fixture már hibátlan volt.

### Fázis 20 – a harness szűkösségének oldása

A CLI a Claude Code-dal azonos modellt futtatja, de vékonyabb körítéssel; hosszú, kutatós feladatokon ez érezhető volt. Három szűkület megszűnt.

- **Webkeresés és URL-olvasás:** a `WebSearch` és `WebFetch` bekerült az eszközkészletbe. Élő bizonyíték: `WEBSEARCH_OK:24` – ezt a modell csak kereséssel tudhatta.
- **Subagentek:** az `Agent` eszköz engedélyezve, tehát a munka szétosztható. Élő bizonyíték: `SUBAGENT_OK`.
- **Turnlimit:** alapérték `12` → `40`, felső korlát `40` → `200`. Előfizetéses módban ez az egyetlen guard, és a cancel bármikor elérhető.

Az engedélyezési szabály új, tesztelt modulba került (`agent-bridge/policy.mjs`). A hálózati és delegáló eszközök **jóváhagyás nélkül** futnak, mert nem érik el a workspace-t; a subagent saját eszközhívásai ugyanezen a kapun jönnek vissza, tehát a delegálás nem tágítja a jogosultságot. A `Bash` továbbra is jóváhagyást kér.

Ami tudatosan kimaradt: MCP, plan mód, notebook szerkesztés (a felhasználónak nincs `.ipynb` fájlja).

### Fázis 21 – system prompt és projektutasítások

**A legsúlyosabb, sokáig észrevétlen hiány.** A bridge egyáltalán nem állított `systemPrompt`-ot, és az SDK dokumentációja szerint ilyenkor *minimális* promptot használ, ami „omits Claude Code's coding guidelines, response style, and project context". A modell tehát ugyanaz volt, de a Claude Code kódolási irányelvei nélkül futott – ez önmagában többet magyaráz a „vékonyabb körítés" érzésből, mint a hiányzó eszközök.

Javítás:

- `systemPrompt: { type: "preset", preset: "claude_code" }` – a teljes Claude Code prompt.
- Az `append` részbe a felhasználó saját utasításfájljai kerülnek. Új `agent-bridge/instructions.mjs`: a projekt gyökeréből és legfeljebb három szinttel feljebbről összegyűjti a `CLAUDE.md` és `AGENTS.md` fájlokat, **külső-először** sorrendben, hogy a konkrétabb, projekt-szintű szabály legyen az erősebb. Fájlonként 32 KB, összesen 64 KB a korlát.
- A felhasznált fájlok útvonala `turn/instructions/loaded` eseményként auditálhatóan kimegy – ezt a terv 11. fázisa külön előírta.

**Miért nem a `settingSources`-szal.** Az SDK be tudná tölteni a `CLAUDE.md`-t, de csak setting source engedélyezésével, ami a globális hookokat, plugineket és MCP-ket is behúzná – pontosan azt, amit a 11. fázis biztonsági célja tilt. Így az utasítások megérkeznek, más nem. Az `AGENTS.md`-t az SDK amúgy sem keresi, azt mindenképp magunknak kell beolvasni.

### Fázis 22 – kép- és SVG-előnézet

Claude tud SVG-t írni (az szöveg), de a felületen nem lehetett megnézni: a képek eddig csak *bemenetként* léteztek (png/jpeg/webp csatolmány).

- **Rust:** a `read_project_image` eddig magic byte alapján ismerte fel a formátumot, ezért az SVG-t elutasította. Új `svg_bytes_mime` tartalom-alapú felismerés, ami kezeli a BOM-ot, az XML-deklarációt és a vezető kommentet is; nem SVG szövegre nem hamis pozitív. Teszttel fedve.
- **Frontend:** a `FÁJLOK / VÁLTOZÁSOK` listában a képfájlok (`svg`, `png`, `jpg`, `jpeg`, `webp`) kattinthatók, és nagy méretben nyílnak egy overlayben.
- **Biztonság:** a kép `<img>` elemben, data URL-ből jelenik meg. Az agent által írt SVG így nem futtathat scriptet és nem érhet el hálózatot – ezért nem inline HTML-ként rendereljük.

**Élő bizonyíték:** Claude a `claude-fixture` projektbe megírta a `blockdiagram.svg`-t (Signal Generator → DUT → Spectrum Analyzer), a listában `ÚJ +20 −0`-ként jelent meg, kattintásra pedig `data:image/svg+xml;base64,…` forrással, `naturalWidth=640`-nel kirajzolódott. Screenshot: `Screenshots/775.png` – ugyanazon a képen a `↺ Visszavonás` gomb is látszik.

**Élő bizonyíték a projektutasításokra:** a modell megkérdezve visszaadta mindkét betöltött fájl teljes útvonalát (`my projects\AGENTS.md` és `my projects\claude-fixture\AGENTS.md`), és szó szerint idézte az első pontot („Magyarul válaszolj, kivéve, ha a felhasználó más nyelvet kér."). A szabályt be is tartotta: angol kérdésre angolul válaszolt.

### Fázis 23 – a sync-karantén megszüntetése (1–4. lépés)

#### A hiba: egyetlen kimaradt match-ág, egygépes hatással

A v2 journal hat helyen dolgozza fel az eseményeket. Az `agent_session.*` típusok **ötbe** be voltak kötve – validátor, kompakció-kijelölés, esemény-rangsor, store-apply, store-export –, és **egyből hiányoztak**: a `reduce_snapshot`-ból, ami az eseményekből a UI-állapotot építi. Ott a catch-all ág hibát dob.

Mivel a `sync_v2_publish_snapshot` a végén `reduce_snapshot`-ot hív, az első Claude-turn után **minden publish elhasalt**, és a frontend `syncWriteEnabled = false`-ra váltott. Ez nem csak a cross-device Claude-sessiont érintette: **a teljes kimenő sync leállt**, a Codex-beszélgetésekkel együtt, a következő restartig. A konzolban ez `Ismeretlen v2 event a reducerben: agent_session.upsert` néven látszott.

Miért nem fogta meg teszt: a meglévő kétgépes teszt a `store::apply_agent_sync_event`-et hívja közvetlenül, tehát a journal-utat és a reducert **sosem járta be**.

#### Elvégzett munka

1. **Bukó teszt előre** – `agent_session_events_survive_the_journal_round_trip`: valódi journal-kör (`make_event` → `write_event` → `scan_journal` → `apply_events` → `reduce_snapshot`) session- és entry-eseménnyel. Hozzáadáskor a várt hibával bukott.
2. **Javítás** – a reducer explicit, üres ágat kap a három agent-eseményre: nem részei a UI-snapshotnak, a store-apply már perzisztálta őket. A catch-all hiba **megmaradt** minden ismeretlen típusra, mert az a journal integritás-őre. Kódkommentbe került mind a hat feldolgozóhely felsorolása.
3. **Cross-device resume származtatással** – a `conversations.active_agent_session_id` lokális könyvelés, nem része a sync payloadnak, ezért az átvett beszélgetésnél üres. Az `agent_conversation_status` most visszaesik a beszélgetés legfrissebb, nem törölt `agent_sessions` sorára – az a tábla syncel. **Journal-formátum nem változott**, tehát nincs kompatibilitási teher. A lokális oszlop továbbra is elsőbbséget élvez, ha ki van töltve; törölt session nem támad fel. A függvény törzse `agent_conversation_status_from_connection` néven kiemelve, hogy tesztelhető legyen.
4. **`project_key` normalizálás** – az SDK a munkakönyvtárból szanitálja a saját kulcsát, így az extended-length gyökérből `----C--Users-…`, a sima alakból `C--Users-…` lett: egy projekt két kulccsal, kettéhasadt session-vonallal. A store határán `normalize_project_key` egységesíti. **Tömeges migráció szándékosan elmaradt**: a resume a conversation ID-n megy, a régi sorok legfeljebb kozmetikai szemetek, a migráció kockázata pedig nyereség nélküli lenne.

**Verzió-skew:** kompatibilitási réteg nem készült. A journalban lévő agent-események a **régi buildet futtató másik gépet karanténba viszik**, ezért a két gépet együtt kell frissíteni.

**Ellenőrzés:** Rust `111/111`, bridge `23/23`, frontend `34/34`, `cargo fmt --check` zöld, debug bináris újraépítve.

**Még nem bizonyított:** az élő kétgépes acceptance (a terv 6. lépése) – két lokális app-adatkönyvtár közös sync rooton.

### Hátralévő élő acceptance

| Pont | Állapot | Miért nem futott le |
|---|---|---|
| 14.3/8–9 – diff preview, apply, rollback | **guard-szinten lefedve, GUI-szinten nyitott** | Új teszt: `agent_diff_preview_surfaces_the_edit_before_rollback` – a `claude-fixture` `multiply` hibáját másoló szerkesztésre a `agent_diff_preview_at` pontosan a két érintett fájlt adja vissza (`math.js` = `modified`, `NOTES.md` = `added`), a sordiffban a hibás sor `removed`, a javított `added`, a rollback pedig visszaállítja az eredeti hibás fixture-t és nem nyúl az érintetlen fájlhoz. Az apply/discard/stage/rebase útvonalakat a korábbi tesztek fedik. A Tauri-parancsokon átmenő, GUI-ból indított élő lánc továbbra is nyitott. |
| 14.3/11 – app restart utáni resume | **kontextus igen, provider session nem** | Lásd a lentebbi „Hiba 3" szakaszt. |
| 14.3/14 – `maxBudgetUsd` kulturált leállás | **scope-on kívülre került** | Előfizetéses módban nem küldünk budgetet, tehát nincs mit tesztelni. Csak a kulcsos tartalékútra érvényes, és API-kreditet fogyaszt. |
| 14.5 – teljes GUI végigkattintás | **nyitott** | GUI-interakciót igényel. |

**Ellenőrzés:** frontend/Vite build zöld; timeline/exact-once, hibamodell és canonical-ID tesztek `34/34`; Claude bridge `6/6`; fixture lokális teszt `2/2`; teljes Rust tesztcsomag `102/102`; `node --check agent-bridge/main.mjs` és `cargo fmt --check` zöld; debug standalone cargo build zöld; friss restart + Sync/GUI acceptance zöld. Az élő acceptance dokumentált költsége összesen `0.0496339 USD` (kapcsolat-teszt, rövid stream, canonical fixture-turn); release build nem készült.

## 7. Implementációs commit-szeletek

1. `refactor(agent): introduce provider-neutral runtime contract`
2. `feat(bridge): add versioned Claude JSONL bridge skeleton`
3. `feat(auth): store Claude API key in Windows Credential Manager`
4. `feat(claude): stream cost-limited Sonnet 5 turns`
5. `feat(claude): surface tool approvals and user questions`
6. `refactor(guard): make workspace snapshots provider-neutral`
7. `feat(store): persist Claude sessions and terminal lifecycle`
8. `feat(sync): mirror Claude SessionStore through OneDrive v2 journal`
9. `feat(ui): add Claude to CODING model picker`
10. `fix(recovery): restore exact provider session across restart and devices`
11. `test(agent): add Claude runtime, sync, and exact-once coverage`
12. `test(gui): verify Claude flow from debug desktop shortcut`

Minden commit után kockázatarányos teszt fut. A Codex-regressziót minden nagyobb szelet után ellenőrizni kell.

## 8. Kockázatok és mitigációk

| Kockázat | Hatás | Mitigáció |
|---|---|---|
| A bridge/SDK process lefagy | Magas | idle timeout, cancel, process-tree kill, recovery state |
| Az API-kredit gyorsan elfogy | Közepes | mock tesztek, per-turn budget, low effort, fixture repo |
| Approval callback beragad | Magas | request ID, persistent pending state, cancel/defer kezelés |
| Claude projekten kívül ír | Kritikus | cwd containment, PreToolUse/path policy, hard deny |
| Snapshot túl nagy | Magas | snapshot soha nem kerül API-ra; lokális ignore/size policy |
| Duplikált terminal event | Magas | stabil request/turn ID, idempotens terminal guard |
| Cross-device session összekeveredik | Kritikus | base head, HLC, fork conflict, exact restore acceptance |
| Törölt session visszatér | Magas | kaszkád tombstone, idempotens delete, stale-save guard |
| Globális Claude hook megkerüli a policyt | Magas | explicit setting sources, strict MCP, globális plugin tiltás |
| Codex regresszió | Magas | adapter refaktor viselkedésváltozás nélkül, baseline GUI teszt |
| API-kulcs kiszivárog | Kritikus | Credential Manager, redaction, env-only child injection |

## 9. Bonyolultság és becslés

| Terület | Nehézség | Becsült fókuszált idő |
|---|---:|---:|
| Runtime-absztrakció és Codex refaktor | 7/10 | 2–3 nap |
| Claude bridge és process supervision | 9/10 | 3–4 nap |
| API-key és connection flow | 5/10 | 1–2 nap |
| Stream/event mapping | 7/10 | 2–3 nap |
| Approval és kérdéskezelés | 8/10 | 2–3 nap |
| Providerfüggetlen workspace guard | 7/10 | 1–2 nap |
| SessionStore és adatbázis | 9/10 | 3–4 nap |
| OneDrive cross-device session sync | 10/10 | 4–7 nap |
| CODING GUI | 6/10 | 2–3 nap |
| Unit/integrációs/GUI-verifikáció | 8/10 | 3–5 nap |

Reális mérföldkövek:

- Élő Claude technikai vertical slice: 4–6 fejlesztési nap.
- Stabil egygépes Claude CODING: 7–10 fejlesztési nap.
- Cross-device sessionnel és valódi GUI acceptance-szel teljes implementáció: 12–18 fókuszált fejlesztési nap.

Összesített nehézség: **8.5/10**.

A legnagyobb kockázat nem maga a Claude API-hívás, hanem:

1. a megszakítható, GUI-ba visszacsatolt approval-folyamat;
2. a provider session egzakt, cross-device visszaállítása;
3. a durable terminal válasz és a workspace snapshot lifecycle szétválasztása;
4. a Codex regressziómentes megtartása.

## 10. Hivatalos technikai referenciák

- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK TypeScript referencia](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Agent-loop, maxTurns és maxBudgetUsd](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Approval és felhasználói kérdések](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Permission-konfiguráció](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Sessionök kezelése](https://code.claude.com/docs/en/agent-sdk/sessions)
- [SessionStore és cross-host resume](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [Claude Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5)
- [Claude modellek és árak](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Claude API prepaid billing](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage)
