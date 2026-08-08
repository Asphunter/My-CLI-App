import assert from "node:assert/strict";
import test from "node:test";
import { liveNarrationLines } from "../src/liveNarration.ts";

test("minden menet közbeni sor önálló bulletet kap", () => {
  const text = [
    "A sandbox tiltja a workspace-en kívüli adb hívást — feloldom:",
    "Az adb közvetlenül nem elérhető a sandboxból.",
    "Telepítés sikeres — az APK a telefonon van.",
  ].join("\n");
  assert.deepEqual(liveNarrationLines(text), [
    "A sandbox tiltja a workspace-en kívüli adb hívást — feloldom:",
    "Az adb közvetlenül nem elérhető a sandboxból.",
    "Telepítés sikeres — az APK a telefonon van.",
  ]);
});

test("az üres sorok nem lesznek üres bulletek", () => {
  assert.deepEqual(liveNarrationLines("első\n\n\nmásodik\n"), [
    "első",
    "második",
  ]);
  assert.deepEqual(liveNarrationLines("   \n\n"), []);
  assert.deepEqual(liveNarrationLines(""), []);
});

test("a kódblokk egyben marad, nem esik szét soronként", () => {
  const text = [
    "Most hozzáadok egy segédfeladatot:",
    "```kotlin",
    "tasks.register(\"adb\") {",
    "    doLast { println(1) }",
    "}",
    "```",
    "A --args nem Gradle-opció.",
  ].join("\n");
  assert.deepEqual(liveNarrationLines(text), [
    "Most hozzáadok egy segédfeladatot:",
    '```kotlin\ntasks.register("adb") {\n    doLast { println(1) }\n}\n```',
    "A --args nem Gradle-opció.",
  ]);
});

test("a lezáratlan kódblokk sem esik szét (élő streamelés közben ez normális)", () => {
  const text = ["Írom a fájlt:", "```ts", "const a = 1;", "const b = 2;"].join(
    "\n",
  );
  assert.deepEqual(liveNarrationLines(text), [
    "Írom a fájlt:",
    "```ts\nconst a = 1;\nconst b = 2;",
  ]);
});

test("a tilde-kerítés is kódblokk, és a hosszabb kerítés is záródik", () => {
  const text = ["előtte", "~~~", "kód", "~~~", "utána"].join("\n");
  assert.deepEqual(liveNarrationLines(text), [
    "előtte",
    "~~~\nkód\n~~~",
    "utána",
  ]);
});

test("a kódblokkon belüli üres sor nem vágja el a blokkot", () => {
  const text = ["```", "egy", "", "kettő", "```"].join("\n");
  assert.deepEqual(liveNarrationLines(text), ["```\negy\n\nkettő\n```"]);
});
