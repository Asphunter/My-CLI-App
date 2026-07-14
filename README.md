# min — saját, kompakt ChatGPT workspace

Ez egy Windows desktop app első működő váza Tauri 2 + React + TypeScript + Vite alapon. A felület célja a Codex-szerű munkatér megtartása sokkal kisebb betűvel, sorközzel és vizuális zajjal.

## Jelenlegi állapot

- bal oldali, összecsukható projektfa és beszélgetéslista;
- minden üzenet balra rendezve, a saját üzenetek halványzöld háttérrel;
- állítható betűméret és sorköz, helyi mentéssel;
- jobb oldali kódváltozás-panel diff-előnézettel;
- `Ctrl/Cmd + K` parancspaletta;
- Tauri 2 Windows shell saját ikonnal;
- hivatalos Codex app-server bekötés Tauri oldalon;
- ChatGPT/Codex bejelentkezéssel működő streaming válaszok, külön API-kulcs nélkül;
- beszélgetésenként megőrzött Codex thread ID.

## Fejlesztés

Új PowerShell-ablakban, a projekt mappájából:

```powershell
npm.cmd install
npm.cmd run dev
```

Natív Tauri fejlesztői ablak:

```powershell
npm.cmd run tauri -- dev
```

Release build:

```powershell
npm.cmd run tauri -- build
```

A jelenlegi futtatható build:

```text
src-tauri\target\release\min.exe
```

## Hitelesítés

Az app nem a Responses API-t hívja közvetlenül, és nem olvassa vagy másolja ki az `auth.json` tartalmát. A hivatalos Codex app-server indul el helyi folyamatként, amely a gépen már bejelentkezett ChatGPT/Codex munkamenetet használja. Emiatt a ChatGPT-előfizetésedhez tartozó Codex-hozzáférés fogy, nem külön API-kulcsos számlázás.

Ha a Codex desktop appban vagy CLI-ban kijelentkezel, az app következő kérése újrahitelesítést igényelhet. A projekt a hivatalos `@openai/codex` csomag Windows binárisát használja.

## Közös projektinstrukciók

A közös szabálysablon a projektgyűjtemény gyökerében található:

```text
C:\Users\danis\OneDrive\my projects\AGENTS.md
```

Az app ezt automatikusan bemásolja egy új projektbe, illetve egy meglévő projekt első megnyitásakor, ha ott még nincs `AGENTS.md` vagy `AGENTS.override.md`. Meglévő instrukciófájlt nem ír felül.

## Következő fejlesztési lépés

Az AI-réteg Tauri oldali adapterként működik. Ez kezeli a helyi Codex app-servert, a streaming választ és a thread-folytatást; a frontend csak eseményeket és megjelenítést kap.

A következő lépés a valódi fájlesemények és diffek bekötése, majd a projektenkénti munkakönyvtár-választó. A projektek, beszélgetések, üzenetek és változáscsomagok helyi SQLite-tárolóba kerülhetnek.
