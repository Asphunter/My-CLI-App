import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("mind a négy feladott kérdés megjelenik, nem csak az első", () => {
  assert.doesNotMatch(app, /const question = pendingClaudeQuestion\.questions\[0\]/);
  assert.match(
    app,
    /const questions = pendingClaudeQuestion\.questions\.filter\(/,
  );
  assert.match(app, /\{questions\.map\(\(question, index\) => \{/);
  // Minden megválaszolt kérdés bekerül a rekordba, a kérdés teljes szövegével
  // kulcsolva — az SDK csak ezt olvassa vissza.
  assert.match(
    app,
    /answer\[question\.question \|\| question\.header \|\| `answer-\$\{index\}`\] = value/,
  );
});

test("a listából választás és a saját szöveg külön állapot", () => {
  assert.doesNotMatch(app, /claudeQuestionDraft/);
  assert.doesNotMatch(app, /claudeQuestionSelections/);
  assert.match(
    app,
    /const \[claudeQuestionChoices, setClaudeQuestionChoices\] = useState<string\[\]\[\]>\(\[\]\)/,
  );
  assert.match(
    app,
    /const \[claudeQuestionTexts, setClaudeQuestionTexts\] = useState<string\[\]>\(\[\]\)/,
  );
  // A szövegmező a saját sorát mutatja, nem a kiválasztott opció címkéjét.
  assert.match(app, /value=\{claudeQuestionTexts\[index\] \?\? ""\}/);
});

test("egyválasztósnál a lista és a szöveg kizárja egymást, többválasztósnál összeadódik", () => {
  assert.match(app, /if \(!multiSelect\) setText\(index, ""\)/);
  assert.match(app, /if \(!multiSelect && value\.trim\(\)\) setChoice\(index, \[\]\)/);
  assert.match(app, /const all = typed \? \[\.\.\.picked, typed\] : picked/);
});

test("a panel halk sorokból áll, nem keretes gombokból", () => {
  assert.doesNotMatch(app, />CLAUDE KÉRDÉS</);
  assert.match(app, /className="agent-question-eyebrow">Claude kérdez</);
  assert.doesNotMatch(styles, /\.agent-question-options button\s*\{/);
  assert.match(
    styles,
    /\.agent-question-option\s*\{[^}]*border:\s*0;[^}]*border-bottom:\s*1px solid #2b3338/s,
  );
  assert.match(
    styles,
    /\.agent-question-option\.is-selected \.agent-question-mark\s*\{[^}]*background:\s*var\(--tick4-khaki\)/s,
  );
  // A magyarázat a címke alatt marad, a rács második hasábjában.
  assert.match(styles, /\.agent-question-note\s*\{[^}]*grid-column:\s*2/s);
});

test("a választás állapota felolvasható, és a hiányzó válaszok látszanak", () => {
  assert.match(app, /role=\{multiSelect \? "checkbox" : "radio"\}/);
  assert.match(app, /aria-checked=\{active\}/);
  assert.match(app, /\{answered\} \/ \{questions\.length\} megválaszolva/);
  // Egy hiányzó válasz nem tiltja le a küldést, csak látszik, hogy kimaradt.
  assert.match(app, /disabled=\{answered === 0\}/);
});
