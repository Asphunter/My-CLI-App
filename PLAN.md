# GENERAL / CODING mód – részletes megvalósítási terv

**Állapot:** implementálva és ellenőrizve; a teljes natív release-acceptance külön ellenőrzési kör

**Készült:** 2026-07-22

## 1. Cél

Az alkalmazás két, jól elkülönülő használati módot kapjon:

1. **CODING** – a jelenlegi működés megtartása: projekt kiválasztása, projekt alatti beszélgetések, aktív projektmappa, Codex fájlműveletek, munkafolyamat, `VÁLASZ / LÉPÉSEK` és trace.
2. **GENERAL** – projektfüggetlen, ChatGPT.com-szerű főnézet a hétköznapi kérdésekhez, például „Tell me a joke”.

Az alkalmazás megnyitásakor alapértelmezetten a GENERAL legyen a látható főnézet. A főpanel ekkor egy új, üres beszélgetésre kész chatfelület legyen, ne a projektlista vagy a Coding munkanézete.

A GENERAL módban létrehozott beszélgetések legyenek visszakereshetők, megnyithatók és folytathatók. A tárolás, a kétgépes szinkron és a visszaállítás ugyanúgy legyen tartós és determinisztikus, mint a CODING beszélgetéseknél.

## 2. Végleges UX-szerződés

### 2.1 Felső szintű módválasztó

A bal oldali sáv tetején, a `PROJEKTEK` fejléc alatt jelenjen meg egy kompakt választó:

```text
CODING   GENERAL
```

Ez nem a `VÁLASZ / LÉPÉSEK` kapcsoló új neve. Ez az alkalmazás legfelső szintű tartományválasztója.

- A kiválasztott mód legyen egyértelműen kiemelve.
- Billentyűzettel is működjön, legyen `aria-pressed` vagy egyenértékű állapotjelzés.
- A módváltás ne törölje és ne írja át egyik mód beszélgetéseit.
- A két módhoz tartozó lokális UI-állapot külön legyen megőrizve.
- Az első indításkor, illetve hiányzó módpreferencia esetén a GENERAL legyen aktív.

### 2.2 GENERAL mód indításkor

GENERAL módban az alkalmazás főpanelje a webes ChatGPT-hez hasonló, egyszerű beszélgetési felület legyen:

- középen vagy a jelenlegi layout természetes főterületén az üres chat állapota;
- látható composer és küldésvezérlés;
- projektmappa, Coding trace, fájldiff és projektinstrukció ne jelenjen meg;
- az üres állapotban használható legyen azonnal a composer;
- a fejléc jelezze, hogy GENERAL módban vagyunk;
- ne legyen szükség előbb projektet kiválasztani.

Ha egy korábbi General-beszélgetés van kiválasztva, a főpanel annak üzeneteit mutassa. A GENERAL új beszélgetése alapból válasz-nézet legyen; a Coding munkafolyamat részletei ne kerüljenek a felhasználó elé.

### 2.3 GENERAL oldalsáv

GENERAL módban a projektfa ne látszódjon projektlistaként. Helyette jelenjen meg:

- `ÚJ BESZÉLGETÉS` gomb;
- a General-beszélgetések időrend szerinti előzménylistája;
- az aktív beszélgetés kiemelése;
- beszélgetésenként opcionális műveleti menü: átnevezés, archiválás/törlés, ha ezek a Coding módban is biztonságosan rendelkezésre állnak;
- a lista ne tartalmazzon rejtett vagy látható „GENERAL projektet”.

A GENERAL mód belső tárolási scope, nem a felhasználó számára megjelenő projekt.

### 2.4 GENERAL beszélgetés-létrehozás

Az új, önálló General-kérdés külön beszélgetést indítson.

Az első elküldött üzenetkor:

1. létrejön egy stabil, új conversation ID;
2. a beszélgetés címe az első nem üres sorból készül;
3. a cím normalizált, rövidített, de a kérdés tartalmát tükrözi;
4. a user- és assistant-sor ugyanahhoz a stabil turn identityhez tartozik;
5. a beszélgetés bekerül a General-előzménylistába.

Azonos szövegű kérdések is külön beszélgetések legyenek. A cím nem lehet az identity vagy az elsődleges merge-kulcs.

### 2.5 Folytatás és új beszélgetés

A „minden új kérdés külön beszélgetés” szabályt úgy kell megvalósítani, hogy a folytatás természetes maradjon:

- `ÚJ BESZÉLGETÉS` vagy üres General állapot → a következő üzenet új conversation;
- kiválasztott korábbi beszélgetésben küldött üzenet → ugyanannak a beszélgetésnek a folytatása;
- a beszélgetés kiválasztása után a Codex-kontekstus a tárolt előzményekből épüljön fel;
- ha a másik gépen a helyi Codex thread ID nem érhető el, a General-beszélgetés akkor is folytatható legyen a szinkronizált üzenetkontekstussal;
- a folytatás ne nyisson véletlenül új, azonos című beszélgetést.

Automatikus szövegelemzésből nem szabad megpróbálni kitalálni, hogy egy üzenet új kérdés vagy folytatás. Ezt az aktív beszélgetés és az `ÚJ BESZÉLGETÉS` művelet állapota határozza meg.

### 2.6 CODING mód megőrzése

CODING módban a jelenlegi viselkedés maradjon a szabály:

- projektfa és projektenkénti beszélgetéslista;
- aktív projekt könyvtára a Codex `cwd` értéke;
- projektfájlok olvasása és módosítása csak itt;
- jelenlegi `VÁLASZ / LÉPÉSEK` nézet, trace, work item és diff működése;
- meglévő Coding-beszélgetések és címek változatlanul megmaradnak;
- a módváltás Generalra nem módosítja a Coding aktív projektjét vagy beszélgetését.

## 3. Határvonalak és nem célok

### 3.1 GENERAL nem Coding

GENERAL módban:

- ne legyen aktív projektútvonal;
- a Codex-kérés `cwd` értéke legyen üres/null vagy külön, nem projekt alapú biztonságos munkakönyvtár;
- ne kerüljön be aktív projektből automatikus fájlkontekstus;
- ne induljon projektfájl-írás, projektfuttatás, diff vagy snapshot-apply;
- ne kerüljön General-üzenet valamelyik Coding-projekt beszélgetései közé.

Ha a felhasználó fájlmunkát szeretne, át kell váltania CODING módra és projektet kell választania.

### 3.2 Első változatból kimarad

Az első implementáció ne tartalmazza:

- külön General-projektmappák létrehozását;
- automatikus projektfelismerést General üzenetekből;
- automatikus AI-címgenerálást az első kérdéshez;
- a beszélgetés minden üzenet utáni kötelező szétszakítását;
- General módban a projektmappához kötött képfeltöltést; ez a Coding composer funkciója marad;
- a Codex rollout/session fájlok OneDrive-ra szinkronizálását;
- a meglévő Coding tárolási formátum csendes átírását migráció nélkül.

## 4. Ajánlott adattervezés

### 4.1 Külön conversation scope

A General beszélgetéseket explicit scope-pal kell bevezetni, nem egy álprojektként vagy speciális fájlútként.

Ajánlott domainmodell:

```ts
type ConversationScope = "coding" | "general";

type ConversationIdentity = {
  id: string;
  scope: ConversationScope;
  projectId: string | null;
};
```

A `SyncConversation`/`LocalConversation` megfelelő mezői:

- `id`: kötelező stabil conversation identity;
- `scope`: `coding` vagy `general`;
- `projectId`: CODING esetén kötelező, GENERAL esetén `null`;
- `title`;
- `messages`;
- `threadId`/`codexThreadId`;
- `createdAt` és `updatedAt`;
- meglévő `workItems`, `planHistory`, `commentary` csak akkor, ha az adott scope-ban értelmes.

Az új kód ne használja a `projectPath/title` összefűzést elsődleges identityként. Ez legfeljebb legacy lookup és kompatibilitási átmenet lehet.

### 4.2 SQLite-migráció

A jelenlegi `conversations.project_id` mező nem nullable és a projekt táblára hivatkozik. A meglévő, működő Coding-adatbázis biztonságos megőrzése miatt a v19 migráció a `scope` oszlopot vezeti be, a fizikai foreign key szerkezetet pedig nem bontja meg. A domain- és sync-rétegben ettől függetlenül a General rekord logikai `projectId: null` értékkel jelenik meg.

1. a jelenlegi SQLite schema- és migration-verzió pontos ellenőrzése;
2. új migration verzió létrehozása, meglévő verzió újrahasználata nélkül;
3. `scope` mező hozzáadása default `coding` értékkel;
4. minden régi Coding conversation `scope = coding` értéket kap;
5. General conversation esetén a logikai snapshot- és wire-reprezentáció `projectId = null`;
6. a fizikai foreign key miatt Generalhoz csak szükség esetén, tranzakcióban jön létre a `system-general-scope-v1` belső tárolókonténer;
7. ez a konténer nem kerül vissza a projektlistába, nem kap `project.upsert` eseményt, és UI-szinten soha nem jelenik meg projektként;
8. migration után integritás- és darabszám-ellenőrzés;
9. hibánál az egész tranzakció rollbackeljen.

Így a nullable `project_id` domain-szerződés megmarad, miközben a meglévő SQLite foreign key-k és Coding-adatok nem igényelnek kockázatos tábla-újraépítést. A belső konténer nem felhasználói projekt és nem része a General identitynek.

### 4.3 Sync v2

A v2 append-only sync eventekben is legyen explicit scope:

- `conversation.upsert` payload: `scope` és opcionális `projectId`;
- `message.upsert` payload: a conversation ID alapján működjön, ne csak project/title alapján;
- General conversation esetén ne keletkezzen `project.upsert`;
- General conversation tombstone-jában a `projectId` legyen null;
- a reducer General rekordot ne próbáljon projektlistába visszaemelni;
- az event ID, conversation ID és message identity legyen determinisztikus és gépek között közös;
- az azonos című, de külön ID-jú General-beszélgetések ne olvadjanak össze;
- későbbi stale snapshot ne rejthessen el már befejezett General-választ.

A régi, scope nélküli snapshotok visszaolvasásakor minden conversation alapértelmezett értéke `coding` legyen. A régi Coding-adatokból ne vesszen el sem üzenet, sem work item, sem Codex thread metadata.

### 4.4 Aktív mód és kiválasztás

Az aktív UI-mód és a kiválasztott conversation legyen lokális UI-állapot, ne egy több gép által egymást felülíró globális „utolsó kiválasztás” adat.

Javasolt lokális kulcsok:

- `min-active-mode` → `coding | general`;
- `min-active-general-conversation-id`;
- a meglévő Coding aktív projekt/beszélgetés kulcsai kompatibilitási ideig maradjanak.

Indításkor:

1. SQLite és sync hidratálás történik;
2. a General előzménylista felépül a stabil conversation ID-kből;
3. ha nincs érvényes General kiválasztás, új General nézet jelenik meg;
4. ha van lokálisan megőrzött és ténylegesen létező General conversation ID, az nyitható meg;
5. egy hiányzó vagy csak stale cím alapján nem szabad másik beszélgetést kiválasztani.

Ez nem írhatja felül a jelenlegi Coding keresztgépes visszaállítási garanciáit.

## 5. Megvalósítási fázisok

### Fázis 0 – baseline és invariánsok

- [x] A jelenlegi workspace módosításainak megőrzése; csak a feature-höz tartozó fájlok módosítása.
- [x] A jelenlegi SQLite migration/schema verzió dokumentálása.
- [x] A jelenlegi Coding snapshot, sync event és localStorage forma mintavételezése.
- [x] A stabil conversation/message identity jelenlegi merge-szabályainak rögzítése.
- [x] A Coding regressziós acceptance tesztjeinek kiválasztása.

**Kimenet:** implementáció előtt ismert baseline és tesztelhető invariánslista.

### Fázis 1 – tiszta frontend domainmodell

Érintett területek: `src/App.tsx`, új opcionális `src/conversationScope.ts`, frontend tesztek.

- [x] `ConversationScope` és `AppMode` típusok bevezetése.
- [x] A General és Coding conversation identity/kulcsfüggvények különválasztása.
- [x] General címképzés a meglévő normalizálási elv alapján, projektfüggés nélkül.
- [x] Új beszélgetés és folytatás állapotgépének megírása.
- [x] Azonos című General beszélgetések külön identity-tesztje.
- [x] A Coding útvonalakra explicit `scope = coding` alapértelmezés.

**Kimenet:** a frontend domainlogikája tesztelhető UI nélkül.

### Fázis 2 – SQLite és snapshot migráció

Érintett területek: `src-tauri/src/store.rs`, szükséges Tauri típusok és lokális snapshot-kód.

- [x] Új schema migration a `scope` és a logikai nullable `projectId` kompatibilis támogatására.
- [x] `LocalConversation` és snapshot serde-kompatibilis bővítése.
- [x] Régi snapshotok `coding` defaulttal történő beolvasása.
- [x] General conversation létrehozása, mentése, betöltése és törlésének támogatása.
- [x] Transaction rollback és integrity-check tesztek.
- [x] Meglévő Coding rekordok darabszám- és tartalom-ellenőrzése migration előtt/után.

**Kimenet:** General beszélgetés OneDrive és UI nélkül is tartósan tárolható.

### Fázis 3 – v2 sync és recovery

Érintett területek: `src-tauri/src/sync.rs`, `src-tauri/src/store.rs`, frontend sync adapterek.

- [x] Conversation event payloadok scope-bővítése.
- [x] General conversation/project-null reducer-útvonal.
- [x] General message és work item nélkül is helyes materializálás.
- [x] Tombstone/restore General beszélgetésre.
- [x] Régi scope nélküli eventek kompatibilis redukciója.
- [x] Két device offline írásának konvergenciatesztje.
- [x] Külön General conversation azonos című promptokkal.
- [x] A lokális Codex thread hiányakor a tárolt conversation-kontekstus használata.

**Kimenet:** a General előzmény két gépen is megmarad és nem keveredik Codinggal.

### Fázis 4 – app-szintű módválasztó és indítási nézet

Érintett területek: `src/App.tsx`, `styles.css`.

- [x] `activeMode` állapot és lokális perzisztencia.
- [x] `CODING / GENERAL` választó a `PROJEKTEK` fejléc alatt.
- [x] App-start alapértelmezett GENERAL viselkedés.
- [x] Coding nézet meglévő projektfájának feltételes renderelése.
- [x] General nézetben projektlista helyett General history renderelése.
- [x] Módváltáskor a két mód draftja, kiválasztása és scrollállapota ne keveredjen.
- [x] A főpanel General üres állapota és fejlécszövege.

**Kimenet:** az alkalmazás indításkor ChatGPT-szerű General chatként jelenik meg.

### Fázis 5 – General conversation lifecycle

Érintett területek: `src/App.tsx`, composer és timeline renderelés.

- [x] `ÚJ BESZÉLGETÉS` művelet General módban.
- [x] Első General submit előtt stabil conversation ID és turn ID létrehozása.
- [x] Cím beállítása az első promptból.
- [x] Üres General állapotból új conversation létrehozása.
- [x] Kiválasztott General conversation folytatása.
- [x] A folytatás contextje az adott conversation előzménye legyen, ne a legutóbbi másik chat.
- [x] General requestnél nincs aktív project cwd vagy projektfájl-kontekstus.
- [x] Válasz, hiba, cancel, reload és stream-completion minden életciklusban a megfelelő conversation ID alatt maradjon.
- [x] A Codex thread ID hiányakor fallback a tárolt conversation kontextusra.

**Kimenet:** a „Tell me a joke” típusú kérdés önálló chatként létrejön, később megnyitható és folytatható.

### Fázis 6 – UI finomítás és Coding regresszióvédelem

- [x] Kompakt módválasztó illeszkedése a jelenlegi sötét UI-hoz.
- [x] General history olvashatósága hosszú címekkel és azonos címekkel.
- [x] Üres állapot, betöltés, sync warning és hibaállapot megtervezése.
- [x] General módban ne maradjon látható Coding-only panel.
- [x] Coding mód vizuális és funkcionális ellenőrzése módváltás után.
- [x] Csökkentett mozgás és billentyűzetes navigáció ellenőrzése.
- [x] GUI-screenshot-szabály betartása a projekt `Screenshots` mappájában.

### Fázis 7 – release acceptance

- [x] Frontend production build.
- [x] Frontend timeline és identity tesztek.
- [x] Rust store/sync tesztek.
- [x] App-server smoke teszt.
- [x] Böngészős hidegindítás-analógia üres General nézettel.
- [ ] Hidegindítás mentett General conversation visszaállításával.
- [ ] Két gépes OneDrive szinkron és újraindítás utáni pontos conversation-nyitás.
- [ ] Coding projekt megnyitása és egy rövid, nem romboló Coding turn.
- [ ] General módból indított kérésnél nincs projektfájl-módosítás.

## 6. Tesztmátrix

### 6.1 Frontend domain tesztek

| Eset | Elvárt eredmény |
|---|---|
| Nincs módpreferencia | GENERAL aktív |
| Módváltás GENERAL → CODING → GENERAL | A két mód külön állapotot őriz |
| Üres General submit | Új conversation ID jön létre |
| Első prompt címe | Az első nem üres sor rövidített tartalma |
| Két azonos prompt | Két külön conversation ID és két külön history elem |
| Kiválasztott General folytatása | Ugyanaz a conversation ID marad |
| `ÚJ BESZÉLGETÉS` után submit | Új conversation ID jön létre |
| Legacy Coding rekord scope nélkül | `coding` scope-pal jelenik meg |
| General kiválasztott ID hiányzik | Nem nyílik meg másik chat tévesen |

### 6.2 Tárolási és sync tesztek

| Eset | Elvárt eredmény |
|---|---|
| Régi SQLite migration | Nincs adatvesztés, minden régi conversation Coding |
| General mentés/betöltés | `project_id = NULL`, `scope = general` |
| General snapshot roundtrip | Az identity és üzenetsorrend változatlan |
| General upsert két gépről | Determinisztikus, duplikációmentes merge |
| Azonos cím, külön conversation ID | Nem olvad össze |
| General tombstone | Csak az adott chat tűnik el az aktív listából |
| General restore | A pontos chat visszaállítható |
| Stale üres snapshot | Nem rejti el a kész választ |
| Hiányzó helyi Codex thread | Conversation contextből folytatható |

### 6.3 UI és runtime tesztek

- app indításakor a főpanel General chat;
- General módban nincs projektfa és nincs Coding cwd-kontekstus;
- Coding módba váltáskor a jelenlegi projekt/beszélgetés működik;
- General history-ból kiválasztott chat pontosan a kiválasztott tartalmat mutatja;
- stream közben a válasz és az esetleges állapotjelző ugyanahhoz a General chathez tartozik;
- restart után nincs duplikált user vagy assistant sor;
- a befejezési hang egyszer szól;
- General request nem indít projektfájl-írást;
- a meglévő sync health, quarantine és recovery felület nem romlik el.

## 7. Érintett fájlok – várhatóan

Ez a lista implementációs kiindulópont, nem előre eldöntött teljes fájllista:

- `src/App.tsx` – módállapot, startup, sidebar, General history, submit és timeline routing;
- `src/conversationScope.ts` – tiszta scope-, identity- és címfüggvények, ha a logika mérete indokolja;
- `src/messageIdentity.ts` – meglévő identity merge szabályokhoz illesztés;
- `src/chatTimeline.ts` – csak akkor, ha a General timeline-nak külön csoportosítás kell;
- `styles.css` – módválasztó, General home/history és állapotok;
- `src-tauri/src/store.rs` – SQLite schema, migration, snapshot és LocalConversation;
- `src-tauri/src/sync.rs` – scope-os event payload, reducer, snapshot és tombstone;
- `src-tauri/src/codex.rs` – csak akkor, ha a General cwd/thread policy backend oldali változtatást igényel;
- `src-tauri/src/lib.rs` – csak új Tauri command vagy request mező esetén;
- `tests/*.test.ts` – domain, identity és timeline regressziók;
- Rust unit/integration tesztek a store/sync modulok mellett;
- `README.md` – a végleges működés rövid dokumentálása az implementáció után.

## 8. Adatbiztonsági és kompatibilitási szabályok

- A meglévő Coding beszélgetéseket nem szabad General migration közben átnevezni vagy új conversation ID alá mozgatni.
- A General conversation ID ne függjön címtől, időbélyegtől, géptől vagy projektúttól.
- A conversation title csak megjelenítési metadata.
- A user üzenet tartalma immutable az identity merge szempontjából.
- A kész assistant-válasz nem válhat újra üres/live állapotúvá egy későbbi stale import miatt.
- A Codex lokális rollout ID-je nem tekinthető két gép között tartós conversation identitynek.
- OneDrive-on ne legyen közös élő SQLite adatbázis.
- A General mód ne kapjon véletlenül Coding projektútvonalat.
- Migration és sync hiba esetén fail-closed viselkedés maradjon.
- Törlés/archiválás továbbra is recoverable tombstone legyen, ne csendes hard delete.

## 9. Definition of Done

A terv akkor tekinthető teljesítettnek, ha:

1. az app indításakor a főpanel General chatként jelenik meg;
2. a `CODING / GENERAL` választóval egyértelműen váltható a két mód;
3. General módban nincs projektfelosztás, de van saját beszélgetés-előzménylista;
4. minden új, önálló General-kérdés külön conversation ID-t és promptból képzett címet kap;
5. kiválasztott régi General-beszélgetés folytatható;
6. a Coding működés és a meglévő projektek változatlanul működnek;
7. a General adatok SQLite-ban, v2 syncben és recoveryben is szabályosak;
8. két gépen a beszélgetések nem keverednek össze, azonos című kérdések sem olvadnak össze;
9. General módból nem történik projektfájl-módosítás;
10. a build, frontend tesztek, Rust store/sync tesztek, smoke és restart/restore ellenőrzések sikeresek.

## 10. Első implementációs sorrend

A tényleges kódolást ebben a sorrendben kell kezdeni:

1. domain scope és identity tesztek;
2. SQLite/snapshot migration;
3. sync v2 payload és reducer;
4. frontend startup és módválasztó;
5. General history és new/continue lifecycle;
6. General request cwd/context policy;
7. UI finomítás;
8. teljes regression és kétgépes acceptance.

Az első kódolási lépés előtt a migration aktuális verzióját és a dirty workspace releváns módosításait újra ellenőrizni kell. A terv nem jogosít fel kapcsolódó felhasználói változtatások felülírására.
