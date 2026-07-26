# Cross-device sync hibavadászat — 2026-07-26

Kódolvasás: `sync.rs` (8395 sor, teljes), `store.rs` (perzisztencia-utak), `codex.rs` (rehidratáció, v1 state), `claude.rs` + `agent-bridge/main.mjs` (session lánc), `App.tsx` (pull/publish kadencia, cache-ek). Journal-forenzika: mind a 46 783 event beolvasva, számok lent. **Kód nem változott** — ez csak leltár a holnapi javításhoz.

## A journal jelenlegi állapota (bizonyíték-alap)

| Event típus | Darab | Méret |
|---|---|---|
| agent_session.entry_append | **29 813** | 74,2 MB |
| work_item.upsert | 7 329 | 8,1 MB |
| conversation.upsert | 4 738 | **98,2 MB** |
| agent_session.upsert | 3 383 | 3,8 MB |
| message.upsert | 1 375 | 10,8 MB |
| tombstone/restore/project | 145 | 0,1 MB |

Napi növekedés: júl. 24: 4 756 · **júl. 25: 25 792** · júl. 26 (fél nap): 2 977. A journal ~80%-a visszhang, nem adat.

---

## P0 — Aktív vagy azonnal ható hibák

> **Státusz: mind a három javítva** (2026-07-26). Mérés a javítás után, éles adaton:
> egymás utáni publish-ek `45 → 0 → 0` eventet írnak (előtte `45 → 45 → 45`, a
> bejegyzéseknél ezrek); két valódi turn összesen 27 eventet szül, mind új adat.
> A reducer-teszt javítás nélkül `["VALASZ_2"]`-t ad három válasz helyett.

### 1. Az agent-session entry echo-vihar (a journal-hízás fő oka) — JAVÍTVA

**Tünet:** egyetlen változatlan session-bejegyzés **122-szer** szerepel a journalban, 122 különböző payload-hash-sel (`agent-entry:31cf7404…`). Emiatt volt a másik gépen az „1,5 órája tölt le kb-os fájlokat".

**Gyökérok — önmagát gerjesztő hurok:**
1. Az export minden entry payloadba beágyazza a **teljes session objektumot** a mutálódó mezőkkel együtt (`hlc`, `updatedAt`, `originDeviceId`, `headTurnId`): [store.rs:2822-2834](src-tauri/src/store.rs#L2822-L2834) és [store.rs:2874-2882](src-tauri/src/store.rs#L2874-L2882).
2. A publish után a gép a **saját eventjét visszaimportálja**, és az import a session sor `hlc`/`origin_device_id` mezőit az event értékeire állítja: [store.rs:2951-2961](src-tauri/src/store.rs#L2951-L2961).
3. A következő publish exportja már az **új** hlc-t ágyazza minden entry payloadba → minden hash más → a dedup ([sync.rs:4949-4965](src-tauri/src/sync.rs#L4949-L4965)) átengedi → **minden entry újra kiíródik**. Goto 2.

**Hatás:** minden publish O(összes valaha volt session-entry) új fájlt ír a OneDrive-ra. Nem adatvesztés, de ez öli meg a sync sebességét és a OneDrive-ot.

**Javítás-vázlat:** az entry payloadba csak stabil session-stub kerüljön (`id`, `conversationId`, `projectKey`, `provider`, `providerSessionId`, `createdAt` — mutálódó mező semmi); a validátor ([sync.rs:1796-1811](src-tauri/src/sync.rs#L1796-L1811)) csak `session.id`-t követel, tehát visszafelé kompatibilis. Teszt: két publish egymás után → a második 0 entry-eventet ír.

### 2. A reducer ma is összeolvasztja a különböző turnök válaszait — JAVÍTVA

**Tünet-osztály:** pontosan az, amit ma javítottunk — csak a lánc **harmadik** rétegében még él.

**Gyökérok:** `existing_message_alias_id` a `same_item` ágon **turn-szűrés nélkül** párosít: [sync.rs:2967-2968](src-tauri/src/sync.rs#L2967-L2968), használat: [sync.rs:3256-3259](src-tauri/src/sync.rs#L3256-L3259). A journalban bizonyítottan ott vannak az ütköző cimkék:

```
f04ddfa7 (claude-fixture): 23 különböző turn, mind item=assistant-0
f5eba073: 19 turn · 9e324674 (Work 3): 12 turn · 1c2a0841: 2 turn
```

Amikor a reducer fut (azaz amikor **új remote event érkezik** — pont a cross-device eset), ezek a válaszok egyetlen üzenetté olvadnak a snapshotban.

**Miért nem látszik ma:** két maszk takarja. (a) Ha nincs új import, a pull a materializált SQLite-ot adja vissza, reducer nem fut ([sync.rs:5044-5049](src-tauri/src/sync.rs#L5044-L5049)). (b) Ha fut, a válasz-checkpoint (mindkét gép fájlja, id-nként) visszarakja az összeolvasztott válaszokat. **De:** a checkpoint 512 válasznál levág ([sync.rs:885-887](src-tauri/src/sync.rs#L885-L887)), GENERAL scope-ra **egyáltalán nem készül** ([sync.rs:804](src-tauri/src/sync.rs#L804)), és „redundáns recovery"-nek van deklarálva, nem igazságforrásnak. Amint bármelyik maszk kiesik, a mai adatvesztés-tünet visszatér a másik gépen.

**Javítás-vázlat:** a `same_item` ág csak `same_turn`-nel együtt érvényes (ugyanaz a szabály, mint ma a store/frontend oldalon); teszt: két turn, mindkettő `assistant-0`, reducer után 2 üzenet marad.

### 3. „A hosszabb szöveg nyer" még két rétegben él — JAVÍTVA

Ma az SQLite upsertben lecseréltük (újabb óra nyer). De:
- **Reducer + checkpoint-merge:** `merge_message_versions` settled válasznál is a hosszabbat tartja: [sync.rs:2898-2907](src-tauri/src/sync.rs#L2898-L2907) — ez fut a reducer üzenet-ágán ([sync.rs:3289-3291](src-tauri/src/sync.rs#L3289-L3291)) és a checkpoint-írásnál is ([sync.rs:916](src-tauri/src/sync.rs#L916)), tehát egy romlott hosszú törzs a **snapshot-rétegben** örökre nyer, hiába gyógyult az SQLite.
- **Mentés-előtti coalesce:** `merge_snapshot_message_versions` ugyanez: [store.rs:3409-3414](src-tauri/src/store.rs#L3409-L3414) — a romlott cache-példány már a memóriában legyőzi a helyeset, mielőtt az új SQL-szabály szóhoz jutna.

**Javítás-vázlat:** settled+settled esetben rank/HLC döntsön (a reducerben ott a rank), a hossz-heurisztika csak live/csonka sorokra maradjon. Teszt: rövid helyes + hosszú ragasztott settled → a helyes marad.

---

## P1 — Súlyos, de körülhatárolt hibák

### 4. conversation.upsert = 98 MB (az összméret fele)

Minden beszélgetés-upsert a **teljes** `plan_history` + `commentary` tömböt viszi ([sync.rs:4758-4777](src-tauri/src/sync.rs#L4758-L4777)), és mivel az `updated_at` minden aktivitásnál változik, minden mentés új eventet szül: a „Work" beszélgetés **2 113** upsertet írt (≤37 tervkulccsal darabonként). Ez a 98 MB akkor is újra letöltődik a másik gépen, ha csak egy cím változott.

**Javítás-vázlat:** a plan_history/commentary külön, kulcsonkénti eventekbe (`plan.upsert entity=conv:planKey`), vagy publish előtt tartalom-diff az utolsó kiírt payloaddal (updated_at nélkül hasonlítva). A reducer plan-uniója már ma is kulcsonként merge-öl ([sync.rs:3190-3193](src-tauri/src/sync.rs#L3190-L3193)), tehát a fogadó oldal kész rá.

### 5. Cím-kulcsú snapshot-térképek: azonos című beszélgetések kitakarása + szellem-beszélgetések

- A reducer kimenete `"{project}::{title}"`, GENERAL-nál `"GENERAL::{title}"` kulcsú map ([sync.rs:3527-3528](src-tauri/src/sync.rs#L3527-L3528), [sync.rs:3574-3575](src-tauri/src/sync.rs#L3574-L3575)) — **két azonos című beszélgetésből az egyik némán eltűnik** a snapshotból. A store-load viszont GENERAL-nál `general::{id}`-t használ ([store.rs:3789-3793](src-tauri/src/store.rs#L3789-L3793)) — inkonzisztens kulcsolás ugyanarra az adatra. Két gépen offline egyszerre nyitott „Új beszélgetés" pontosan ezt az ütközést gyártja.
- A mentés a `project.threads` címlistából **üres beszélgetést kreál** minden olyan címre, amihez nincs conversation ([store.rs:4107-4134](src-tauri/src/store.rs#L4107-L4134)) — a threads-unió ([sync.rs:3401-3411](src-tauri/src/sync.rs#L3401-L3411)) miatt átnevezés/verseny után árva címek maradhatnak → **szellem „Új beszélgetés"-ök** (a DB-ben ma is több üres ilyen sor van).
- Ugyanott: ha egy UUID két cím-slotban tűnik fel, a második **új, cím-alapú id-t kap** ([store.rs:4175-4192](src-tauri/src/store.rs#L4175-L4192)) — identitás-forkolás rename-verseny esetén.

**Javítás-vázlat:** a snapshot-térkép kulcsa mindenhol az **id** legyen (a cím csak megjelenítés); a threads lista származtatott adat, ne legyen beszélgetés-teremtő.

### 6. HLC óra-fúzió hiánya: a lassabb órájú gép szisztematikusan veszít

Az append csak a **saját** utolsó HLC-jéből lép tovább ([sync.rs:4928-4947](src-tauri/src/sync.rs#L4928-L4947), `next_hlc` [sync.rs:1672-1684](src-tauri/src/sync.rs#L1672-L1684)); a fogadott remote HLC-k sosem emelik a helyi órát (Lamport-merge hiányzik; a `devices.last_hlc` meglévő sorra sosem frissül: `INSERT OR IGNORE`, [sync.rs:2472-2477](src-tauri/src/sync.rs#L2472-L2477)). Ha a két gép órája között eltérés van, az elmaradt órájú gép **friss** szerkesztései (átnevezés, terv-állapot, conversation-meta) rank szerint veszítenek a másik gép **régebbi** eventjeivel szemben — „az átnevezésem visszaugrik" típusú hibák.

**Javítás-vázlat:** import után `last_hlc = max(saját, látott remote)`; appendnél ebből lépni.

---

## P2 — Latens hibák, élő kockázattal

7. **Checkpoint user-párosítás:** ha nincs turn-egyezés, „az utolsó user előtte" heurisztika párosít ([sync.rs:849-855](src-tauri/src/sync.rs#L849-L855)) — rossz kérdés-válasz pár kerülhet a checkpointba (a kód kommentje maga is elismeri). A 512-es sapka + GENERAL-kihagyás fent (P0/2).
8. **Pull-rövidzár:** ha egy korábbi import után a materializálás elmaradt (crash a kettő között), a további pullok `imported==0` miatt soha nem futtatják a reducert ([sync.rs:5044-5049](src-tauri/src/sync.rs#L5044-L5049)) — a sync_events-ben ülő adat láthatatlan a következő valódi remote eventig.
9. **Globális írás-blokk:** bármely idegen eszköz egyetlen hibás fájlja minden gép **írását** letiltja ([sync.rs:4894-4900](src-tauri/src/sync.rs#L4894-L4900), `can_write` [sync.rs:2574](src-tauri/src/sync.rs#L2574)) — biztonságos, de egy OneDrive-félrészinkron az egész rendszert quarantine-ba teszi (már megtörtént veletek).
10. **Üres `archived_at` tombstone:** publishkor `now_text()`-et kap ([sync.rs:3836-3840](src-tauri/src/sync.rs#L3836-L3840)) → ha valaha üresen kerül snapshotba, minden publish új eventet gyárt belőle. Ma nincs ilyen sor, de nincs is védelem.
11. **`\\?\` prefix inkonzisztencia:** a store-oldali `project_path_key` levágja ([store.rs:3530-3536](src-tauri/src/store.rs#L3530-L3536)), a sync-oldali `sync_path_key` **nem** ([sync.rs:4660-4665](src-tauri/src/sync.rs#L4660-L4665)) → projekt-tombstone path-egyezés kétféleképp viselkedik a két rétegben.

## P3 — Élek, törékenységek

12. **Bridge itemId-k továbbra is pozicionálisak** (`assistant-${index}`, [main.mjs:386](agent-bridge/main.mjs#L386)), a végső válasz külön `assistant-final` id-t és `turnId: turn.sessionId`-t kap ([main.mjs:656](agent-bridge/main.mjs#L656)) — a turn-scope ma véd, de az id-rendszer törékeny; per-üzenet UUID a bridge-ben végleg lezárná ezt az osztályt.
13. **Work-item fallback-identitás** `id:time:index`-ből ([sync.rs:3728-3741](src-tauri/src/sync.rs#L3728-L3741)) — item_id nélküli soroknál gépenként eltérő identitás → duplikált LÉPÉSEK lehetségesek (Codex `call_*`/Claude `toolu_*` id-s sorok rendben vannak).
14. **`collapse_repeated_assistant_text`** a valóban kétszer ismételt szöveget is felezi ([store.rs:3344-3365](src-tauri/src/store.rs#L3344-L3365)) — tudatos trade-off, de dokumentálatlan adatmódosítás.
15. **v1 state.json még él** a v2 mellett (`sync_save`/`sync_load`, [codex.rs:3753-3766](src-tauri/src/codex.rs#L3753-L3766)) — kettős perzisztencia; ellenőrizni, mi hívja még, és kivezetni.
16. **N+1 lekérdezés** az `export_agent_session_events`-ben (prepare a session-cikluson belül, [store.rs:2848-2855](src-tauri/src/store.rs#L2848-L2855)).

---

## Codex-specifikus megállapítások

- **Thread-folytatás másik gépen:** a rollout-id szándékosan nem syncel ([sync.rs:4763-4766](src-tauri/src/sync.rs#L4763-L4766)); hiányzó rolloutnál `thread/start` + max 24k karakter kontextus-újrainjektálás ([codex.rs:2832-2884](src-tauri/src/codex.rs#L2832-L2884)). Működik, de a rehidratált szál „önéletrajzból dolgozik" — hosszú beszélgetésnél csendben butul. Javaslat: UI-jelzés, hogy a szál rehidratált.
- A `min-local-thread-ids` kulcsa `${project.path}/${title}` — másik gépről érkező átnevezés után a helyi kulcs árván marad, a következő turn új threadet indít (rehidratációval). Kicsi, de valós.
- A rollout-recovery ([codex.rs:344-379](src-tauri/src/codex.rs#L344-L379)) csak helyi rollout-fájlokból gyógyít — a másik gépen keletkezett turnökre nem tud (by design, csak tudni kell róla).

## Claude-specifikus megállapítások

- A SessionStore→SQLite→journal lánc **jó terv** (a transcript tényleg géptől független), de a fölötte lévő export a P0/1 echo-vihar forrása.
- Fork-fallback (`shouldStartFreshSession`, [main.mjs:617-637](agent-bridge/main.mjs#L617-L637)): ha a resume nem megy, **némán** új sessiont nyit — a „Claude session fork" sor ma is látszott a fixture beszélgetésben. Kell UI-jelzés + ok-napló, különben észrevétlen kontextusvesztés.
- Az `agent_session.upsert` LWW-je rendben (hlc-guard, [store.rs:2951-2961](src-tauri/src/store.rs#L2951-L2961)).

---

## Fejlesztési javaslatok (nem hiba, hanem adósság)

1. **Dirty-set publish** a teljes-snapshot-újraküldés helyett: a publish ma O(teljes állapot), csak a hash-dedup menti meg — az menti meg, amíg a payload determinisztikus (lásd P0/1, ahol nem az).
2. **Egy igazságforrás-elv:** a mai hiba négy rejtekhelyen bujkált (SQLite, journal, checkpoint, frontend-cache). Cél: SQLite = igazság, journal = szállítás; a checkpoint a reducer-fix után **kivezethető**; a Tauri-profil localStorage-tükrei (`min-message-history` stb.) szintén.
3. **Journal-tömörítés lefuttatása:** a protokoll (ack → backup → purge, [sync.rs:5290-5334](src-tauri/src/sync.rs#L5290-L5334)) kész és kapuzott; a 46k fájl pár százra esne, a másik gép first-sync-je másodpercekre. Az echo-fix UTÁN érdemes, különben visszahízik.
4. **Fájl-granularitás:** 1 event = 1 OneDrive-fájl → napi 25k fájl. Hosszabb távon napi/szegmensenkénti JSONL-append eszközönként (a hash-lánc ugyanúgy működik soronként).
5. **Blokkolás-granularitás:** idegen eszköz hibája ne tiltsa a saját appendet (per-device karantén, saját lánc írható marad).
6. **Óradrift-őr:** ha a helyi óra és a journal legnagyobb HLC-je között nagy az eltérés, figyelmeztetés a UI-n (a P1/6 fúzióval együtt).

## Sorrend

1. ~~**Echo-vihar leállítása** (P0/1)~~ — kész.
2. ~~**Reducer item-alias turn-scope** + **longest-wins csere** (P0/2, P0/3)~~ — kész.
3. **Compaction/prune** mindkét gépen (Fejlesztés/3) — a ~39k fájl eltüntetése. Most már biztonságos: az echo-forrás elapadt, nem hízik vissza.
4. conversation.upsert karcsúsítás (P1/4).
5. Cím-kulcs → id-kulcs rendezés + szellem-beszélgetés fix (P1/5).
6. HLC-fúzió (P1/6), majd a P2/P3 lista.
