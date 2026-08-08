import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const bridge = readFileSync(
  new URL("../agent-bridge/main.mjs", import.meta.url),
  "utf8",
);

test("két assistant-üzenet határa bekezdéshatár lesz a válaszban", () => {
  // A híd az itemId-be teszi, hányadik üzenetről van szó — a felületnek ezt
  // kell bekezdésre fordítania. Enélkül a delták vakon fűződtek egymáshoz, és
  // a mentett válasz „…ellenőrzöm:A forrás fájlok rendben." lett: a sorok
  // összeolvadtak, a felsorolás eltűnt a lezárt válaszból.
  assert.match(bridge, /assistant-\$\{turn\.assistantTexts\.length\}-\$\{raw\.index\}/);
  assert.match(app, /const previousItemId = stream\.meta\?\.itemId;/);
  assert.match(
    app,
    /meta\.itemId && previousItemId && meta\.itemId !== previousItemId\s*\?\s*"\\n\\n"\s*:\s*""/,
  );
  assert.match(app, /stream\.pending \+= `\$\{boundary\}\$\{delta\}`;/);
  // A határt a `meta` felülírása *előtt* kell kiolvasni, különben mindig
  // önmagával hasonlítanánk össze.
  const enqueueBody = app.slice(app.indexOf("const enqueueAnswerDelta"));
  assert.ok(
    enqueueBody.indexOf("const previousItemId") <
      enqueueBody.indexOf("stream.meta = meta;"),
    "a korábbi itemId-t a meta felülírása előtt kell kiolvasni",
  );
});

test("bukott futásnál a hiba a válasz, nem az előző verzió", () => {
  // Egy húsz perces DeepSeek-kör körlimitre bukott, és a kártyán a *megelőző*
  // Claude-hiba jelent meg, mintha az lett volna az új futás eredménye.
  assert.match(
    app,
    /stripStaleInterruptionMarker\(message\)\.text\.trim\(\) \|\|\s*`Nem sikerült a \$\{providerName\}-kérés/,
  );
});

test("nem létező fázisra mutató kiválasztás nem tünteti el a VÁLASZ panelt", () => {
  // Minden szakasz-kártya csak akkor rajzol, ha ő a kiválasztott. Ha a
  // kiválasztott slotnak ebben a verzióban nincs üzenete, a feltétel
  // mindegyikre igaz lett, és az egész panel eltűnt — a rossz index pedig a
  // state-ben maradt, tehát csak újraindítással jött vissza.
  assert.match(app, /const requestedStage = stage/);
  assert.match(
    app,
    /const resolvableStages = stage\s*\?\s*slotsOfChain\(chain\)\.filter\(/,
  );
  assert.match(
    app,
    /resolvableStages\.includes\(requestedStage\)\s*\?\s*requestedStage\s*:\s*\(resolvableStages\.at\(-1\) \?\? requestedStage\)/,
  );
});

test("a re-run jelölőjét ugyanaz a feltétel írja ki, mint ami beváltja", () => {
  // A jelölő kiírása lazább feltételen állt, mint a beváltása: ha a re-run
  // lefutott (nincs `pipelineProgress`), de a `chain.resume` a futáskezelőben
  // maradt, a szűrő kidobta a jelölőt — és a lánc kártyája eltűnt a
  // beszélgetésből, amíg a GUI-t újra nem indították.
  assert.match(
    app,
    /if \(stage && liveRunResume\?\.chainKey === chainKey && pipelineProgress\) \{\s*return LIVE_RERUN_SLOT;/,
  );
  assert.match(
    app,
    /const rerunInPlace = Boolean\(\s*liveRunResume && pipelineProgress && hasLiveRerunSlot,\s*\)/,
  );
  // A kidobó ág megmarad védőhálónak, de a fenti feltétel mellett már nem
  // érhet el hozzá élő jelölő.
  assert.match(app, /timelineContent\.filter\(\(node\) => node !== LIVE_RERUN_SLOT\)/);
});

test("a tervbíráló nem kéri számon a még meg sem valósított fájlokat", () => {
  const pipeline = readFileSync(
    new URL("../src-tauri/src/pipeline.rs", import.meta.url),
    "utf8",
  );
  assert.match(pipeline, /A terv SZÖVEG, nem megvalósítás/);
  assert.match(pipeline, /még nem léteznek, és nem is kell létezniük/);
});

test("nincs alapértelmezett körlimit, és a bridge ilyenkor el sem küldi", () => {
  assert.match(app, /const DEFAULT_CLAUDE_MAX_TURNS = "";/);
  assert.match(app, /const claudeTurnLimit = \(value: string\): number \| null/);
  assert.match(app, /maxTurns: claudeTurnLimit\(claudeMaxTurns\)/);
  // A régi `: 1` fallback egyetlen körre vágta volna a munkát.
  assert.match(
    bridge,
    /typeof payload\.maxTurns === "number" && payload\.maxTurns > 0\s*\?\s*payload\.maxTurns\s*:\s*null/,
  );
  assert.match(bridge, /\.\.\.\(maxTurns \? \{ maxTurns \} : \{\}\),/);
});
