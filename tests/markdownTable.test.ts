import assert from "node:assert/strict";
import test from "node:test";

import { isTableSeparator, markdownTableAt } from "../src/markdownTable.ts";

test("a fejléc és a törzs cellái a keret nélkül állnak elő", () => {
  const lines = [
    "| Fájl | Tartalom |",
    "|---|---|",
    "| smith_chart.py | a diagram rajzolása |",
    "| tline_math.py | a reflexiós tényező |",
  ];
  const table = markdownTableAt(lines, 0);
  assert.ok(table);
  assert.deepEqual(table.header, ["Fájl", "Tartalom"]);
  assert.deepEqual(table.rows, [
    ["smith_chart.py", "a diagram rajzolása"],
    ["tline_math.py", "a reflexiós tényező"],
  ]);
  assert.equal(table.end, 4);
});

test("a szeparátor igazítás-jelekkel is szeparátor", () => {
  assert.ok(isTableSeparator("|:---|---:|:--:|"));
  assert.ok(isTableSeparator(" --- | --- "));
  // Tartalom, nem keret: van benne betű.
  assert.equal(isTableSeparator("| a | b |"), false);
  assert.equal(isTableSeparator("csak szöveg"), false);
});

test("szeparátor nélkül a csöves mondat nem lesz tábla", () => {
  // Enélkül egy „A | B" alakú mondat táblává esett volna szét.
  assert.equal(markdownTableAt(["Bal | jobb", "és a folytatás"], 0), null);
});

test("egyoszlopos tábla nem mond többet a bekezdésnél", () => {
  assert.equal(markdownTableAt(["| Fájl |", "|---|", "| a.py |"], 0), null);
});

test("a tábla a saját utolsó soránál véget ér", () => {
  const lines = [
    "Bevezető mondat.",
    "| Paraméter | Érték |",
    "| --- | --- |",
    "| Z0 | 100 Ω |",
    "Záró mondat.",
  ];
  assert.equal(markdownTableAt(lines, 0), null);
  const table = markdownTableAt(lines, 1);
  assert.ok(table);
  assert.deepEqual(table.rows, [["Z0", "100 Ω"]]);
  assert.equal(table.end, 4);
});

test("a hiányzó cella nem csúsztatja el a sort", () => {
  // A modell néha rövidebb sort ír; a hívó a fejléc szerint tölti fel.
  const table = markdownTableAt(
    ["| a | b | c |", "|---|---|---|", "| 1 | 2 |"],
    0,
  );
  assert.ok(table);
  assert.deepEqual(table.rows, [["1", "2"]]);
});
