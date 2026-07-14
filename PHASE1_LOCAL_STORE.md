# Phase 1 – lokális store

## Elkészült

- A gépenkénti SQLite-adatbázis helye `%LOCALAPPDATA%\min\min.db`.
- A DB WAL módban, foreign-key ellenőrzéssel és `user_version` alapú migrációval indul.
- Indulás előtt read-only `integrity_check` ellenőrzi a meglévő adatbázist. Hiba vagy újabb schema esetén recovery/karantén állapot keletkezik, automatikus felülírás nélkül.
- A schema projekteket, beszélgetéseket, üzeneteket, turnöket, work itemeket, approvalokat, sync-eventeket, cursorokat, backupokat és import-provenance rekordokat tartalmaz.
- A Tauri backend typed `local_store_health`, `local_store_initialize`, `local_store_import_v1`, `local_store_load` és `local_store_save` parancsokat ad.
- Induláskor a kliens inicializálja a DB-t, copy-only módon importálja a canonical és legacy v1 `state.json` forrásokat, majd a SQLite snapshotból hidratálja a projekt-, üzenet- és work-item állapotot.
- A korábbi localStorage-adatokkal a hidratálás uniont képez; a SQLite-adat marad elsődleges, a localStorage pedig csak böngészős fallback és UI-preferencia marad.

## Repository invariánsok

1. A v1 forrásfájlokat az importer csak olvassa; a forrás byte-jai nem változnak.
2. Az import és a typed snapshot mentése SQLite-tranzakcióban történik.
3. A projekt-, beszélgetés-, üzenet- és work-item azonosítók determinisztikus UUIDv5-alapúak, így az ismételt mentés nem duplikál rekordokat.
4. A teljes snapshotból hiányzó aktív rekordok archiválódnak, hard delete nélkül.
5. Ismeretlen vagy hibás schema/integrity esetén a lokális írás letiltódik.

## Tudatos korlát

A OneDrive `state.json` távoli szinkronja még a korábbi v1, fail-closed egyfájlos kompatibilitási réteg. A lokális domain-adat már SQLite repository-n keresztül működik; a következő szelet az append-only sync-event/cursor réteg bekötése és a v1 távoli állapot fokozatos kiváltása.
