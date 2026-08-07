# GUI-teszt CDP-n keresztül

A min.exe WebView2 felülete Chrome DevTools Protocolon vezérelhető, ha az app
a debug porttal indul. Nem kell hozzá semmilyen npm-csomag: a Node 22 natív
WebSocketje elég.

## Indítás

A min ne fusson (a start-min.cmd blokkol, ha igen). Git Bashből:

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  "$LOCALAPPDATA/Temp/min-cargo-target/debug/min.exe"
```

A port csak localhoston él. Friss buildhez előtte: `npm run build`, majd
`CARGO_TARGET_DIR="$LOCALAPPDATA\\Temp\\min-cargo-target" cargo build
--manifest-path src-tauri/Cargo.toml --features custom-protocol`.

## Szkriptek

- `cdp-smoke.mjs` — csatlakozás, DOM-lekérdezések, PNG screenshot a szkript
  mappájába (`min-gui-smoke.png`).
- `cdp-interact.mjs` — interakció-minta: gépelés a composerbe a React-hű
  útvonalon (natív value-setter + `input` event — a sima `.value=` nem elég),
  kattintás a fázissínen, screenshot, majd a composer visszatakarítása.

## Backend-oldali igazság

A GUI mellett érdemes nézni:

- `%LOCALAPPDATA%\min\claude-bridge.log` — élő eseményfolyam (turn/delta/tool).
- `%LOCALAPPDATA%\min\min.db` — SQLite (másold le olvasás előtt, mert a futó
  app írja): `pipeline_runs`, `messages`, `turns`.
