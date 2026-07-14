# Min projektutasítások

## Kommunikáció

- Magyarul válaszolj, kivéve, ha a felhasználó más nyelvet kér.
- Vezess az eredménnyel, és csak annyi részletet adj, amennyi a döntéshez vagy a használathoz kell.
- A felhasználó RF/mikrohullámú mérnök, Python-alapú műszerautomatizálással dolgozik, és otthonos a SCPI, VISA/pyvisa, spektrumanalizátorok, jelgenerátorok és tápegységek használatában. A technikai válaszokat ehhez a szinthez igazítsd.
- Ha a feladat egyértelműen végrehajtható, ne kérj felesleges megerősítést.

## Munkavégzés

- A meglévő felhasználói fájlokat és változtatásokat őrizd meg; ne írj felül kapcsolódó munkát indoklás nélkül.
- Szöveg- és fájlkereséshez elsőként `rg`, illetve `rg --files` használandó.
- Fájlmódosítás után végezz a kockázattal arányos ellenőrzést vagy tesztet.
- Ne használj destruktív Git- vagy fájlrendszer-műveletet kifejezett felhasználói kérés nélkül.
- A projekt Tauri + React/Vite kliens; a Codex-kapcsolatot a helyi app-server kezeli.

## Fejlesztői környezet és csomagok

- Ne állítsd egyetlen sikertelen parancs alapján, hogy egy runtime vagy csomagkezelő nincs telepítve. Windows alatt ellenőrizd a `py`, `python`, `python3`, `pip`, `pip3` és `where.exe` elérhetőségét, majd a verziójukat.
- Ha a felhasználó kifejezetten csomag telepítését kéri, hajtsd végre a telepítést, ellenőrizd az importot vagy a verziót, és csak a ténylegesen sikertelen lépés után jelezd a problémát.
- Python-csomaghoz elsőként a `py -m pip` vagy `python -m pip` formát használd, ne a különálló `pip` parancsot.
- Ha maga a Python-runtime hiányzik, ne próbálj Python-csomagot telepíteni nem létező `pip` paranccsal. Ellenőrizd a gép hivatalos telepítési lehetőségeit, és adj konkrét bootstrap-lépést vagy hajtsd végre azt, ha a felhasználó telepítést kért.

## Felhasználói hangjelzések

- A válasz befejezésekor a kliens a `public/sounds/tada.wav` hangot használja.
- A figyelmeztető/input jelzéshez a `public/sounds/notify.wav` hang tartozik.
- A hangok lejátszása a kliensen történjen, rejtett CMD- vagy PowerShell-ablak megnyitása nélkül.

## Shell- és parancsfuttatás

- Githez, Pythonhoz és általános fejlesztéshez alapértelmezés szerint Bash-t használj; PowerShellt Windows-specifikus feladatokra. Ha Bash nem érhető el, használd a rendelkezésre álló shellt.
- A kapcsolódó shell-parancsokat lehetőség szerint egy stabil hívásba vond össze.
- Ne használj alügynököt, hacsak a felhasználó külön nem kéri.

## Korábbi Claude-projektmemóriák

- Ha egy régi projektben fontos előzmény vagy döntés hiányzik, keresd meg a `C:\Users\danis\.codex\imported-claude-projects` archívumot.
- A munkakönyvtárhoz illő kódolt projektmappát keresd meg, majd először csak annak `memory\MEMORY.md` indexét olvasd el.
- Ne töltsd be automatikusan az egész archivált memóriát; csak a feladathoz szükséges részt használd.
