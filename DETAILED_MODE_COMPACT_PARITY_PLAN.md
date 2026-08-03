# Részletes mód – végleges kompakt GUI-rehaul terv

## Cél

A Részletes mód tartsa meg a TERV → KÓD → REVIEW munkafolyamat teljes
funkcionalitását, de ugyanazt a nyugodt, fekete, minimális vizuális nyelvet
használja, mint a Nem-Részletes mód. A széles desktop felületet két hasznos
oszlop töltse ki; ne legyen külön, állandó VÁLASZ panel.

## Végleges döntések

- A user bubble szövege normál, nem félkövér.
- Minden AI-válasz elsődleges szövege fehér.
- A TERV/KÓD/REVIEW választóban nincs `1/3`, `2/3`, `3/3`; csak a fázisnév.
- A választó egyetlen minimalista slider/track, nem három külön gombdoboz.
- A REVIEW fül teljes háttere zöld vagy piros a verdikt szerint.
- A provider ikon, futásanimáció és számláló a bal oldali státuszsávban marad.
- Nincs külön LÉPÉSEK, GONDOLKODÁS MENETE vagy VÁLASZ fejlécpanel.

## Közös kétoszlopos váz

Desktopon:

1. Bal oldal: LÉPÉSEK.
2. Jobb oldal: az adott fázis olvasófelülete.

A lépéssorok finom sötét háttérrel, vékony elválasztással és kompakt
magassággal különülnek el. A kijelölt sor bézs éllel és enyhe bézs tónussal
kap fókuszt. A panelek saját belső scrollt használnak, ezért egy hosszú trace
nem nyújtja korlátlanul a beszélgetést.

## TERV

- Bal oldalon a számozott tervlépések vannak.
- Jobb oldalon mindig a teljes RAW terv látszik; nincs RAW/RÉSZLET kapcsoló és
  nincs duplikált részletpanel.
- Egy bal oldali lépésre kattintva a hozzá tartozó teljes jobb oldali bekezdés
  finom bézs highlightot kap, és szükség esetén a panel odagörget.
- A számozást a kliens egyszer rendereli; nem fordulhat elő `1. 1. 1.`.

## KÓD

- Bal oldalon a KÓD lépései vannak.
- Jobb oldalon a kijelölt lépés kompakt gondolkodási folyamata jelenik meg.
- A végső VÁLASZ az utolsó lépés folyamának végén jelenik meg, nem külön
  oszlopban.
- Az utolsó lépéssor kis `VÁLASZ` jelölést kap.
- A FÁJLOK / VÁLTOZÁSOK összegzés a végső válasz alatt, a Nem-Részletes mód
  kompakt komponensével jelenik meg; nem lesz teljes szélességű külön sáv.

## REVIEW

- A struktúra azonos a KÓD fáziséval: LÉPÉSEK balra, gondolkodási folyamat
  jobbra.
- A végső válasz az utolsó, `VERDIKT` jelölt lépés folyamának végén van.
- A verdikt lépéssor teljes háttere finom zöld vagy piros tónust kap, erősebb
  azonos színű bal éllel.
- Maga a gondolkodási panel fekete marad; nem kap teljes zöld/piros hátteret.

## Szín- és tipográfiai rendszer

- Tree, chat háttér, válaszfelületek: `#000000`.
- User bubble és input: `#A59B7C`.
- Elsődleges AI-válaszszöveg: `#FFFFFF`.
- Fókusz és válaszél: `#A59B7C`.
- Másodlagos metaadat: tompa hidegszürke.
- Verdikt: visszafogott, de egyértelmű zöld/piros felület fehér felirattal.

## Reszponzív viselkedés

- Széles desktop: körülbelül `33% / 67%` LÉPÉSEK/tartalom arány.
- Közepes szélesség: a bal oszlop kissé szélesebb arányt kap.
- Keskeny nézet: a két oszlop egymás alá törik, előbb a lépések, utána a
  tartalom.

## Megvalósítás

- [x] Tervszöveg felbontása külön kiemelhető, de egyetlen RAW dokumentumban
  maradó lépésblokkokra.
- [x] Hibás újrainduló ordered-list számozás javítása.
- [x] Külön VÁLASZ oszlop eltávolítása.
- [x] Fázisonkénti kétoszlopos renderelés.
- [x] KÓD/REVIEW végső válaszának utolsó lépésbe ágyazása.
- [x] Kompakt fájlváltozás-panel beágyazása.
- [x] Minimalista fázisslider és verdiktfelületek.
- [x] Statikus, timeline- és parser-tesztek frissítése és futtatása.
- [x] Production build és Rust regressziós tesztek.
- [x] Valódi GUI indítása, My VNA-new / Planning megnyitása és screenshotok.
- [x] Vizuális/működési hibák javítása, újrabuild és újraellenőrzés.

## Elfogadási kritériumok

1. A fázisok között váltva mindig a helyes történeti tartalom jelenik meg.
2. TERV-ben egy kattintás a helyes RAW bekezdést emeli ki és görgeti láthatóvá.
3. KÓD és REVIEW alatt nincs harmadik, duplikált VÁLASZ oszlop.
4. A végső válasz csak az utolsó lépésnél jelenik meg, az actionök működnek.
5. A REVIEW fül és verdiktsor színe megfelel az elfogadott/javítást kér
   állapotnak.
6. A user bubble normál súlyú, az AI-válaszok fehérek.
7. A fájlváltozás-panel nem uralja a teljes kártyaszélességet.
8. Nincs vízszintes túlcsordulás, egymásba futó szöveg vagy indokolatlan üres
   panel.
9. Build, frontend tesztek és Rust tesztek zöldek.
10. A végleges GUI-t a projekt `Screenshots` mappájában rögzített képek alapján
    külön vizuálisan is ellenőriztük.
