# Terv-fájl és fázis-UX — terv

*2026-07-29 · a felhasználóval pontról pontra egyeztetett specifikáció.
Alap: `parallel-project-runs` ág, `8424ffb`.*

## A vízió egy mondatban

A terv **fájl** (a projekt része, gitelhető), a LÉPÉS lista **a tervből jön**,
a KÓD **ugyanazon a listán halad végig**, és a GONDOLKODÁS MENETE mindig azt
mutatja, ami tényleg történik — a TERV-nél a születő tervet (RAW/DETAIL), a
KÓD-nál az élő munkát.

## Döntések (a beszélgetésből, sorrendben)

| kérdés | döntés |
|---|---|
| Ki írja a terv-fájlt? | A lánc-futtató (Rust), a terv-szakasz **végén**, egyben. A tervező modell read-only marad. |
| Hova? | A projekt gyökerébe: `tervek/ÉÉÉÉ-HH-NN-<téma>-v<kör>.md`. Téma = beszélgetéscím, ékezet nélkül. Gitelhető, diffben látszik — ez szándék. |
| Folyamatos fájlírás? | Nem — nem éri meg. A RAW nézet a már streamelő szövegből él, a fájl a tartós példány. |
| v2/v3? | Külön fájl (`-v2.md`). |
| LÉPÉS lista forrása | A terv számozott fő pontjai. A TERV és a KÓD listája **bitre ugyanaz**. |
| „Csak lényeges" gomb | **Teljes törlés** — a GONDOLKODÁS MENETE semmit ne szűrjön. |
| RAW/DETAIL váltó | A GONDOLKODÁS MENETE fejlécébe, az ismert váltó-vizuállal, csak TERV-fázisú kártyán. RAW = teljes terv formázva; DETAIL = a kiválasztott lépés szelete. |
| TERV VÁLASZ fül | Marad, de letiltva — a RAW veszi át a szerepét. |
| Lépés-haladás a KÓD alatt | (1) a kódoló todo-frissítései (utasítás már kéri); (2) tartalék: fájl-alapú következtetés — a lépésben megnevezett fájl írása lépteti a listát. |
| 1 todo-s felülírás | Lánc-szakasz tervfrissítése nem cserélheti le a ≥2 lépéses listát 1 lépésre (ez okozta az „1/1 kész"-t). |

## Lépések

### R1 — Rust: a terv-fájl kiírása
`PipelineRunRequest` új mezője: `plan_file: Option<String>` (relatív út, a
frontend számolja ki névvel-dátummal-körrel). A stage-záró closure-ben, ha a
szakasz szerepe `Plan` és sikerült: a fájl kiírása a `cwd` alá. Védelem:
csak relatív, `..`-mentes út; hiba nem-fatális (a lánc nem hal bele).

### F1 — Frontend: a fájlnév és a kérés
Slug a beszélgetéscímből (ékezet-leszedés, kisbetű, kötőjel), dátum, kör.
`planFile` a `pipeline_send`-be (friss futás: v1; újrafuttatás: v<iteráció>).

### F2 — „Csak lényeges" törlése
`essentialTraceOnly` state + gomb + szűrés teljes eltávolítása.

### F3 — TERV-kártya: RAW/DETAIL
`TurnProgressCard` plan-szerepű kártyáján: VÁLASZ fül letiltva (nem auto-vált
rá); a GONDOLKODÁS MENETE fejlécében RAW/DETAIL váltó; RAW = a terv szövege
formázva (élőben a streamelő szöveg), DETAIL = a kiválasztott lépés szelete a
számozott pontok határai mentén.

### F4 — A lista születése és öröklése
A terv-szakasz lezárásakor a végleges szövegből számozott lépések →
a TERV kártya lépéslistája (kész státusszal). A KÓD indulásakor ugyanez a
lista öröklődik (első lépés folyamatban) — a meglévő átvitel marad, közös
parserrel.

### F5 — Lépés-haladás a KÓD alatt
(1) todo-frissítés jön → átvesszük; de lánc-szakasz ≥2 lépéses listáját 1
lépéses frissítés nem írhatja felül. (2) tartalék: az aktivitás fájlneve a
lépés-szövegekhez illesztve — az első nem-kész, egyező lépésre lépünk
(`markOwnedPlanStepStarted` végzi a korábbi lezárását).

## Kiegészítés — 2026-07-30 (a futás utáni három észrevétel)

| észrevétel | döntés |
|---|---|
| A TERV LÉPÉS listája a RAW szó szerinti másolata volt | A listába a pont **címe** kerül (vastag fej, vagy az első gondolatjelig/kettőspontig) — ugyanaz, amit a KÓD is mutat. A magyarázat a RAW-ban és a DETAIL szeletében marad. A lista továbbra is a szöveggel együtt nő. |
| Két szakasz között pár másodpercre kiürült a panel | A lezárt szakasz szövege a kész buborékból (tervnél a futás `planText`-jéből) él tovább, amíg a következő szakasz elindul; a lezárt szakasz nem „streamel", tehát a lépései sem látszanak félkésznek. |
| Képletek nyersen látszottak (`\(Z_0=100\,\Omega\)`) | KaTeX. A `\(...\)`, `\[...\]`, `$$...$$` és a TeX-jelet tartalmazó `$...$` mindenhol kirendelődik, ahol szöveget írunk ki (válasz, TERV RAW/DETAIL, gondolkodás menete). A kétszer escape-elt vezérjel (`\\Omega`) visszaáll egyre. |

A lépés-címek és a képlet-felismerés külön modulba kerültek (`src/planText.ts`,
`src/mathText.ts`), tesztekkel — eddig egyik sem volt gépileg ellenőrizhető.

## Ellenőrzés

Gépi: `cargo test` (169+), `tsc -b`, 50 frontend-teszt, build.
Kézi (a felhasználónál): TERV alatt RAW-ban folyik a szöveg, lépésekre
kattintva DETAIL; KÓD alatt a terv lépései egyenként haladnak; a `tervek/`
mappában megjelenik a fájl; a diffben látszik; „Csak lényeges" sehol.
