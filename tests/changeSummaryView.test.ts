import assert from "node:assert/strict";
import test from "node:test";
import {
  changeRowLabels,
  changeSummaryView,
  churnOf,
  fileNameOf,
  sortChangeSummary,
  type ChangeSummaryRow,
} from "../src/changeSummaryView.ts";

const file = (
  path: string,
  added: number,
  removed = 0,
  status: ChangeSummaryRow["status"] = "added",
): ChangeSummaryRow => ({ path, added, removed, status });

test("a sorrend a tényleges változás mérete, nem az érkezés", () => {
  // A 45 fájlos futáson mérve: a `.gitignore +2` vezetett, a `device.py +267`
  // a 21. sor volt.
  const sorted = sortChangeSummary([
    file(".gitignore", 2),
    file("homemade_vna/device.py", 267),
    file("CACHEDIR.TAG", 4),
    file("homemade_vna/max2871.py", 244),
  ]);
  assert.deepEqual(
    sorted.map((row) => fileNameOf(row.path)),
    ["device.py", "max2871.py", "CACHEDIR.TAG", ".gitignore"],
  );
});

test("a churn a hozzáadott és eltávolított sorok összege", () => {
  assert.equal(churnOf({ added: 12, removed: 30 }), 42);
  const sorted = sortChangeSummary([file("a.py", 40), file("b.py", 5, 50)]);
  assert.deepEqual(sorted.map((row) => row.path), ["b.py", "a.py"]);
});

test("azonos churn esetén a név dönt, tehát a sorrend determinisztikus", () => {
  const rows = [file("z.py", 10), file("a.py", 10), file("m.py", 10)];
  assert.deepEqual(
    sortChangeSummary(rows).map((row) => row.path),
    ["a.py", "m.py", "z.py"],
  );
  // Ugyanaz a bemenet kétszer ugyanazt adja, és az eredetit nem írja át.
  assert.deepEqual(sortChangeSummary(rows), sortChangeSummary(rows));
  assert.deepEqual(rows.map((row) => row.path), ["z.py", "a.py", "m.py"]);
});

test("a nulla-változású fájlok külön csoportba kerülnek, de nem tűnnek el", () => {
  const view = changeSummaryView([
    file("cli.cpython-311.pyc", 0),
    file("device.py", 267),
    file("sweep.cpython-311.pyc", 0),
    file("py.typed", 0),
  ]);
  assert.deepEqual(view.changed.map((row) => row.path), ["device.py"]);
  assert.equal(view.untouched.length, 3);
  // Együtt a teljes lista — a csoportosítás nem szűr.
  assert.equal(view.changed.length + view.untouched.length, 4);
});

test("a −0 oszlop csak akkor jelenik meg, ha tényleg töröltek valamit", () => {
  assert.equal(changeSummaryView([file("a.py", 10), file("b.py", 4)]).showRemoved, false);
  assert.equal(
    changeSummaryView([file("a.py", 10), file("b.py", 4, 1)]).showRemoved,
    true,
  );
});

test("a státusz-badge csak akkor jelenik meg, ha többféle státusz van", () => {
  const allNew = [file("a.py", 10), file("b.py", 4)];
  assert.equal(changeSummaryView(allNew).showStatus, false);
  const mixed = [file("a.py", 10), file("b.py", 4, 2, "modified")];
  assert.equal(changeSummaryView(mixed).showStatus, true);
});

test("ütköző fájlneveknél a szülőmappa is kiíródik", () => {
  // Két README.md sor korábban csak a számaiban különbözött.
  const labels = changeRowLabels([
    file("app/README.md", 8),
    file("docs/README.md", 63),
    file("src/device.py", 267),
  ]);
  assert.deepEqual(labels, ["app/README.md", "docs/README.md", "device.py"]);
});

test("a szülőmappa Windows-elválasztóval is előjön, gyökérfájlnál nem", () => {
  const labels = changeRowLabels([
    file("app\\README.md", 8),
    file("docs\\README.md", 63),
  ]);
  assert.deepEqual(labels, ["app/README.md", "docs/README.md"]);
  assert.deepEqual(changeRowLabels([file("README.md", 1)]), ["README.md"]);
});

test("üres lista nem borul fel", () => {
  const view = changeSummaryView([]);
  assert.deepEqual(view.changed, []);
  assert.deepEqual(view.untouched, []);
  assert.equal(view.showRemoved, false);
  assert.equal(view.showStatus, false);
  assert.deepEqual(changeRowLabels([]), []);
});
