# Cross-projekt / cross-beszélgetés bug — elemzés

*2026-07-28 · Fable xHigh elemzés, kódírás nélkül. A konfidencia azt mondja meg,
mennyire vagyok biztos benne, hogy a mechanizmus valós ÉS ebben az incidensben
szerepet játszott.*

## Mi történt (tünetek, bizonyítékkal)

Futás közbeni navigáció mellett:

- A **GUI test 2 / 1_** beszélgetésbe került három válasz, ami a GUI tests-é
  volt („Teszt 999 véve.", „Teszt BBB véve.", „Teszt EEEE véve.") — **lemezen**,
  nem csak a képernyőn.
- A **GUI tests / 1**-ben kérdés nélküli, árva válaszok álltak („Teszt AAA
  véve."), és kérdések tűntek el, amik csak GUI-restartra jöttek vissza —
  vagy soha („test EEEE" kérdése egyáltalán nem került lemezre).

A revert (`cecb835`) után a navigáció futás alatt újra tiltott, ezért a hiba
**maszkolva** van — de az okai a kódban maradtak.

## Kulcsbizonyíték: az üzenet-ID-k verziója elárulja az írót

A message ID harmadik csoportjának első hexjegye a UUID-verzió:

| sor | ID (részlet) | verzió | író |
|---|---|---|---|
| GUI tests, „Teszt 999 véve." | `a3b76d8d-fab1-5b36-…` | **v5** (determinisztikus) | Rust runtime — jó helyre |
| GUI test 2, „Teszt 999 véve." | `4da4f361-dad4-4570-…` | **v4** (random) | frontend — rossz helyre |

Mindhárom átszivárgott sor v4-es. Ugyanaz a válasz kétszer íródott le, két
író által, két különböző beszélgetésbe.

## (A) Architektúra-szintű hibák — a HEAD-ben ma is élnek

### A1. Minden írás célpontja egyetlen közös nézet-állapot — 95%

A `messages`, `codeActivity`, `activePlan`, `pipelineProgress` nem „egy
beszélgetés adata", hanem „ami épp a képernyőn van". A stream, a befejezés és a
mentés mind ehhez nyúl; a tulajdonos beszélgetés csak implicit. Minden további
hiba ennek a következménye.

### A2. Két író, két igazság — 90%

Az assistant választ a Rust runtime is leírja (v5 ID, helyes beszélgetés) és a
frontend mentőhurok is (v4 ID, az épp látott beszélgetés). Egy beszélgetésen
belül az identitás-összefésülés eltünteti a duplikátumot; két beszélgetés
között nincs, ami eltüntesse.

### A3. A mentőhurok az aktuális threadKey-hez könyvel, uniósan — 90%

A save-effekt azt menti, ami a `messages`-ben van, arra a kulcsra, ami épp
aktív. A `mergeMessages` additív (ID szerinti unió, sort nem töröl), ezért
egyetlen tranziens keveredés **végleges** lemezsorrá válik. Ezért élte túl a
szennyezés az újraindítást.

### A4. A kérdés egyetlen példányban, a nézet-állapotban él a mentésig — 85%

User sort csak a frontend ír. Ha a beírás és a mentési ciklus közé
hydrálás / cache-visszatöltés / sync-pull esik, a kérdés örökre elvész, a
válasz (runtime, v5) pedig árván érkezik meg. Bizonyíték:

- a „test EEEE" kérdés soha nem került lemezre, a v5 válasza igen;
- a DB-ben **július 26-i** `answer-before-question` sírkövek vannak — tehát ez
  a hiba a mai navigációs munka **előtt is** termelt árvákat;
- a reggeli „stop után restartra előjött a válasz" jelenség ugyanez a család.

### A5. A beszélgetés-kulcs elérésiút-sztring, két írásmóddal — 75%

A kulcs `${project.path}/${title}`, a path pedig hol `\\?\C:\…`
(store-kanonizált — a sidebar tooltipben látszik), hol sima `C:\…`. A kód tud
róla (a `findCachedConversation` pont ezért létezik), de minden exact-string
összehasonlítás és exact cache-lookup szétcsúszhat a két írásmód között.

## (B) A mai — visszavont — patch saját hibái (tanulság a következő fixhez)

### B1. TOCTOU a tulajdonos-ellenőrzésben — 85%

A `messageKeyRef`-et csak egy effekt frissíti, a kattintás utáni
render-körben. Az ablakban a guard még a régi kulcsot látja, miközben a
`messages` már a másik beszélgetést tartalmazza → a befejezés „képernyőn
vagyunk" ágra fut, idegen state-be ír, az A3-as hurok pedig a rossz kulcs alá
menti. Ez gyártotta a v4-es szivárgó sorokat.

### B2. „Gazdátlan = mindenhol látszik" default — 80% / ~50%

A `viewingLiveRun()` igazat adott, ha a `liveRunThreadKeyRef` null volt — a
run-végi `finally` pedig nullázta, így a késői események bármelyik nézetbe
beírhattak. A helyes default: gazdátlan írás = eldob.

### B3. Kétféle „mi van a képernyőn" óra + néma eldobás — 85%

Egyik guard a `threadKey` render-state-hez mért, másik a `messageKeyRef`-hez —
váltás közben a kettő szükségszerűen széttart. A `commitMessagesForThread`
ráadásul exact kulccsal keresett a cache-ben (`if (!existing) return` — néma
eldobás), miközben az A5 miatt írásmód-toleráns keresés kellett volna.

## A kauzális lánc az incidensre

1. A kérdés a globális `messages`-be kerül (egyetlen példány — A4).
2. Váltáskor a guard elavult (B1); a stream/befejezés az új nézet state-ébe ír.
3. A mentőhurok az új kulcs alá könyveli, uniósan, véglegesen (A3).
4. A runtime közben a jó helyre írja a v5 példányt (A2) → duplikátum két
   beszélgetésben.
5. A hydrálás alá eső kérdés sehova nem mentődik → árva válasz (A4).
6. Restart a lemez igazságát mutatja — ezért „jött vissza" minden újraindításra.

## Verdikt

A bug **nem hiányzó guard, hanem címzési modell-hiba**: nézet-címzett írások +
két író + additív mentés + sztring-kulcs. Guard-okkal elvi okból nem tömíthető
— minden guard órája széttarthat váltás közben. A megoldás iránya:

- beszélgetés-**ID**-vel címzett, beszélgetésenkénti állapot (nem path-sztring);
- soronként pontosan **egy író**: user sor szinkron write-through beküldéskor,
  assistant sor csak a runtime-tól;
- a nézet csak **olvas** és címez, sosem ő a tárolás forrása.

---

# A kódstruktúra állapota (az eldöntendő kérdéshez)

Számok, 2026-07-28:

| | sor | megjegyzés |
|---|---|---|
| `src/App.tsx` | **15 330** | ebből az `App()` komponens maga ~8 500 sor |
| hookok az App.tsx-ben | 96 useState, 62 useRef, 62 useEffect | gyakorlatilag mind egyetlen komponensben |
| kiemelt TS modulok | 315 + 47 + 7 sor | (`messageIdentity`, `conversationScope`, `conversationIdentity`) — jó irány, de elenyésző |
| Rust oldal | 27 465 sor, 7 modulban | `sync` 9k, `store` 8k, `codex` 4.8k… — tagolt, 163 teszttel |

**Ítélet: a frontend magja strukturálisan a határán túl van; a Rust oldal
rendben van.** A 96 useState egyetlen komponensben azt jelenti, hogy minden
állapot mindenkivel érintkezhet — a cross-conversation bug pontosan ennek a
szerkezetnek a terméke, és a mai napi három sikertelen javítás pontosan azért
bukott el, mert ebben a szerkezetben a „melyik beszélgetéshez tartozik ez az
írás" kérdésre nincs megbízható válasz.

**De: nem „szépítés" kell, hanem célzott szétbontás — és az azonos a bug
fixével.** A beszélgetésenkénti állapot-szétválasztás (A1 felszámolása) maga a
strukturális javítás első és legfontosabb lépése. Sorrendben:

1. **Beszélgetés-állapot modul**: a messages/workItems/plan/commentary egy
   beszélgetés-ID-vel kulcsolt tárba, a view csak kiválaszt belőle. (Ez a bug
   fixe is.)
2. **Írók szétválasztása**: submit → szinkron user-sor mentés; runtime → assistant
   sor; a save-hurok megszűnik igazságforrás lenni.
3. Csak ezután érdemes komponensekre bontani (sidebar, composer, run-panel,
   settings) — ez már mechanikus, kockázata kicsi.

Amihez **nem** éri meg nyúlni: a Rust modulok, a stílusréteg, és minden olyan
átnevezgetés, ami nem a fenti címzési modellt szolgálja. Big-bang átírás
tilos — a fenti sorrend lépésenként tesztelhető.

---

# Állapot — 2026-07-28, 1. lépés kész

**Új modul: `src/conversationState.ts`** (+ `tests/conversationState.test.ts`).
Ez a címzés egyetlen döntése:

| gazda | nézet | eredmény |
|---|---|---|
| nincs | bármi | **eldobás** (a régi default „mindenhol látszik" volt — B2) |
| X | X | tárba és nézetbe |
| X | Y | **csak tárba**, a képernyő meg sem mozdul |

Itt lakik a kulcs-normalizálás is, egyetlen példányban (A5); az `App.tsx`
`normalizedThreadStorageKey`-e mostantól erre mutat.

**Az `App.tsx`-ben:**

- `runOwnerConversationIdRef` — a futás gazdája; a `finally` a futás végén
  *nullázza*, és a gazdátlan írás ettől kezdve eldobás, nem broadcast (B2).
- `writeOwnedMessages` / `writeOwnedWorkItems` / `writeOwnedCommentary` /
  `updateOwnedPlanState` — minden futás-eredetű írás ezeken megy: a stream
  deltái, a `item/completed`, a `turn/completed`, a natív válasz, a hibaág, a
  stop, a lánc és az újrafuttatás is (A1, A2 fele).
- `runPlanRef` — a futás saját terve. Az `activePlanRef` azé, amit nézünk; a
  futás nem abból építi a következő lépését.
- `ownedMessages(ownerId)` — a futás a *saját* sorai közt keresi a válaszát,
  nem a képernyőn (ez volt a „nem találom, hát hozzáfűzöm" duplikátumforrás).
- A kérdés a küldéskor **szinkron write-through**-tal a tárba kerül, a
  beszélgetés kanonikus ID-jével együtt (A4). A korábbi, `agent_send` előtti
  ID-vetés megszűnt: egy helyen, egyszer dől el, ki a gazda.
- A `turn/completed` checkpoint és az `activeConversationId` sem az „épp látott
  beszélgetés"-re esik vissza többé (A5 miatt írásmód-toleráns kereséssel).

# 2. lépés — egy sor, egy azonosság (A2)

**Új modul: `src/deterministicId.ts`** (+ `tests/deterministicId.test.ts`):
szinkron SHA-1 → UUID v5, a Rust `stable_id`-jével azonos képlettel
(`uuid_v5(NAMESPACE_OID, "min:local:{kind}:{key}")`). A tesztek referencia-
vektorokkal ellenőrzik az egyezést (RFC-vektor + `uuid.uuid5` kimenetek).

A válasz-sor ID-je innentől nem random v4, hanem
`agentAnswerMessageId(beszélgetés, kérés)` — **pontosan az, amit a runtime is
ír**. Az élő buborék és a lemezre kerülő sor tehát ugyanaz a sor, az első
képkockától; nincs többé „két író, két ID, és a takarítás majd összefésüli".
(A v4/v5 kettősség volt a bizonyíték a szivárgásra — most nincs mit
kettőzni.) A regeneráció változatlanul az eredeti válasz ID-jét viszi tovább.

# 3. lépés — a mentés is azonosságra kérdez (A3 fele)

A debounce-olt SQLite snapshot eddig azt kérdezte, „melyik projekt/thread van
kiválasztva", és arra fésülte rá a nézet-állapotot. Ez a kérdés váltás közben
széttart a valósággal — az uniós merge pedig a tranziens keveredést véglegesen
lemezre írja. Mostantól a feltétel az, hogy *ennek* a beszélgetésnek a sorai
vannak-e a nézetben (`conversationKeysMatch(localKey, messageKeyRef.current)`),
írásmód-toleránsan. Ha nem, a snapshot a tár tartalmát írja ki — ami a címzett
írások miatt már úgyis a teljes igazság.

# 4. lépés — a navigáció feloldva futás közben

**Előfeltétel, ami eddig hiányzott:** a `selectThread` és a `selectProject`
betöltötte az új beszélgetést a nézetbe, de a négy `*KeyRef`-et nem állította
át — azokat csak egy renderrel később, a hidráló effekt. Pontosan ez a B1-es
TOCTOU: a kattintás utáni ablakban a nézet már a másik beszélgetést mutatta,
az óra viszont még a régit. Mindkettő mostantól a `resetConversationView`-n
megy keresztül (`openCodingConversation`): a nézet és az óra együtt mozdul.

**Feloldva:** `selectThread`, `selectProject`, `selectGeneralConversation`,
`selectAppMode`. **Zárolva marad** minden *módosítás* — átnevezés, törlés, új
beszélgetés/projekt —, mert az a futás alól húzná ki a talajt. A zárolás
szövege is ezt mondja már.

**A futás egy beszélgetésé a felületen is** (`viewingActiveRun`): a LÉPÉSEK
panel, az élő buborék, a work-log automatikus kinyitása és a „legaljára" gomb
csak a tulajdonos beszélgetésben jelenik meg. A küldés viszont mindenhol
zárolt marad, mert egyszerre egy futás van, és a stop is elérhető marad.

**`runProjectPathRef`**: a futás munkakönyvtára a saját projektjéé. Eddig a
fájlolvasás a *kiválasztott* projekt útját használta — futás közbeni
projektváltásnál a másik projektben kereste volna a futás fájljait.

# 5. lépés — a válasz gördülékeny kiírása

A modell szavankénti-mondatonkénti darabokban küld, és minden darab egy teljes
React-rendert kért az egész beszélgetésre: néhány szó, szünet, néhány szó. A
beérkező szöveg mostantól pufferbe megy, és képkockánként adagolódik ki belőle
a hátralék arányos része (`answerStreamRef` + rAF) — ha felgyűlik, gyorsabban
ürül, tehát nem marad le, és egy képkocka egy render, akárhány darab érkezett
közben. Ha nem látszik (háttérbeszélgetés, elrejtett ablak), a puffer egyben
ürül: ott az adagolás csak fölösleges rendert csinálna. Minden lezáró ág
(befejezett elem, `turn/completed`, natív válasz, hibaág, stop, lánc) előbb
kiüríti a puffert, csak utána írja a hiteles szöveget.

**Ez a darabolást szünteti meg, nem a render költségét** — az a 6. lépés.

# 6. lépés — memoizált üzenetsorok

A `MessageRow` `memo`-ba került. Streamelés közben az `appendCodexDelta` csak
az élő sor objektumát cseréli le (`messages.map` a többit változatlanul adja
vissza), tehát a memo pontosan a beszélgetés egészének újrarajzolását spórolja
meg minden képkockán — hosszú beszélgetésnél ez a domináns költség.

Ehhez kellett a `useStableCallback`: a memo csak akkor fog, ha *minden* prop
azonos marad, és a renderenként újragyártott `jumpToQuote` / `revertToMessage`
mindet elrontotta volna. A helper egy örökre azonos függvényt ad vissza, ami
mindig a legfrissebb testet hívja.

# 7. lépés — a zárolás a futó beszélgetésre szűkül, és látszik is, melyik az

A stream-zárolás eddig *mindent* tiltott: futás közben másik projektben sem
lehetett új beszélgetést létrehozni, pedig ahhoz a futásnak semmi köze. A
zárolás mostantól célzott:

| művelet | zárolva |
|---|---|
| új beszélgetés / projekt (bárhol) | **nem** |
| beszélgetés átnevezése, törlése | csak ha *az* fut (`blockRunOwnerMutation`) |
| projekt átnevezése, törlése | csak ha *benne* fut valami (`blockRunProjectMutation`) |
| projektgyökér cseréje | igen (az egész munkaterületet forgatja fel) |

Az átnevező párbeszédek a jóváhagyás pillanatában újra kérdeznek: a dialógus
nyitva maradhat addig, amíg egy futás elindul.

**A fában `ThinkingDots`**: annak a beszélgetésnek a sorában, amelyik épp
gondolkodik — a pont helyén, ugyanazzal a ritmussal, mint a válasz alatti
gépelésjelző. Összecsukott projekten a projekt sorában is megjelenik, hogy egy
háttérben futó válasz ne tűnjön el a szem elől. `prefers-reduced-motion`
mellett nem animál.

# 8. lépés — a válasz utáni „még dolgozik" idő

**Mit csinál a futás a válasz *után*?** `finalize_agent_snapshot_from_root`
újraolvassa és hasheli az egész munkaterületet (`collect_guard_files_for_manifest`,
max 10 000 fájl / 256 MB), majd a `copy_guard_files` **mindet** átmásolja a
snapshot `post-files` mappájába — a változatlanokat is. OneDrive-on ez a 10–20
másodperc, ami után a futás végre lezárul. A válasz szövege ekkor már rég kész.

Amit ez a lépés javít (a költséget nem, a viselkedést igen):

- **Az Enter nem vész el.** Futás közbeni küldés a szerkesztőben tartja a
  szöveget, és a futás végén magától elindul — ugyanazon az ajtón
  (`requestSubmit`), tehát a csatolmányok, idézetek és a mód is stimmel. Egy
  pill mutatja, hogy vár, és megszakítható. Új kört *indítani* továbbra sem
  lehet közben: a mentés alatt indított futás félig alkalmazott munkaterületről
  készítené a saját alapját.
- **A fa jelzése őszinte.** A `turn/completed` után a három lüktető pont
  helyére egy halk, lassú „mentés" jel kerül: a modell már nem gondolkodik.

# 9. lépés — a guard nem másolja többé a változatlan fájlokat

Egy turn eddig **háromszor** másolta végig a munkaterületet: a `finalize` a
teljes post-állapotot, a `stage` a teljes base-t vissza, az `apply` pedig a
teljes post-ot előre. Ebből a hasznos rész a megváltozott fájlok — jellemzően
néhány darab.

| hol | mostantól |
|---|---|
| `finalize_agent_snapshot_from_root` | csak a base-hez képest változott/új fájlok mennek a `post-files`-ba |
| `apply_agent_snapshot_at` | a munkaterületen már azonos tartalmú fájlt nem írja felül |
| `restore_guard_file_set` / rollback | ugyanígy: csak azt írja vissza, ami tényleg eltér |

Hogy ez ne csendes feltételezés legyen, a manifest **leírja, mi van a
lemezen**: az új `post_changed_paths` mező sorolja fel a ténylegesen lemásolt
útvonalakat. Ami nincs benne, annak a tartalma bitre azonos a base-fájllal — és
ezt nem hinni kell, hanem a manifestben ott a hash mindkettőre. `None` a régi
snapshotokat jelenti (minden fájl lemásolva); azok változatlanul működnek. Ha
egy fájl a lista szerint a `post-files`-ban van, de hiányzik, az továbbra is
hiba — a hiányzó másolatot nem pótoljuk csendben a base-szel.

A rebase teljes `post-files`-t ír, ezért ott a lista `None`-ra áll vissza:
különben a merge eredményét hagyná ki az olvasás.

A manifestek (`post_files`, hash-ek, report, diff) szemantikája **nem
változott** — csak az, hogy hány fájl kerül fizikailag másolásra. A záró
hash-ellenőrzések ugyanazok, tehát a fail-closed viselkedés is ugyanaz.

Tesztek: 165/165 zöld, köztük két új eset — a szűkített másolás
(`only_changed_files_reach_post_files_and_apply_still_lands`) és a régi
formátumú snapshot továbbélése
(`a_legacy_snapshot_with_every_file_copied_still_applies`).

Mérés (a felhasználó gépén, valós projekten): **~20 s → ~10 s**.

# 10. lépés — a maradék a várakozás, nem a számolás

A megmaradt ~10 másodperc szinte teljesen fájlolvasás + SHA-256. Egy
változásokat hozó turn ennyiszer fésüli át a munkaterületet: induláskor 1
(+ a base másolása), `finalize` 1, `stage` 2, `apply` 2, diff preview 1.
OneDrive-on ez latency-limitált — minden fájl megnyitása külön kör —, tehát a
nyerő nem a kevesebb ellenőrzés, hanem az átfedő várakozás.

`run_guard_file_jobs`: fájlonkénti munka szétosztva szálakra
(`available_parallelism * 2`, 4–16 között; 32 fájl alatt marad soros, mert
addig a szálindítás többe kerül). Ezen megy a hashelés
(`hash_guard_candidates`) és a snapshot-másolás (`copy_guard_files`) is.

Amit **nem** párhuzamosítottam: a könyvtárbejárást. A fájlszám- és
összméret-limit meg a symlink-tiltás sorrendfüggő, és ugyanazt az üzenetet
kell adniuk, mint eddig — ezért a bejárás egy szálon gyűjti a jelölteket
(`GuardCandidate`), és csak az olvasás fut szét. A hiba is az *első* elhasalt
fájlé, nem azé, amelyik szál előbb ért oda: ugyanarra a munkaterületre
ugyanaz az üzenet jön.

Egyetlen ellenőrzés sem tűnt el — ugyanazok a hash-ek, ugyanaz a rendezett
sorrend, ugyanaz a fail-closed viselkedés.

Tesztek: 166/166, köztük egy új eset, ami átviszi a párhuzamos küszöböt
(`a_workspace_past_the_parallel_threshold_hashes_deterministically`): 120
fájl három szinten, rendezett sorrend, tartalomhelyes hash, teljes base
másolat, és két egymás utáni pásztázás azonos eredménye.

**Amit itt nem érdemes tovább feszíteni:** a pásztázások *számát*. A `stage`
újraolvassa azt, amit a `finalize` már kiszámolt — de pont ez a független
ellenőrzés az, amiért a guard fail-closed. Ha a ~10 másodperc a párhuzamosítás
után is sok, a következő valódi kérdés a snapshot-gyökér szűkítése (mit
őrzünk egyáltalán), nem az ellenőrzések elhagyása.

---

**Folytatás:** a párhuzamos futások terve (több projekt egyszerre) külön
dokumentumban: [MULTI_PROJECT_PARALLEL_RUNS_PLAN.md](MULTI_PROJECT_PARALLEL_RUNS_PLAN.md).

**Ami még mindig újrarajzolódik:** a trace-kártyák (`TurnProgressCard`,
`CodeWorkCard`). A propjaik renderenként képzett tömbök
(`commentaryForWorkGroup(...)`, `activities`), tehát memo önmagában nem fogna
rajtuk — előbb a származtatott tömböket kellene `useMemo`-val csoportonként
stabilizálni. Ez a következő lépés, ha a hosszú, sok work-log-os
beszélgetésekben még mindig érezhető az akadás.

**Ami maradt:**

- A mentőhurok (`messages` → cache) továbbra is a nézet-állapotból dolgozik.
  Ez most már ártalmatlan — a nézetbe csak a saját beszélgetés sorai
  kerülhetnek —, de az invariánst a hívók tartják, nem a szerkezet. A teljes
  felszámolása a komponensbontással együtt esedékes.

Ellenőrzés: `tsc -b` tiszta, `npm run test:timeline` 48/48, `npm run build` zöld.
**Élő GUI-teszt nem futott** — ez a lépés az, ami kifejezetten kér egyet:

1. Indíts futást az „A" beszélgetésben, és még stream közben válts „B"-re.
   B-ben ne jelenjen meg semmi a futásból; A-ba visszatérve legyen ott a
   teljes válasz.
2. Ugyanez másik *projektbe* váltva, és GENERAL ↔ CODING váltással is.
3. Futás közben próbálj törölni/átnevezni: legyen zárolva, érthető üzenettel.
4. A futás végén, már B-ben állva: A-ban legyen meg a kérdés *és* a válasz,
   pontosan egy példányban — appot újraindítva is.
5. Futás közbeni projektváltás után a válaszban hivatkozott fájlok tartalma az
   *eredeti* projektből jöjjön.
