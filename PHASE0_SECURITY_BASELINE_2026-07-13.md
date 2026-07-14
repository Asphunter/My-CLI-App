# Phase 0 biztonsági baseline

**Dátum:** 2026-07-13  
**Projekt:** `min`  
**Cél:** a biztonsági refaktor előtt legyen OneDrive-tól független, bytepontos visszaút.

## Elkészült baseline

A projekt aktuális forrásmentése és a sync-állapotok másolata itt található:

```text
C:\Users\danis\AppData\Local\min\phase0-baselines\20260713-003928
```

A mentés nem módosította a projektet vagy a `.min-sync` fájlokat. A forrásmásolatból a generált/nagy könyvtárak ki lettek hagyva: `node_modules`, `dist`, `target`, `.pnpm-store`, `.git`, `.min-sync`. A canonical sync-másolat a `canonical-sync` almappában, a workspace legacy-másolata a `.min-sync` almappában található. A pontos másolási listát és hash-eket a `baseline-manifest.json` tartalmazza.

### Canonical sync-állapotok

Forrás: `C:\Users\danis\OneDrive\my projects\.min-sync`

| Fájl | Méret | SHA-256 | Másolat bytepontos |
|---|---:|---|---|
| `state.json` | 67145 | `73E06CF935F05596427D5A8FBA7AEF3560F6D8C5611EA2F7D5163D075B18CC15` | igen |
| `state.json.bak` | 67145 | `BA0686684E3C78A6813DC5251E4CA6E431898EB3C4D4D36E1392BBB4390E72D8` | igen |

A canonical `state.json` diagnosztikai darabszámai: schema 1, 2 projekt, 2 beszélgetés, 34 üzenet, 36 work item.

### Workspace legacy sync-állapotok

Forrás: `C:\Users\danis\OneDrive\my projects\my AI CLI app\.min-sync`

| Fájl | Méret | SHA-256 | Másolat bytepontos |
|---|---:|---|---|
| `.min-sync/state.json` | 1623 | `5DEC0EDC86F02507560A1A53DD1062A89C7CD920E4601259BF3DC85A8E624C8B` | igen |
| `.min-sync/state.json.bak` | 1290 | `A8E88127B21D4198AA4B5DD851B31F13B2DA50890E0F3E198C6B236852B11D9D` | igen |

A workspace legacy `state.json` diagnosztikai darabszámai: schema 1, 1 projekt, 1 beszélgetés, 4 üzenet, 1 work item.

## Repository-diagnózis

- A `.git` könyvtár OneDrive Microsoft reparse point (`0x9000601a`), nem használható lokális Git-repositoryként.
- A `git status --short` eredménye: `not a git repository`.
- Emiatt a visszaállítás jelenleg a fenti lokális baseline-másolatra támaszkodik; Git-alapú rollbackről külön döntés szükséges.

## Phase 0 mentési szabály

Minden további, adatmodellt vagy sync-írást érintő változtatás előtt:

1. A `.min-sync/state.json` és `.min-sync/state.json.bak` SHA-256 hash-elt, dátumozott másolata készüljön a `%LOCALAPPDATA%\min\phase0-baselines\<timestamp>` alatt.
2. A forráskód OneDrive-on kívüli másolata készüljön; a generált könyvtárak nem szükségesek a rollbackhez.
3. A hash-eket és a rekorddarabszámokat a baseline-manifestben rögzíteni kell.
4. Az eredeti OneDrive-fájlokat nem szabad javítás vagy migráció közben felülírni.
5. Visszaállítás csak leállított app és ellenőrzött hash-egyezés után történhet.

## Első védelmi változtatás

A frontend csak validált sync-állapot után engedélyezi a távoli mentést. Hiányzó, sérült, ismeretlen sémájú vagy betöltési hibás állapotnál helyi/karantén mód marad aktív. A Rust backend ugyanezt újraellenőrzi, és a jelenlegi single-file modellben másik eszköz állapotát nem írja felül automatikusan. Ha csak a workspace legacy állapot létezik, explicit migráció nélkül a canonical sync-fájlba sem ír.
