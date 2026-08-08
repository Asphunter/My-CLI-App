# Sub-beszélgetések egy prompt–VÁLASZ párhoz — terv

*2026-08-08 · állapot: javaslat, nincs elfogadva*

## Mi ez

Egy lezárt VÁLASZ-kártyához (tipikusan TERV/KÓD/REVIEW lánchoz) utólag további promptok
csatolhatók. Ezek nem a beszélgetés aljára kerülnek, hanem a kártyához kötött, alapból
összecsukott **sub-szálba**. Cél: napokkal későbbi visszanézésnél a kérdés-válasz a
témájánál van, nem 40 üzenettel lejjebb.

## Vélemény (rövid)

- **Megéri.** A mai steer ("TE · MENET KÖZBEN") már fél lépés ebbe az irányba, de az csak
  futás közben él. A lezárt válaszhoz kötés a hiányzó fele.
- **A FÁZIS-sín alatti hely a belépési pont, nem a szál helye.** A bal sín 21 px széles —
  oda badge/gomb fér (💬 + darabszám), maga a szál a kártya *alatt* nyíljon teljes
  szélességben. Vizuális kötés: a sín színe/vonala fusson le a sub-szál blokkjáig.
- **Mélység = 1.** Sub-szál sub-szála tilos. Aki ott új nagy témát kezd, új beszélgetést
  vagy új láncot indítson. E nélkül a timeline-csoportosítás (chatTimeline) komplexitása
  elszáll.
- **A görgetés-fájdalom másik felét nem ez oldja meg.** Kiegészítőnek javaslok egy
  TOC-ot: a jobb szélen kis index a user-promptokból, kattintásra ugrás. Olcsó, és a
  sub-szálakkal együtt adja azt, amit akarsz.

## UX

1. Lezárt kártya bal sínjén, a fázisikonok alatt: `💬 n` gomb (n = sub-üzenetek száma;
   0-nál csak hoverre látszik).
2. Kattintásra a kártya alatt kinyílik a sub-szál: szűkebb hasáb, balról behúzva,
   a sín vonalához kötve. Alul saját mini-composer ("Kérdés ehhez a válaszhoz…").
3. A sub-promptra érkező válasz ugyanebbe a blokkba folyik, a meglévő
   kompakt kártya-renderrel (CompactAnswersTimeline újrahasznosítva).
4. A fő timeline-ban a sub-szál csukva: egy sor („💬 3 kapcsolódó kérdés").
5. Fut a fő lánc → a gomb tiltva (a steer útvonal él helyette).

## Adatmodell

- `messages` új oszlop: `anchor_json TEXT` — `{ "chainKey": "...", "messageId": "..." }`.
  A `chainKey`-hez kötünk, nem `runId`-hoz: így a v1/v2 regenerálás után is ugyanahhoz a
  panelhez tartozik. Migráció: meglévő `ensure_column` minta (store.rs).
- Sub-válasz assistant-üzenete ugyanazt az `anchor_json`-t örökli.
- Sync: az oszlop megy a sync_events-be; régi kliens nem ismeri → mezőt eldobja, az
  üzenet nála a timeline alján jelenik meg (degradáció, nem törés).
- Rendezés: a chatTimeline a horgonyzott üzeneteket kiemeli a fő sorrendből és a
  horgony-csoport alá fűzi. (Vigyázat: pont most javítottuk itt a padló-lekérdezést —
  tesztek kellenek.)

## Kontextus a modellnek

Sub-prompt küldésekor **nem** a teljes beszélgetés megy:

1. Claude/kompatibilis: ha van `provider_session_id` a horgony-turnhöz → `resume`.
2. Ha nincs (lejárt, más gép): rehydration a horgony user-promptjából + a VÁLASZ
   szövegéből + az érintett fázis-artefaktumokból (max ~12k char, a meglévő
   `MAX_ARTIFACT_CHARS` mintára).
3. A sub-szál korábbi üzenetei mindig mennek (rövidek).

Ez olcsóbb és fókuszáltabb, mint a fő szál folytatása — ez a feature másik haszna.

## Ütemezés

| Fázis | Tartalom | Méret |
|---|---|---|
| M1 | Oszlop + horgonyzott küldés + inline megjelenítés, csukva/nyitva. Sync-safe. | közepes |
| M2 | Kontextus-stratégia (resume/rehydration), futás-tiltás, badge a sínen. | közepes |
| M3 | TOC-index a gyors ugráshoz; sub-szál keresésben/exportban. | kicsi |

## Limitációk, nyitott kérdések

- **Regenerálás a sub-szálban**: v1-hez kérdeztél, aztán v2 lett a fő válasz — a sub-szál
  a chainKey-nél marad, de jelezni kell, melyik verzióhoz szólt. Javaslat: badge
  („v1-hez kérdezve"), nem blokkoló.
- **Rollback/visszaállítás**: ha a fő promptra visszaállsz, a horgonyzott üzenetek
  árvák lesznek → a horgonnyal együtt törlendők (revert-preview-ba beleszámolni).
- **Régi kliens sync**: lásd fent, degradáció.
- **Mobil/keskeny nézet**: 680 px alatt a sub-szál teljes szélességű, a sín-kötés elmarad.
- **Nem oldja meg**: a General mód üzenetei (nincs kártya), és a több beszélgetésen
  átívelő keresés.
