# MULTI-AI fázis-UI javítási terv (2026-07-27)

> **Státusz (2026-07-27 este): mind a hat pont javítva és élő GUI-futással
> igazolva.** Bizonyíték: `Screenshots/785–792`. Három egymás utáni lánc
> (invoiceAverage/Max/Min) zöld REVIEW-val zárult, a lemezen 55/55 teszt.
>
> **A 7. hiba is javítva (2026-07-27, `Screenshots/793`):** a lánc KÓD-fázisának
> LÉPÉSEK-sorai elvesztették a fájlnevet ("Edit"×3). Ok: a bridge minden
> tool-hívást **kétszer** jelentett — először a streamelt `content_block_start`
> ból, ahol a tool inputja még **üres** (innen a névtelen sor), majd a teljes
> assistant-üzenetből, fájlúttal. A második, dús példánynak a frontend
> `mergeCodeActivity`-jében kellett volna beolvadnia az elsőbe, és ez a merge
> vesztett a láncban. Javítás: a stream-eleji emit megszűnt, a kártya **egyszer**
> keletkezik, a teljes inputú assistant-üzenetből — így nincs mibe beolvadni.
> Eredmény a láncban: `Read — invoice.js`, `Read — math.test.js`,
> `Fájl — invoice.js`, `Fájl — math.test.js` ×2 (kész, diff-gombbal),
> `$ cd … && npm test`.

Élő GUI-tesztből (chain-test projekt, TERV→KÓD→REVIEW lánc, Screenshots/778–784)
hat hiba jött elő. Minden állításhoz bizonyíték: a `min.db` `work_items` /
`messages` táblái, a képernyőképek és a lemezen lévő fájlok.

## Hibák és gyökérok

### 1. FÁJLOK / VÁLTOZÁSOK kártya tool-neveket ír fájlnév helyett
**Tünet:** a KÓD fülön `Read MÓDOSÍTVA +138 −0`, `Edit MÓDOSÍTVA +291 −0`
(783.png). Az EGY AI ugyanitt helyes fájlneveket ír.
**Gyökérok (mért):** a `work_items`-ben a Claude-fázis minden sora
`item/tool/started`, `detail = "Edit"` / `"Read"` — nincs fájlút. A bridge a
`content_block_start`-nál emitál (`agent-bridge/main.mjs` ~457. sor), amikor a
tool `input`-ja még üres (az input `input_json_delta`-ként streamel), így a
`filePath` mindig `undefined`, a frontend `detail`-je a tool nevére esik vissza
(`App.tsx` ~3333), és a `changeSummaryFromActivities` ezt hiszi útvonalnak, a
tool *kimenetét* pedig diffnek (+138 = a Read outputjának sorszáma).
**Javítás:**
- bridge: a teljes (nem streamelt) assistant üzenetből — ahol az input már
  teljes — újra kiküldeni a tool-itemet ugyanazzal az `itemId`-vel, `filePath`
  + before/after tartalommal, és `item/completed` státusszal;
- frontend: a change-összegző ne fogadjon el útvonalként olyan `detail`-t, ami
  egy ismert tool-név, és tool-outputot ne számoljon hozzáadott sornak.

### 2. A lánc kódolójának változásai nem érnek lemezre
**Tünet:** a kódoló „45/45 teszt zöld"-et jelent, a review lefuttatja és látja
is a 45 tesztet — de a futás után a `chain-test` projektben nincs
`formatAmount`, a fájlok mtime-ja a *korábbi* EGY AI futásé (19:29), és
`node --test` → 32 teszt. Tehát futás közben a fájlok léteztek, utána
eltűntek/visszaálltak.
**Gyanú (ellenőrizendő):** a snapshot-guard / discard útvonal (`codex.rs`
`rollback_agent_snapshot` / `discard_agent_snapshot`), ami a lánc lezárásakor —
pl. a soha el nem indult placeholder-kérés takarításakor — visszaállítja a
kódoló snapshotját. Első lépés: megkeresni, ki hívja a rollbackot a pipeline
lezárása után, és a bridge/std log alapján igazolni.
**Javítás:** a sikeresen lezárt lánc kódoló-fázisának változásai maradjanak a
lemezen; rollback csak kifejezett user-kérésre (Visszavonás gomb) vagy hibára.

### 3. Szövegragadás és commentary-duplázás
**Tünet:** `„…lefuttatom a teszteket;fájlt nem módosítok.A 45 teszt…"`,
`„…clampAmount tests.32/32 teszt zöld."` — a commentary és a válasz elválasztó
nélkül összeér; ugyanaz a mondat a GONDOLKODÁS MENETE bulletben is megjelenik.
**Gyökérok-gyanú:** különböző szövegblokkok (commentary + végső válasz)
ugyanabba a message-be fűződnek `\n\n` nélkül (compact/append útvonal), és a
commentary egyszerre kerül a válaszba és a reasoning-listába.
**Javítás:** blokkhatáron `\n\n` beszúrása, ha az előző nem whitespace-re
végződik; a commentary vagy a válaszba megy, vagy a gondolkodás-listába —
egyszerre a kettőbe nem.

### 4. Minden fázis 0. lépése „Terv előkészítése és feladatértelmezése"
**Tünet:** a REVIEW fázis LÉPÉSEK-ében is ez a címke fut (782.png).
**Javítás:** a 0. lépés címkéje a fázis szerepéből jöjjön (terv/kódolás/bírálat
előkészítése), vagy legyen semleges („A feladat értelmezése").

### 5. EGY AI: a kész válasz duplán jelenik meg
**Tünet:** a settled VÁLASZ panel *és* egy csupasz buborék ugyanazzal a
szöveggel, amíg új turn nem indul (778.png).
**Gyökérok-gyanú:** a turn lezárásakor az élő buborék nem kerül ki a
state-ből, mert a turn-azonosítója nem egyezik a store-ból visszajövő sorral
(a pipeline-hoz bevezetett `request:` turn-id-séma mellékhatása az egy-AI
útvonalon).
**Javítás:** lezáráskor az élő buborék cseréje a tárolt sorra, egy-AI módban is.

### 6. LÉPÉSEK: TERV-ben üres, KÓD-ban gyér
**Mérés:** stage-0 (TERV): 0 work item — a tervező kapott olvasó eszközöket,
de egyet sem hívott (a kontextusban már ott volt minden fájl), a terv maga a
VÁLASZ fülön van. Stage-1 (KÓD): 8 item, mind `started`, csak tool-név.
A Claude-fázisok reasoningje 0 db — a Codex review-é 3 db.
**Verdikt: van baj, három rétegben:**
- a bridge nem továbbítja a Claude thinking-blokkokat reasoning work itemként;
- a tool-itemek soha nem kapnak `done` státuszt / fájlutat / eredményt (1. hiba
  rokonsága) — ettől „gyér" a KÓD lépéslista;
- a 0 itemes fázis üres kétpaneles vázat mutat pörgő kamu-lépéssel — legyen
  helyette őszinte állapot („Ez a fázis csak szöveget írt, eszközt nem
  használt"), a kamu 0. lépés ne pörögjön.

## Megvalósult javítások (commit-kész állapot)

1. **Lánc-változások lemezre kerülnek:** `pipeline_send` a staged guard
   reportot visszaadja (`PipelineRunResult.guard`), a frontend
   `settleChainGuard`-ja appli­kálja (auto-apply + Visszavonás), és a
   fájl-összegzőt a KÓD-fázis üzenetére teszi (perzisztál). Igazolva:
   `formatAmount`/`invoiceLineCount` a lemezen, 45/48 teszt zöld valós
   futtatásban.
2. **Bridge esemény-dúsítás:** tool-hívás teljes inputtal (`fileChange`
   started/completed, fájlút projekt-relatívan, before/after), tool_result →
   `completed` státusz, thinking → durable `reasoning` work item. A commentary
   (tool-ok közti narráció) a gondolkodás-sávra kerül, a válasz a lezáró
   assistant-üzenet szövege — a "tests.32/32" jellegű ragadás megszűnt.
3. **Codex-oldali ragadás:** `codex.rs` final_text item-határon `\n\n`-t szúr
   be, és a completed-item nem írja felül a hosszabb akkumulált szöveget.
   Claude-oldalon a runner a bridge tiszta finalText-jét fogadja el ("longer
   wins" eltávolítva).
4. **Fázisfüggő 0. lépés:** `prePlanStepLabel` — terv/kódolás/bírálat
   előkészítése, mindhárom keletkezési ponton + a kártya `stageRole` propján.
5. **EGY AI dupla válasz:** az `item/completed` (final_answer) most feltétel
   nélkül cseréli az élő buborék szövegét; a futás után egyetlen panel marad.
6. **LÉPÉSEK:** tool-hívások bulletként a gondolkodás-listában
   (`Fájl — invoice.js`, `$ node --test ...`, </> diff-gombbal); a 0 aktivitású
   fázis őszinte egysoros jelzést kap; a lánc-fülek kamu fájlkártyája
   (tool-nevek / abszolút utak) letiltva — kártya csak a chain guardból.

Tesztek: 156/156 Rust, 26/26 bridge, `npm.cmd run build` zöld.
Diagnosztika (env-gated, bennmaradt): `MIN_AGENT_BRIDGE_LOG` (bridge emit),
`MIN_AGENT_EVENT_LOG` (Rust határ).

## Sorrend

1. **#2** (adatvesztés — a legsúlyosabb): nyomozás + javítás + Rust-teszt.
2. **#1 + #6 bridge-oldal** (ugyanaz a tő): tool-item teljes inputtal,
   `done` státusz, thinking→reasoning; frontend change-összegző védelem.
3. **#3** szövegragadás + duplázás.
4. **#4** fázisfüggő 0. lépés címke.
5. **#5** EGY AI dupla válasz.
6. **#6 frontend-oldal**: üres fázis őszinte megjelenítése.

## Ellenőrzés

- `npm.cmd run build` + `cargo test --no-default-features` (50+ teszt) zöld.
- Bridge-tesztek: `npm.cmd run test:claude-bridge`.
- Élő GUI-iteráció a chain-test projekten, amíg minden jó:
  1. MULTI-AI lánc (opus/opus/sol, low/low/low): fájlkártyán valódi útvonalak;
     a futás után a `formatAmount` tényleg a lemezen van és `node --test` zöld;
  2. TERV LÉPÉSEK: vagy valódi lépések, vagy őszinte „nem használt eszközt"
     állapot; KÓD LÉPÉSEK: fájlutak + kész státuszok + gondolkodás;
  3. nincs szövegragadás, nincs commentary-duplázás;
  4. fázisonként helyes 0. lépés címke;
  5. EGY AI futás: egyetlen válaszpanel a lezárás után is.
- Minden állapotról screenshot a `Screenshots/` mappába (785-től).
