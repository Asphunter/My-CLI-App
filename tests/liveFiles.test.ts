import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_LIVE_FILES,
  activeLiveFile,
  applyEditToFile,
  canonicalLiveFilePath,
  closeLiveFile,
  followLiveFiles,
  openLiveFiles,
  reopenLiveFiles,
  removeLiveFile,
  selectLiveFile,
  touchLiveFile,
  liveFilePathKey,
  wholeFileHighlight,
} from "../src/liveFiles.ts";

const touch = (path: string, content = "", sequence = 1) => ({
  path,
  content,
  streaming: false,
  mode: "write" as const,
  sequence,
});

test("a fülek gyűlnek, és a legújabb kerül előre", () => {
  let state = touchLiveFile(EMPTY_LIVE_FILES, touch("a.py", "a", 1));
  assert.deepEqual(state.files.map((file) => file.path), ["a.py"]);
  assert.equal(state.activePath, "a.py");
  state = touchLiveFile(state, touch("b.py", "b", 2));
  state = touchLiveFile(state, touch("c.py", "c", 3));
  // A korábbi fájlok fent maradnak — ez a kért viselkedés: 1 → 2 → 3 fül.
  assert.deepEqual(state.files.map((file) => file.path), [
    "a.py",
    "b.py",
    "c.py",
  ]);
  assert.equal(state.activePath, "c.py");
});

test("ugyanaz a fájl nem nyit második fület, csak frissül", () => {
  let state = touchLiveFile(EMPTY_LIVE_FILES, touch("a.py", "első", 1));
  state = touchLiveFile(state, touch("a.py", "második", 2));
  assert.equal(state.files.length, 1);
  assert.equal(state.files[0].content, "második");
});

test("kézi választás után a futás nem rángatja el az olvasót", () => {
  let state = touchLiveFile(EMPTY_LIVE_FILES, touch("a.py", "a", 1));
  state = touchLiveFile(state, touch("b.py", "b", 2));
  state = selectLiveFile(state, "a.py");
  assert.equal(state.following, false);
  state = touchLiveFile(state, touch("c.py", "c", 3));
  // Az új fül létrejön, de a nézet marad ott, ahol az olvasó hagyta.
  assert.deepEqual(state.files.map((file) => file.path), [
    "a.py",
    "b.py",
    "c.py",
  ]);
  assert.equal(state.activePath, "a.py");
  state = followLiveFiles(state);
  assert.equal(state.activePath, "c.py");
  assert.equal(state.following, true);
});

test("a bezárt fül helyét a szomszédja veszi át", () => {
  let state = touchLiveFile(EMPTY_LIVE_FILES, touch("a.py", "a", 1));
  state = touchLiveFile(state, touch("b.py", "b", 2));
  state = touchLiveFile(state, touch("c.py", "c", 3));
  state = selectLiveFile(state, "b.py");
  state = closeLiveFile(state, "b.py");
  assert.deepEqual(openLiveFiles(state).map((file) => file.path), [
    "a.py",
    "c.py",
  ]);
  assert.equal(state.activePath, "c.py");
  // Nem aktív fül bezárása nem mozdítja a nézetet.
  state = closeLiveFile(state, "a.py");
  assert.equal(state.activePath, "c.py");
  assert.equal(activeLiveFile(state)?.path, "c.py");
});

test("az utolsó fül bezárása sem veszíti el a fájlokat", () => {
  // Enélkül az utolsó X-szel az egész panel eltűnt, és nem volt visszaút.
  let state = touchLiveFile(EMPTY_LIVE_FILES, touch("a.py", "a", 1));
  state = touchLiveFile(state, touch("b.py", "b", 2));
  state = closeLiveFile(state, "a.py");
  state = closeLiveFile(state, "b.py");
  assert.deepEqual(openLiveFiles(state), []);
  assert.equal(activeLiveFile(state), undefined);
  // A fájlok megvannak, csak nem látszanak — és visszahozhatók.
  assert.equal(state.files.length, 2);
  state = reopenLiveFiles(state);
  assert.deepEqual(openLiveFiles(state).map((file) => file.path), [
    "a.py",
    "b.py",
  ]);
});

test("amihez a modell újra hozzányúl, az visszakerül a sávra", () => {
  let state = touchLiveFile(EMPTY_LIVE_FILES, touch("a.py", "a", 1));
  state = closeLiveFile(state, "a.py");
  assert.deepEqual(openLiveFiles(state), []);
  state = touchLiveFile(state, touch("a.py", "a2", 2));
  assert.deepEqual(openLiveFiles(state).map((file) => file.path), ["a.py"]);
  assert.equal(state.files.length, 1);
});

test("a szerkesztés a lemezen álló fájlra vetül, és megmondja a sorait", () => {
  const base = "egy\nkettő\nhárom\n";
  const applied = applyEditToFile(base, "kettő", "KETTŐ\nKÉTTŐ");
  assert.ok(applied);
  assert.equal(applied.content, "egy\nKETTŐ\nKÉTTŐ\nhárom\n");
  assert.deepEqual(applied.highlight, { from: 2, to: 3 });
});

test("a 100. sor körüli szerkesztés megtartja a teljes fájl sorszámait", () => {
  const base = Array.from({ length: 120 }, (_, index) => `sor-${index + 1}`).join(
    "\n",
  );
  const applied = applyEditToFile(base, "sor-100", "ÚJ-100\nÚJ-101");
  assert.ok(applied);
  assert.equal(applied.content.split("\n")[98], "sor-99");
  assert.equal(applied.content.split("\n")[99], "ÚJ-100");
  assert.equal(applied.content.split("\n")[100], "ÚJ-101");
  assert.deepEqual(applied.highlight, { from: 100, to: 101 });
});

test("CRLF fájl és LF patch esetén is ugyanaz marad a sorszám", () => {
  const applied = applyEditToFile("első\r\n" + "régi\r\n" + "utolsó", "régi", "új");
  assert.ok(applied);
  assert.equal(applied.content, "első\núj\nutolsó");
  assert.deepEqual(applied.highlight, { from: 2, to: 2 });
});

test("ha a keresett szöveg nincs meg, nem rajzolunk félrevezető fájlt", () => {
  assert.equal(applyEditToFile("egy\nkettő\n", "nincs ilyen", "x"), null);
  assert.equal(applyEditToFile("egy\n", "", "x"), null);
});

test("új fájlnál az egész tartalom a változás", () => {
  assert.deepEqual(wholeFileHighlight("a\nb\nc"), { from: 1, to: 3 });
  assert.deepEqual(wholeFileHighlight(""), { from: 1, to: 1 });
});

test("az eltérő útvonal-spellingek ugyanazt a live fájlt azonosítják", () => {
  let state = touchLiveFile(
    EMPTY_LIVE_FILES,
    touch("./Requirements.TXT", "első", 1),
    "C:/projekt",
  );
  state = touchLiveFile(
    state,
    touch("C:/PROJEKT/requirements.txt", "második", 2),
    "c:/projekt",
  );
  assert.equal(state.files.length, 1);
  assert.equal(state.files[0].content, "második");
  assert.equal(state.files[0].path, "Requirements.TXT");
  assert.equal(canonicalLiveFilePath("./src\\..\\app.js"), "app.js");
  assert.equal(
    liveFilePathKey("C:/Projekt/APP.JS", "c:/projekt"),
    liveFilePathKey("app.js"),
  );
});

test("azonos fájlnév különböző könyvtárban külön tab marad", () => {
  let state = touchLiveFile(EMPTY_LIVE_FILES, touch("src/app.js", "src", 1));
  state = touchLiveFile(state, touch("tests/app.js", "test", 2));
  assert.deepEqual(state.files.map((file) => file.path), [
    "src/app.js",
    "tests/app.js",
  ]);
});

test("failed provider writes are removed from the live preview", () => {
  let state = touchLiveFile(EMPTY_LIVE_FILES, touch("a.py", "disk", 1));
  state = touchLiveFile(state, touch("b.py", "preview only", 2));
  state = removeLiveFile(state, "B.PY");
  assert.deepEqual(state.files.map((file) => file.path), ["a.py"]);
  assert.equal(state.activePath, "a.py");
});
