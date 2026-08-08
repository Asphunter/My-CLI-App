import assert from "node:assert/strict";
import test from "node:test";

import { listBreak, listIndent } from "../src/composerList.ts";

const apply = (value: string, edit: ReturnType<typeof listBreak>) => {
  assert.ok(edit, "várt szerkesztés");
  return value.slice(0, edit.from) + edit.text + value.slice(edit.to);
};

test("a számozott lista folytatódik", () => {
  const value = "1) első";
  assert.equal(apply(value, listBreak(value, value.length)), "1) első\n2) ");
});

test("üres számozott elemen a Shift+Enter kilép a listából", () => {
  // Enélkül a lista „beragadt": minden új sor kapott egy sorszámot.
  const value = "1) első\n2) ";
  assert.equal(apply(value, listBreak(value, value.length)), "1) első\n");
});

test("a Tab betűs alszintre húzza be az elemet", () => {
  const value = "1) első\n2) ";
  assert.equal(
    apply(value, listIndent(value, value.length, "in")),
    "1) első\n   a) ",
  );
});

test("a betűs szint a-tól b-ig folytatódik", () => {
  const value = "1) első\n   a) alpont";
  assert.equal(
    apply(value, listBreak(value, value.length)),
    "1) első\n   a) alpont\n   b) ",
  );
});

test("üres betűs elemen a Shift+Enter visszalép a számozott szintre", () => {
  const value = "1) első\n   a) alpont\n   b) ";
  assert.equal(
    apply(value, listBreak(value, value.length)),
    "1) első\n   a) alpont\n2) ",
  );
});

test("a Shift+Tab is visszalép a számozott szintre, a szöveget megtartva", () => {
  const value = "1) első\n   a) alpont";
  assert.equal(
    apply(value, listIndent(value, value.length, "out")),
    "1) első\n2) alpont",
  );
});

test("nem listasoron egyik művelet sem szól bele", () => {
  const value = "sima szöveg";
  assert.equal(listBreak(value, value.length), null);
  assert.equal(listIndent(value, value.length, "in"), null);
  assert.equal(listIndent(value, value.length, "out"), null);
});
