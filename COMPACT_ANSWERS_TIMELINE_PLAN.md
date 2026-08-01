# Nem-Részletes VÁLASZOK idővonal — implementációs terv

*2026-08-01 · csak terv, ebben a körben nincs implementáció*

## Utólagos vizuális korrekció

Az implementáció kipróbálása után kiderült, hogy a felhasználói szempontból
értelmezett kimenet mindig egyetlen kanonikus válasz. Ezért az alábbi döntések
felülírják a dokumentum többválaszos lista- és kijelölési részeit:

- a fejléc **VÁLASZ**, nem **VÁLASZOK**;
- nincs „1 válasz” számláló és nincs „1.” sorszámgutter;
- a bal panel mindig a kanonikus teljes assistant választ mutatja;
- a köztes `assistant-output` elemek a jobb oldali gondolkodási idővonal
  narrációi, nem külön válaszkártyák;
- az élő állapot ugyanebben az egy válaszhelyben alakul kész válasszá;
- a fenced kódblokkok fejlécében külön, ikon-alapú másolás van, amely pontosan
  a nyers kódot teszi a vágólapra és siker után röviden pipára vált.

A provider-itemes timeline helper megmarad normalizáló és regressziós
segédnek, de a compact React-nézet csak a legutolsó/kanonikus blokkot vetíti
ki. Így a történeti provider-adatok kompatibilisek maradnak, miközben a GUI
nem állítja azt, hogy egyetlen modellfutás több felhasználói választ adott.

## Döntés

A Nem-Részletes nézet ne a Részletes panel összecsukott változata legyen.
Kapjon saját, egyszerű időrendi felületet:

- a fejléc egyetlen címe **VÁLASZOK**;
- nincs **VÁLASZ / LÉPÉSEK** slider;
- bal oldalon, a mai LÉPÉSEK oszlophoz hasonló fix szélességű listában
  egymás alatt jelennek meg a modell tényleges válaszblokkjai;
- egy válaszblokk tetszőlegesen több soros lehet, ezért a hozzá tartozó
  sub-panel lefelé nő, nem vágjuk egy sorra és nem daraboljuk bekezdésenként;
- jobb oldalon megmarad a **GONDOLKODÁS MENETE** panel, de mindig a bal oldalon
  kiválasztott válaszblokkot közvetlenül megelőző gondolkodási és
  műveleti eseményeket mutatja.

Ez a modell azt ábrázolja, ahogy a futás valóban történik:

```text
gondolkodás / tool események ──► 1. válaszblokk
gondolkodás / tool események ──► 2. válaszblokk
gondolkodás / tool események ──► végső válaszblokk
```

Nem cél a rejtett chain-of-thought nyers megjelenítése. A panel kizárólag a
providertől már ma is megkapott, felhasználónak megjeleníthető reasoning
summaryt, státuszt és tool-aktivitást használja.

## Mit jelent egy „VÁLASZ”

Egy listaelem egy valódi provider-oldali assistant output item, nem egy sor és
nem egy Markdown-bekezdés.

- Az azonos `itemId`-hez tartozó stream-delták egy blokkba fűződnek.
- Egy több bekezdéses, listákat és kódblokkokat tartalmazó válasz egyetlen,
  teljes szélességében tördelődő sub-panel marad.
- Két külön assistant item két külön listaelem.
- A `final_answer` külön válaszblokk, ugyanebben a listában.
- Ha a provider csak `turn/completed.finalText` formában adja át a teljes
  választ, egyetlen végső blokk készül belőle.
- Régi, item-határok nélkül tárolt beszélgetésből nem találunk ki mesterséges
  darabolást: az egész korábbi válasz egy blokk lesz.

Ez megakadályozza, hogy egy tipikus hosszú GPT-válasz húsz apró kártyára essen
szét csak azért, mert sok bekezdése van.

## Időbeli összerendelés

Minden eseménynek már most van futás-, turn- és időrendi azonossága
(`requestId`, `turnId`, `itemId`, `sequence`). A nézet ezekből készít vetületet.

Az `i`-edik válaszblokkhoz azok a trace-elemek tartoznak, amelyek:

1. ugyanahhoz a futáshoz/turnhöz tartoznak;
2. az előző válaszblokk határa után keletkeztek;
3. az aktuális válaszblokk első deltája előtt vagy azzal azonos időrendi
   ponton érkeztek.

Formálisan:

```text
thoughts(answer[i]) = trace(previousAnswer.sequence, answer[i].sequence]
```

Az első válaszblokk a turn kezdetétől kapja az előzményét. A végső válasz az
utolsó köztes válasz utáni gondolkodást kapja. Ugyanaz a trace-elem soha nem
kerülhet két válasz mellé.

### Élő, még válasz nélküli szakasz

Ha már érkezik gondolkodás vagy tool-aktivitás, de a következő assistant item
még nem kezdődött el, a bal lista alján megjelenik egy ideiglenes sor:

**„Következő válasz készül…”**

Ehhez tartozik a jobb oldalon az éppen gyűlő gondolkodás. Amikor megérkezik az
assistant item első deltája, ugyanaz a sor alakul át valódi válaszblokká; nem
ugrik a panel és nem keletkezik új, duplikált sor.

## GUI

### Felső sáv

- Balra: **VÁLASZOK**.
- Mellette: `készül` / `kész` és a futás ideje.
- Jobbra változatlanul megmaradnak a teljes válaszra vonatkozó műveletek:
  Másolás, Újragenerálás, illetve ahol releváns, rollback.
- A mai VÁLASZ/LÉPÉSEK slider teljesen eltűnik compact módban.

### Bal oszlop — VÁLASZOK

- A mai LÉPÉSEK oszlop szélességét és reszponzív szabályait használja;
  desktopon fix, a jobb panel tölti ki a maradék helyet.
- A blokkok egymás alatt helyezkednek el és tartalom szerint nőnek lefelé.
- Sorszám és rövid állapotjel kerül rájuk, de nem generálunk mesterséges címet.
- A teljes Markdown-tartalom olvasható: több bekezdés, lista, képlet,
  inline/code block és link.
- A kiválasztott blokk a mai aktív LÉPÉS vizuális nyelvét használja.
- Élő blokknál megtartható a forgó aktív keret; lezárt blokknál stabil keret.
- Futás közben alapértelmezetten a legújabb blokkot követi. Ha a felhasználó
  régebbire kattint, a nézet nem rántja vissza addig, amíg új válaszblokk nem
  kezdődik; ekkor ismét felajánlható/aktiválható az automatikus követés.

### Jobb oszlop — GONDOLKODÁS MENETE

- A cím változatlan: **GONDOLKODÁS MENETE**.
- Nincs RAW/DETAIL vagy VÁLASZ/LÉPÉSEK váltó.
- Csak a kiválasztott válaszblokkhoz tartozó időablak eseményeit mutatja.
- Az események a mai részletes nézet komponenseit használják: reasoning
  summary, státusz, parancs, tool, fájlművelet.
- Üres előzménynél világos placeholder jelenik meg:
  **„Ehhez a válaszhoz nem érkezett külön gondolkodási összefoglaló.”**
- A nyers belső chain-of-thought nem jelenik meg és nem kerül perzisztálásra.

### Keskeny ablak

- A két oszlop egymás alá törik.
- Elöl marad a VÁLASZOK lista, alatta a kiválasztott blokk GONDOLKODÁS MENETE.
- A válaszblokkokon belül nincs vízszintes scroll, kivéve a valódi kódblokkot.

## Adatmodell és normalizálás

### Új frontend-vetület

Új, tiszta helper készüljön például
`src/compactAnswerTimeline.ts` fájlban:

```ts
type CompactAnswerBlock = {
  id: string;
  requestId?: string;
  turnId?: string;
  itemId?: string;
  sequenceStart: number;
  sequenceEnd: number;
  text: string;
  final: boolean;
  live: boolean;
  pending: boolean;
  trace: CompactTraceItem[];
};
```

A helper bemenete a futás assistant message-e, commentary-je és work itemje;
kimenete determinisztikus, renderelhető blokksor. A React komponens ne maga
próbálja eseményenként kitalálni a határokat.

### Eseményosztályozás

A jelenlegi `CommentaryEntry` kapjon opcionális, visszafelé kompatibilis
forrásjelölést, például:

```ts
channel?: "assistant-output" | "reasoning-summary" | "status";
```

- `assistant-output`: bal oldali VÁLASZOK blokk alapanyaga;
- `reasoning-summary` és `status`: jobb oldali trace;
- tool/file/command továbbra is `CodeActivity`, szintén a jobb oldalra kerül.

A provider adaptereknél kell normalizálni, nem a renderben szövegmintákból.
Régi adatoknál konzervatív fallback használható; bizonytalan elem inkább a
GONDOLKODÁS MENETE panelre kerüljön, mint hogy duplikált válasz legyen.

### Perzisztencia

- A `commentary` ma JSON-ként, sémafüggetlen `Value` tömbben utazik a Rust
  store-on és a syncen keresztül, ezért az opcionális `channel` mezőhöz nem
  kell SQLite-migráció.
- A végső assistant message formátuma nem változik.
- A compact blokkok származtatott nézeti adatok; külön nem mentjük őket.
- Újraindítás és másik gépes sync után ugyanabból a tartós eseménysorból
  ugyanazokat a blokkokat kell előállítani.

## Implementációs lépések

1. **Provider-események leltára és fixture-ök.**
   Rögzíteni kell egy Codex explicit `final_answer`, egy Codex phase nélküli
   fallback, valamint egy Claude több assistant itemes mintát. Meg kell jelölni,
   mely esemény válasz és melyik trace; nyers felhasználói tartalom nem kerül
   fixture-be.

2. **Normalizált channel bevezetése.**
   Az `item/agentMessage/delta`, reasoning summary, státusz és tool események
   feldolgozásakor a frontend explicit típust ad. Az azonos `itemId` deltái
   továbbra is egy objektumba fűződnek.

3. **Tiszta timeline-builder.**
   Elkészül a `buildCompactAnswerTimeline(...)`, amely item-határon csoportosít,
   sequence alapján rendez, a trace-elemeket pontosan egy következő válaszhoz
   rendeli, deduplikálja a `turn/completed.finalText` fallbacket, és előállítja
   a live pending sort.

4. **Külön compact komponens.**
   A `TurnProgressCard` nagy `if (compact)` ága költözzön egy célzott
   `CompactAnswersTimeline` komponensbe. A Részletes ág logikája és DOM-ja ne
   változzon.

5. **VÁLASZOK lista.**
   Fix szélességű bal oszlop, tartalom szerint növekvő blokkok, kiválasztás,
   billentyűzetes fókusz, élő/pending állapot és automatikus követés.

6. **Kapcsolt GONDOLKODÁS MENETE.**
   A kiválasztott blokk `trace` szelete a meglévő work/commentary rendererek
   újrafelhasználásával jelenjen meg. Egy esemény csak egy blokkhoz tartozhat.

7. **Teljes válasz és műveletek megőrzése.**
   Másolás és Újragenerálás továbbra is a kanonikus teljes assistant message-et
   kapja, nem csak a kijelölt blokkot. A change summary és rollback a teljes
   panel alatt marad.

8. **Live és lezárt állapot összeillesztése.**
   A live kártya timeline-ja DOM-ugrás nélkül váljon lezárt történeti kártyává;
   `turn/completed` ne hozzon létre második végső blokkot, és a pending sor ne
   maradjon ott.

9. **Reszponzív és vizuális finomhangolás.**
   A meglévő khaki/dark tokenek, aktív keretanimáció és scrollbar-stílus
   újrafelhasználása; keskeny nézetben egymás alá törés. Új világos/fehér
   alapértelmezett böngészőfelület nem maradhat.

10. **Regresszió és kézi ellenőrzés.**
    A Részletes EGY-AI és Részletes MULTI-AI panelnek pixel- és
    viselkedésszinten változatlannak kell maradnia. A Nem-Részletes nézetet
    Codexszel és Claude-dal, live futással, restarttal és sync-hidratálással is
    ellenőrizni kell.

## Tesztmátrix

### Automatikus helper-tesztek

- több delta, azonos `itemId` → egy válaszblokk;
- két külön `itemId` → két válaszblokk;
- több bekezdés egy itemben → továbbra is egy blokk;
- trace A → answer 1 → trace B → answer 2 → helyes, kizárólagos hozzárendelés;
- gondolkodás válasz nélkül → egy pending sor;
- pending sor + első answer delta → ugyanaz a logikai sor válasszá alakul;
- `final_answer` deltasor + azonos `turn/completed.finalText` → nincs duplikáció;
- csak `turn/completed.finalText` → egy végső blokk;
- megszakítás → pending lezárul vagy eltűnik, nem marad örök spinner;
- régi, channel nélküli snapshot → konzervatív, stabil fallback;
- események eltérő érkezési sorrendje → sequence alapján azonos eredmény.

### Integrációs esetek

- Nem-Részletes Codex, amely végig csak tool/reasoning eseményt küld, majd
  egyszerre ad végső választ;
- Nem-Részletes Codex több köztes assistant outputtal;
- Nem-Részletes Claude több assistant itemmel;
- hosszú Markdown-válasz listával, képlettel és kódblokkal;
- futás közben régebbi válasz kiválasztása, majd új blokk érkezése;
- Stop, hiba, approval/question várakozás;
- háttérben futó beszélgetés megnyitása;
- restart és kétgépes sync utáni hidratálás;
- V2 újrafuttatás és pipeline-válasz: a meglévő chain UI nem törhet el.

### Vizuális elfogadási feltételek

- nincs VÁLASZ/LÉPÉSEK slider Nem-Részletes módban;
- a fejléc pontosan **VÁLASZOK**;
- a bal oszlop nem változtat szélességet hosszabb válasznál;
- a válaszblokkok lefelé nőnek, tartalmuk nem csonkolódik;
- kattintásra a jobb panel mindig a kijelölt választ közvetlenül megelőző
  trace-t mutatja;
- live futás közben nem csak egy jelentés nélküli spinner látszik;
- lezáráskor nincs villanás, panelcsere vagy duplikált teljes válasz;
- a Részletes nézet vizuálisan és funkcionálisan változatlan.

## Érintett fájlok

- `src/App.tsx` — event channel normalizálás, compact ág kiszervezése és
  bekötése;
- `src/compactAnswerTimeline.ts` — tiszta csoportosító/időablak-logika;
- `src/CompactAnswersTimeline.tsx` — új Nem-Részletes panel;
- `styles.css` — kétoszlopos compact layout és válaszblokkok;
- `tests/compactAnswerTimeline.test.ts` — determinisztikus timeline-tesztek;
- szükség esetén a provider fixture-ek tesztfájljai, de Rust store-migráció nem
  várható.

## Nem része ennek a fejlesztésnek

- valódi mid-turn steering;
- nyers chain-of-thought megjelenítése;
- a Részletes LÉPÉSEK panel áttervezése;
- a MULTI-AI fázisfülek vagy a V2 workflow módosítása;
- válaszok mesterséges felosztása mondat, sor vagy Markdown-bekezdés szerint.

## Kész definíciója

A fejlesztés akkor kész, ha a Nem-Részletes futás egy stabil **VÁLASZOK**
listában mutatja az assistant output blokkokat, a jobb oldali
**GONDOLKODÁS MENETE** pedig minden kijelölésnél kizárólag az adott válasz előtt
keletkezett trace-szeletet jeleníti meg; mindez live, lezárt, újraindított és
szinkronizált állapotban ugyanúgy működik, miközben a Részletes felület és a
kanonikus tárolt válasz változatlan marad.
