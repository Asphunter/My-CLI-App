# Phase 7–8 – Windows release, telepítés és kétgépes qualification

> **Hatókör-megjegyzés:** ez a dokumentum a későbbi, másoknak is terjeszthető publikus release részletes referenciaterve. A jelenlegi aktív, kizárólag saját PC-re és laptopra szóló terv: [`PERSONAL_TWO_PC_RELEASE_PLAN.md`](PERSONAL_TWO_PC_RELEASE_PLAN.md).

**Dátum:** 2026-07-14  
**Állapot:** végrehajtási terv; az installer implementációja még nem kezdődött el  
**Első célkiadás:** `0.1.0-rc.1`, belső Windows x64 qualification release  
**Végső cél:** forráskód, Node.js és Rust nélkül telepíthető, frissíthető és visszaállítható `min` alkalmazás két OneDrive-os Windows gépre.

## 1. Rövid döntés

Az első terjesztési forma egy **felhasználónként települő NSIS `.exe` installer** lesz.

- Windows x64 az egyetlen első körös célplatform.
- A telepítés nem kér adminisztrátori jogot.
- A Codex x64 bináris az installer része; a telepített app nem használhatja a projekt `node_modules` mappáját.
- A build-cache és a bundle kimenet `%LOCALAPPDATA%\min\cargo-target` alatt marad, nem kerül OneDrive-ba.
- A felhasználói adatokat az installer frissítéskor és eltávolításkor sem törli automatikusan.
- Az első belső RC lehet aláíratlan, ezért SmartScreen-figyelmeztetés várható. A végleges, másoknak is átadható release kapuja a kódaláírás.
- Automatikus frissítés az első kiadásban nincs. Az első stabil folyamat kézi, verziózott installerrel történő in-place upgrade.
- Ugyanazon a gépen egyszerre csak egy `min` példány futhat.

## 2. Jelenlegi állapot és release-blokkolók

### Ami már használható alap

- A frontend production build működik.
- A Rust library tesztcsomag, a bináris check és az app-server smoke korábban sikeres volt.
- A `tauri:dev:local` és `tauri:build:local` a Cargo targetet `%LOCALAPPDATA%\min\cargo-target` alá irányítja.
- A Windows ikonok rendelkezésre állnak.
- A backend már elsőként a Tauri resource könyvtárban keresi a `codex.exe` fájlt.
- A lokális SQLite, device ID, agent snapshotok és sync backupok eleve `%LOCALAPPDATA%\min` alatt élnek.
- A közös OneDrive journal külön, append-only adatútvonalon működik.

### Kötelezően javítandó blokkolók

| Prioritás | Blokkoló | Jelenlegi bizonyíték | Elvárt megoldás |
|---|---|---|---|
| P0 | Nincs installer | `src-tauri/tauri.conf.json`: `bundle.active = false` | NSIS bundle bekapcsolása |
| P0 | A Codex nincs becsomagolva | A resource lookup létezik, de nincs `bundle.resources` | A lockolt x64 `codex.exe` közvetlenül kerüljön a bundle-be |
| P0 | A release runtime a buildgépi forrásútra eshet vissza | `workspace_cwd()` végső fallbackje a beégetett `CARGO_MANIFEST_DIR` | Külön, tartós runtime `projectsRoot` beállítás |
| P0 | A projektek gyökere a `my projects` mappanévre és a forrásmappára támaszkodik | `projects_root()` a `workspace_cwd()` őseit vizsgálja | Első indítási OneDrive-gyökér választás és lokális konfiguráció |
| P0 | Release-ben működik az env/workspace/PATH Codex fallback | `MIN_CODEX_BIN`, `node_modules`, managed plugin és PATH lookup | Release build csak hash-ellenőrzött bundled Codexet fogadhat el |
| P1 | Több apppéldány ugyanazzal a device ID-val írhat | Nincs single-instance védelem | Második indítás a meglévő ablakot fókuszálja |
| P1 | Három helyen él az appverzió | `package.json`, `Cargo.toml`, `tauri.conf.json` | Automatikus verziókonzisztencia-kapu |
| P1 | Nincs telepített runtime diagnosztika | A felhasználó nem látja, melyik EXE/Codex/adatútvonal fut | Beépített Diagnostics nézet és másolható riport |
| P1 | A CSP ki van kapcsolva | `app.security.csp = null` | Release CSP és Tauri capability review |
| P1 | Nincs reprodukálható artifact-manifest | Csak lockfájlok vannak | Verzió-, hash-, függőség- és build-manifest |

## 3. Kötelező implementációs sorrend

### 3.1 Runtime-gyökér leválasztása a forráskódról

Ez az első lépés. Installer addig nem készülhet, amíg a telepített EXE a buildgép forrásútvonalára támaszkodhat.

- Készüljön géphelyi konfiguráció:

  ```text
  %LOCALAPPDATA%\min\settings.json
  ```

- A minimális tartalom:

  ```json
  {
    "schemaVersion": 1,
    "projectsRoot": "C:\\Users\\<user>\\OneDrive\\my projects"
  }
  ```

- Első indításkor:
  1. az app megpróbálja felismerni a Windows OneDrive környezeti útvonalát;
  2. ha pontosan egy érvényes `my projects` gyökér található, azt felajánlja;
  3. egyébként mappaválasztót nyit;
  4. csak létező, írható könyvtár menthető el;
  5. a beállítás atomikusan íródik.
- A `projects_root()` kizárólag ezt a konfigurált útvonalat használja release-ben.
- A `CARGO_MANIFEST_DIR` csak debug buildben maradhat fejlesztői fallback.
- A Settings/Diagnostics nézetből a gyökér később explicit módon újraköthető, automatikusan nem változhat meg.
- A projektengedélyezés továbbra is canonical path alapján ellenőrizze, hogy a kiválasztott projekt a konfigurált gyökér alatt van.

Elfogadási feltétel:

- az installerrel telepített app a forrásmappa átnevezése vagy hiánya mellett is elindul;
- A és B gép eltérő abszolút OneDrive útvonalával ugyanazokat a relatív projekteket látja;
- a telepített app semmilyen buildgépi `C:\Users\...\my AI CLI app` útvonalat nem használ.

### 3.2 Pinned, bundled Codex runtime

A jelenleg lockolt runtime:

```text
@openai/codex 0.144.1
codex-cli 0.144.1
Windows x64 codex.exe: 325.39 MiB
```

Megvalósítás:

- A Tauri `bundle.resources` közvetlenül csomagolja be ezt a lockolt fájlt:

  ```text
  node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe
  ```

- A célútvonal a resource könyvtár gyökerében `codex.exe`, mert a backend ezt keresi.
- Ne készüljön külön 325 MiB-os staging másolat a OneDrive-os projektmappában.
- Készüljön `release:preflight` ellenőrzés, amely:
  - ellenőrzi a fájl létezését és x64 architektúráját;
  - lefuttatja a `codex.exe --version` parancsot;
  - összeveti a verziót a lockolt `@openai/codex` verzióval;
  - SHA-256 hash-t készít;
  - ellenőrzi az Authenticode státuszt;
  - a kapott adatokat a release manifestbe írja.
- Release buildben a `MIN_CODEX_BIN`, workspace `node_modules`, managed plugin és PATH fallback legyen letiltva. Ezek debug buildben megmaradhatnak.
- A bundled hash vagy verzió eltérésekor a Codex-funkció nem indulhat el; az app olvasható diagnosztikai módban maradjon, egyértelmű hibával.
- A telepített gépen Node.js, npm és Rust nem lehet runtime-követelmény.

Elfogadási feltétel:

- a Diagnostics a telepítési resource könyvtárból futó `codex.exe` útvonalát mutatja;
- a forrásmappa és a felhasználói PATH nélkül is sikerül az `initialize` és `thread/start` smoke;
- a Codex folyamat rejtett ablakban indul.

### 3.3 Tauri NSIS bundle beállítása

Tervezett konfiguráció:

- `bundle.active = true`;
- `bundle.targets = ["nsis"]`;
- current-user telepítés;
- magyar és angol installer-nyelv;
- meglévő `icon.ico` használata;
- WebView2 `downloadBootstrapper`, silent módban;
- downgrade tiltása;
- stabil `identifier = "hu.danis.min"` megtartása;
- az alkalmazás neve és fő bináris neve maradjon `min`.

Az első installer várható kimenete:

```text
%LOCALAPPDATA%\min\cargo-target\release\bundle\nsis\min_0.1.0_x64-setup.exe
```

Az installer feladata:

- telepítés a jelenlegi felhasználónak adminjog nélkül;
- Start menü bejegyzés;
- in-place upgrade azonos identifier mellett;
- a futó app kulturált lezárásának kérése upgrade előtt;
- az alkalmazásfájlok cseréje;
- a `%LOCALAPPDATA%\min` és a OneDrive journal érintetlenül hagyása.

Az installernek tilos:

- `%LOCALAPPDATA%\min\min.db` törlése;
- `%LOCALAPPDATA%\min\sync-device-id` újragenerálása upgrade során;
- `.min-sync` tartalom módosítása telepítés vagy uninstall közben;
- a projekt forrásmappájába release EXE-t vagy Cargo targetet másolni.

### 3.4 Single-instance, CSP és diagnosztika

- Kerüljön be single-instance védelem. A második indítás a már futó ablakot aktiválja.
- Release CSP legyen explicit és minimális; `csp: null` nem maradhat.
- A Tauri capabilities listája csak a ténylegesen használt funkciókat engedélyezze.
- Készüljön Diagnostics nézet vagy másolható diagnosztikai riport az alábbi mezőkkel:
  - appverzió;
  - EXE útvonala;
  - build típusa;
  - bundled Codex útvonala, verziója és hash-e;
  - `projectsRoot`;
  - lokális SQLite útvonala, schema-verziója és integrity állapota;
  - device ID és annak fájlútvonala;
  - OneDrive journal és quarantine útvonala;
  - utolsó sync health;
  - WebView2 verzió, ha lekérdezhető.
- A riport nem tartalmazhat auth tokent, prompttartalmat vagy fájltartalmat.
- Készüljön lokális, rotált release log. Érzékeny adatok alapból legyenek redaktálva.

### 3.5 Verziózás és release-parancsok

Egy release-verzió csak akkor érvényes, ha ugyanaz az érték szerepel itt:

```text
package.json
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
```

Készüljön gépi kapu, amely eltérésnél megszakítja a buildet.

Javasolt npm parancsok:

```text
release:preflight    runtime, verzió, ikon, lockfájl és Codex ellenőrzés
release:test         frontend build + Rust tesztek + bin check + app-server smoke
release:build        NSIS build a lokális Cargo targetbe
release:verify       installer, PE, hash, aláírás és manifest ellenőrzés
release:package      verziózott átadási könyvtár elkészítése
```

A build reprodukálhatóságának alapja:

- `npm.cmd ci`, nem kézi dependency-frissítés;
- `package-lock.json` és `src-tauri/Cargo.lock` kötelező;
- a build előtt nincs dependency-major upgrade;
- a release manifest tartalmazza:
  - appverzió;
  - build időpont;
  - target triple;
  - Tauri CLI verzió;
  - Rust verzió;
  - Codex verzió és SHA-256;
  - `package-lock.json` és `Cargo.lock` SHA-256;
  - installer SHA-256;
  - forrás revision vagy – működő Git hiányában – determinisztikus source-tree hash.

## 4. Kötelező release pipeline

### 4.1 Preflight

```powershell
cd "C:\Users\danis\OneDrive\my projects\my AI CLI app"
npm.cmd ci
npm.cmd run release:preflight
```

A preflightnak fail-closed módon kell leállnia hiányzó vagy eltérő Codex, verzióeltérés, hibás ikon, hiányzó lockfájl vagy nem támogatott architektúra esetén.

### 4.2 Minőségi kapu

```powershell
npm.cmd run build
npm.cmd run smoke:app-server
$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\min\cargo-target"
cargo test --manifest-path src-tauri\Cargo.toml --lib
cargo check --manifest-path src-tauri\Cargo.toml --bins
```

Későbbi végleges release-kapu:

- `npm audit` high/critical nélkül;
- `cargo audit` high/critical nélkül;
- licenc- és SBOM riport;
- CSP/capability ellenőrzés.

### 4.3 Installer build

```powershell
npm.cmd run tauri:build:local
```

A build után csak a verziózott installer, manifest, checksum és release notes kerülhet az átadási mappába. A teljes Cargo target nem másolandó OneDrive-ba.

### 4.4 Artifact ellenőrzés

- Installer SHA-256 újraszámítása.
- PE x64 ellenőrzés.
- NSIS telepítés és uninstall teszt.
- Bundled `codex.exe` jelenlétének és hash-ének ellenőrzése.
- Authenticode státusz rögzítése.
- Az installer neve tartalmazza a verziót és architektúrát.
- A manifestben szereplő és tényleges fájlhash egyezzen.

## 5. Telepítési és frissítési runbook két gépre

### 5.1 Első RC telepítés

1. A és B gépen zárd be a dev appot és minden kézzel indított `min.exe` példányt.
2. Mindkét gépen legyen zöld OneDrive sync.
3. Egy gépen készüljön igazolt v2 retention backup; mindkét gépen készüljön lokális másolat a `%LOCALAPPDATA%\min` mappáról.
4. Telepítsd A gépre azt az installer buildet, amelynek SHA-256 hash-e egyezik a manifesttel.
5. Az első indításkor válaszd ki A gép saját OneDrive `my projects` gyökerét.
6. Ellenőrizd a Diagnostics riportot és egy fájlmódosítás nélküli Codex-kérést.
7. Telepítsd ugyanazt a buildet B gépre, majd válaszd ki B saját OneDrive gyökerét.
8. Ellenőrizd, hogy a két device ID különböző maradt, és mindkét gép ugyanazt a journal állapotot látja.
9. Futtasd le a rövid qualification mátrixot.

### 5.2 Kézi upgrade

- Ugyanazt az új verziót kell telepíteni mindkét gépre.
- Upgrade előtt az appokat be kell zárni és a syncnek konvergálnia kell.
- Az installer nem változtathatja meg a device ID-t vagy a `projectsRoot` beállítást.
- SQLite schema-emelés előtt automatikus lokális backup szükséges.
- Újabb, nem támogatott sync schema esetén a régi app csak olvasható karanténba léphet; nem írhat vissza.
- Sync/event schema-emelést nem szabad egyszerű installer-javítással összekeverni. Ahhoz külön kétgépes migrációs terv kell.

### 5.3 Rollback

- Az első kiadásban az automatikus downgrade tiltott.
- UI-only vagy schema-semleges hibánál a korábbi installer csak dokumentált, kompatibilis rollbackként használható.
- Store- vagy sync-schema változás után rollback kizárólag a release előtti lokális backupból és igazolt journal backupból történhet.
- A rollback soha nem törölheti automatikusan a közös journal újabb eventjeit.

### 5.4 Uninstall és újratelepítés

- Az uninstall az alkalmazást távolítja el, a felhasználói adatot alapból megtartja.
- Teljes adatreset csak külön, explicit és többször megerősített művelet lehet.
- Újratelepítés után ugyanazon a gépen ugyanaz a device ID használható tovább, ha a helyi adat nem lett kézzel törölve.

## 6. Qualification tesztmátrix

### 6.1 Telepített runtime

- [ ] Start menüből indul, PowerShell nélkül.
- [ ] Nem szükséges Node.js, npm, Rust vagy a forrásmappa.
- [ ] A Diagnostics bundled Codex útvonalat mutat.
- [ ] Codex modellek betöltődnek és egy kérés sikeresen lefut.
- [ ] Második appindítás nem hoz létre második írható példányt.
- [ ] Windows reboot után az app és a lokális adatok épek.
- [ ] A mappaválasztó szóközt és ékezetes útvonalat is kezel.

### 6.2 Adatmegőrzés

- [ ] Dev buildről installer buildre váltva minden projekt és beszélgetés megmarad.
- [ ] In-place upgrade után a `min.db`, device ID és settings megmarad.
- [ ] Uninstall/újratelepítés után az adat megmarad.
- [ ] Sérült vagy újabb SQLite schema fail-closed diagnosztikát ad.
- [ ] OneDrive nélkül indulva a lokális adat olvasható, a sync nem ír vakon.

### 6.3 Kétgépes telepített működés

- [ ] A és B ugyanazt az installer SHA-256 buildet futtatja.
- [ ] A és B eltérő lokális device ID-t használ.
- [ ] A és B saját abszolút OneDrive útvonala ugyanarra a relatív projektállapotra képeződik.
- [ ] Online, offline/reconnect és párhuzamos írás után az állapot konvergál.
- [ ] Aktív válasz és WorkFlow a másik gépen helyes sorrendben jelenik meg.
- [ ] App kill és újraindítás után nincs duplikált vagy elveszett üzenet.
- [ ] Az egyik gép upgrade-je alatt a másik régi verziója nem tud ismeretlen sémára írni.

### 6.4 Installer-specifikus hibák

- [ ] SmartScreen viselkedés dokumentált.
- [ ] WebView2 hiánya esetén az installer helyreállítja vagy érthető hibát ad.
- [ ] Kevés lemezhely esetén a telepítés nem hagy félkész írható állapotot.
- [ ] Futó app melletti upgrade nem sérti az adatokat.
- [ ] Az installer megszakítása után a korábbi verzió vagy az új verzió konzisztensen indul.

## 7. Aláírás és frissítési csatorna

### Belső RC

- Az `0.1.0-rc.1` saját A/B gépes qualification céljára lehet aláíratlan.
- A SHA-256 manifest kötelező.
- A SmartScreen figyelmeztetés ebben a körben ismert, dokumentált korlát.

### Végleges kiadás

- Kódaláíró tanúsítvány és időbélyegzés szükséges.
- Az installer és az alkalmazás EXE aláírását release-kapu ellenőrzi.
- Automatikus updater csak aláírt artifacttal, külön update-manifesttel és tesztelt rollbackkel kapcsolható be.
- Az updater nem előzheti meg a kétgépes verziókompatibilitás megoldását.

## 8. Kiadási artifactok

Egy átadható release könyvtár tartalma:

```text
min-0.1.0-rc.1-windows-x64/
  min_0.1.0-rc.1_x64-setup.exe
  SHA256SUMS.txt
  release-manifest.json
  RELEASE_NOTES.md
  INSTALL.md
  RESTORE_RUNBOOK.md
```

Nem kerül bele:

- `target` vagy Cargo cache;
- `node_modules`;
- lokális SQLite vagy device ID;
- auth fájl;
- prompt-, chat- vagy projektfájltartalom;
- agent snapshot.

## 9. Definition of Done

A release/telepítési folyamat akkor tekinthető késznek, ha:

- [ ] a source-path és `CARGO_MANIFEST_DIR` release függés megszűnt;
- [ ] a Codex pinned, bundled és hash-ellenőrzött;
- [ ] az NSIS installer forrásmappa és dev toolchain nélkül működik;
- [ ] a single-instance védelem aktív;
- [ ] a CSP/capability hardening elkészült;
- [ ] a verzió és lockfájl kapuk automatizáltak;
- [ ] a teljes release test pipeline egy paranccsal futtatható;
- [ ] az installerhez manifest és SHA-256 készül;
- [ ] upgrade, uninstall/újratelepítés és rollback drill dokumentált;
- [ ] A és B gép telepített builddel adatvesztés nélkül konvergál;
- [ ] végleges terjesztésnél az installer aláírt és időbélyegzett.

## 10. Következő konkrét implementációs szelet

Az első kódolási csomag határa:

1. tartós `projectsRoot` és első indítási gyökérválasztás;
2. release-only bundled Codex és preflight hash/version check;
3. `bundle.active = true`, NSIS current-user konfiguráció;
4. single-instance védelem;
5. verziókonzisztencia- és release build parancsok;
6. helyi installer build és egygépes installed smoke.

Csak ennek sikeres lefutása után következik a kétgépes installer qualification, majd a kódaláírás és az automatikus updater kérdése.
