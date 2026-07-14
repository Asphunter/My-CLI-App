# Phase 2 – append-only OneDrive Sync v2

**Állapot:** az append-only v2 alap, a részletes Sync Health, a tombstone-alap és az alap Recovery Center/restore elkészült; a teljes Phase 2/3 még nincs lezárva.

## Elkészült ebben a szeletben

- A gépenkénti v2 eszközazonosító a `%LOCALAPPDATA%\min\sync-device-id` fájlban él; nem kerül OneDrive-ba.
- A közös adatútvonal:

  ```text
  <OneDrive>\my projects\.min-sync\v2\
    events\<device-id>\<sequence>-<event-id>.json
    quarantine\<importer-device-id>\<source-device-id>\...
  ```

- Egy v2 event létrehozás után nem módosul. Az írás ideiglenes fájlba, majd ugyanazon a könyvtáron belüli atomikus átnevezéssel történik.
- Az event envelope ellenőrzi a schema-verziót, UUID-ket, monoton device sequence-t, HLC-t, payload hash-t, event hash-t és a hash-láncot.
- A támogatott eventek:
  - `project.upsert`;
  - `conversation.upsert`;
  - `message.upsert`;
  - `work_item.upsert`;
  - `entity.tombstone`;
  - `entity.restore`.
- Az importer sequence- és hash-lánc-szakadásnál nem ugrik át csendben, a hibás fájlt copy-only quarantine-másolatba teszi hash-elt manifesttel, symlinket nem követ, és írásképtelen állapotot jelez; az eredeti OneDrive-event automatikus törlése tiltott.
- A lokális SQLite `sync_events`, `sync_cursors` és `sync_tombstones` táblái v5 migrációval tárolják az importált eventeket, cursorokat és offline tombstone metadata-t; a message/work item sorok a HLC-eredetet is megőrzik.
- Az ismételt import idempotens; a teljes payload-azonos event újra nem kerül kiírásra.
- A reducer üzeneteket és work itemeket stabil entity ID alapján egyesít, a projekt beszélgetéslistája unionként marad meg, a metadata konfliktusa HLC/device/sequence sorrenddel determinisztikus.
- A kliens a message- és WorkFlow-időrendet is HLC/device/sequence alapján jeleníti meg; a gépek saját lokális sorszáma nem tudja többé felcserélni a két gépen írt üzeneteket.
- Work itemből a v2 journal alapból nem visz át nyers `body` és `code` tartalmat.
- Az App induláskor és 15 másodpercenként v2 journalból importál (aktív stream közben a pull szünetel), a sikeres lokális SQLite-mentés után pedig v2 eventeket publikál. A régi v1 `state.json` csak copy-only bootstrap/import forrás marad.
- A v2 válasz strukturált Sync Health állapotot ad: journal- és quarantine-path, ellenőrzési/import idő, event-számok, blokkolt device-ok, warnings és recovery-javaslat. A kliens ezt részletes panelen mutatja, és kézi újraellenőrzést kínál.
- A projekt- és beszélgetés-eltávolítás v2-ben append-only `entity.tombstone` eventet készít; a reducer az aktív listából elrejti az entitást, de a recovery metadata megmarad. A tombstone lokálisan SQLite-ban is tartós, így OneDrive-kimaradás közben sem vész el.
- A Sync Health panel Recovery Center része kilistázza az archivált projekt/beszélgetés entitásokat, és megerősítés után explicit `entity.restore` eventet ír; karantén vagy írásképtelen journal esetén a visszaállítás letiltott.
- A restore előtt külön dry-run ellenőrzés fut: stale archiválásnál vagy karanténos journalnál nincs event-írás, az előnézet megmutatja a várható hatást és azt is, hogy a projektfájlok nem módosulnak.
- A retention ellenőrzés a 30 napnál régebbi tombstone-okat jelöli, de a közös journal purge-je többgépes acknowledgement és igazolt backup nélkül szándékosan tiltott; automatikus event-törlés nincs.
- A retention gate immár append-only ACK rekordokat ír gépenként, a jelenlegi journal-digestet hashelve; a backup művelet OneDrive-on kívüli lokális event- és compaction-snapshot-másolatot készít, visszaellenőrzi, majd backup-manifestet és saját ACK-et publikál. Minden ismert eszköz aktuális ACK-je és legalább egy aktuális, igazolt backup-manifest szükséges.
- A gated compaction immutable, hash-elt állapot-snapshotot ír; a prefix-cursorok alapján az eventlánc folytatható marad, a régi eventek tranzakciós trash-mozgatással törlődnek, hiba esetén visszaállítással. Az új gép snapshotból tud hidratálni, a következő event pedig a snapshot cursorából folytatódik.
- A retention auditpanel megmutatja az aktuális journal event-számot/digestet, a compaction snapshotot, az összes archivált jelölt okát és eszközönként az ACK/backup állapotot. A kijelölt jelöltek tömeges purge-je külön Tauri parancson fut, explicit megerősítéssel és backend oldali stale/non-eligible kijelölés-ellenőrzéssel.
- A retention ACK/backup/purge lépések append-only auditrekordokat írnak `started/completed/failed` állapottal; a legutóbbi auditműveletek a retention panelen is láthatók.
- A reducer 1200 eventes, két eszközről érkező eltérő import-sorrendet is ugyanarra a snapshotra redukálja.
- 24 determinisztikus generált seed, 3840 eventes interleaving és hibás JSON event fault-injection teszt védi a konvergenciát és a quarantine fail-closed viselkedést.
- A hosszabb soak 4 seeden, seedenként 2 eszköz 500-500 láncolt eventjével és 4 ismételt permutált importtal ellenőrzi, hogy a reducer ugyanarra az állapotra konvergál.
- A `filesystem_two_device_offline_reconnect_and_quarantine_recovery` teszt valódi temp-fájlrendszeres journalon próbálja az offline sequence-gapet, a későbbi reconnectet, a két lokális store eltérő pull-időpontjait és a sérült event explicit javítás utáni újraimportját.
- A `proptest` 64 generált esettel valódi property-tesztként ellenőrzi a két device-chain tetszőleges import-permutációjának konvergenciáját; a zsugorított hibapéldák a `src-tauri/proptest-regressions/sync.txt` regressziós corpusban maradnak.
- A Codex cwd-je technikailag a `my projects` gyökér alá van korlátozva; tetszőleges külső könyvtárból agent-futtatás és kódfájl-olvasás nem indulhat.
- Minden agent-turn előtt helyi, nem-Git snapshot és base-hash készül korlátozott fájl-/méretlimittel. A turn után a módosított, új és törölt fájlok listája megjelenik, és explicit rollback kérhető; ha a projekt közben változott, a rollback blokkolódik.
- Az app-server parancs- és fájlmódosítási approval-kérései a klienshez jutnak; a turn a döntésig vár, a kliens `accept`, `acceptForSession`, `decline` vagy `cancel` döntést küldhet, és UI-válasz nélkül 5 perc után fail-closed elutasítás történik.
- Sikeres agent-turn után a nem-Git snapshot a post-state fájltartalmát stage-eli, a canonical workspace-t base-hashre visszaállítja, majd külön diff-review `Alkalmazás` vagy `Elvetés` döntést kér; az apply base-hash-eltérésnél blokkol, részleges apply-hibánál megpróbálja a base-state-et visszaállítani.
- A stage snapshotból sor-szintű, korlátozott diff preview készül hozzáadott/törölt/context sorokkal, binary/large-file jelzéssel, base/post/current hash-sel és snapshot-akció auditmezőkkel; a teljes fájlhash továbbra is az autoritatív ellenőrzés.
- A staged snapshothoz konzervatív 3-way rebase/preflight is kérhető: csak nem átfedő UTF-8 szöveges változásokat egyesít, konfliktusnál nem ír, és a rebase után is külön Apply szükséges; rebase után a teljes rollback szándékosan letiltott, mert külső változás is része lehet a workspace-nek.
- Tiszta Git-repóban, runtime-függőségek nélkül az agent lokális `git worktree` shadowban fut; dirty vagy ilyen függőségeket tartalmazó repónál automatikusan a nem-Git snapshot fallback marad aktív. A jelenlegi workspace nem érvényes Git-repó, ezért itt a fallback fut.
- A Git-shadow base-választó nem áll meg egy létező, de nem írható lokális mappánál: sikertelen worktree-létrehozás után a temp fallbacket is kipróbálja.
- A Codex binary-feloldás az explicit `MIN_CODEX_BIN`, a bundled/workspace bináris és a PATH alias mellett a felhasználói `.codex/plugins/.plugin-appserver/codex.exe` managed fallbacket is keresi.
- A Codex rollout/thread azonosító géphelyi app-server állapot, ezért nem kerül OneDrive-on használatra. Ha egy átvett beszélgetés régi rolloutja a másik gépen hiányzik, az app új helyi threadet indít, és a szinkronizált beszélgetés-előzményt kontextusként átadja.
- A Rust/Cargo dev- és release-build targetje a `tauri:dev:local` és `tauri:build:local` parancsokkal gépenkénti `%LOCALAPPDATA%\min\cargo-target` mappába kerül; a OneDrive-ban nem marad build-cache.

## Ellenőrzés

- Rust v2 sync unit tesztek: 12 passed; a teljes Rust library tesztcsomag: 39 passed. A binárisok `cargo check` ellenőrzése és a Vite production build is sikeres.
- Frontend TypeScript + Vite production build: sikeres.
- `cargo check --bins`: sikeres.
- A `npm run smoke:app-server` harness valódi ideiglenes Git- és nem-Git fixture-t hoz létre, mindkettőn sikeres `initialize` és `thread/start` választ ellenőriz, majd process-tree szinten takarít. A managed Codex fallbackdel mindkét smoke sikeres.

## Tudatos korlátok

- A Recovery Center alap restore, a retention auditnézet és az ACK/backup-gated snapshot/compaction purge elkészült; a kijelölt jelöltek tömeges purge-je explicit megerősítésű és fail-closed.
- A Sync Health diagnosztikát és újraellenőrzést ad; a quarantine forrás-eventjének javítása vagy eltávolítása továbbra is manuális, automatikus event-helyreállítás nincs.
- A projektfájl-agent végrehajtás nem-Git snapshot/base-hash/rollback guarddal, app-server approval-flow-val, diff/audit preview-val, explicit transactional apply/3-way rebase-gate-tel és tiszta Git-repóhoz shadow-worktree adapterrel védett.
- A property framework most már 64 generált esettel és regressziós corpus-szal lefedi az interleavinget; a teljes, hosszú, valódi kétgépes/OneDrive soak továbbra is külön környezeti teszt.
- A Phase 4-ből jelenleg cwd/path authorization, approval request kezelés, sor-szintű diff/audit preview, nem-Git transactional apply, konzervatív 3-way rebase, Git/shadow-worktree adapter, retention audit és snapshot/compaction purge készült el.

## Következő szelet

1. Hosszú, valódi kétgépes/OneDrive soak futtatása.
2. A managed Codex fallback külön installációs variánsainak ellenőrzése.
3. Opcionális, explicit quarantine-repair workflow az authoring gépen, külön megerősítéssel.
