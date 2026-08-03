# Részletes mód – kompakt GUI-paritási fejlesztési terv

## Cél

A Részletes mód tartsa meg a teljes TERV → KÓD → REVIEW munkafolyamatot, de vizuálisan ugyanazt a letisztult nyelvet használja, mint a Nem-Részletes mód:

- nincs VÁLASZ/LÉPÉSEK nézetváltó;
- nincs külön „LÉPÉSEK” vagy „GONDOLKODÁS MENETE” fejlécpanel;
- a provider ikon, a teljes futás számlálója, a kész/megszakított szín és a futó animáció a bal oldali státuszsávban él;
- a VÁLASZ, a lépések és a kompakt gondolkodási kivonat egyszerre látható három oszlopban;
- a fájl- és változásösszegzés a három oszlop alatt, teljes szélességben jelenik meg;
- a TERV, KÓD és REVIEW szakaszfülek változatlanul megmaradnak.

## Jelenlegi felület problémái

1. A VÁLASZ/LÉPÉSEK kapcsoló ugyanannak a futásnak két felét kölcsönösen elrejti.
2. A LÉPÉSEK és GONDOLKODÁS MENETE dedikált fejlécei magasságot és vizuális zajt adnak, információt alig.
3. A fájlváltozások oldalsó panelje kiszorítja az éppen olvasott tartalmat.
4. Az állapot, idő, szakaszjelvény és nézetváltó egy központi fejlécbe torlódik.
5. A Részletes kártya több egymásba ágyazott keretet és háttérszínt használ, miközben a Nem-Részletes mód egyetlen nyugodt olvasófelület.
6. A futó animáció a kártyát hangsúlyozza ahelyett, hogy a ténylegesen dolgozó AI-t jelezné.
7. A panelek egymás alatt vagy egymást váltva jelennek meg, ezért a széles desktop felület nagy része kihasználatlan.

## Megtartandó funkciók

- TERV/KÓD/REVIEW szakaszfülek és szakaszállapotok;
- provider- és modellazonosság;
- teljes futásidő és szakaszidő;
- kész, fut, megszakítva és review verdict állapotok;
- válaszmásolás és újragenerálás;
- lépéskiválasztás, aktív lépés követése és lépésenkénti idő;
- intenzitásjelzés és eszköz-/reasoning-események;
- terv RAW és kiválasztott lépés DETAIL nézete;
- magyar narratív kivonatok elsődleges megjelenítése;
- belső/technikai gondolkodás összecsukott sorai és lenyitása;
- inline kóddiff, quote anchorok és visszaugrás;
- fájllista, képelőnézet, rollback és hozzáadás/törlés számlálók;
- pipeline verdict és újrafuttatási műveletek;
- történeti, élő és megszakított futások helyes visszaállítása.

## Új információs architektúra

### 1. Futásfejléc

A meglévő TERV/KÓD/REVIEW tabsáv marad a kártya felett. Nem kerül mellé új „Részletes” fejléc.

### 2. Bal oldali AI-státuszsáv

Ugyanaz a komponensnyelv, mint a Nem-Részletes módban:

- provider ikon;
- futás közben bézs orbit + finom pulzálás;
- alatta `mm:ss` számláló;
- zöld kész, piros megszakított állapot;
- nincs teljes kártyát körbefutó loading keret.

### 3. Háromoszlopos főfelület

Desktop alaparány: `36% / 28% / 36%`.

#### Bal oszlop – Válasz

- nincs „VÁLASZ” felirat;
- a szöveg azonnal a panel tetején kezdődik;
- másolás és regenerate a jobb felső sarok kompakt ikonsorában;
- élő válasznál a szöveg mellett kis inline spinner maradhat;
- a TERV szakaszban itt olvasható a teljes, streamelt tervszöveg is.

#### Középső oszlop – Lépések

- nincs „LÉPÉSEK” fejlécpanel;
- a lista rögtön az első lépéssel indul;
- megmarad a sorszám, státusz, intenzitás, kijelölés és idő;
- az összesített szakaszidő a lista alján marad;
- a kijelölt lépés továbbra is a jobb oldali gondolkodási tartalmat vezérli.

#### Jobb oszlop – Gondolkodási kivonat

- nincs „GONDOLKODÁS MENETE” fejlécpanel;
- elsődlegesen csak a felhasználónak szánt magyar narratív mondatok látszanak;
- a technikai/internal részletek egysoros, lenyitható sorok;
- az eszköz- és fájlesemények megtartják az inline diff gombot;
- TERV szakaszban egy apró RAW/DETAIL vezérlő marad, fejlécpanel nélkül;
- üres technikai napló nem hoz létre nagy üres sub-panelt.

### 4. Fájlok és változások

- a három oszlop alatt, teljes szélességben;
- csak akkor jelenik meg, ha ténylegesen van változás;
- megtartja a fájlnevet, státuszt, `+/-` számokat, preview-t és rollbacket;
- a lista saját kompakt keretet kaphat, de nem szűkíti a három fő oszlopot.

## Színrendszer

- Tree: `#000000`;
- VÁLASZ és részletes futáskártya olvasófelülete: `#000000`;
- Chat háttér: `#555C64`;
- Részletes/Nem-Részletes Switch háttere: `#000000`;
- bézs rendszer-szín: `rgb(150, 146, 116)`;
- Tree/chat függőleges elválasztó és projektfejléc alsó vonala: bézs;
- a lépések és gondolkodás oszlopát csak vékony, sötét/bézsbe hajló szeparátor választja el, külön „doboz a dobozban” hatás nélkül.

## Reszponzív viselkedés

- `>= 1180 px`: három oszlop egymás mellett;
- `800–1179 px`: VÁLASZ teljes szélességben felül, LÉPÉSEK és gondolkodás két oszlopban alul;
- `< 800 px`: egy oszlop, sorrendben VÁLASZ → LÉPÉSEK → gondolkodás → fájlok;
- minden oszlop saját belső scrollt kap, a teljes kártya nem nyúlik korlátlanul.

## Megvalósítási fázisok

### Fázis 1 – szín- és shell-paritás

- globális háttérváltozók átállítása;
- Tree, VÁLASZ és Switch mélyfekete;
- bézs Tree/chat és fejléc-elválasztók;
- teljes kártya-loading kikapcsolása részletes módban.

### Fázis 2 – háromoszlopos részletes kártya

- VÁLASZ/LÉPÉSEK state és kapcsoló eltávolítása a renderelésből;
- a három lane egyidejű renderelése;
- dedikált LÉPÉSEK/GONDOLKODÁS fejlécek eltávolítása;
- válasz actionök kompakt sarokpozíciója;
- status rail és provider animáció öröklése.

### Fázis 3 – kompakt gondolkodás és tervnézet

- magyar narráció elsődleges lane-je;
- internal/technikai sorok lenyitása;
- RAW/DETAIL kis méretű, fejléc nélküli vezérlő;
- üres és streaming állapotok tömörítése.

### Fázis 4 – fájlváltozások alul

- ChangeSummaryPanel kivétele az oldalsó oszlopból;
- teljes szélességű alsó elhelyezés;
- kompakt lista, preview és rollback ellenőrzése.

### Fázis 5 – kompatibilitás és takarítás

- történeti részletes futások;
- chain stage-ek és review verdict színek;
- megszakítás és restart utáni visszaállítás;
- elavult trace-view CSS/state eltávolítása.

## Elfogadási kritériumok

1. A TERV, KÓD és REVIEW tabok továbbra is ugyanazt a szakaszt nyitják meg.
2. Desktopon a VÁLASZ, lépések és gondolkodás egyszerre látható.
3. Nincs VÁLASZ/LÉPÉSEK kapcsoló és nincs LÉPÉSEK/GONDOLKODÁS fejlécpanel.
4. A bal oldali provider ikon és számláló ugyanúgy viselkedik, mint Nem-Részletes módban.
5. A technikai részletek alapból nem uralják a gondolkodási oszlopot, de lenyithatók.
6. A fájlváltozások nem csökkentik egyik fő oszlop szélességét sem.
7. A terv RAW és lépésenkénti DETAIL tartalma továbbra is elérhető.
8. Copy, regenerate, quote jump, diff preview és rollback működik.
9. A teljes build, a timeline tesztek és a Rust tesztek zöldek.
10. A változtatás nem módosítja a pipeline végrehajtási vagy tartósítási szemantikáját.
