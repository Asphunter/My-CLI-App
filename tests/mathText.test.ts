import assert from "node:assert/strict";
import test from "node:test";

import { mathPattern, parseMath } from "../src/mathText.ts";

const scan = (text: string) => text.match(new RegExp(mathPattern.source, "g")) ?? [];

test("a modellek négyféle jelölését felismerjük", () => {
  assert.deepEqual(
    scan("A \\(Z_0=100\\) és a \\[ \\Gamma_L=\\frac13 \\] meg a $$x^2$$ és a $a_1$ is."),
    ["\\(Z_0=100\\)", "\\[ \\Gamma_L=\\frac13 \\]", "$$x^2$$", "$a_1$"],
  );
});

test("a dollár csak TeX-jellel képlet", () => {
  // Enélkül a „bruttó $5 és $10 között" közepe egy piros hibajelzés lett volna.
  assert.deepEqual(scan("bruttó $5 és $10 között"), []);
  assert.deepEqual(scan("a $z_L$ normalizált"), ["$z_L$"]);
});

test("a képlet a hivatkozás-mintát megelőzi", () => {
  // A `\[ ... \]` egy karakterrel korábban kezdődik, mint a benne látszó
  // `[ ... ]`, és a korábbi találat nyer.
  assert.deepEqual(scan("érték: \\[x\\](nem link)"), ["\\[x\\]"]);
});

test("a kifejezés megmondja, hogy kiemelt-e", () => {
  assert.deepEqual(parseMath("\\(x+1\\)"), { tex: "x+1", display: false });
  assert.deepEqual(parseMath("\\[x+1\\]"), { tex: "x+1", display: true });
  assert.deepEqual(parseMath("$$x+1$$"), { tex: "x+1", display: true });
  assert.deepEqual(parseMath("$x_1$"), { tex: "x_1", display: false });
  assert.equal(parseMath("`nem képlet`"), null);
});

test("a kétszer escape-elt vezérjelek visszaállnak", () => {
  // A tervekben így jelent meg: `\(Z_0=100\\,\\Omega\)` — a TeX ebből
  // sortörést olvasott volna.
  assert.deepEqual(parseMath("\\(Z_0=100\\\\,\\\\Omega\\)"), {
    tex: "Z_0=100\\,\\Omega",
    display: false,
  });
});

test("az üres képletből nem lesz kifejezés", () => {
  assert.equal(parseMath("\\(   \\)"), null);
});
