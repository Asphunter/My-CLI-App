# `min` – saját kétgépes release és telepítési terv

**Dátum:** 2026-07-14  
**Állapot:** aktív végrehajtási terv  
**Hatókör:** kizárólag a saját Windows PC és laptop  
**Első telepíthető verzió:** `0.1.0`

## 1. Cél

Egyetlen, verziózott Windows installer készüljön, amelyet manuálisan fel lehet telepíteni a PC-re és a laptopra.

Az installált `min`:

- Start menüből indul;
- nem igényli a projekt forrásmappáját;
- nem igényel Node.js-, npm-, Rust- vagy Cargo-telepítést;
- saját, becsomagolt Codex binárist használ;
- mindkét gépen a gép saját OneDrive `my projects` gyökerét használja;
- megtartja a gépenként külön lokális adatbázist és device ID-t;
- a meglévő append-only OneDrive journalon keresztül szinkronizál;
- új verziónál ugyanazzal a folyamattal kézzel frissíthető mindkét gépen.

Nem cél nyilvános alkalmazásbolt, más felhasználóknak történő terjesztés vagy automatikus frissítési szolgáltatás.

## 2. Végleges működési modell

### PC

```text
Telepített min.exe
  ├─ bundled codex.exe
  ├─ %LOCALAPPDATA%\min\min.db
  ├─ %LOCALAPPDATA%\min\sync-device-id
  ├─ %LOCALAPPDATA%\min\settings.json
  └─ C:\Users\<pc-user>\OneDrive\my projects\.min-sync\v2
```

### Laptop

```text
Telepített min.exe
  ├─ bundled codex.exe
  ├─ %LOCALAPPDATA%\min\min.db
  ├─ %LOCALAPPDATA%\min\sync-device-id
  ├─ %LOCALAPPDATA%\min\settings.json
  └─ C:\Users\<laptop-user>\OneDrive\my projects\.min-sync\v2
```

### Fontos invariánsok

- A két `min.db` nem kerül OneDrive-ba és nem másolódik egymásra.
- A két device ID különböző marad.
- A közös adat kizárólag a `.min-sync\v2` journal.
- Az abszolút OneDrive útvonal lehet eltérő a két gépen.
- A projektek közös azonossága relatív OneDrive útvonalból származik.
- A dev app és a telepített app ugyanazon a gépen nem futhat egyszerre.

## 3. Jelenlegi blokkolók

| Prioritás | Probléma | Miért blokkoló? |
|---|---|---|
| P0 | `bundle.active` jelenleg `false` | Nem készül installer |
| P0 | A Codex nincs a bundle-ben | Másik gépen a release EXE a fejlesztői környezetre támaszkodhat |
| P0 | A runtime visszaeshet a buildgép `CARGO_MANIFEST_DIR` útvonalára | A laptopon hibás vagy nem létező forrásútvonalat használhat |
| P0 | A `projects_root()` a `workspace_cwd()` és a `my projects` mappanév keresésére épül | A telepített appnak külön, géphelyi OneDrive-gyökér kell |
| P1 | Nincs single-instance védelem | Két apppéldány ugyanazzal a device ID-val írhat |
| P1 | A verzió három fájlban él | Könnyű eltérő EXE- és installer-verziót készíteni |
| P1 | Nincs egyszerű runtime diagnosztika | Nem látszik biztosan, melyik EXE, Codex és adatútvonal fut |

## 4. Implementációs terv

### 4.1 Géphelyi `projectsRoot`

Ez az első lépés, mert a jelenlegi fejlesztői forrásútvonal nem lehet release runtime-konfiguráció.

Készüljön:

```text
%LOCALAPPDATA%\min\settings.json
```

Minimális tartalma:

```json
{
  "schemaVersion": 1,
  "projectsRoot": "C:\\Users\\danis\\OneDrive\\my projects"
}
```

Működés:

- első indításkor az app megpróbálja felismerni a OneDrive `my projects` mappát;
- ha nem talál pontosan egy használható gyökeret, mappaválasztót nyit;
- a kiválasztás géphelyi, nem kerül OneDrive-ba;
- gyökér nélkül az app nem írhat a sync journalba;
- a Settings nézetben az útvonal látható és explicit módon módosítható;
- release buildben a `CARGO_MANIFEST_DIR` nem lehet fallback;
- debug buildben a jelenlegi fejlesztői fallback megmaradhat.

Elfogadási feltétel:

- a telepített app a forrásmappa nélkül is elindul;
- a PC és a laptop saját abszolút útvonalát használja;
- ugyanazokat a relatív projekteket látják.

### 4.2 A Codex becsomagolása

A jelenleg lockolt runtime:

```text
@openai/codex 0.144.1
codex-cli 0.144.1
Windows x64 codex.exe: 325.39 MiB
```

Feladatok:

- a Tauri `bundle.resources` csomagolja be a lockolt Windows x64 `codex.exe` fájlt;
- a bundle célútvonala `codex.exe`, mert a backend már ezt keresi a resource könyvtárban;
- ne készüljön újabb 325 MiB-os staging másolat az OneDrive-os projektben;
- build előtt gépi ellenőrzés fusson:
  - fájl létezik;
  - `codex.exe --version` eredménye `0.144.1`;
  - x64 bináris;
  - Authenticode státusz érvényes;
  - SHA-256 kiszámolható;
- release buildben csak a bundled Codex használható;
- `MIN_CODEX_BIN`, workspace `node_modules`, managed plugin és PATH fallback csak debug buildben maradjon;
- hiányzó vagy eltérő bundled Codex esetén az app érthető hibát mutasson, és ne induljon el a Codex-turn.

Elfogadási feltétel:

- a telepített app Node.js és a forrásmappa nélkül is válaszol;
- a Codex folyamat rejtett ablakban indul;
- a Diagnostics a telepített resource útvonalat mutatja.

### 4.3 NSIS installer

A Tauri konfigurációban:

- `bundle.active = true`;
- `bundle.targets = ["nsis"]`;
- Windows x64 target;
- current-user telepítés adminjog nélkül;
- meglévő `icon.ico`;
- WebView2 download bootstrapper;
- stabil `identifier = "hu.danis.min"`;
- downgrade tiltása.

Az installer:

- Start menü bejegyzést készít;
- ugyanazzal az identifierrel in-place frissít;
- nem törli a `%LOCALAPPDATA%\min` mappát;
- nem módosítja közvetlenül a `.min-sync` journalt;
- nem másol build-cache-t a OneDrive-ba.

Elsődleges artifact:

```text
%LOCALAPPDATA%\min\cargo-target\release\bundle\nsis\min_0.1.0_x64-setup.exe
```

Megvalósítási állapot (2026-07-14):

- [x] `scripts/release_check.cjs`: lockolt Codex-verzió, x64 PE, Authenticode és SHA-256 ellenőrzés;
- [x] release-ben csak a Tauri resource-könyvtárban lévő `codex.exe` használható;
- [x] `bundle.resources` a Codexet a release EXE mellé csomagolja, nem a OneDrive-os targetbe;
- [x] current-user NSIS konfiguráció, Start menü, WebView2 bootstrapper és downgrade-tiltás;
- [x] az installer elkészült és a resource hash-e egyezik a lockolt inputtal;
- [ ] telepített EXE kézi ellenőrzése A és B gépen a 7. fejezet szerint.

### 4.4 Single-instance és minimális diagnosztika

- Második `min` indításakor a meglévő ablak kerüljön előtérbe.
- Ne lehessen két folyamatból ugyanazzal a device ID-val journalt írni.
- A Settings vagy Sync Health nézet mutassa:
  - appverzió;
  - futó EXE útvonala;
  - bundled Codex verzió és útvonal;
  - `projectsRoot`;
  - SQLite útvonal és schema;
  - device ID;
  - journal útvonal;
  - utolsó sync állapot.
- A diagnosztika ne tartalmazzon auth tokent, promptot vagy fájltartalmat.
- Készüljön alap release CSP; `csp: null` ne maradjon a telepített buildben.

### 4.5 Verzió és buildparancsok

Ugyanaz a verzió szerepeljen itt:

```text
package.json
src-tauri\Cargo.toml
src-tauri\tauri.conf.json
```

Javasolt parancsok:

```text
release:check    verzió + Codex + bundle input ellenőrzése
release:test     frontend build + Rust tesztek + app-server smoke
release:build    NSIS installer készítése
release:verify   installer SHA-256 és tartalomellenőrzés
```

Tervezett használat:

```powershell
cd "C:\Users\danis\OneDrive\my projects\my AI CLI app"
npm.cmd ci
npm.cmd run release:check
npm.cmd run release:test
npm.cmd run release:build
npm.cmd run release:verify
```

A Cargo target továbbra is itt legyen:

```text
%LOCALAPPDATA%\min\cargo-target
```

OneDrive-ba csak a végső installer és a hozzá tartozó SHA-256 kerülhet, a teljes target nem.

## 5. Első telepítés a két gépre

### Előkészítés

1. PC-n és laptopon legyen zöld a OneDrive sync.
2. Mindkét gépen zárd be a dev appot és minden kézzel indított `min.exe` példányt.
3. Mindkét gépen készüljön másolat a `%LOCALAPPDATA%\min` mappáról.
4. Egy gépen készüljön igazolt v2 retention backup.
5. Számítsuk ki az installer SHA-256 hashét.

### PC

1. Telepítsd a `min_0.1.0_x64-setup.exe` fájlt.
2. Indítsd Start menüből.
3. Válaszd ki a PC saját OneDrive `my projects` gyökerét.
4. Ellenőrizd a Diagnostics mezőit.
5. Ellenőrizd, hogy a korábbi projektek és beszélgetések megjelentek.
6. Futtass egy fájlmódosítás nélküli Codex-kérést.
7. Zárd be és indítsd újra az appot.

### Laptop

1. Ellenőrizd, hogy ugyanaz az installer SHA-256 hash.
2. Telepítsd ugyanazt a buildet.
3. Válaszd ki a laptop saját OneDrive `my projects` gyökerét.
4. Ellenőrizd, hogy a laptop device ID-je nem egyezik a PC-ével.
5. Várd meg a journal importot.
6. Futtass egy fájlmódosítás nélküli Codex-kérést.
7. Ellenőrizd a választ a PC-n is.

## 6. Kézi frissítési folyamat

Az első verziók frissítése manuális:

1. Elkészül például a `0.1.1` installer.
2. Lefut a release test és elkészül az SHA-256.
3. Mindkét gépen megvárjuk a zöld syncet.
4. Mindkét gépen bezárjuk az appot.
5. Telepítjük az új verziót a PC-re.
6. Rövid smoke után telepítjük ugyanazt a verziót a laptopra.
7. Ellenőrizzük, hogy a device ID, `projectsRoot`, SQLite és beszélgetések megmaradtak.

Szabályok:

- a két gép tartósan ne maradjon eltérő verzión;
- automatikus downgrade nincs;
- SQLite schema-emelés előtt automatikus lokális backup szükséges;
- sync/event schema-emelés külön migrációs feladat, nem egyszerű installer-frissítés;
- újabb, ismeretlen schema esetén a régi app fail-closed, csak olvasható állapotba kerül.

## 7. Kötelező tesztek az első installerrel

### Egygépes

- [ ] Start menüből indul.
- [ ] Nem jelenik meg PowerShell- vagy CMD-ablak.
- [ ] A forrásmappa és `node_modules` nélkül is működik.
- [ ] A bundled Codexből érkezik válasz.
- [ ] Második indítás nem hoz létre második írható példányt.
- [ ] Bezárás és újraindítás után minden adat megmarad.
- [ ] In-place újratelepítés után minden adat megmarad.
- [ ] OneDrive pause mellett az app nem ír vakon a journalba.

### Kétgépes

- [ ] Mindkét gép ugyanazt az appverziót és installer-hash-t használja.
- [ ] A device ID-k különböznek.
- [ ] A két eltérő abszolút `projectsRoot` ugyanazokat a projekteket adja.
- [ ] Üzenet és WorkFlow mindkét gépen helyes sorrendben jelenik meg.
- [ ] Offline/reconnect után nincs duplikáció vagy adatvesztés.
- [ ] Az egyik gép újraindítása nem zavarja a másik működését.
- [ ] Frissítés után mindkét gép ugyanarra az állapotra konvergál.

## 8. Amit most nem csinálunk meg

- fizetős Windows kódaláírás;
- automatikus updater vagy update-szerver;
- Microsoft Store/MSIX kiadás;
- többnyelvű publikus installer;
- SBOM és teljes licenc-riport;
- publikus privacy/telemetry rendszer;
- más felhasználói profilok támogatása;
- ARM64, macOS vagy Linux build;
- formális 7 napos release soak.

Az aláíratlan installer miatt az első futtatásnál SmartScreen-figyelmeztetés várható. Saját két gépnél ezt manuálisan lehet engedélyezni.

## 9. Definition of Done

A személyes kétgépes release akkor kész, ha:

- [x] a release runtime nem használ buildgépi forrásútvonalat;
- [x] mindkét gépen külön beállítható a `projectsRoot`;
- [x] a Codex az installer része és release-ben nincs PATH fallback;
- [x] elkészül a current-user NSIS installer;
- [ ] egyszerre csak egy apppéldány futhat gépenként;
- [ ] a release-verzió gépileg konzisztens;
- [x] az installer SHA-256 ellenőrizhető;
- [ ] PC-n és laptopon Start menüből működik;
- [ ] upgrade után a lokális adatok és device ID-k megmaradnak;
- [ ] a telepített A/B build szinkronja adatvesztés nélkül működik.

## 10. Következő konkrét lépés

Az első implementációs csomag:

1. [x] `%LOCALAPPDATA%\min\settings.json` és `projectsRoot` kezelés;
2. [x] első indítási OneDrive-gyökér választás;
3. [x] `workspace_cwd()` és `projects_root()` release leválasztása a forrásmappáról;
4. [x] unit tesztek a két eltérő géphelyi abszolút útvonalra.

Az első implementációs csomag elkészült és ellenőrizve lett. A következő csomag a bundled Codex és az NSIS installer.

## 11. Második implementációs csomag

1. [x] lockolt Windows x64 Codex-input gépi ellenőrzése;
2. [x] Codex resource bundle és release-only runtime path;
3. [x] current-user NSIS installer konfiguráció;
4. [x] release build, installer és `.sha256` artifact ellenőrzése;
5. [x] frontend build, 41 Rust teszt, valamint Git és nem-Git app-server smoke teszt.

A második csomag elkészült és ellenőrizve lett. A következő konkrét lépés az installer telepítése és kézi ellenőrzése A, majd B gépen; ezután jön a single-instance és a minimális runtime-diagnosztika.
