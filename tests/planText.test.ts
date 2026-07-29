import assert from "node:assert/strict";
import test from "node:test";

import {
  numberedPlanLines,
  numberedPlanSteps,
  planStepSlice,
  planStepTitle,
} from "../src/planText.ts";

const PLAN = [
  "A terv a Smith-chart animációjára.",
  "",
  "1. **Smith-chart megjelenítő fájl** – A meglévő chart-komponensben rögzíteni kell a paramétereket: \\(Z_0=100\\,\\Omega\\).",
  "2. **Számítási/modellfájl** – Bevezetni az elektromos hossz változóját:",
  "   \\[ \\Gamma(\\theta)=\\Gamma_L e^{-j2\\theta} \\]",
  "3. **Animációs/UI-fájl** – Animálni kell az elektromos hosszúságot nulláról \\(2\\pi\\)-ig.",
  "",
  "Kockázatok: a fázis könnyen elcsúszik.",
].join("\n");

test("a lista a pontok címét mutatja, nem a teljes bekezdést", () => {
  // Ez volt a hiba: a LÉPÉSEK panel a terv szó szerinti másolata lett, mert a
  // teljes számozott sor került a lépés szövegébe.
  assert.deepEqual(
    numberedPlanSteps(PLAN).map((step) => step.step),
    ["Smith-chart megjelenítő fájl", "Számítási/modellfájl", "Animációs/UI-fájl"],
  );
});

test("a cím határa a vastag fej, a gondolatjel vagy a kettőspont", () => {
  assert.equal(
    planStepTitle("1. **Tesztfájl vagy kézi ellenőrzési lista** – Ellenőrizni kell:"),
    "Tesztfájl vagy kézi ellenőrzési lista",
  );
  assert.equal(
    planStepTitle("2. Számítási modellfájl – bevezetni a változót"),
    "Számítási modellfájl",
  );
  assert.equal(
    planStepTitle("3. Chart-overlay: az aktuális érték kiírása"),
    "Chart-overlay",
  );
  // A szóközök nélküli kötőjel egy szó belseje, nem határ.
  assert.equal(planStepTitle("4. Smith-chart frissítése"), "Smith-chart frissítése");
});

test("a cím nélküli, hosszú pont rövidítve kerül a listába", () => {
  const long = `5. ${"a".repeat(140)}`;
  const title = planStepTitle(long);
  assert.equal(title.length, 89);
  assert.ok(title.endsWith("…"));
});

test("a nyers sorok megmaradnak a fájlnév-kereséshez", () => {
  // A lépés-léptetés a fájlnevet a pont magyarázatában keresi; a rövid cím
  // önmagában nem tartalmazza.
  const lines = numberedPlanLines("1. **Modell** – írd meg a smith_chart_model.mjs fájlt");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("smith_chart_model.mjs"));
});

test("egy pont szelete a következő pontig tart", () => {
  const slice = planStepSlice(PLAN, 1);
  assert.ok(slice.startsWith("2. **Számítási/modellfájl**"));
  assert.ok(slice.includes("Gamma(\\theta)"));
  assert.ok(!slice.includes("Animációs"));
  assert.equal(planStepSlice(PLAN, 9), "");
});

test("számozott pont nélkül nincs lista", () => {
  assert.deepEqual(numberedPlanSteps("Csak folyó szöveg, felsorolás nélkül."), []);
});
